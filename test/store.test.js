'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, closeDb, MIGRATIONS } = require('../lib/db');
const { createStore, deriveShortId } = require('../lib/store');

function fixture(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-store-'));
  const db = openDb(baseDir);
  t.after(() => { closeDb(db); fs.rmSync(baseDir, { recursive: true, force: true }); });
  return { baseDir, db, store: createStore({ baseDir, db }) };
}

function seed(store, overrides = {}) {
  const trackerId = overrides.trackerId || `page-${Math.random().toString(16).slice(2, 10)}`;
  return store.upsertFromTracker({
    tracker: 'github:acme/caligo',
    trackerId,
    projectKey: overrides.projectKey || 'caligo',
    kind: overrides.kind || 'feature',
    title: overrides.title || 'A ticket',
    createdAt: overrides.createdAt || '2026-01-01T00:00:00Z',
    ...overrides,
  });
}

test('upsertFromTracker is idempotent on (tracker, trackerId)', (t) => {
  const { store } = fixture(t);
  const a = seed(store, { trackerId: 'p1', title: 'First' });
  const b = seed(store, { trackerId: 'p1', title: 'First (edited)' });
  assert.equal(a.id, b.id);
  assert.equal(b.title, 'First (edited)');
  assert.equal(store.stats().tickets, 1);
  // status is runner-owned: re-ingest must not reset it
  store.transition(a.id, 'in_progress');
  const c = seed(store, { trackerId: 'p1', title: 'First' });
  assert.equal(c.status, 'in_progress');
});

test('shortId uses provided value or derives a stable one', (t) => {
  const { store } = fixture(t);
  const withShort = seed(store, { trackerId: 'p2', shortId: 'abcdef123456' });
  assert.equal(withShort.shortId, 'abcdef123456');
  const derived = seed(store, { trackerId: 'p3' });
  assert.equal(derived.shortId, deriveShortId('github:acme/caligo', 'p3'));
});

test('upsertFromTracker falls back when provided shortId collides', (t) => {
  const { store } = fixture(t);
  const original = seed(store, {
    tracker: 'github:nikhil1231/caligo-app',
    trackerId: '1',
    shortId: 'work00000001',
  });
  const collided = seed(store, {
    tracker: 'github:nikhil1231/workout-tracker',
    trackerId: '1',
    shortId: 'work00000001',
  });
  assert.equal(original.shortId, 'work00000001');
  assert.equal(collided.shortId, deriveShortId('github:nikhil1231/workout-tracker', '1'));
  assert.equal(store.stats().tickets, 2);
});

test('claimNext is atomic: two claims return different tickets, oldest first', (t) => {
  const { store } = fixture(t);
  seed(store, { trackerId: 'newer', title: 'Newer', createdAt: '2026-01-02T00:00:00Z' });
  seed(store, { trackerId: 'older', title: 'Older', createdAt: '2026-01-01T00:00:00Z' });
  const first = store.claimNext();
  const second = store.claimNext();
  assert.equal(first.title, 'Older');
  assert.equal(first.status, 'in_progress');
  assert.equal(first.attempts, 1);
  assert.equal(second.title, 'Newer');
  assert.notEqual(first.id, second.id);
  assert.equal(store.claimNext(), null);
});

test('claimNext orders by priority before oldest-first fallback', (t) => {
  const { store } = fixture(t);
  seed(store, { trackerId: 'old-low', title: 'Old low', priority: 'Low', createdAt: '2026-01-01T00:00:00Z' });
  seed(store, { trackerId: 'new-high', title: 'New high', priority: 'High', createdAt: '2026-01-03T00:00:00Z' });
  seed(store, { trackerId: 'old-medium', title: 'Old medium', createdAt: '2026-01-02T00:00:00Z' });
  seed(store, { trackerId: 'new-medium', title: 'New medium', priority: 'unknown', createdAt: '2026-01-04T00:00:00Z' });

  assert.deepEqual(store.readyTickets().map((ticket) => [ticket.title, ticket.priority]), [
    ['New high', 'High'],
    ['Old medium', 'Medium'],
    ['New medium', 'Medium'],
    ['Old low', 'Low'],
  ]);
  assert.equal(store.claimNext().title, 'New high');
});

