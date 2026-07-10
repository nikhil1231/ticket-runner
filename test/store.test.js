'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, closeDb } = require('../lib/db');
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
    tracker: 'notion',
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
  assert.equal(derived.shortId, deriveShortId('notion', 'p3'));
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
  assert.throws(() => store.transition(ticket.id, 'done'), /illegal transition queued -> done/);
  store.transition(ticket.id, 'in_progress');
  assert.throws(() => store.transition(ticket.id, 'done'), /illegal transition in_progress -> done/);
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

test('ready query honors dependency chains', (t) => {
  const { store } = fixture(t);
  const a = seed(store, { trackerId: 'a', title: 'A', createdAt: '2026-01-01T00:00:00Z' });
  const b = seed(store, { trackerId: 'b', title: 'B', createdAt: '2026-01-02T00:00:00Z' });
  store.addDependency(b.id, a.id);
  // B is blocked by A; only A is ready
  let ready = store.readyTickets().map((tk) => tk.title);
  assert.deepEqual(ready, ['A']);
  // finishing A unblocks B
  store.transition(a.id, 'in_progress');
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
  assert.equal(store2.getByTrackerId('notion', 'persist').title, 'Persisted');
  assert.equal(db2.prepare('PRAGMA user_version').get().user_version, 1);
  closeDb(db2);
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
