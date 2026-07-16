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

function requestText(port, pathName) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathName }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
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

test('dashboard /api/data includes a token-usage rollup parsed from runs/', async (t) => {
  const { baseDir, db, store } = fixture(t);
  const ticket = seed(store, { trackerId: 'issue-3', shortId: 'tokrun000001', title: 'Token run' });
  const testing = seed(store, { trackerId: 'issue-4', shortId: 'testing00001', title: 'Testing run' });
  store.transition(ticket.id, 'in_progress', { lastAgent: 'codex/gpt-5' });
  store.transition(testing.id, 'in_progress');
  store.transition(testing.id, 'testing');
  closeDb(db);

  const invDir = path.join(baseDir, 'runs', 'tokrun000001-1783000000000', 'feature-0-codex');
  fs.mkdirSync(invDir, { recursive: true });
  fs.writeFileSync(path.join(invDir, 'stderr.log'), 'diff...\ntokens used\n2,500\n');

  const { server } = await startServer({}, { baseDir, port: 0, restart: () => ({ ok: true }) });
  t.after(() => server.close());
  const port = server.address().port;

  const data = await requestJson(port, '/api/data');
  assert.equal(data.status, 200);
  assert.equal(data.body.tokens.available, true);
  assert.equal(data.body.tokens.byProvider.codex.tokens, 2500);
  assert.equal(data.body.tokens.byPhase.implementation.tokens, 2500);
  assert.equal(data.body.store.current.running[0].shortId, 'tokrun000001');
  assert.equal(data.body.store.current.testing[0].shortId, 'testing00001');
  assert.equal(data.body.store.current.inFlight[0].shortId, 'tokrun000001');
  assert.equal(data.body.store.current.projectFlow[0].moving, 2);
  assert.match(data.body.dashboard.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(data.body.dashboard.port, port);
  assert.equal(data.body.dashboard.pid, process.pid);
  assert.ok(data.body.dashboard.codeVersion);
  assert.ok(data.body.dashboard.restartCommand);
  const codexProvider = data.body.providers.find((p) => p.name === 'codex');
  if (codexProvider) assert.equal(codexProvider.tokens, 2500);
});

test('dashboard /api/data surfaces human-wait dependency blockages transitively', async (t) => {
  const { baseDir, db, store } = fixture(t);
  const blocker = seed(store, { trackerId: 'issue-b0', shortId: 'humanblock01', title: 'Needs a human decision' });
  const middle = seed(store, { trackerId: 'issue-b1', shortId: 'middle000001', title: 'Waits on blocker' });
  const leaf = seed(store, { trackerId: 'issue-b2', shortId: 'leaf00000001', title: 'Waits on middle' });
  const inFlightDep = seed(store, { trackerId: 'issue-b3', shortId: 'working00001', title: 'Being worked' });
  const routine = seed(store, { trackerId: 'issue-b4', shortId: 'routine00001', title: 'Waits on in-progress work' });
  const free = seed(store, { trackerId: 'issue-b5', shortId: 'free00000001', title: 'Nothing blocking' });
  store.addDependency(middle.id, blocker.id);
  store.addDependency(leaf.id, middle.id);
  store.addDependency(routine.id, inFlightDep.id);
  store.transition(blocker.id, 'in_progress');
  store.transition(blocker.id, 'needs_info', { reviewFeedback: 'Blocked on credentials' });
  store.transition(inFlightDep.id, 'in_progress');
  closeDb(db);

  const { server } = await startServer({}, { baseDir, port: 0, restart: () => ({ ok: true }) });
  t.after(() => server.close());
  const port = server.address().port;

  const data = await requestJson(port, '/api/data');
  assert.equal(data.status, 200);
  const blockages = data.body.store.blockages;
  // Direct and transitive dependents of the needs_info ticket are blocked...
  assert.deepEqual(blockages.blocked.map((item) => item.shortId).sort(), ['leaf00000001', 'middle000001']);
  assert.deepEqual(blockages.blocked[0].blockedBy, ['humanblock01']);
  // ...and the human-wait root is the single blocker, credited with both.
  assert.equal(blockages.blockers.length, 1);
  assert.equal(blockages.blockers[0].shortId, 'humanblock01');
  assert.equal(blockages.blockers[0].status, 'needs_info');
  assert.equal(blockages.blockers[0].note, 'Blocked on credentials');
  assert.equal(blockages.blockers[0].url, 'https://github.com/acme/widgets/issues/1');
  assert.deepEqual(blockages.blockers[0].blocks.sort(), ['leaf00000001', 'middle000001']);
  // A dependency that is merely in progress is routine flow, not a blockage.
  assert.equal(blockages.blocked.some((item) => item.shortId === 'routine00001'), false);
  // The queued list marks stalled tickets so "Up next" does not oversell them.
  const queuedFlags = Object.fromEntries(data.body.store.current.queued.map((item) => [item.shortId, item.blocked]));
  assert.equal(queuedFlags.middle000001, true);
  assert.equal(queuedFlags.leaf00000001, true);
  assert.equal(queuedFlags.routine00001, false);
  assert.equal(queuedFlags.free00000001, false);
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
    logReader: (serviceId, options) => ({
      service: { id: serviceId, label: 'Ticket runner', unit: 'ticket-runner.service' },
      generatedAt: '2026-07-14T10:00:00.000Z',
      lines: [`${serviceId} tail ${options.lines}`],
    }),
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

  const logs = await requestJson(port, '/api/logs/ticket-runner?lines=100');
  assert.equal(logs.status, 200);
  assert.deepEqual(logs.body.lines, ['ticket-runner tail 100']);
});

test('dashboard exposes bounded task log tails for the newest run directory', async (t) => {
  const { baseDir, db, store } = fixture(t);
  const ticket = seed(store, { trackerId: 'issue-5', shortId: 'ticket000005', title: 'Running ticket' });
  const logless = seed(store, { trackerId: 'issue-6', shortId: 'ticket000006', title: 'Logless ticket' });
  store.transition(ticket.id, 'in_progress');
  store.transition(logless.id, 'in_progress');
  closeDb(db);

  const oldDir = path.join(baseDir, 'runs', 'ticket000005-1783000000000', 'impl-0-codex');
  const newDir = path.join(baseDir, 'runs', 'ticket000005-review-1783000100000', 'review-0-claude');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'stdout.log'), 'old stdout\n');
  fs.writeFileSync(path.join(newDir, 'stdout.log'), 'first stdout\nsecond stdout\n');
  fs.writeFileSync(path.join(newDir, 'stderr.log'), 'first stderr\nsecond stderr\n');

  const { server } = await startServer({}, { baseDir, port: 0, restart: () => ({ ok: true }) });
  t.after(() => server.close());
  const port = server.address().port;

  const logs = await requestJson(port, '/api/task-logs/ticket000005?lines=20');
  assert.equal(logs.status, 200);
  assert.equal(logs.body.ticket.shortId, 'ticket000005');
  assert.equal(logs.body.run.name, 'ticket000005-review-1783000100000');
  assert.equal(logs.body.invocations[0].tag, 'review-0-claude');
  assert.deepEqual(logs.body.invocations[0].stderrLines, ['first stderr', 'second stderr']);
  assert.deepEqual(logs.body.invocations[0].stdoutLines, ['first stdout', 'second stdout']);

  const empty = await requestJson(port, '/api/task-logs/ticket000006');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.ticket.shortId, 'ticket000006');
  assert.equal(empty.body.run, null);
  assert.deepEqual(empty.body.invocations, []);

  const unknown = await requestJson(port, '/api/task-logs/not-a-ticket');
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.ticket, null);
  assert.equal(unknown.body.run, null);
  assert.deepEqual(unknown.body.invocations, []);
});

test('dashboard shows a clear failure page when React build is missing', async (t) => {
  const { baseDir, db } = fixture(t);
  closeDb(db);

  const { server } = await startServer({}, { baseDir, port: 0, restart: () => ({ ok: true }) });
  t.after(() => server.close());
  const port = server.address().port;

  const page = await requestText(port, '/');
  assert.equal(page.status, 503);
  assert.match(page.body, /Dashboard build unavailable/);
  assert.match(page.body, /npm run dashboard:build/);
});