test('claimNext rotates projects within the same priority', (t) => {
  const { store } = fixture(t);
  seed(store, { trackerId: 'a1', projectKey: 'alpha', title: 'Alpha 1', createdAt: '2026-01-01T00:00:00Z' });
  seed(store, { trackerId: 'a2', projectKey: 'alpha', title: 'Alpha 2', createdAt: '2026-01-02T00:00:00Z' });
  seed(store, { trackerId: 'b1', projectKey: 'beta', title: 'Beta 1', createdAt: '2026-01-03T00:00:00Z' });
  seed(store, { trackerId: 'b2', projectKey: 'beta', title: 'Beta 2', createdAt: '2026-01-04T00:00:00Z' });

  assert.deepEqual(store.fairReadyTickets().map((ticket) => ticket.title), ['Alpha 1', 'Alpha 2', 'Beta 1', 'Beta 2']);
  assert.equal(store.claimNext().title, 'Alpha 1');
  assert.deepEqual(store.fairReadyTickets().map((ticket) => ticket.title), ['Beta 1', 'Beta 2', 'Alpha 2']);
  assert.equal(store.claimNext().title, 'Beta 1');
  assert.deepEqual(store.fairReadyTickets().map((ticket) => ticket.title), ['Alpha 2', 'Beta 2']);
  assert.equal(store.claimNext().title, 'Alpha 2');
  assert.equal(store.claimNext().title, 'Beta 2');
});

test('claimNext keeps priority above project rotation', (t) => {
  const { store } = fixture(t);
  seed(store, { trackerId: 'medium-a', projectKey: 'alpha', title: 'Medium alpha', createdAt: '2026-01-01T00:00:00Z' });
  seed(store, { trackerId: 'high-b', projectKey: 'beta', title: 'High beta', priority: 'High', createdAt: '2026-01-03T00:00:00Z' });
  seed(store, { trackerId: 'medium-b', projectKey: 'beta', title: 'Medium beta', createdAt: '2026-01-02T00:00:00Z' });

  assert.equal(store.claimNext().title, 'High beta');
  assert.equal(store.claimNext().title, 'Medium alpha');
});

test('claimTicket revalidates queue status and dependencies', (t) => {
  const { store } = fixture(t);
  const blocker = seed(store, { trackerId: 'blocker', title: 'Blocker' });
  const blocked = seed(store, { trackerId: 'blocked', title: 'Blocked' });
  store.addDependency(blocked.id, blocker.id);
  store.transition(blocker.id, 'in_progress');

  assert.equal(store.claimTicket(blocked.id), null);
  assert.equal(store.claimTicket(blocker.id), null);

  store.transition(blocker.id, 'testing');
  const claimed = store.claimTicket(blocked.id);
  assert.equal(claimed.title, 'Blocked');
  assert.equal(claimed.status, 'in_progress');
});

test('upsertFromTracker refreshes priority for existing tickets', (t) => {
  const { store } = fixture(t);
  const ticket = seed(store, { trackerId: 'p', priority: 'Low' });
  assert.equal(ticket.priority, 'Low');
  const updated = seed(store, { trackerId: 'p', priority: 'High' });
  assert.equal(updated.id, ticket.id);
  assert.equal(updated.priority, 'High');
});

test('claimNext respects projectKey filter', (t) => {
  const { store } = fixture(t);
  seed(store, { trackerId: 'a', projectKey: 'alpha' });
  seed(store, { trackerId: 'b', projectKey: 'beta' });
  const claimed = store.claimNext({ projectKey: 'beta' });
  assert.equal(claimed.projectKey, 'beta');
  assert.equal(store.claimNext({ projectKey: 'beta' }), null);
  assert.ok(store.claimNext({ projectKey: 'alpha' }));
});

