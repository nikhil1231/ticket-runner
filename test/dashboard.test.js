'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { openDb, closeDb } = require('../lib/db');
const { createStore } = require('../lib/store');
const { collectTicketDetails, startServer, summarizeTranscript } = require('../lib/dashboard');

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
  const mission = store.createLocalTicket({ projectKey: 'widgets', kind: 'mission', title: 'Mission one', status: 'queued', tracker: 'github' });
  const epic = store.createLocalTicket({ projectKey: 'widgets', kind: 'epic', title: 'Epic one', parentId: mission.id, status: 'queued', tracker: 'github' });
  store.transition(mission.id, 'in_progress');
  store.transition(epic.id, 'in_progress');
  store.setParent(ticket.id, epic.id);
  store.transition(ticket.id, 'in_progress', { lastAgent: 'codex/gpt-5' });
  store.transition(testing.id, 'in_progress');
  store.transition(testing.id, 'testing');
  closeDb(db);

  const invDir = path.join(baseDir, 'runs', 'tokrun000001-1783000000000', 'feature-0-codex');
  fs.mkdirSync(invDir, { recursive: true });
  fs.writeFileSync(path.join(invDir, 'stderr.log'), 'diff...\ntokens used\n2,500\n');

  const { server } = await startServer({
    projects: [{
      key: 'widgets',
      repoPath: '.',
      tracker: { type: 'github', owner: 'acme', repo: 'widgets' },
      flywheel: { enabled: true, continuous: true, maxEpics: 3 },
    }],
  }, { baseDir, port: 0, restart: () => ({ ok: true }) });
  t.after(() => server.close());
  const port = server.address().port;

  const data = await requestJson(port, '/api/data');
  assert.equal(data.status, 200);
  assert.equal(data.body.tokens.available, true);
  assert.equal(data.body.tokens.byProvider.codex.tokens, 2500);
  assert.equal(data.body.tokens.byPhase.implementation.tokens, 2500);
  assert.equal(data.body.store.current.running[0].shortId, 'tokrun000001');
  assert.equal(data.body.store.current.running.some((item) => item.kind === 'mission' || item.kind === 'epic'), false);
  assert.equal(data.body.store.current.running[0].epic.shortId, epic.shortId);
  assert.equal(data.body.store.current.running[0].mission.shortId, mission.shortId);
  assert.equal(data.body.store.current.testing[0].shortId, 'testing00001');
  assert.equal(data.body.store.current.inFlight[0].shortId, 'tokrun000001');
  assert.equal(data.body.store.current.projectFlow[0].moving, 4);
  assert.equal(data.body.store.projectFlowByProject.widgets.moving, 4);
  assert.equal(data.body.store.projectStructure.widgets.missions[0].shortId, mission.shortId);
  assert.equal(data.body.store.projectStructure.widgets.epics[0].shortId, epic.shortId);
  const project = data.body.projects.find((item) => item.key === 'widgets');
  assert.equal(project.flywheelEnabled, true);
  assert.equal(project.flywheelContinuous, true);
  assert.equal(project.flywheelMaxEpics, 3);
  assert.match(data.body.dashboard.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(data.body.dashboard.port, port);
  assert.equal(data.body.dashboard.pid, process.pid);
  assert.ok(data.body.dashboard.codeVersion);
  assert.ok(data.body.dashboard.restartCommand);
  const codexProvider = data.body.providers.find((p) => p.name === 'codex');
  if (codexProvider) assert.equal(codexProvider.tokens, 2500);
});

