'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, closeDb } = require('../lib/db');
const { createStore } = require('../lib/store');
const { applyTrackerCommands } = require('../lib/cutover');

function fixture(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-'));
  const db = openDb(baseDir);
  t.after(() => { closeDb(db); fs.rmSync(baseDir, { recursive: true, force: true }); });
  return { store: createStore({ baseDir, db }) };
}

function seedEpic(store, status) {
  const epic = store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Epic', status: 'in_review', tracker: 'github:acme/caligo' });
  store.transition(epic.id, 'in_progress');
  if (status === 'testing') store.transition(epic.id, 'testing');
  return store.getById(epic.id);
}

test('authorize_epic_merge collects the epic for cascade processing without transitioning it', (t) => {
  const { store } = fixture(t);
  const epic = seedEpic(store, 'testing');
  const actions = applyTrackerCommands({ store, commands: [{ type: 'authorize_epic_merge', ticket: epic, snapshot: {} }] });
  assert.equal(actions.epicMerges.length, 1);
  assert.equal(actions.epicMerges[0].id, epic.id);
  assert.equal(store.getById(epic.id).status, 'testing'); // runner closes it after merging children
});

test('resume_epic moves an epic parked in Testing back to In progress', (t) => {
  const { store } = fixture(t);
  const epic = seedEpic(store, 'testing');
  applyTrackerCommands({ store, commands: [{ type: 'resume_epic', ticket: epic, snapshot: {} }] });
  assert.equal(store.getById(epic.id).status, 'in_progress');
});

test('resume_epic is a no-op when the epic is not in Testing', (t) => {
  const { store } = fixture(t);
  const epic = seedEpic(store, 'in_progress');
  applyTrackerCommands({ store, commands: [{ type: 'resume_epic', ticket: epic, snapshot: {} }] });
  assert.equal(store.getById(epic.id).status, 'in_progress');
});
