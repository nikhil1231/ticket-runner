'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Canonical ticket statuses. Each tracker adapter owns the mapping to/from its
// own board vocabulary (Notion "Not started"/"In review"/..., GitHub board
// single-select options). Kept here so the state machine is tracker-agnostic.
const STATUSES = ['queued', 'in_progress', 'needs_info', 'in_review', 'testing', 'done', 'failed', 'cancelled'];

// Allowed transitions. Self-transitions are always permitted (idempotent
// requeues, re-asserting a status). Terminal states can only reopen to queued.
const TRANSITIONS = {
  queued: ['in_progress', 'done', 'cancelled'],
  // in_progress -> done: an epic the flywheel finished decomposing whose tickets
  // are all already terminal (merged or cancelled), so there is nothing to park
  // in Testing for sign-off. Feature tickets still reach done only via testing.
  in_progress: ['testing', 'done', 'in_review', 'needs_info', 'queued', 'failed', 'cancelled'],
  // testing -> in_progress: a human (or the flywheel) reopening an epic parked in
  // Testing to add more tickets to it.
  testing: ['done', 'in_progress', 'in_review', 'needs_info', 'queued', 'cancelled'],
  // in_review -> in_progress: the flywheel promoting a freshly-approved epic it is
  // starting to work (approval itself is still In review -> Not started).
  in_review: ['queued', 'in_progress', 'testing', 'done', 'needs_info', 'cancelled'],
  // needs_info -> done: a human resolved a parked ticket by hand (did the work
  // outside the runner) and moved its board card straight to Done. We accept
  // that as the ticket's terminal state instead of trying to merge a branch the
  // runner never implemented.
  needs_info: ['queued', 'done', 'cancelled'],
  done: ['queued'],
  failed: ['queued'],
  cancelled: ['queued'],
};

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const CLAIMABLE_KINDS = ['feature', 'query', 'incubator'];
const MAX_OUTBOX_ATTEMPTS = 20;
const PRIORITIES = ['High', 'Medium', 'Low'];
const PRIORITY_RANK_SQL = "CASE t.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 WHEN 'Low' THEN 2 ELSE 1 END";

// Columns that may be set through transition()'s patch or updateFields, mapped
// from ergonomic camelCase to physical snake_case.
const PATCH_COLUMNS = {
  attempts: 'attempts',
  reviewRounds: 'review_rounds',
  reviewFeedback: 'review_feedback',
  lastAgent: 'last_agent',
  branch: 'branch',
  enginePin: 'engine_pin',
  modelPin: 'model_pin',
};

const JSON_COLUMNS = ['changed_files', 'native_sensitive_files', 'processed_comment_ids', 'pending_comment_ids', 'tracker_meta', 'meta'];

function deriveShortId(tracker, trackerId) {
  return crypto.createHash('sha1').update(`${tracker}/${trackerId}`).digest('hex').slice(0, 12);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => { out[key] = canonical(value[key]); return out; }, {});
  }
  return value;
}

function rowToTicket(row) {
  if (!row) return null;
  const trackerMeta = (() => {
    try { return JSON.parse(row.tracker_meta); } catch { return {}; }
  })();
  const parse = (col, fallback) => {
    try { return JSON.parse(row[col]); } catch { return fallback; }
  };
  return {
    id: row.id,
    shortId: row.short_id,
    pageId: row.tracker_id,
    app: row.project_key,
    projectKey: row.project_key,
    kind: row.kind,
    parentId: row.parent_id,
    title: row.title,
    body: row.body,
    priority: normalizePriority(row.priority),
    status: row.status,
    attempts: row.attempts,
    reviewRounds: row.review_rounds,
    reviewFeedback: row.review_feedback,
    reviewHistory: parse('review_history', []),
    requeueCount: row.requeue_count,
    cli: row.engine_pin,
    model: row.model_pin,
    enginePin: row.engine_pin,
    modelPin: row.model_pin,
    lastAgent: row.last_agent,
    repoPath: row.repo_path,
    branch: row.branch,
    dir: row.worktree_dir,
    worktreeDir: row.worktree_dir,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    changedFiles: parse('changed_files', []),
    nativeSensitiveFiles: parse('native_sensitive_files', []),
    implementedAt: row.implemented_at,
    tracker: row.tracker,
    trackerId: row.tracker_id,
    trackerMeta,
    url: trackerMeta.url || '',
    databaseId: trackerMeta.databaseId || '',
    mirrorHash: row.mirror_hash,
    mirrorSyncedAt: row.mirror_synced_at,
    mirroredStatus: row.mirrored_status,
    processedCommentIds: parse('processed_comment_ids', []),
    pendingCommentIds: parse('pending_comment_ids', []),
    createdAt: row.created_at,
    createdTime: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    meta: parse('meta', {}),
  };
}

