'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, closeDb } = require('../lib/db');
const { createStore } = require('../lib/store');
const integration = require('../lib/integration');
const runner = require('../runner');

function fixture(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-actions-'));
  const db = openDb(baseDir);
  t.after(() => { closeDb(db); fs.rmSync(baseDir, { recursive: true, force: true }); });
  return { baseDir, store: createStore({ baseDir, db }) };
}

function toTesting(store, id) {
  store.transition(id, 'in_progress');
  store.transition(id, 'testing');
}

function config(baseDir, store, projects = [{ key: 'caligo', app: 'caligo', repoPath: '/repo', tracker: { type: 'github', owner: 'acme', repo: 'caligo' } }]) {
  return { baseDir, store, projects, pollIntervalMs: 5000 };
}

function seedFeature(store, overrides = {}) {
  return store.upsertFromTracker({
    tracker: 'github:acme/caligo',
    trackerId: overrides.trackerId || `issue-${Math.random().toString(16).slice(2)}`,
    projectKey: overrides.projectKey || 'caligo',
    kind: 'feature',
    title: overrides.title || 'Ready work',
    createdAt: overrides.createdAt || '2026-01-01T00:00:00Z',
    ...overrides,
  });
}

function quietServices(extra = {}) {
  return {
    flushOutbox: async () => {},
    pollAndApplyCommands: async () => ({ promotions: [], forceDeploys: [], incubatorApprovals: [], epicMerges: [] }),
    processStoreActions: async () => ({ status: 'ok' }),
    importBugReports: async () => {},
    syncBugReportStatuses: async () => {},
    projectTrackerFacade: () => ({}),
    ...extra,
  };
}

test('tick claims ready work before flywheel, reconciliation, or archive maintenance', async (t) => {
  const { baseDir, store } = fixture(t);
  seedFeature(store, { title: 'Run me now' });
  const calls = [];
  const result = await runner.tick(config(baseDir, store), {
    services: quietServices({
      runTicket: async ({ ticket }) => { calls.push(['runTicket', ticket.title]); return { status: 'ran', shortId: ticket.shortId }; },
      runFlywheelPass: async () => { throw new Error('flywheel should not run before a ready claim'); },
      reconcileBoards: async () => { throw new Error('reconcile should not run before a ready claim'); },
      runArchivePass: async () => { throw new Error('archive should not run before a ready claim'); },
    }),
  });

  assert.equal(result.status, 'ran');
  assert.deepEqual(calls, [['runTicket', 'Run me now']]);
});

test('tick claims a ticket created by the flywheel in the same tick', async (t) => {
  const { baseDir, store } = fixture(t);
  const calls = [];
  const result = await runner.tick(config(baseDir, store), {
    services: quietServices({
      runFlywheelPass: async ({ store: runStore, board }) => {
        calls.push(['flywheel', board.key]);
        runStore.createLocalTicket({
          projectKey: board.key,
          kind: 'feature',
          title: 'Fresh flywheel ticket',
          status: 'queued',
          tracker: 'github:acme/caligo',
        });
        return { status: 'ok', created: 1 };
      },
      runTicket: async ({ ticket }) => { calls.push(['runTicket', ticket.title]); return { status: 'ran', shortId: ticket.shortId }; },
      reconcileBoards: async () => { throw new Error('reconcile should wait until after same-tick flywheel claims'); },
      runArchivePass: async () => { throw new Error('archive should wait until after same-tick flywheel claims'); },
    }),
  });

  assert.equal(result.status, 'ran');
  assert.deepEqual(calls, [['flywheel', 'caligo'], ['runTicket', 'Fresh flywheel ticket']]);
});

test('processStoreActions: moving an epic to Done cascade-merges every Testing ticket under it and closes the epic', async (t) => {
  const { baseDir, store } = fixture(t);
  const epic = store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Signed-off epic', status: 'in_review', tracker: 'github:acme/caligo' });
  store.transition(epic.id, 'in_progress');
  store.transition(epic.id, 'testing');
  const c1 = store.createLocalTicket({ projectKey: 'caligo', kind: 'feature', title: 'C1', parentId: epic.id, status: 'queued', tracker: 'github:acme/caligo' });
  const c2 = store.createLocalTicket({ projectKey: 'caligo', kind: 'feature', title: 'C2', parentId: epic.id, status: 'queued', tracker: 'github:acme/caligo' });
  const straggler = store.createLocalTicket({ projectKey: 'caligo', kind: 'feature', title: 'Still building', parentId: epic.id, status: 'queued', tracker: 'github:acme/caligo' });
  toTesting(store, c1.id);
  toTesting(store, c2.id);
  store.transition(straggler.id, 'in_progress'); // not in Testing yet

  // Stub the real squash with what a successful epic promotion does to the
  // store: mark every Testing child done (the store-backed tracker's
  // mirror(status:'done') path).
  const merged = [];
  const original = integration.promoteEpic;
  integration.promoteEpic = async ({ children }) => {
    const ids = children.map((child) => child.id);
    ids.forEach((id) => { merged.push(id); store.transition(id, 'done'); });
    return { status: 'merged', merged: ids };
  };
  t.after(() => { integration.promoteEpic = original; });

  const actions = { promotions: [], forceDeploys: [], incubatorApprovals: [], epicMerges: [store.getById(epic.id)] };
  const result = await runner.processStoreActions(config(baseDir, store), store, actions, runner.trackerCache());

  assert.equal(result.status, 'ok');
  assert.deepEqual(merged.sort(), [c1.id, c2.id].sort()); // only the two Testing tickets squashed
  assert.equal(store.getById(c1.id).status, 'done');
  assert.equal(store.getById(c2.id).status, 'done');
  assert.equal(store.getById(straggler.id).status, 'in_progress'); // straggler left alone
  assert.equal(store.getById(epic.id).status, 'done'); // epic closed after squash

  const epicComments = store.pendingOutbox(epic.id).filter((op) => op.op === 'comment');
  assert.ok(epicComments.some((op) => /Squashed 2 ticket\(s\)/.test(op.payload.text)));
  assert.ok(epicComments.some((op) => /not in Testing yet/.test(op.payload.text)));
});

test('processStoreActions: a blocked promotion (remote advanced) leaves the epic open to retry next tick', async (t) => {
  const { baseDir, store } = fixture(t);
  const epic = store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Epic', status: 'in_review', tracker: 'github:acme/caligo' });
  store.transition(epic.id, 'in_progress');
  store.transition(epic.id, 'testing');
  const c1 = store.createLocalTicket({ projectKey: 'caligo', kind: 'feature', title: 'C1', parentId: epic.id, status: 'queued', tracker: 'github:acme/caligo' });
  toTesting(store, c1.id);

  const original = integration.promoteEpic;
  integration.promoteEpic = async () => ({ status: 'remote_advanced' });
  t.after(() => { integration.promoteEpic = original; });

  const actions = { promotions: [], forceDeploys: [], incubatorApprovals: [], epicMerges: [store.getById(epic.id)] };
  const result = await runner.processStoreActions(config(baseDir, store), store, actions, runner.trackerCache());

  assert.equal(result.status, 'blocked');
  assert.equal(store.getById(epic.id).status, 'testing'); // not closed; re-fires next poll
  assert.equal(store.getById(c1.id).status, 'testing');
});