test('transition table rejects illegal moves and allows self-transitions', (t) => {
  const { store } = fixture(t);
  const ticket = seed(store, { trackerId: 'p' });
  // queued -> done is legal (used to complete epics whose tickets are all
  // terminal) but queued -> testing is still not a direct path.
  assert.throws(() => store.transition(ticket.id, 'testing'), /illegal transition queued -> testing/);
  store.transition(ticket.id, 'in_progress');
  // in_progress -> done is legal (an epic finished with every ticket already
  // merged/cancelled); needs_info -> testing is not.
  store.transition(ticket.id, 'needs_info');
  assert.throws(() => store.transition(ticket.id, 'testing'), /illegal transition needs_info -> testing/);
  store.transition(ticket.id, 'queued');
  store.transition(ticket.id, 'in_progress');
  store.transition(ticket.id, 'testing');
  const done = store.transition(ticket.id, 'done');
  assert.ok(done.closedAt);
  // terminal reopens only to queued
  const reopened = store.transition(ticket.id, 'queued');
  assert.equal(reopened.status, 'queued');
  assert.equal(reopened.closedAt, null);
  // self-transition is a no-op-ish requeue, still legal
  assert.doesNotThrow(() => store.transition(ticket.id, 'queued'));
});

test('epic lifecycle transitions are legal: approve -> in_progress, freeze -> testing, resume, cascade done', (t) => {
  const { store } = fixture(t);
  const epic = seed(store, { trackerId: 'e', kind: 'epic', status: 'in_review' });
  assert.doesNotThrow(() => store.transition(epic.id, 'in_progress')); // flywheel promotes an approved epic
  assert.doesNotThrow(() => store.transition(epic.id, 'testing'));     // frozen for sign-off
  assert.doesNotThrow(() => store.transition(epic.id, 'in_progress')); // human resumes to add more tickets
  assert.doesNotThrow(() => store.transition(epic.id, 'testing'));
  assert.equal(store.transition(epic.id, 'done').status, 'done');      // human moves epic to Done -> cascade
});

test('ready query honors dependency chains', (t) => {
  const { store } = fixture(t);
  const a = seed(store, { trackerId: 'a', title: 'A', createdAt: '2026-01-01T00:00:00Z' });
  const b = seed(store, { trackerId: 'b', title: 'B', createdAt: '2026-01-02T00:00:00Z' });
  store.addDependency(b.id, a.id);
  // B is blocked by A; only A is ready
  let ready = store.readyTickets().map((tk) => tk.title);
  assert.deepEqual(ready, ['A']);
  // review is not enough to unblock dependent work
  store.transition(a.id, 'in_progress');
  store.transition(a.id, 'in_review');
  ready = store.readyTickets().map((tk) => tk.title);
  assert.deepEqual(ready, []);
  // admitting A to the testing stack unblocks B
  store.transition(a.id, 'testing');
  ready = store.readyTickets().map((tk) => tk.title);
  assert.deepEqual(ready, ['B']);
  // finishing A keeps B unblocked
  store.transition(a.id, 'testing');
  store.transition(a.id, 'done');
  ready = store.readyTickets().map((tk) => tk.title);
  assert.deepEqual(ready, ['B']);
});

test('epic/mission kinds are never claimable', (t) => {
  const { store } = fixture(t);
  seed(store, { trackerId: 'e', kind: 'epic', title: 'Epic' });
  seed(store, { trackerId: 'f', kind: 'feature', title: 'Feature' });
  const ready = store.readyTickets().map((tk) => tk.title);
  assert.deepEqual(ready, ['Feature']);
});

test('mirror ops coalesce; other ops are FIFO', (t) => {
  const { store } = fixture(t);
  const ticket = seed(store, { trackerId: 'p' });
  store.transition(ticket.id, 'in_progress'); // enqueues mirror
  store.transition(ticket.id, 'in_review');   // coalesces mirror
  store.enqueueComment(ticket.id, 'hello');
  store.enqueueComment(ticket.id, 'world');
  const pending = store.pendingOutbox(ticket.id);
  const mirrors = pending.filter((op) => op.op === 'mirror');
  const comments = pending.filter((op) => op.op === 'comment');
  assert.equal(mirrors.length, 1);
  assert.equal(comments.length, 2);
  assert.deepEqual(comments.map((op) => op.payload.text), ['hello', 'world']);
});

test('outboxFail backs off then parks after the cap', (t) => {
  const { store } = fixture(t);
  const ticket = seed(store, { trackerId: 'p' });
  store.transition(ticket.id, 'in_progress');
  const [op] = store.outboxDue();
  let result;
  for (let i = 0; i < 19; i += 1) result = store.outboxFail(op.id, new Error('boom'), 1000);
  assert.equal(result.parked, false);
  result = store.outboxFail(op.id, new Error('boom'), 1000);
  assert.equal(result.parked, true);
  assert.equal(store.stats().outboxParked, 1);
  assert.equal(store.outboxDue().length, 0);
});