function rowToStack(row) {
  if (!row) return null;
  let tickets = [];
  try { tickets = JSON.parse(row.tickets); } catch {}
  return {
    projectKey: row.project_key,
    status: row.status,
    baseSha: row.base_sha,
    compositeSha: row.composite_sha,
    branch: row.branch,
    fingerprint: row.fingerprint,
    tickets,
    publisher: row.publisher,
    deployedAt: row.deployed_at,
  };
}

function rowToOp(row) {
  if (!row) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload); } catch {}
  return {
    id: row.id,
    ticketId: row.ticket_id,
    op: row.op,
    payload,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    doneAt: row.done_at,
  };
}

function assertStatus(status) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status "${status}"`);
}

function normalizePriority(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'high') return 'High';
  if (text === 'low') return 'Low';
  return 'Medium';
}

function assertTransition(from, to) {
  assertStatus(to);
  if (from === to) return;
  if (!(TRANSITIONS[from] || []).includes(to)) {
    throw new Error(`illegal transition ${from} -> ${to}`);
  }
}

function createStore({ baseDir, db, now = () => new Date().toISOString() }) {
  let inTx = false;

  // Reentrant transaction wrapper: claimNext calls transition(), which would
  // otherwise start a nested BEGIN (unsupported). Inner calls just run inline.
  function tx(fn) {
    if (inTx) return fn();
    db.exec('BEGIN IMMEDIATE');
    inTx = true;
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    } finally {
      inTx = false;
    }
  }

  const getById = (id) => rowToTicket(db.prepare('SELECT * FROM tickets WHERE id = ?').get(id));
  const getByShortId = (shortId) => rowToTicket(db.prepare('SELECT * FROM tickets WHERE short_id = ?').get(shortId));
  const getByTrackerId = (tracker, trackerId) =>
    rowToTicket(db.prepare('SELECT * FROM tickets WHERE tracker = ? AND tracker_id = ?').get(tracker, trackerId));
  function listByTracker(tracker, { projectKey, statuses } = {}) {
    const where = ['tracker = ?', 'tracker_id IS NOT NULL'];
    const params = [tracker];
    if (projectKey) { where.push('project_key = ?'); params.push(projectKey); }
    if (statuses?.length) {
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    return db.prepare(`SELECT * FROM tickets WHERE ${where.join(' AND ')} ORDER BY created_at, short_id`)
      .all(...params).map(rowToTicket);
  }

  function event(ticketId, type, extra = {}) {
    db.prepare('INSERT INTO ticket_events(ticket_id, type, from_status, to_status, payload, created_at) VALUES(?,?,?,?,?,?)')
      .run(ticketId, type, extra.from ?? null, extra.to ?? null, JSON.stringify(extra.payload ?? {}), now());
  }

  // Coalesced mirror op: only one pending 'mirror' per ticket (latest-wins,
  // payload is computed at send time from the current row).
  function enqueueMirror(ticketId) {
    const at = now();
    db.prepare("DELETE FROM outbox WHERE ticket_id = ? AND op = 'mirror' AND done_at IS NULL").run(ticketId);
    db.prepare('INSERT INTO outbox(ticket_id, op, payload, next_attempt_at, created_at) VALUES(?,?,?,?,?)')
      .run(ticketId, 'mirror', '{}', at, at);
  }

  function enqueueOp(ticketId, op, payload) {
    const at = now();
    db.prepare('INSERT INTO outbox(ticket_id, op, payload, next_attempt_at, created_at) VALUES(?,?,?,?,?)')
      .run(ticketId, op, JSON.stringify(payload || {}), at, at);
  }

  function applyPatch(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
      if (patch[key] !== undefined) { sets.push(`${column} = ?`); values.push(patch[key]); }
    }
    if (!sets.length) return;
    values.push(id);
    db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  function transition(id, toStatus, patch = {}, { mirror = true } = {}) {
    return tx(() => {
      const ticket = getById(id);
      if (!ticket) throw new Error(`no ticket ${id}`);
      assertTransition(ticket.status, toStatus);
      const ts = now();
      const closedAt = TERMINAL.has(toStatus) ? ts : null;
      // A real do-over: the ticket is going back to queued after already having
      // been implemented at least once (it has a head_sha), not just its first
      // claim. Counting these makes a ticket that keeps bouncing (max review
      // rounds, testing-stack conflicts, human-driven re-queues) visible instead
      // of silently repeating forever.
      const isRequeue = toStatus === 'queued' && ticket.status !== 'queued' && !!ticket.headSha;
      db.prepare(`UPDATE tickets SET status = ?, closed_at = ?, updated_at = ?${isRequeue ? ', requeue_count = requeue_count + 1' : ''} WHERE id = ?`)
        .run(toStatus, closedAt, ts, id);
      // A ticket leaving a terminal status has been reopened/restored; drop the
      // archived flag so it becomes visible again (and eligible to re-archive
      // once it closes again).
      if (!TERMINAL.has(toStatus) && ticket.meta?.archived) {
        const meta = { ...ticket.meta };
        delete meta.archived;
        delete meta.archivedAt;
        db.prepare('UPDATE tickets SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
      }
      applyPatch(id, patch);
      event(id, 'transition', { from: ticket.status, to: toStatus, payload: patch });
      if (mirror) enqueueMirror(id);
      return getById(id);
    });
  }

  // Durably records one reviewer finding for the life of the ticket. Unlike
  // review_feedback/review_rounds (scoped to the current implementation
  // attempt and reset on approve/park), review_history is never cleared, so a
  // ticket that gets parked for a human and later re-queued still remembers
  // every distinct issue any reviewer has ever flagged on it.
  function appendReviewNote(id, { round, reviewer, notes } = {}) {
    return tx(() => {
      const ticket = getById(id);
      if (!ticket) throw new Error(`no ticket ${id}`);
      const history = [...ticket.reviewHistory, { round: round ?? null, reviewer: reviewer || '', notes: notes || '', at: now() }];
      db.prepare('UPDATE tickets SET review_history = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(history), now(), id);
      return getById(id);
    });
  }

  function upsertFromTracker(input) {
    const {
      tracker, trackerId, projectKey, kind = 'feature', title, body, createdAt,
      enginePin = '', modelPin = '', trackerMeta = {}, mirroredStatus = null,
      status = 'queued', shortId, priority = 'Medium',
    } = input;
    if (!tracker || !trackerId) throw new Error('upsertFromTracker requires tracker and trackerId');
    assertStatus(status);
    return tx(() => {
      const existing = getByTrackerId(tracker, trackerId);
      const ts = now();
      if (existing) {
        db.prepare(`UPDATE tickets SET title = ?, body = ?, kind = ?, engine_pin = ?, model_pin = ?,
                    tracker_meta = ?, project_key = ?, priority = ?, mirrored_status = COALESCE(?, mirrored_status), updated_at = ?
                    WHERE id = ?`)
          .run(title ?? existing.title, body ?? existing.body, kind, enginePin, modelPin, JSON.stringify(trackerMeta),
            projectKey ?? existing.projectKey, normalizePriority(priority), mirroredStatus, ts, existing.id);
        return getById(existing.id);
      }
      const fallbackSid = deriveShortId(tracker, trackerId);
      let sid = shortId || fallbackSid;
      if (shortId) {
        const collision = db.prepare('SELECT id FROM tickets WHERE short_id = ?').get(shortId);
        if (collision) sid = fallbackSid;
      }
      db.prepare(`INSERT INTO tickets(short_id, project_key, kind, title, body, priority, status, engine_pin, model_pin,
                  tracker, tracker_id, tracker_meta, mirrored_status, created_at, updated_at)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(sid, projectKey, kind, title || '(untitled)', body || '', normalizePriority(priority), status, enginePin, modelPin,
          tracker, trackerId, JSON.stringify(trackerMeta), mirroredStatus, createdAt || ts, ts);
      const created = getByTrackerId(tracker, trackerId);
      event(created.id, 'created', { to: status });
      return created;
    });
  }

  // Human-owned intent fields, re-read once at claim time then frozen for the run.
  function refreshIntent(id, { title, body, enginePin, modelPin, priority, trackerMeta } = {}) {
    const sets = [];
    const values = [];
    if (title !== undefined) { sets.push('title = ?'); values.push(title); }
    if (body !== undefined) { sets.push('body = ?'); values.push(body); }
    if (enginePin !== undefined) { sets.push('engine_pin = ?'); values.push(enginePin); }
    if (modelPin !== undefined) { sets.push('model_pin = ?'); values.push(modelPin); }
    if (priority !== undefined) { sets.push('priority = ?'); values.push(normalizePriority(priority)); }
    if (trackerMeta !== undefined) { sets.push('tracker_meta = ?'); values.push(JSON.stringify(trackerMeta)); }
    if (!sets.length) return getById(id);
    sets.push('updated_at = ?'); values.push(now());
    values.push(id);
    db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return getById(id);
  }

  function retargetTracker(id, { tracker, trackerId = null, trackerMeta = {} }) {
    if (!tracker) throw new Error('retargetTracker requires tracker');
    return tx(() => {
      const ticket = getById(id);
      if (!ticket) throw new Error(`no ticket ${id}`);
      db.prepare('UPDATE tickets SET tracker = ?, tracker_id = ?, tracker_meta = ?, mirror_hash = NULL, updated_at = ? WHERE id = ?')
        .run(tracker, trackerId, JSON.stringify(trackerMeta), now(), id);
      event(id, 'retarget_tracker', { payload: { from: ticket.tracker, to: tracker, trackerId } });
      enqueueMirror(id);
      return getById(id);
    });
  }

  function readyTickets({ projectKey, kinds = CLAIMABLE_KINDS } = {}) {
    const placeholders = kinds.map(() => '?').join(', ');
    const params = [...kinds];
    let sql = `SELECT * FROM tickets t
      WHERE t.status = 'queued' AND t.kind IN (${placeholders})
      AND NOT EXISTS (
        SELECT 1 FROM ticket_dependencies d JOIN tickets b ON b.id = d.depends_on_id
        WHERE d.ticket_id = t.id AND b.status NOT IN ('testing','done','cancelled')
      )`;
    if (projectKey) { sql += ' AND t.project_key = ?'; params.push(projectKey); }
    sql += ` ORDER BY ${PRIORITY_RANK_SQL}, t.created_at, t.short_id`;
    return db.prepare(sql).all(...params).map(rowToTicket);
  }

  function claimNext({ projectKey } = {}) {
    return tx(() => {
      const ready = readyTickets({ projectKey });
      const first = ready[0];
      if (!first) return null;
      transition(first.id, 'in_progress', { attempts: first.attempts + 1 });
      return getById(first.id);
    });
  }

  function listByStatus(projectKey, status) {
    if (projectKey) {
      return db.prepare('SELECT * FROM tickets WHERE project_key = ? AND status = ? ORDER BY created_at, short_id')
        .all(projectKey, status).map(rowToTicket);
    }
    return db.prepare('SELECT * FROM tickets WHERE status = ? ORDER BY created_at, short_id').all(status).map(rowToTicket);
  }

  // Tickets that have sat in a terminal status long enough to be archived off the
  // board: in one of `statuses`, closed on/before `before`, and not already
  // archived. `before` is an ISO timestamp compared against closed_at (also ISO,
  // so lexicographic comparison is chronological).
  function listArchivable({ projectKey, statuses = [], before } = {}) {
    if (!statuses.length || !before) return [];
    const where = [
      `status IN (${statuses.map(() => '?').join(', ')})`,
      'closed_at IS NOT NULL',
      'closed_at <= ?',
      "COALESCE(json_extract(meta, '$.archived'), 0) != 1",
    ];
    const params = [...statuses, before];
    if (projectKey) { where.push('project_key = ?'); params.push(projectKey); }
    return db.prepare(`SELECT * FROM tickets WHERE ${where.join(' AND ')} ORDER BY created_at, short_id`)
      .all(...params).map(rowToTicket);
  }

  // Soft-archive: flag the ticket locally (hidden from the dashboard, skipped by
  // listArchivable so the pass is idempotent) and enqueue a durable 'archive' op
  // so the tracker removes its card from the board.
  function archiveTicket(id) {
    return tx(() => {
      const ticket = getById(id);
      if (!ticket) throw new Error(`no ticket ${id}`);
      const meta = { ...(ticket.meta || {}), archived: true, archivedAt: now() };
      db.prepare('UPDATE tickets SET meta = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(meta), now(), id);
      event(id, 'archived', {});
      enqueueOp(id, 'archive', {});
      return getById(id);
    });
  }

  // ---- worktree lifecycle (replaces lib/ticket-state.js) ----
  function recordWorktree(id, { repoPath, branch, worktreeDir, baseSha }) {
    db.prepare('UPDATE tickets SET repo_path = ?, branch = ?, worktree_dir = ?, base_sha = ?, updated_at = ? WHERE id = ?')
      .run(repoPath ?? null, branch ?? null, worktreeDir ?? null, baseSha ?? null, now(), id);
    return getById(id);
  }

  function recordImplementation(id, { headSha, changedFiles = [], nativeSensitiveFiles = [], implementedAt }) {
    db.prepare('UPDATE tickets SET head_sha = ?, changed_files = ?, native_sensitive_files = ?, implemented_at = ?, updated_at = ? WHERE id = ?')
      .run(headSha ?? null, JSON.stringify(changedFiles), JSON.stringify(nativeSensitiveFiles), implementedAt ?? now(), now(), id);
    return getById(id);
  }

  function clearWorktree(id) {
    db.prepare('UPDATE tickets SET worktree_dir = NULL, branch = NULL, base_sha = NULL, updated_at = ? WHERE id = ?')
      .run(now(), id);
    return getById(id);
  }

  function markRemoteMissing(id, details = {}) {
    return tx(() => {
      const ticket = getById(id);
      if (!ticket) throw new Error(`no ticket ${id}`);
      let current = ticket;
      if (!TERMINAL.has(ticket.status)) current = transition(id, 'cancelled', {}, { mirror: false });
      const meta = {
        ...(current.meta || {}),
        remoteMissing: true,
        remoteMissingAt: now(),
        remoteMissingTracker: details.tracker || current.tracker,
        remoteMissingTrackerId: String(details.trackerId || current.trackerId || ''),
      };
      db.prepare('UPDATE tickets SET meta = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(meta), now(), id);
      event(id, 'remote_missing', { payload: { tracker: meta.remoteMissingTracker, trackerId: meta.remoteMissingTrackerId } });
      return getById(id);
    });
  }

  function listBugReportTickets() {
    return db.prepare("SELECT * FROM tickets WHERE json_extract(meta, '$.bugReport.docName') IS NOT NULL ORDER BY created_at, short_id")
      .all().map(rowToTicket);
  }

  function markCommentsProcessed(id, ids) {
    const ticket = getById(id);
    if (!ticket) return;
    const merged = Array.from(new Set([...ticket.processedCommentIds, ...ids]));
    db.prepare('UPDATE tickets SET processed_comment_ids = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), now(), id);
  }

  function setPendingComments(id, ids) {
    db.prepare('UPDATE tickets SET pending_comment_ids = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(ids || []), now(), id);
  }

  // ---- outbound side-effects ----
  const enqueueComment = (id, text) => enqueueOp(id, 'comment', { text });
  const enqueueSection = (id, { heading, markdown }) => enqueueOp(id, 'append_section', { heading, markdown });
  const enqueuePromotion = (id, targetProjectKey) => enqueueOp(id, 'promote_incubator', { targetProjectKey });

  // Planner-created tickets are local-first: no human authored them on a
  // board, so there is no tracker/trackerId to derive a short id from. The
  // `tracker` column must still be the exact poll-snapshot key (e.g.
  // `github:<owner>/<repo>` or `notion`) so that once the outbound mirror op
  // creates the remote issue/page and backfills tracker_id, the tracker's own
  // pollCommands sees it as already-known and never emits a duplicate
  // `create` command for it.
  function createLocalTicket({ projectKey, kind, title, body = '', priority = 'Medium', parentId = null, status = 'queued', tracker, trackerMeta = {}, meta = {} }) {
    if (!tracker) throw new Error('createLocalTicket requires tracker');
    assertStatus(status);
    return tx(() => {
      let shortId;
      do {
        shortId = crypto.randomBytes(6).toString('hex');
      } while (getByShortId(shortId));
      const ts = now();
      db.prepare(`INSERT INTO tickets(short_id, project_key, kind, parent_id, title, body, priority, status,
                  tracker, tracker_id, tracker_meta, meta, created_at, updated_at)
                  VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)`)
        .run(shortId, projectKey, kind, parentId, title || '(untitled)', body, normalizePriority(priority), status,
          tracker, JSON.stringify(trackerMeta), JSON.stringify(meta), ts, ts);
      const created = getByShortId(shortId);
      event(created.id, 'created', { to: status, payload: { source: 'planner' } });
      enqueueMirror(created.id);
      return created;
    });
  }

  function ticketsByKind(projectKey, kind) {
    return db.prepare('SELECT * FROM tickets WHERE project_key = ? AND kind = ? ORDER BY created_at DESC')
      .all(projectKey, kind).map(rowToTicket);
  }

  function childrenOf(parentId) {
    return db.prepare('SELECT * FROM tickets WHERE parent_id = ? ORDER BY created_at, short_id').all(parentId).map(rowToTicket);
  }

  // ---- hierarchy & dependencies ----
  function setParent(id, parentId) {
    db.prepare('UPDATE tickets SET parent_id = ?, updated_at = ? WHERE id = ?').run(parentId ?? null, now(), id);
    return getById(id);
  }
  function addDependency(id, dependsOnId, depType = 'blocks') {
    if (id === dependsOnId) throw new Error('a ticket cannot depend on itself');
    db.prepare('INSERT OR IGNORE INTO ticket_dependencies(ticket_id, depends_on_id, dep_type, created_at) VALUES(?,?,?,?)')
      .run(id, dependsOnId, depType, now());
  }
  function removeDependency(id, dependsOnId) {
    db.prepare('DELETE FROM ticket_dependencies WHERE ticket_id = ? AND depends_on_id = ?').run(id, dependsOnId);
  }
  function dependencies(id) {
    return db.prepare('SELECT depends_on_id AS dependsOnId, dep_type AS depType FROM ticket_dependencies WHERE ticket_id = ?').all(id);
  }

  // ---- stacks ----
  function getStack(projectKey) {
    return rowToStack(db.prepare('SELECT * FROM stacks WHERE project_key = ?').get(projectKey));
  }
  function saveStack(projectKey, record = {}) {
    db.prepare(`INSERT INTO stacks(project_key, status, base_sha, composite_sha, branch, fingerprint, tickets, publisher, deployed_at)
                VALUES(?,?,?,?,?,?,?,?,?)
                ON CONFLICT(project_key) DO UPDATE SET status=excluded.status, base_sha=excluded.base_sha,
                  composite_sha=excluded.composite_sha, branch=excluded.branch, fingerprint=excluded.fingerprint,
                  tickets=excluded.tickets, publisher=excluded.publisher, deployed_at=excluded.deployed_at`)
      .run(projectKey, record.status || 'unknown', record.baseSha ?? null, record.compositeSha ?? null,
        record.branch ?? null, record.fingerprint ?? null, JSON.stringify(record.tickets || []),
        record.publisher ?? null, record.deployedAt ?? null);
    return getStack(projectKey);
  }

  // ---- repairs ledger ----
  function getRepair(fingerprint) {
    const row = db.prepare('SELECT * FROM repairs WHERE fingerprint = ?').get(fingerprint);
    if (!row) return null;
    let meta = {};
    try { meta = JSON.parse(row.meta); } catch {}
    return { fingerprint: row.fingerprint, count: row.count, lastStatus: row.last_status, lastAt: row.last_at, meta };
  }
  function recordRepair(fingerprint, patch = {}) {
    const existing = getRepair(fingerprint);
    const count = patch.count ?? ((existing?.count || 0) + (patch.bumpCount ? 1 : 0));
    const status = patch.status ?? existing?.lastStatus ?? null;
    const meta = patch.meta ?? existing?.meta ?? {};
    db.prepare(`INSERT INTO repairs(fingerprint, count, last_status, last_at, meta) VALUES(?,?,?,?,?)
                ON CONFLICT(fingerprint) DO UPDATE SET count=excluded.count, last_status=excluded.last_status,
                  last_at=excluded.last_at, meta=excluded.meta`)
      .run(fingerprint, count, status, now(), JSON.stringify(meta));
    return getRepair(fingerprint);
  }

  // ---- kv ----
  function getKv(name, fallback = null) {
    const row = db.prepare('SELECT value FROM kv WHERE name = ?').get(name);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  }
  function setKv(name, value) {
    db.prepare('INSERT INTO kv(name, value, updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(name, JSON.stringify(value), now());
  }
  function deleteKv(name) {
    db.prepare('DELETE FROM kv WHERE name = ?').run(name);
  }

  // ---- outbox (driven by lib/sync.js) ----
  function outboxDue(at = now(), limit = 50) {
    return db.prepare('SELECT * FROM outbox WHERE done_at IS NULL AND next_attempt_at <= ? ORDER BY id LIMIT ?')
      .all(at, limit).map(rowToOp);
  }
  function pendingOutbox(ticketId) {
    return db.prepare('SELECT * FROM outbox WHERE ticket_id = ? AND done_at IS NULL ORDER BY id').all(ticketId).map(rowToOp);
  }
  function outboxDone(opId) {
    db.prepare('UPDATE outbox SET done_at = ? WHERE id = ?').run(now(), opId);
  }
  function outboxFail(opId, error, backoffMs) {
    const row = db.prepare('SELECT attempts FROM outbox WHERE id = ?').get(opId);
    const attempts = (row?.attempts || 0) + 1;
    const message = String(error && error.message ? error.message : error).slice(0, 500);
    if (attempts >= MAX_OUTBOX_ATTEMPTS) {
      db.prepare('UPDATE outbox SET attempts = ?, last_error = ?, done_at = ? WHERE id = ?')
        .run(attempts, `parked: ${message}`, now(), opId);
      return { parked: true, attempts };
    }
    const nextAt = new Date(Date.parse(now()) + backoffMs).toISOString();
    db.prepare('UPDATE outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?')
      .run(attempts, message, nextAt, opId);
    return { parked: false, attempts };
  }
  function setMirrorState(id, { mirrorHash, mirroredStatus, trackerId, trackerMeta }) {
    const sets = ['mirror_synced_at = ?'];
    const values = [now()];
    if (mirrorHash !== undefined) { sets.push('mirror_hash = ?'); values.push(mirrorHash); }
    if (mirroredStatus !== undefined) { sets.push('mirrored_status = ?'); values.push(mirroredStatus); }
    if (trackerId !== undefined) { sets.push('tracker_id = ?'); values.push(trackerId); }
    if (trackerMeta !== undefined) { sets.push('tracker_meta = ?'); values.push(JSON.stringify(trackerMeta)); }
    values.push(id);
    db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return getById(id);
  }

  // ---- durability & introspection ----
  function exportJsonl() {
    if (baseDir === ':memory:') return null;
    const dir = path.join(baseDir, 'state', 'export');
    fs.mkdirSync(dir, { recursive: true });
    const dump = (name, rows) => {
      const target = path.join(dir, name);
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
      const body = rows.map((row) => JSON.stringify(canonical(row))).join('\n');
      fs.writeFileSync(temp, rows.length ? `${body}\n` : '', 'utf8');
      try {
        fs.renameSync(temp, target);
      } catch (error) {
        if (process.platform !== 'win32' || !['EEXIST', 'EPERM'].includes(error.code)) throw error;
        fs.rmSync(target, { force: true });
        fs.renameSync(temp, target);
      }
    };
    const tickets = db.prepare('SELECT * FROM tickets ORDER BY short_id').all().map(rowToTicket);
    const deps = db.prepare('SELECT * FROM ticket_dependencies ORDER BY ticket_id, depends_on_id').all();
    const stacks = db.prepare('SELECT * FROM stacks ORDER BY project_key').all().map(rowToStack);
    dump('tickets.jsonl', tickets);
    dump('deps.jsonl', deps);
    dump('stacks.jsonl', stacks);
    return { tickets: tickets.length, deps: deps.length, stacks: stacks.length };
  }

  function stats() {
    const byStatus = {};
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status').all()) {
      byStatus[row.status] = row.n;
    }
    const outbox = db.prepare(`SELECT
        SUM(CASE WHEN done_at IS NULL THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN last_error LIKE 'parked:%' THEN 1 ELSE 0 END) AS parked
      FROM outbox`).get();
    return {
      tickets: db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n,
      byStatus,
      outboxPending: outbox.pending || 0,
      outboxParked: outbox.parked || 0,
    };
  }

  return {
    // identity & ingest
    getById, getByShortId, getByTrackerId, listByTracker, upsertFromTracker, createLocalTicket, refreshIntent, retargetTracker,
    // state machine
    transition, claimNext, readyTickets, listByStatus, listArchivable, archiveTicket, appendReviewNote,
    // worktree lifecycle
    recordWorktree, recordImplementation, clearWorktree, markRemoteMissing, listBugReportTickets, markCommentsProcessed, setPendingComments,
    // outbound side-effects
    enqueueComment, enqueueSection, enqueuePromotion,
    // hierarchy & deps
    setParent, addDependency, removeDependency, dependencies, ticketsByKind, childrenOf,
    // stacks / repairs / kv
    getStack, saveStack, getRepair, recordRepair, getKv, setKv, deleteKv,
    // outbox
    outboxDue, pendingOutbox, outboxDone, outboxFail, setMirrorState,
    // durability & introspection
    exportJsonl, stats,
    // low-level escape hatch (tests / migration tooling)
    db,
  };
}

module.exports = { createStore, deriveShortId, canonical, STATUSES, TRANSITIONS, assertTransition, normalizePriority, PRIORITIES };
