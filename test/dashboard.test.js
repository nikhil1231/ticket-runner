'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { openDb, closeDb } = require('../lib/db');
const { createStore } = require('../lib/store');
const { collectTicketDetails, startServer } = require('../lib/dashboard');

function fixture(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-dashboard-'));
  const db = openDb(baseDir);
  t.after(() => {
    closeDb(db);
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
  return { baseDir, db, store: createStore({ baseDir, db }) };
}

function seed(store, overrides = {}) {
  return store.upsertFromTracker({
    tracker: 'github',
    trackerId: overrides.trackerId || `issue-${Math.random().toString(16).slice(2)}`,
    trackerMeta: { url: 'https://github.com/acme/widgets/issues/1' },
    projectKey: 'widgets',
    kind: 'feature',
    title: 'Improve dashboard',
    createdAt: '2026-01-01T00:00:00Z',
    shortId: overrides.shortId,
    ...overrides,
  });
}

function requestJson(port, pathName, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathName, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('dashboard ticket details include local state around the ticket', (t) => {
  const { baseDir, db, store } = fixture(t);
  const blocker = seed(store, { trackerId: 'issue-0', shortId: 'blocker000001', title: 'Blocking task' });
  const ticket = seed(store, { trackerId: 'issue-1', shortId: 'ticket000001' });
  store.refreshIntent(ticket.id, { body: 'Detailed acceptance notes' });
  store.addDependency(ticket.id, blocker.id);
  store.transition(ticket.id, 'in_progress', { lastAgent: 'codex/gpt-5' });
  store.recordWorktree(ticket.id, { repoPath: 'C:/repo/widgets', branch: 'ticket/ticket000001', worktreeDir: 'C:/tmp/worktree', baseSha: 'a'.repeat(40) });
  store.recordImplementation(ticket.id, { headSha: 'b'.repeat(40), changedFiles: ['lib/dashboard.js'] });
  store.enqueueComment(ticket.id, 'Queued sync comment');
  closeDb(db);

  const details = collectTicketDetails(baseDir, 'ticket000001');
  assert.equal(details.ticket.title, 'Improve dashboard');
  assert.equal(details.ticket.body, 'Detailed acceptance notes');
  assert.equal(details.ticket.lastAgent, 'codex/gpt-5');
  assert.deepEqual(details.ticket.changedFiles, ['lib/dashboard.js']);
  assert.equal(details.dependencies[0].shortId, 'blocker000001');
  assert.equal(details.outbox.some((op) => op.op === 'comment'), true);
  assert.equal(details.events.some((event) => event.type === 'transition'), true);
});

test('dashboard exposes ticket details and restart action endpoints', async (t) => {
  const { baseDir, db, store } = fixture(t);
  seed(store, { trackerId: 'issue-2', shortId: 'ticket000002', title: 'Clickable ticket' });
  closeDb(db);

  let restarted = false;
  const { server } = await startServer({}, {
    baseDir,
    port: 0,
    restart: () => {
      restarted = true;
      return { ok: true, command: 'fake restart' };
    },
  });
  t.after(() => server.close());
  const port = server.address().port;

  const details = await requestJson(port, '/api/tickets/ticket000002');
  assert.equal(details.status, 200);
  assert.equal(details.body.ticket.title, 'Clickable ticket');

  const restart = await requestJson(port, '/api/restart', { method: 'POST' });
  assert.equal(restart.status, 202);
  assert.equal(restart.body.ok, true);
  assert.equal(restarted, true);
});
