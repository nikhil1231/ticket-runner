'use strict';

const fs = require('fs');
const path = require('path');

function canonicalStatus(value, fallback = 'queued') {
  const text = String(value || '').toLowerCase().trim();
  const map = {
    'not started': 'queued',
    backlog: 'queued',
    queued: 'queued',
    'in progress': 'in_progress',
    in_progress: 'in_progress',
    'needs info': 'needs_info',
    needs_info: 'needs_info',
    'in review': 'in_review',
    in_review: 'in_review',
    testing: 'testing',
    done: 'done',
    failed: 'failed',
    cancelled: 'cancelled',
  };
  return map[text] || fallback;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function markImported(file) {
  const target = `${file}.imported`;
  if (fs.existsSync(target)) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.renameSync(file, target);
}

function importWorktreeMeta({ store, baseDir }) {
  const dir = path.join(baseDir, 'worktrees');
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.imported')) continue;
    const file = path.join(dir, entry.name);
    const meta = readJson(file);
    if (!meta?.pageId) continue;
    const shortId = meta.shortId || path.basename(entry.name, '.json');
    const projectKey = meta.projectKey || meta.app || 'unknown';
    const status = canonicalStatus(meta.status, meta.headSha ? 'testing' : 'in_review');
    const ticket = store.upsertFromTracker({
      tracker: meta.tracker || 'legacy',
      trackerId: meta.pageId,
      projectKey,
      kind: meta.kind || 'feature',
      title: meta.title || '(untitled)',
      shortId,
      createdAt: meta.createdTime || meta.createdAt || new Date().toISOString(),
      trackerMeta: { url: meta.url || '' },
      status,
    });
    store.recordWorktree(ticket.id, {
      repoPath: meta.repoPath || null,
      branch: meta.branch || null,
      worktreeDir: meta.dir || meta.worktreeDir || null,
      baseSha: meta.baseSha || null,
    });
    if (meta.headSha || meta.changedFiles || meta.nativeSensitiveFiles) {
      store.recordImplementation(ticket.id, {
        headSha: meta.headSha || null,
        changedFiles: meta.changedFiles || [],
        nativeSensitiveFiles: meta.nativeSensitiveFiles || [],
        implementedAt: meta.implementedAt || null,
      });
    }
    if (meta.processedCommentIds) store.markCommentsProcessed(ticket.id, meta.processedCommentIds);
    if (meta.pendingCommentIds) store.setPendingComments(ticket.id, meta.pendingCommentIds);
    markImported(file);
    count += 1;
  }
  return count;
}

function importStackState({ store, baseDir }) {
  const dir = path.join(baseDir, 'state');
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^integration-.+\.json$/.test(entry.name) || entry.name.endsWith('.imported')) continue;
    const file = path.join(dir, entry.name);
    const record = readJson(file);
    if (!record) continue;
    const key = record.projectKey || record.app || entry.name.replace(/^integration-/, '').replace(/\.json$/, '');
    store.saveStack(key, record);
    markImported(file);
    count += 1;
  }
  return count;
}

function importRepairs({ store, baseDir }) {
  const file = path.join(baseDir, 'state', 'repairs.json');
  if (!fs.existsSync(file)) return 0;
  const ledger = readJson(file);
  if (!ledger || typeof ledger !== 'object') return 0;
  let count = 0;
  for (const [fingerprint, record] of Object.entries(ledger)) {
    store.recordRepair(fingerprint, {
      count: record.attempts || record.count || 0,
      status: record.status || record.lastStatus || null,
      meta: record,
    });
    count += 1;
  }
  markImported(file);
  return count;
}

function importLegacyState({ store, baseDir, log = () => {} }) {
  if (store.getKv('legacy-import:v1', false)) return { skipped: true };
  const result = {
    worktrees: importWorktreeMeta({ store, baseDir }),
    stacks: importStackState({ store, baseDir }),
    repairs: importRepairs({ store, baseDir }),
  };
  store.setKv('legacy-import:v1', { ...result, importedAt: new Date().toISOString() });
  const total = result.worktrees + result.stacks + result.repairs;
  if (total) log(`imported legacy state: ${result.worktrees} worktree, ${result.stacks} stack, ${result.repairs} repair record(s)`);
  return result;
}

module.exports = { importLegacyState, canonicalStatus };
