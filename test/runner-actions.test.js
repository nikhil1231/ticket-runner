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

function config(baseDir, store) {
  return {
    baseDir,
    store,
    projects: [{ key: 'caligo', app: 'caligo', repoPath: '/repo', tracker: { type: 'github', owner: 'acme', repo: 'caligo' } }],
  };
}

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

  // Stub the real merge with what a successful promotion does to the store: mark
  // the ticket done (the store-backed tracker's mirror(status:'done') path).
  const merged = [];
  const original = integration.promoteTicket;
  integration.promoteTicket = async ({ ticket }) => { merged.push(ticket.id); store.transition(ticket.id, 'done'); return { status: 'merged' }; };
  t.after(() => { integration.promoteTicket = original; });

  const actions = { promotions: [], forceDeploys: [], incubatorApprovals: [], epicMerges: [store.getById(epic.id)] };
  const result = await runner.processStoreActions(config(baseDir, store), store, actions, runner.trackerCache());

  assert.equal(result.status, 'ok');
  assert.deepEqual(merged.sort(), [c1.id, c2.id].sort()); // only the two Testing tickets merged
  assert.equal(store.getById(c1.id).status, 'done');
  assert.equal(store.getById(c2.id).status, 'done');
  assert.equal(store.getById(straggler.id).status, 'in_progress'); // straggler left alone
  assert.equal(store.getById(epic.id).status, 'done'); // epic closed after cascade

  const epicComments = store.pendingOutbox(epic.id).filter((op) => op.op === 'comment');
  assert.ok(epicComments.some((op) => /Merged 2 ticket\(s\)/.test(op.payload.text)));
  assert.ok(epicComments.some((op) => /not in Testing yet/.test(op.payload.text)));
});

test('processStoreActions: a blocked promotion (remote advanced) leaves the epic open to retry next tick', async (t) => {
  const { baseDir, store } = fixture(t);
  const epic = store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Epic', status: 'in_review', tracker: 'github:acme/caligo' });
  store.transition(epic.id, 'in_progress');
  store.transition(epic.id, 'testing');
  const c1 = store.createLocalTicket({ projectKey: 'caligo', kind: 'feature', title: 'C1', parentId: epic.id, status: 'queued', tracker: 'github:acme/caligo' });
  toTesting(store, c1.id);

  const original = integration.promoteTicket;
  integration.promoteTicket = async () => ({ status: 'remote_advanced' });
  t.after(() => { integration.promoteTicket = original; });

  const actions = { promotions: [], forceDeploys: [], incubatorApprovals: [], epicMerges: [store.getById(epic.id)] };
  const result = await runner.processStoreActions(config(baseDir, store), store, actions, runner.trackerCache());

  assert.equal(result.status, 'blocked');
  assert.equal(store.getById(epic.id).status, 'testing'); // not closed; re-fires next poll
  assert.equal(store.getById(c1.id).status, 'testing');
});
