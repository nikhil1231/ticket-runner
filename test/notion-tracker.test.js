'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, closeDb } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createNotionTracker } = require('../lib/trackers/notion');

function fixture(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-notion-'));
  const db = openDb(baseDir);
  t.after(() => { closeDb(db); fs.rmSync(baseDir, { recursive: true, force: true }); });
  return { store: createStore({ baseDir, db }) };
}

function page({ id, title, status, kind, tags = [], createdTime = '2026-01-01T00:00:00Z' }) {
  const properties = {
    Name: { title: [{ plain_text: title }] },
    Status: { status: { name: status } },
  };
  if (kind) properties.Kind = { select: { name: kind } };
  if (tags.length) properties.Tags = { multi_select: tags.map((name) => ({ name })) };
  return { id, url: `https://notion.so/${id}`, created_time: createdTime, properties };
}

function fakeTransport() {
  const calls = [];
  let nextId = 1;
  return {
    calls,
    createPage: async (databaseId, properties) => {
      const id = `page-${nextId++}`;
      calls.push(['createPage', databaseId, properties]);
      return { id, url: `https://notion.so/${id}` };
    },
    updatePage: async (id, properties) => { calls.push(['updatePage', id, properties]); },
    updatePageMarkdown: async (id, command) => { calls.push(['updatePageMarkdown', id, command]); },
    queryDatabase: async () => [],
  };
}

test('upsertMirror creates a page when the ticket has no trackerId, sets Kind, and appends the body', async () => {
  const transport = fakeTransport();
  const tracker = createNotionTracker({ transport, databaseId: 'db-1' });
  const result = await tracker.upsertMirror(
    { title: 'Epic one', body: 'Scope and goals', kind: 'epic', trackerMeta: {} },
    { status: 'in_review' },
  );
  assert.equal(result.trackerId, 'page-1');
  assert.equal(result.trackerMeta.databaseId, 'db-1');
  const create = transport.calls.find((call) => call[0] === 'createPage');
  assert.equal(create[1], 'db-1');
  assert.equal(create[2].Name.title[0].text.content, 'Epic one');
  assert.equal(create[2].Kind.select.name, 'epic');
  assert.equal(create[2]['For AI'].checkbox, true);
  assert.equal(create[2].Status.status.name, 'In review');
  const append = transport.calls.find((call) => call[0] === 'updatePageMarkdown');
  assert.equal(append[1], 'page-1');
  assert.equal(append[2].insert_content.content, 'Scope and goals');
});

test('upsertMirror uses ticket.trackerMeta.databaseId over the tracker default database', async () => {
  const transport = fakeTransport();
  const tracker = createNotionTracker({ transport, databaseId: 'db-default' });
  await tracker.upsertMirror({ title: 'Feature', kind: 'feature', trackerMeta: { databaseId: 'db-target' } }, { status: 'queued' });
  const create = transport.calls.find((call) => call[0] === 'createPage');
  assert.equal(create[1], 'db-target');
});

test('upsertMirror updates in place when the ticket already has a page', async () => {
  const transport = fakeTransport();
  const tracker = createNotionTracker({ transport, databaseId: 'db-1' });
  const result = await tracker.upsertMirror({ trackerId: 'page-existing', title: 'Feature' }, { status: 'testing' });
  assert.equal(result.trackerId, 'page-existing');
  assert.equal(transport.calls.filter((call) => call[0] === 'createPage').length, 0);
  const update = transport.calls.find((call) => call[0] === 'updatePage');
  assert.equal(update[1], 'page-existing');
  assert.equal(update[2].Status.status.name, 'Testing');
});

test('pollCommands prefers a page-level Kind property over the polled default', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  transport.queryDatabase = async (databaseId, filter) => {
    const isQueueFilter = filter?.and?.some((clause) => clause.or?.some((inner) => inner.status?.equals === 'Not started'));
    if (isQueueFilter) return [page({ id: 'epic-page', title: 'Epic one', status: 'Not started', kind: 'epic' })];
    return [];
  };
  const tracker = createNotionTracker({ transport, databaseId: 'db-1' });
  const commands = await tracker.pollCommands({ store, projectKey: 'caligo', kind: 'feature' });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'create');
  assert.equal(commands[0].snapshot.kind, 'epic');
});

test('pollCommands carries Notion page tags into tracker metadata', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  transport.queryDatabase = async (databaseId, filter) => {
    const isQueueFilter = filter?.and?.some((clause) => clause.or?.some((inner) => inner.status?.equals === 'Not started'));
    if (isQueueFilter) return [page({ id: 'mission-page', title: 'Mission', status: 'Not started', kind: 'mission', tags: ['Perpetual'] })];
    return [];
  };
  const tracker = createNotionTracker({ transport, databaseId: 'db-1' });
  const commands = await tracker.pollCommands({ store, projectKey: 'caligo', kind: 'feature' });
  assert.deepEqual(commands[0].snapshot.trackerMeta.tags, ['Perpetual']);
});

test('pollCommands emits cancel for an open ticket moved to Cancelled', async (t) => {
  const { store } = fixture(t);
  const existing = store.upsertFromTracker({ tracker: 'notion', trackerId: 'epic-page', projectKey: 'caligo', kind: 'epic', title: 'Epic one', status: 'in_review' });
  const transport = fakeTransport();
  transport.queryDatabase = async (databaseId, filter) => {
    if (filter?.property === 'Status' && filter.status?.equals === 'Cancelled') {
      return [page({ id: 'epic-page', title: 'Epic one', status: 'Cancelled', kind: 'epic' })];
    }
    return [];
  };
  const tracker = createNotionTracker({ transport, databaseId: 'db-1' });
  const commands = await tracker.pollCommands({ store, projectKey: 'caligo', kind: 'feature' });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'cancel');
  assert.equal(commands[0].ticket.id, existing.id);
});