test('dashboard hides tickets whose tracker issue was deleted remotely', async (t) => {
  const { baseDir, db, store } = fixture(t);
  const visible = seed(store, { trackerId: 'issue-live', shortId: 'visible000001', title: 'Visible work' });
  const deleted = seed(store, { trackerId: 'issue-gone', shortId: 'deleted00001', title: 'Deleted issue' });
  store.transition(visible.id, 'in_progress');
  store.markRemoteMissing(deleted.id, { trackerId: 'issue-gone' });
  closeDb(db);

  const { server } = await startServer({}, { baseDir, port: 0, restart: () => ({ ok: true }) });
  t.after(() => server.close());
  const port = server.address().port;

  const data = await requestJson(port, '/api/data');
  assert.equal(data.status, 200);
  assert.equal(data.body.store.totals.tickets, 1);
  assert.equal(data.body.store.byStatus.cancelled, undefined);
  assert.equal(data.body.store.projectStatus.widgets.cancelled, undefined);
  assert.equal(data.body.store.current.running[0].shortId, 'visible000001');
  assert.equal(data.body.store.activity.some((item) => item.shortId === 'deleted00001'), false);
  assert.equal(collectTicketDetails(baseDir, 'deleted00001'), null);
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
  store.enqueueComment(blocker.id, 'Set up the OAuth app first');
  store.enqueueComment(blocker.id, 'Waiting on the client secret to land in .env');
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
  assert.equal(blockages.blockers[0].lastComment, 'Waiting on the client secret to land in .env');
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

test('dashboard /api/data lists needs_info tickets with the latest tracker comment', async (t) => {
  const { baseDir, db, store } = fixture(t);
  const parked = seed(store, { trackerId: 'issue-n0', shortId: 'parked000001', title: 'Ambiguous requirements' });
  const commentless = seed(store, { trackerId: 'issue-n1', shortId: 'parked000002', title: 'Parked without comment' });
  const healthy = seed(store, { trackerId: 'issue-n2', shortId: 'healthy00001', title: 'Just queued' });
  store.transition(parked.id, 'in_progress');
  store.transition(parked.id, 'needs_info');
  store.enqueueComment(parked.id, 'Implemented (codex) - awaiting review.');
  store.enqueueComment(parked.id, 'NEEDS_INFO: which currency should totals use?');
  store.transition(commentless.id, 'in_progress');
  store.transition(commentless.id, 'needs_info', { reviewFeedback: 'Reviewer wants a decision on schema shape' });
  closeDb(db);

  const { server } = await startServer({}, { baseDir, port: 0, restart: () => ({ ok: true }) });
  t.after(() => server.close());
  const port = server.address().port;

  const data = await requestJson(port, '/api/data');
  assert.equal(data.status, 200);
  const needsInfo = data.body.store.needsInfo;
  assert.deepEqual(needsInfo.map((item) => item.shortId).sort(), ['parked000001', 'parked000002']);
  const withComment = needsInfo.find((item) => item.shortId === 'parked000001');
  // The newest outbox comment is the latest comment on the tracker issue.
  assert.equal(withComment.lastComment, 'NEEDS_INFO: which currency should totals use?');
  assert.equal(withComment.url, 'https://github.com/acme/widgets/issues/1');
  const withFeedback = needsInfo.find((item) => item.shortId === 'parked000002');
  assert.equal(withFeedback.lastComment, '');
  assert.equal(withFeedback.note, 'Reviewer wants a decision on schema shape');
  assert.equal(needsInfo.some((item) => item.shortId === 'healthy00001'), false);
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

test('summarizeTranscript collapses codex tool-call and patch noise, keeps narration', () => {
  const transcript = [
    'OpenAI Codex v0.142.5',
    '--------',
    'workdir: /worktree',
    'session id: abc',
    '--------',
    'user',
    'you are completing a ticket...',
    'lots more prompt text',
    'codex',
    'I will look at the recall endpoint before editing.',
    'exec',
    '/bin/bash -lc "rg -n recall ." in /worktree',
    ' succeeded in 12ms:',
    'server/main.py:10:def recall():',
    'server/main.py:20:def recall_again():',
    'static/app.js:5:recall()',
    'codex',
    'Making the grade call synchronous now.',
    'apply patch',
    'patch: completed',
    'server/main.py',
    'diff --git a/server/main.py b/server/main.py',
    'index 111..222',
    '--- a/server/main.py',
    '+++ b/server/main.py',
    '@@ -10,3 +10,3 @@',
    '-    old line',
    '+    new line',
    ' context line',
    'diff --git a/server/main.py b/server/main.py',
    'index 333..444',
    '--- a/server/main.py',
    '+++ b/server/main.py',
    '@@ -30,1 +30,1 @@',
    '-old',
    '+new',
    'codex',
    'Done — grading now happens inline.',
  ].join('\n');

  const out = summarizeTranscript(transcript);

  assert.match(out, /workdir: \/worktree/);
  assert.match(out, /I will look at the recall endpoint before editing\./);
  assert.match(out, /Making the grade call synchronous now\./);
  assert.match(out, /Done — grading now happens inline\./);
  assert.doesNotMatch(out, /you are completing a ticket/);
  assert.doesNotMatch(out, /lots more prompt text/);
  assert.match(out, /… ticket prompt omitted/);
  // The exec command + status line survive; the three grep-result lines collapse to one.
  assert.match(out, /rg -n recall \./);
  assert.match(out, /succeeded in 12ms:/);
  assert.doesNotMatch(out, /recall_again/);
  assert.match(out, /… 3 line\(s\) of output collapsed/);
  // The diff hunk body is gone; only the patch status and one deduped file header remain.
  assert.doesNotMatch(out, /old line/);
  assert.doesNotMatch(out, /@@ -10,3/);
  assert.match(out, /patch: completed/);
  const dashboardDiffHeaders = out.split('\n').filter((line) => line === 'diff --git a/server/main.py b/server/main.py');
  assert.equal(dashboardDiffHeaders.length, 1);
});

test('summarizeTranscript collapses a diff pasted into the final narration message, with no closing marker', () => {
  // Regression: codex's own final response sometimes recaps a full diff as
  // plain text after COMMIT_MESSAGE, rather than through an "apply patch"
  // block — and the transcript can end right there with no further marker.
  const transcript = [
    'codex',
    'SUMMARY: did the thing.',
    'CHANGES:',
    '- server/main.py: removed the background task.',
    'COMMIT_MESSAGE: fix: make it sync',
    'diff --git a/server/main.py b/server/main.py',
    'index 111..222',
    '--- a/server/main.py',
    '+++ b/server/main.py',
    '@@ -10,3 +10,3 @@',
    '-    old line',
    '+    new line',
    ' context line',
    'tokens used',
    '67,165',
  ].join('\n');

  const out = summarizeTranscript(transcript);

  assert.match(out, /SUMMARY: did the thing\./);
  assert.match(out, /- server\/main\.py: removed the background task\./);
  assert.match(out, /diff --git a\/server\/main\.py b\/server\/main\.py/);
  assert.doesNotMatch(out, /old line/);
  assert.doesNotMatch(out, /@@ -10,3/);
  // Content after the diff, with no closing marker before it, still survives.
  assert.match(out, /tokens used/);
  assert.match(out, /67,165/);
});

test('summarizeTranscript is a no-op on output that is not a codex transcript', () => {
  const plain = 'Let\'s review this patch.\n\n```js\nconst x = 1;\n```\n\nLooks fine.';
  assert.equal(summarizeTranscript(plain), plain);
});

test('/api/task-logs collapses a codex transcript before applying the line-count tail', async (t) => {
  const { baseDir, db, store } = fixture(t);
  const ticket = seed(store, { trackerId: 'issue-7', shortId: 'ticket000007', title: 'Noisy ticket' });
  store.transition(ticket.id, 'in_progress');
  closeDb(db);

  const dir = path.join(baseDir, 'runs', 'ticket000007-1783000200000', 'impl-0-codex');
  fs.mkdirSync(dir, { recursive: true });
  const transcript = [
    'OpenAI Codex v0.142.5', '--------', 'session id: abc', '--------',
    'codex', 'Looking at the file first.',
    'exec', 'rg -n foo .', ' succeeded in 1ms:',
    ...Array.from({ length: 50 }, (_, i) => `match/line/${i}.py:1:foo`),
    'codex', 'Applied the fix.',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'stderr.log'), transcript);

  const { server } = await startServer({}, { baseDir, port: 0, restart: () => ({ ok: true }) });
  t.after(() => server.close());
  const port = server.address().port;

  const logs = await requestJson(port, '/api/task-logs/ticket000007?lines=20');
  assert.equal(logs.status, 200);
  const lines = logs.body.invocations[0].stderrLines;
  assert.ok(lines.some((line) => line.includes('Looking at the file first.')));
  assert.ok(lines.some((line) => line.includes('Applied the fix.')));
  assert.ok(lines.some((line) => /… \d+ line\(s\) of output collapsed/.test(line)));
  assert.equal(lines.some((line) => line.includes('match/line/')), false);
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
