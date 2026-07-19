'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, closeDb } = require('../lib/db');
const { createStore } = require('../lib/store');
const { flushOutbox, buildMirrorPayload, hashPayload, backoffMs } = require('../lib/sync');

function fixture(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-sync-'));
  const db = openDb(baseDir);
  t.after(() => { closeDb(db); fs.rmSync(baseDir, { recursive: true, force: true }); });
  return { baseDir, db, store: createStore({ baseDir, db }) };
}

function seed(store, trackerId = 'p1') {
  return store.upsertFromTracker({ tracker: 'notion', trackerId, projectKey: 'caligo', title: 'T', createdAt: '2026-01-01T00:00:00Z' });
}

// A fake tracker recording calls; upsertMirror/comment can be scripted to fail.
function fakeTracker(script = {}) {
  const calls = { mirror: [], comment: [], section: [] };
  let failMirror = script.failMirror || 0;
  return {
    calls,
    statusToBoard: (s) => `board:${s}`,
    async upsertMirror(ticket, payload) {
      if (failMirror > 0) { failMirror -= 1; throw new Error('mirror boom'); }
      calls.mirror.push({ trackerId: ticket.trackerId, payload });
      return { trackerId: ticket.trackerId };
    },
    async comment(ticket, text) { calls.comment.push({ trackerId: ticket.trackerId, text }); },
    async appendSection(ticket, section) { calls.section.push({ trackerId: ticket.trackerId, section }); },
  };
}

test('buildMirrorPayload carries only runner-owned fields; hash is stable', () => {
  const ticket = { status: 'in_review', attempts: 2, reviewRounds: 1, reviewFeedback: 'fix', lastAgent: 'codex', branch: 'ai/x', title: 'ignored' };
  const payload = buildMirrorPayload(ticket);
  assert.deepEqual(Object.keys(payload).sort(), ['attempts', 'branch', 'lastAgent', 'reviewFeedback', 'reviewRounds', 'status']);
  assert.equal(hashPayload(payload), hashPayload(buildMirrorPayload(ticket)));
});

test('flushOutbox mirrors a transition and records the hash', async (t) => {
  const { store } = fixture(t);
  const ticket = seed(store);
  store.transition(ticket.id, 'in_progress');
  const tracker = fakeTracker();
  const res = await flushOutbox({ store, trackerFor: () => tracker });
  assert.equal(res.done, 1);
  assert.equal(tracker.calls.mirror.length, 1);
  assert.equal(tracker.calls.mirror[0].payload.status, 'in_progress');
  const after = store.getById(ticket.id);
  assert.ok(after.mirrorHash);
  assert.equal(after.mirroredStatus, 'board:in_progress');
  assert.equal(store.outboxDue().length, 0);
});

test('flushOutbox skips a mirror whose payload is unchanged', async (t) => {
  const { store } = fixture(t);
  const ticket = seed(store);
  store.transition(ticket.id, 'in_progress');
  const tracker = fakeTracker();
  await flushOutbox({ store, trackerFor: () => tracker });
  // enqueue another mirror op with identical resulting payload
  store.transition(ticket.id, 'in_progress');
  const res = await flushOutbox({ store, trackerFor: () => tracker });
  assert.equal(res.done, 1); // op consumed
  assert.equal(tracker.calls.mirror.length, 1); // but tracker not called again
});

test('a failed mirror holds later ops for the same ticket (ordering)', async (t) => {
  const { store } = fixture(t);
  const ticket = seed(store);
  store.transition(ticket.id, 'in_progress'); // mirror op
  store.enqueueComment(ticket.id, 'after status'); // comment op, later id
  const tracker = fakeTracker({ failMirror: 1 });
  const res = await flushOutbox({ store, trackerFor: () => tracker });
  assert.equal(res.failed, 1);
  assert.equal(res.skipped, 1); // comment held behind failed mirror
  assert.equal(tracker.calls.comment.length, 0);
  // next pass: mirror succeeds, then the comment flushes in order
  const res2 = await flushOutbox({ store, trackerFor: () => tracker, now: () => new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(tracker.calls.mirror.length, 1);
  assert.equal(tracker.calls.comment.length, 1);
  assert.equal(res2.done, 2);
});

test('backoff grows and caps at one hour', () => {
  assert.equal(backoffMs(0), 30000);
  assert.equal(backoffMs(1), 60000);
  assert.ok(backoffMs(20) <= 60 * 60 * 1000);
});

test('flushOutbox routes an archive op to tracker.archiveItem', async (t) => {
  const { store } = fixture(t);
  const ticket = seed(store);
  store.transition(ticket.id, 'done');
  store.archiveTicket(ticket.id); // enqueues the archive op
  const archived = [];
  const tracker = { ...fakeTracker(), async archiveItem(tk) { archived.push(tk.trackerId); } };
  const res = await flushOutbox({ store, trackerFor: () => tracker });
  assert.ok(res.done >= 1);
  assert.deepEqual(archived, [ticket.trackerId]);
  assert.ok(!store.outboxDue().some((op) => op.op === 'archive'));
});

test('flushOutbox no-ops an archive op when the tracker cannot archive', async (t) => {
  const { store } = fixture(t);
  const ticket = seed(store);
  store.transition(ticket.id, 'done');
  store.archiveTicket(ticket.id);
  const tracker = fakeTracker(); // no archiveItem method
  const res = await flushOutbox({ store, trackerFor: () => tracker });
  assert.equal(res.parked, 0); // completed rather than parked
  assert.ok(!store.outboxDue().some((op) => op.op === 'archive'));
});