test('worktree lifecycle records and clears git state', (t) => {
  const { store } = fixture(t);
  const ticket = seed(store, { trackerId: 'p' });
  store.recordWorktree(ticket.id, { repoPath: '/repo', branch: 'ai/p', worktreeDir: '/wt/p', baseSha: 'base1' });
  store.recordImplementation(ticket.id, { headSha: 'head1', changedFiles: ['a.js'], nativeSensitiveFiles: [] });
  let t2 = store.getById(ticket.id);
  assert.equal(t2.branch, 'ai/p');
  assert.equal(t2.headSha, 'head1');
  assert.deepEqual(t2.changedFiles, ['a.js']);
  store.clearWorktree(ticket.id);
  t2 = store.getById(ticket.id);
  assert.equal(t2.worktreeDir, null);
  assert.equal(t2.branch, null);
  assert.equal(t2.headSha, 'head1'); // history preserved
});

test('appendReviewNote accumulates findings without clobbering prior ones', (t) => {
  const { store } = fixture(t);
  const ticket = seed(store, { trackerId: 'p' });
  store.appendReviewNote(ticket.id, { round: 1, reviewer: 'codex', notes: 'missing guard in reapply' });
  store.appendReviewNote(ticket.id, { round: 2, reviewer: 'claude', notes: 'never stamps on first set' });
  const t2 = store.getById(ticket.id);
  assert.equal(t2.reviewHistory.length, 2);
  assert.equal(t2.reviewHistory[0].notes, 'missing guard in reapply');
  assert.equal(t2.reviewHistory[1].notes, 'never stamps on first set');
  assert.equal(t2.reviewHistory[1].reviewer, 'claude');
  assert.ok(t2.reviewHistory[0].at);
});

test('requeue_count only increments for a real do-over (already implemented, leaving a non-queued status)', (t) => {
  const { store } = fixture(t);
  const ticket = seed(store, { trackerId: 'p' });

  // First claim (queued -> in_progress) is not a do-over.
  store.transition(ticket.id, 'in_progress');
  assert.equal(store.getById(ticket.id).requeueCount, 0);

  // A failed attempt with no implementation yet (no head_sha) requeues but is
  // not counted - nothing to lose memory of.
  store.transition(ticket.id, 'queued');
  assert.equal(store.getById(ticket.id).requeueCount, 0);

  // Now it gets implemented, reviewed, and requested-changes: that IS a
  // real do-over (there's an approved-ish head_sha the next attempt discards).
  store.transition(ticket.id, 'in_progress');
  store.recordImplementation(ticket.id, { headSha: 'head1' });
  store.transition(ticket.id, 'queued');
  assert.equal(store.getById(ticket.id).requeueCount, 1);

  // Parked in_review (max rounds) then bounced back to queued again - counts.
  store.transition(ticket.id, 'in_progress');
  store.transition(ticket.id, 'in_review');
  store.transition(ticket.id, 'queued');
  assert.equal(store.getById(ticket.id).requeueCount, 2);
});

test('setMirrorState records hash and stops re-mirroring identical payloads', (t) => {
  const { store } = fixture(t);
  const ticket = seed(store, { trackerId: 'p' });
  store.transition(ticket.id, 'in_progress');
  const [op] = store.outboxDue();
  store.setMirrorState(ticket.id, { mirrorHash: 'h1', mirroredStatus: 'In progress' });
  store.outboxDone(op.id);
  const t2 = store.getById(ticket.id);
  assert.equal(t2.mirrorHash, 'h1');
  assert.equal(t2.mirroredStatus, 'In progress');
  assert.equal(store.outboxDue().length, 0);
});

