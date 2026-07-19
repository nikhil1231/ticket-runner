'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, closeDb } = require('../lib/db');
const { createStore } = require('../lib/store');
const { runArchivePass, archiveSettings, ARCHIVE_DEFAULTS } = require('../lib/archive');

const DAY = 24 * 60 * 60 * 1000;

// A store whose clock we control, so we can create tickets that closed long ago.
function fixture(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-archive-'));
  const db = openDb(baseDir);
  t.after(() => { closeDb(db); fs.rmSync(baseDir, { recursive: true, force: true }); });
  const clock = { ms: Date.parse('2026-07-01T00:00:00Z') };
  const store = createStore({ baseDir, db, now: () => new Date(clock.ms).toISOString() });
  return { store, clock };
}

function seedClosed(store, { trackerId, status, projectKey = 'widgets' }) {
  const ticket = store.upsertFromTracker({
    tracker: 'github:acme/widgets', trackerId, projectKey, title: `T${trackerId}`,
    createdAt: '2026-01-01T00:00:00Z', trackerMeta: { projectItemId: `ITEM_${trackerId}` },
  });
  if (status === 'failed') store.transition(ticket.id, 'in_progress'); // queued -> failed is illegal
  store.transition(ticket.id, status); // stamps closed_at at the store's current clock
  return store.getById(ticket.id);
}

const githubBoard = { key: 'widgets', tracker: { type: 'github', owner: 'acme', repo: 'widgets' } };

test('archives done/cancelled tickets closed for over a day, leaving recent and failed', async (t) => {
  const { store, clock } = fixture(t);
  const oldDone = seedClosed(store, { trackerId: '1', status: 'done' });
  const oldCancelled = seedClosed(store, { trackerId: '2', status: 'cancelled' });
  const oldFailed = seedClosed(store, { trackerId: '3', status: 'failed' });

  // Advance two days: the above are now "closed for over a day".
  clock.ms += 2 * DAY;
  const recentDone = seedClosed(store, { trackerId: '4', status: 'done' }); // just closed

  const result = await runArchivePass({ config: {}, board: githubBoard, store, now: () => clock.ms });
  assert.equal(result.status, 'ok');
  assert.equal(result.archived, 2);

  assert.equal(store.getById(oldDone.id).meta.archived, true);
  assert.equal(store.getById(oldCancelled.id).meta.archived, true);
  assert.ok(!store.getById(oldFailed.id).meta.archived, 'failed stays on the board');
  assert.ok(!store.getById(recentDone.id).meta.archived, 'recently-closed stays on the board');

  // Each archived ticket enqueued exactly one durable archive op.
  assert.equal(store.pendingOutbox(oldDone.id).filter((op) => op.op === 'archive').length, 1);
  assert.equal(store.pendingOutbox(oldCancelled.id).filter((op) => op.op === 'archive').length, 1);
});

test('is idempotent: a second pass archives nothing new', async (t) => {
  const { store, clock } = fixture(t);
  seedClosed(store, { trackerId: '1', status: 'done' });
  clock.ms += 2 * DAY;

  const first = await runArchivePass({ config: {}, board: githubBoard, store, now: () => clock.ms });
  assert.equal(first.archived, 1);
  const second = await runArchivePass({ config: {}, board: githubBoard, store, now: () => clock.ms });
  assert.equal(second.archived, 0);
});

test('skips non-github trackers', async (t) => {
  const { store, clock } = fixture(t);
  const ticket = store.upsertFromTracker({
    tracker: 'notion', trackerId: 'p1', projectKey: 'caligo', title: 'T', createdAt: '2026-01-01T00:00:00Z',
  });
  store.transition(ticket.id, 'done');
  clock.ms += 2 * DAY;

  const board = { key: 'caligo', tracker: { type: 'notion' } };
  const result = await runArchivePass({ config: {}, board, store });
  assert.equal(result.status, 'unsupported_tracker');
  assert.ok(!store.getById(ticket.id).meta.archived);
});

test('respects enabled:false via config or per-project override', async (t) => {
  const { store, clock } = fixture(t);
  seedClosed(store, { trackerId: '1', status: 'done' });
  clock.ms += 2 * DAY;

  const off = await runArchivePass({ config: { archive: { enabled: false } }, board: githubBoard, store });
  assert.equal(off.status, 'disabled');

  const boardOff = { ...githubBoard, archive: { enabled: false } };
  const off2 = await runArchivePass({ config: {}, board: boardOff, store });
  assert.equal(off2.status, 'disabled');
});

test('closedForMs is configurable and merges config < board', () => {
  assert.equal(archiveSettings({}, {}).closedForMs, ARCHIVE_DEFAULTS.closedForMs);
  assert.equal(archiveSettings({ archive: { closedForMs: 5 } }, {}).closedForMs, 5);
  assert.equal(archiveSettings({ archive: { closedForMs: 5 } }, { archive: { closedForMs: 9 } }).closedForMs, 9);
});

test('a shorter window archives tickets closed more recently', async (t) => {
  const { store, clock } = fixture(t);
  seedClosed(store, { trackerId: '1', status: 'done' });
  clock.ms += 2 * 60 * 60 * 1000; // 2 hours later

  const board = { ...githubBoard, archive: { closedForMs: 60 * 60 * 1000 } }; // 1 hour
  const result = await runArchivePass({ config: {}, board, store, now: () => clock.ms });
  assert.equal(result.archived, 1);
});