test('retargetTracker clears remote identity and queues a mirror create', (t) => {
  const { store } = fixture(t);
  const ticket = seed(store, { trackerId: 'legacy-page', shortId: 'abc123abc123' });
  const retargeted = store.retargetTracker(ticket.id, {
    tracker: 'github',
    trackerId: null,
    trackerMeta: { migratedFrom: { tracker: 'github:acme/caligo', trackerId: 'legacy-page' } },
  });
  assert.equal(retargeted.tracker, 'github');
  assert.equal(retargeted.trackerId, null);
  assert.equal(retargeted.trackerMeta.migratedFrom.trackerId, 'legacy-page');
  const ops = store.pendingOutbox(ticket.id);
  assert.equal(ops.filter((op) => op.op === 'mirror').length, 1);
});

test('stacks and repairs round-trip', (t) => {
  const { store } = fixture(t);
  store.saveStack('caligo', { status: 'deployed', baseSha: 'b', compositeSha: 'c', tickets: [{ shortId: 'x' }], fingerprint: 'fp' });
  const stack = store.getStack('caligo');
  assert.equal(stack.status, 'deployed');
  assert.deepEqual(stack.tickets, [{ shortId: 'x' }]);
  store.recordRepair('fp1', { bumpCount: true, status: 'deployed' });
  store.recordRepair('fp1', { bumpCount: true, status: 'open' });
  const repair = store.getRepair('fp1');
  assert.equal(repair.count, 2);
  assert.equal(repair.lastStatus, 'open');
});

test('kv round-trips typed values', (t) => {
  const { store } = fixture(t);
  store.setKv('cursor', { at: '2026-01-01', n: 3 });
  assert.deepEqual(store.getKv('cursor'), { at: '2026-01-01', n: 3 });
  assert.equal(store.getKv('missing', 'fallback'), 'fallback');
  store.deleteKv('cursor');
  assert.equal(store.getKv('cursor'), null);
});

test('migrations are idempotent across reopen', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-store-mig-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const db1 = openDb(baseDir);
  const store1 = createStore({ baseDir, db: db1 });
  seed(store1, { trackerId: 'persist', title: 'Persisted' });
  closeDb(db1);
  const db2 = openDb(baseDir);
  const store2 = createStore({ baseDir, db: db2 });
  assert.equal(store2.getByTrackerId('github:acme/caligo', 'persist').title, 'Persisted');
  assert.equal(db2.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  closeDb(db2);
});

test('createLocalTicket inserts with no trackerId and enqueues a mirror create', (t) => {
  const { store } = fixture(t);
  const mission = seed(store, { trackerId: 'mission-1', kind: 'mission', title: 'Mission' });
  const epic = store.createLocalTicket({
    projectKey: 'caligo', kind: 'epic', title: 'Epic one', body: 'do the thing',
    parentId: mission.id, status: 'in_review', tracker: 'github:acme/caligo',
  });
  assert.equal(epic.trackerId, null);
  assert.equal(epic.tracker, 'github:acme/caligo');
  assert.equal(epic.parentId, mission.id);
  assert.equal(epic.status, 'in_review');
  assert.ok(epic.shortId);
  const ops = store.pendingOutbox(epic.id);
  assert.equal(ops.filter((op) => op.op === 'mirror').length, 1);
});

test('createLocalTicket assigns unique short ids and rejects a missing tracker', (t) => {
  const { store } = fixture(t);
  const a = store.createLocalTicket({ projectKey: 'p', kind: 'epic', title: 'A', tracker: 'github:acme/caligo' });
  const b = store.createLocalTicket({ projectKey: 'p', kind: 'epic', title: 'B', tracker: 'github:acme/caligo' });
  assert.notEqual(a.shortId, b.shortId);
  assert.throws(() => store.createLocalTicket({ projectKey: 'p', kind: 'epic', title: 'C' }), /requires tracker/);
});

test('ticketsByKind and childrenOf walk the hierarchy', (t) => {
  const { store } = fixture(t);
  const mission = seed(store, { trackerId: 'm', kind: 'mission', title: 'Mission' });
  const epic1 = store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Epic 1', parentId: mission.id, tracker: 'github:acme/caligo' });
  store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Epic 2', parentId: mission.id, tracker: 'github:acme/caligo' });
  const feature = store.createLocalTicket({ projectKey: 'caligo', kind: 'feature', title: 'Feature under epic 1', parentId: epic1.id, tracker: 'github:acme/caligo' });

  const epics = store.ticketsByKind('caligo', 'epic');
  assert.equal(epics.length, 2);
  const missionChildren = store.childrenOf(mission.id).map((tk) => tk.title);
  assert.deepEqual(missionChildren.sort(), ['Epic 1', 'Epic 2']);
  const epicChildren = store.childrenOf(epic1.id);
  assert.equal(epicChildren.length, 1);
  assert.equal(epicChildren[0].id, feature.id);
});

test('queued can transition directly to done (epic auto-completion) or cancelled (rejection)', (t) => {
  const { store } = fixture(t);
  const epic = store.createLocalTicket({ projectKey: 'p', kind: 'epic', title: 'Epic', status: 'queued', tracker: 'github:acme/caligo' });
  const done = store.transition(epic.id, 'done');
  assert.equal(done.status, 'done');
  assert.ok(done.closedAt);

  const rejected = store.createLocalTicket({ projectKey: 'p', kind: 'epic', title: 'Rejected epic', status: 'in_review', tracker: 'github:acme/caligo' });
  const cancelled = store.transition(rejected.id, 'cancelled');
  assert.equal(cancelled.status, 'cancelled');
});

test('listArchivable filters by status, closed window, and archived flag', (t) => {
  const { store } = fixture(t);
  const done = seed(store, { trackerId: 'd', title: 'Done' });
  store.transition(done.id, 'done');
  const cancelled = seed(store, { trackerId: 'c', title: 'Cancelled' });
  store.transition(cancelled.id, 'cancelled');
  const failed = seed(store, { trackerId: 'f', title: 'Failed' });
  store.transition(failed.id, 'in_progress');
  store.transition(failed.id, 'failed');
  seed(store, { trackerId: 'o', title: 'Open' }); // stays queued

  const opts = { projectKey: 'caligo', statuses: ['done', 'cancelled'] };
  // Everything closed before the far future qualifies (except failed/open).
  const due = store.listArchivable({ ...opts, before: '2099-01-01T00:00:00Z' });
  assert.deepEqual(due.map((tk) => tk.title).sort(), ['Cancelled', 'Done']);
  // Nothing closed that long ago.
  assert.equal(store.listArchivable({ ...opts, before: '2000-01-01T00:00:00Z' }).length, 0);
  // An already-archived ticket drops out.
  store.archiveTicket(done.id);
  assert.deepEqual(
    store.listArchivable({ ...opts, before: '2099-01-01T00:00:00Z' }).map((tk) => tk.title),
    ['Cancelled']
  );
});

test('archiveTicket flags the ticket and enqueues a durable archive op', (t) => {
  const { store } = fixture(t);
  const done = seed(store, { trackerId: 'd' });
  store.transition(done.id, 'done');
  const archived = store.archiveTicket(done.id);
  assert.equal(archived.meta.archived, true);
  assert.ok(archived.meta.archivedAt);
  assert.equal(store.pendingOutbox(done.id).filter((op) => op.op === 'archive').length, 1);
});

test('reopening an archived ticket clears the archived flag', (t) => {
  const { store } = fixture(t);
  const done = seed(store, { trackerId: 'd' });
  store.transition(done.id, 'done');
  store.archiveTicket(done.id);
  const reopened = store.transition(done.id, 'queued');
  assert.ok(!reopened.meta.archived);
  assert.ok(!reopened.meta.archivedAt);
});

test('exportJsonl is deterministic and sorted by short_id', (t) => {
  const { store, baseDir } = fixture(t);
  seed(store, { trackerId: 'z', shortId: 'zzz000000000', title: 'Z' });
  seed(store, { trackerId: 'a', shortId: 'aaa000000000', title: 'A' });
  const summary = store.exportJsonl();
  assert.equal(summary.tickets, 2);
  const lines = fs.readFileSync(path.join(baseDir, 'state', 'export', 'tickets.jsonl'), 'utf8').trim().split('\n');
  const ids = lines.map((line) => JSON.parse(line).shortId);
  assert.deepEqual(ids, ['aaa000000000', 'zzz000000000']);
  // stable key order: re-export yields byte-identical file
  const first = fs.readFileSync(path.join(baseDir, 'state', 'export', 'tickets.jsonl'), 'utf8');
  store.exportJsonl();
  const second = fs.readFileSync(path.join(baseDir, 'state', 'export', 'tickets.jsonl'), 'utf8');
  assert.equal(first, second);
});
