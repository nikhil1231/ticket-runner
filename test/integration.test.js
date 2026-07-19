'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const integration = require('../lib/integration');
const ticketState = require('../lib/ticket-state');
const state = require('../lib/healing-state');
const { openDb, closeDb } = require('../lib/db');
const { createStore } = require('../lib/store');

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-stack-'));
  const remote = path.join(baseDir, 'origin.git');
  const repoPath = path.join(baseDir, 'repo');
  fs.mkdirSync(repoPath);
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  git(repoPath, ['init', '-b', 'main']);
  git(repoPath, ['config', 'user.name', 'Test']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(repoPath, 'base.txt'), 'base\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', 'base']);
  git(repoPath, ['remote', 'add', 'origin', remote]);
  git(repoPath, ['push', '-u', 'origin', 'main']);
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  const config = {
    baseDir,
    repoPath,
    baseBranch: 'main',
    installTimeoutMs: 1000,
    integration: { enabled: true, remote: 'origin', mainBranch: 'main' },
  };
  const board = {
    app: 'caligo', databaseId: 'db', appDir: 'apps/caligo', scope: 'caligo', easChannel: 'testing',
    integration: { validationCommands: [] },
    stackBlockPatterns: [
      'package.json', 'yarn.lock', 'package-lock.json', 'pnpm-lock.yaml',
      'apps/caligo/package.json', 'apps/caligo/app.json', 'apps/caligo/app.config.js',
      'apps/caligo/app.config.ts', 'apps/caligo/eas.json', 'apps/caligo/ios/**',
      'apps/caligo/android/**', 'apps/caligo/plugins/**',
    ],
  };
  return { baseDir, repoPath, remote, config, board };
}

function integrationDir(f) {
  return path.join(f.baseDir, 'worktrees', 'caligo', 'integration-caligo');
}

function makePage(id, title, createdTime, status = 'Testing') {
  return {
    id,
    created_time: createdTime,
    properties: {
      Name: { title: [{ plain_text: title }] },
      Status: { status: { name: status } },
      'For AI': { checkbox: true },
    },
  };
}

function addTicket(f, page, file, content) {
  const shortId = page.id.replace(/-/g, '').slice(-12);
  const branch = `ai/${shortId}`;
  git(f.repoPath, ['switch', '-c', branch, 'main']);
  fs.writeFileSync(path.join(f.repoPath, file), content);
  git(f.repoPath, ['add', '.']);
  git(f.repoPath, ['commit', '-m', `${shortId}: change`]);
  const headSha = git(f.repoPath, ['rev-parse', 'HEAD']);
  git(f.repoPath, ['switch', 'main']);
  ticketState.writeMeta(f.baseDir, shortId, {
    pageId: page.id,
    shortId,
    app: f.board.app,
    branch,
    dir: path.join(f.baseDir, 'worktrees', shortId),
    title: page.properties.Name.title[0].plain_text,
    createdTime: page.created_time,
    baseSha: git(f.repoPath, ['rev-parse', 'main']),
    headSha,
    changedFiles: [file],
    nativeSensitiveFiles: [],
  });
  return { shortId, branch, headSha };
}

// Add a ticket implemented on top of some `baseRef` (a predecessor's head or a
// composite) rather than main, so its head carries that predecessor as an ancestor
// and its recorded baseSha is that ref — the shape of a stacked ticket. `ownFile`
// is the only file this ticket itself changes.
function addStackedTicket(f, page, baseRef, ownFile, content) {
  const shortId = page.id.replace(/-/g, '').slice(-12);
  const branch = `ai/${shortId}`;
  const baseSha = git(f.repoPath, ['rev-parse', baseRef]);
  git(f.repoPath, ['switch', '-c', branch, baseSha]);
  fs.writeFileSync(path.join(f.repoPath, ownFile), content);
  git(f.repoPath, ['add', '.']);
  git(f.repoPath, ['commit', '-m', `${shortId}: change`]);
  const headSha = git(f.repoPath, ['rev-parse', 'HEAD']);
  git(f.repoPath, ['switch', 'main']);
  ticketState.writeMeta(f.baseDir, shortId, {
    pageId: page.id,
    shortId,
    app: f.board.app,
    branch,
    dir: path.join(f.baseDir, 'worktrees', shortId),
    title: page.properties.Name.title[0].plain_text,
    createdTime: page.created_time,
    baseSha,
    headSha,
    changedFiles: [ownFile],
    nativeSensitiveFiles: [],
  });
  return { shortId, branch, headSha, baseSha };
}

const { extractTicket } = require('../lib/ticket');

const TO_BOARD = {
  queued: 'Not started', in_progress: 'In progress', needs_info: 'Needs info',
  in_review: 'In review', testing: 'Testing', done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
};

// Legacy-path tracker fixture: reads tickets by board status and records the
// canonical mirror payloads / comments the pipeline emits.
function trackerFixture(pages) {
  const updates = [];
  const comments = [];
  return {
    updates,
    comments,
    statusToBoard: (s) => TO_BOARD[s] || null,
    listByStatus: async (name) => pages.filter((page) => page.properties.Status.status.name === name).map(extractTicket),
    mirror: async (ticket, payload) => {
      updates.push({ ticket, payload });
      const page = pages.find((item) => item.id === (ticket.pageId || ticket.trackerId));
      if (page && payload.status) page.properties.Status = { status: { name: TO_BOARD[payload.status] } };
      if (page && payload.forAI !== undefined) page.properties['For AI'] = { checkbox: payload.forAI };
    },
    comment: async (ticket, message) => comments.push({ ticket, message }),
  };
}

const services = { runSetup: () => {}, runValidation: () => {} };

function storeTracker(store, { mirrorTransitions = true } = {}) {
  const updates = [];
  const comments = [];
  return {
    updates,
    comments,
    mirror: async (ticket, payload) => {
      updates.push({ ticket, payload });
      if (mirrorTransitions && payload.status) store.transition(ticket.id, payload.status);
    },
    comment: async (ticket, message) => comments.push({ ticket, message }),
  };
}

test('cumulative stack is oldest-first and rebuilds after tickets leave Testing', async (t) => {
  const f = fixture(t);
  const newer = makePage('00000000-0000-0000-0000-000000000002', 'Newer', '2026-01-02T00:00:00Z');
  const older = makePage('00000000-0000-0000-0000-000000000001', 'Older', '2026-01-01T00:00:00Z');
  const a = addTicket(f, older, 'older.txt', 'older\n');
  const b = addTicket(f, newer, 'newer.txt', 'newer\n');
  const tracker = trackerFixture([newer, older]);
  const publishes = [];
  const eas = { pushUpdate: (args) => { publishes.push(args); return { ok: true }; } };

  const first = await integration.reconcileBoard({ ...f, tracker, eas, services, log: () => {} });
  assert.equal(first.status, 'deployed');
  assert.deepEqual(first.tickets.map((item) => item.title), ['Older', 'Newer']);
  assert.equal(git(first.branch ? integrationDir(f) : f.repoPath, ['merge-base', '--is-ancestor', a.headSha, first.compositeSha]), '');
  assert.equal(git(integrationDir(f), ['merge-base', '--is-ancestor', b.headSha, first.compositeSha]), '');

  older.properties.Status.status.name = 'Not started';
  const second = await integration.reconcileBoard({ ...f, tracker, eas, services, log: () => {} });
  assert.deepEqual(second.tickets.map((item) => item.title), ['Newer']);
  assert.equal(publishes.length, 2);
  assert.throws(() => git(integrationDir(f), ['merge-base', '--is-ancestor', a.headSha, second.compositeSha]));

  newer.properties.Status.status.name = 'Done';
  const empty = await integration.reconcileBoard({ ...f, tracker, eas, services, log: () => {} });
  assert.deepEqual(empty.tickets, []);
  assert.equal(empty.compositeSha, empty.baseSha);
  assert.equal(publishes.length, 3);
});

test('a conflicting ticket is parked while compatible tickets still deploy', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repoPath, 'shared.txt'), 'start\n');
  git(f.repoPath, ['add', '.']);
  git(f.repoPath, ['commit', '-m', 'shared base']);
  git(f.repoPath, ['push', 'origin', 'main']);
  const firstPage = makePage('00000000-0000-0000-0000-000000000011', 'First', '2026-01-01T00:00:00Z');
  const secondPage = makePage('00000000-0000-0000-0000-000000000012', 'Second', '2026-01-02T00:00:00Z');
  addTicket(f, firstPage, 'shared.txt', 'first\n');
  addTicket(f, secondPage, 'shared.txt', 'second\n');
  const tracker = trackerFixture([firstPage, secondPage]);
  const eas = { pushUpdate: () => ({ ok: true }) };

  const result = await integration.reconcileBoard({ ...f, tracker, eas, services, log: () => {} });
  assert.deepEqual(result.tickets.map((item) => item.title), ['First']);
  assert.equal(secondPage.properties.Status.status.name, 'Needs info');
  assert.match(tracker.comments[0].message, /conflicted/i);
  assert.match(tracker.comments[0].message, /shared\.txt/);
});

test('a merge failure without unmerged files is parked without blocking the stack', async (t) => {
  const f = fixture(t);
  const page = makePage('00000000-0000-0000-0000-000000000014', 'Unrelated history', '2026-01-01T00:00:00Z');
  const shortId = page.id.replace(/-/g, '').slice(-12);
  const branch = `ai/${shortId}`;
  git(f.repoPath, ['switch', '--orphan', branch]);
  try { git(f.repoPath, ['rm', '-rf', '.']); } catch {}
  fs.writeFileSync(path.join(f.repoPath, 'orphan.txt'), 'orphan\n');
  git(f.repoPath, ['add', '.']);
  git(f.repoPath, ['commit', '-m', `${shortId}: unrelated`]);
  const headSha = git(f.repoPath, ['rev-parse', 'HEAD']);
  git(f.repoPath, ['switch', 'main']);
  ticketState.writeMeta(f.baseDir, shortId, {
    pageId: page.id,
    shortId,
    app: f.board.app,
    branch,
    dir: path.join(f.baseDir, 'worktrees', shortId),
    title: page.properties.Name.title[0].plain_text,
    createdTime: page.created_time,
    baseSha: git(f.repoPath, ['rev-parse', 'main']),
    headSha,
    changedFiles: ['orphan.txt'],
    nativeSensitiveFiles: [],
  });
  const tracker = trackerFixture([page]);
  const eas = { pushUpdate: () => ({ ok: true }) };

  const result = await integration.reconcileBoard({ ...f, tracker, eas, services, log: () => {} });

  assert.equal(result.status, 'deployed');
  assert.deepEqual(result.tickets, []);
  assert.equal(page.properties.Status.status.name, 'Needs info');
  assert.match(tracker.comments[0].message, /Git error:/);
});

test('repeated stack conflicts share one repair fingerprint', async (t) => {
  const f = fixture(t);
  const db = openDb(':memory:');
  t.after(() => closeDb(db));
  const store = createStore({ baseDir: f.baseDir, db });
  f.config.store = store;
  fs.writeFileSync(path.join(f.repoPath, 'shared.txt'), 'start\n');
  git(f.repoPath, ['add', '.']);
  git(f.repoPath, ['commit', '-m', 'shared base']);
  git(f.repoPath, ['push', 'origin', 'main']);
  const firstPage = makePage('00000000-0000-0000-0000-000000000015', 'First', '2026-01-01T00:00:00Z');
  const secondPage = makePage('00000000-0000-0000-0000-000000000016', 'Second', '2026-01-02T00:00:00Z');
  const firstRef = addTicket(f, firstPage, 'shared.txt', 'first\n');
  const secondRef = addTicket(f, secondPage, 'shared.txt', 'second\n');
  const first = store.upsertFromTracker({
    tracker: 'github:acme/caligo', trackerId: firstPage.id, projectKey: f.board.app, kind: 'feature',
    title: 'First', status: 'testing', createdAt: firstPage.created_time,
  });
  const second = store.upsertFromTracker({
    tracker: 'github:acme/caligo', trackerId: secondPage.id, projectKey: f.board.app, kind: 'feature',
    title: 'Second', status: 'testing', createdAt: secondPage.created_time,
  });
  store.recordImplementation(first.id, { headSha: firstRef.headSha, changedFiles: ['shared.txt'] });
  store.recordImplementation(second.id, { headSha: secondRef.headSha, changedFiles: ['shared.txt'] });
  const tracker = storeTracker(store, { mirrorTransitions: false });
  const eas = { pushUpdate: () => ({ ok: true }) };

  await integration.reconcileBoard({ ...f, tracker, eas, services, log: () => {} });
  await integration.reconcileBoard({ ...f, tracker, eas, services, log: () => {} });

  const rows = store.db.prepare('SELECT count, last_status AS lastStatus, meta FROM repairs').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].lastStatus, 'stack_conflict');
  assert.match(tracker.comments.at(-1).message, /seen 2 times/);
});

test('an epic parked in Testing is excluded from the stack, not parked for missing metadata', async (t) => {
  const f = fixture(t);
  const db = openDb(':memory:');
  t.after(() => closeDb(db));
  const store = createStore({ baseDir: f.baseDir, db });
  f.config.store = store;

  // One implemented feature ticket in Testing (real branch/commit metadata).
  const page = makePage('00000000-0000-0000-0000-000000000018', 'Feature', '2026-01-01T00:00:00Z');
  const ref = addTicket(f, page, 'shared.txt', 'feature\n');
  const feature = store.upsertFromTracker({
    tracker: 'github:acme/caligo', trackerId: page.id, projectKey: f.board.app, kind: 'feature',
    title: 'Feature', status: 'testing', createdAt: page.created_time,
  });
  store.recordImplementation(feature.id, { headSha: ref.headSha, changedFiles: ['shared.txt'] });

  // An epic frozen in Testing for sign-off: a planning artifact with no branch.
  const epic = store.upsertFromTracker({
    tracker: 'github:acme/caligo', trackerId: 'epic-1', projectKey: f.board.app, kind: 'epic',
    title: 'Signed-off epic', status: 'testing', createdAt: '2026-01-01T00:00:00Z',
  });

  const readTracker = storeTracker(store, { mirrorTransitions: false });
  const status = await integration.stackStatus({ ...f, tracker: readTracker });
  assert.deepEqual(status.desired.map((entry) => entry.shortId), [feature.shortId]); // epic excluded

  const tracker = storeTracker(store, { mirrorTransitions: true });
  await integration.reconcileBoard({ ...f, tracker, eas: { pushUpdate: () => ({ ok: true }) }, services, log: () => {} });
  assert.equal(store.getById(epic.id).status, 'testing'); // never parked to Needs info
  assert.ok(!tracker.comments.some((c) => /testing stack because its branch metadata/.test(c.message)));
});

test('reconciliation replaces an existing generated integration branch worktree', async (t) => {
  const f = fixture(t);
  const staleDir = path.join(f.baseDir, 'worktrees', 'caligo', 'stale-integration-caligo');
  fs.mkdirSync(path.dirname(staleDir), { recursive: true });
  git(f.repoPath, ['worktree', 'add', '-b', 'integration/caligo', staleDir, 'main']);
  const page = makePage('00000000-0000-0000-0000-000000000013', 'Stale branch', '2026-01-01T00:00:00Z');
  addTicket(f, page, 'stale.txt', 'stale\n');
  const tracker = trackerFixture([page]);
  const eas = { pushUpdate: () => ({ ok: true }) };

  const result = await integration.reconcileBoard({ ...f, tracker, eas, services, log: () => {} });

  assert.equal(result.status, 'deployed');
  assert.equal(result.branch, 'integration/caligo');
  assert.equal(fs.existsSync(staleDir), false);
  assert.equal(git(integrationDir(f), ['branch', '--show-current']), 'integration/caligo');
});

test('Done promotion merges only the ticket, pushes main, and finalizes Notion', async (t) => {
  const f = fixture(t);
  const page = makePage('00000000-0000-0000-0000-000000000021', 'Promote me', '2026-01-01T00:00:00Z', 'Done');
  const ticketRef = addTicket(f, page, 'feature.txt', 'feature\n');
  const tracker = trackerFixture([page]);
  const ticket = require('../lib/ticket').extractTicket(page);

  const result = await integration.promoteTicket({ ...f, ticket, tracker, services, log: () => {} });
  assert.equal(result.status, 'merged');
  git(f.repoPath, ['fetch', 'origin', 'main']);
  assert.equal(git(f.repoPath, ['merge-base', '--is-ancestor', ticketRef.headSha, 'origin/main']), '');
  assert.equal(tracker.updates.at(-1).payload.forAI, false);
  assert.match(tracker.comments.at(-1).message, /Merged automatically/);
  assert.equal(ticketState.readMeta(f.baseDir, ticket.shortId), null);
});

test('epic promotion squashes all its tickets into a single commit on main', async (t) => {
  const f = fixture(t);
  const p1 = makePage('00000000-0000-0000-0000-000000000101', 'First', '2026-01-01T00:00:00Z');
  const p2 = makePage('00000000-0000-0000-0000-000000000102', 'Second', '2026-01-02T00:00:00Z');
  const r1 = addTicket(f, p1, 'one.txt', 'one\n');
  const r2 = addTicket(f, p2, 'two.txt', 'two\n');
  const tracker = trackerFixture([p1, p2]);
  const epic = { shortId: 'epicshort001', title: 'Bundle', pageId: 'epic-page-1', projectKey: f.board.app };
  const children = [p1, p2].map((page) => extractTicket(page));

  const before = git(f.repoPath, ['rev-parse', 'origin/main']);
  const result = await integration.promoteEpic({ ...f, epic, children, tracker, services, log: () => {} });
  assert.equal(result.status, 'merged');

  git(f.repoPath, ['fetch', 'origin', 'main']);
  const after = git(f.repoPath, ['rev-parse', 'origin/main']);
  // Exactly one new commit on main — the squash — not two merges plus their
  // own commits transferred over as-is.
  const newCommits = git(f.repoPath, ['rev-list', `${before}..${after}`]).split(/\r?\n/).filter(Boolean);
  assert.equal(newCommits.length, 1);
  // Both tickets' changes are present in that single commit...
  assert.equal(git(f.repoPath, ['cat-file', '-e', `${after}:one.txt`]), '');
  assert.equal(git(f.repoPath, ['cat-file', '-e', `${after}:two.txt`]), '');
  // ...but neither ticket head is an ancestor (squashed, not merged in as-is).
  assert.throws(() => git(f.repoPath, ['merge-base', '--is-ancestor', r1.headSha, after]));
  assert.throws(() => git(f.repoPath, ['merge-base', '--is-ancestor', r2.headSha, after]));

  // Both tickets are finalized as Done and their metadata cleared.
  assert.equal(p1.properties.Status.status.name, 'Done');
  assert.equal(p2.properties.Status.status.name, 'Done');
  assert.equal(ticketState.readMeta(f.baseDir, r1.shortId), null);
  assert.equal(ticketState.readMeta(f.baseDir, r2.shortId), null);
});

test('epic promotion recovers idempotently when its squash is already on main', async (t) => {
  const f = fixture(t);
  const p1 = makePage('00000000-0000-0000-0000-000000000111', 'Only', '2026-01-01T00:00:00Z');
  const ref = addTicket(f, p1, 'only.txt', 'only\n');
  // Simulate a crash after the squash pushed but before the tickets finalized:
  // land the ticket's change on main out of band, leaving the ticket in Testing.
  git(f.repoPath, ['merge', '--no-ff', '--no-edit', ref.branch]);
  git(f.repoPath, ['push', 'origin', 'main']);
  const tracker = trackerFixture([p1]);
  const epic = { shortId: 'epicshort111', title: 'Recovered', pageId: 'epic-page-2', projectKey: f.board.app };

  const before = git(f.repoPath, ['rev-parse', 'origin/main']);
  const result = await integration.promoteEpic({ ...f, epic, children: [extractTicket(p1)], tracker, services, log: () => {} });
  assert.equal(result.status, 'already_merged');
  git(f.repoPath, ['fetch', 'origin', 'main']);
  assert.equal(git(f.repoPath, ['rev-parse', 'origin/main']), before); // nothing pushed
  assert.equal(p1.properties.Status.status.name, 'Done'); // ticket still finalized
  assert.equal(ticketState.readMeta(f.baseDir, ref.shortId), null);
});

test('native-sensitive detection blocks config, native, plugin, and dependency changes', () => {
  const board = {
    stackBlockPatterns: [
      'package.json', 'yarn.lock', 'package-lock.json', 'pnpm-lock.yaml',
      'apps/caligo/package.json', 'apps/caligo/app.json', 'apps/caligo/ios/**',
      'apps/caligo/plugins/**',
    ],
  };
  assert.deepEqual(integration.nativeSensitiveFiles([
    'apps/caligo/src/view.tsx',
    'apps/caligo/app.json',
    'apps/caligo/ios/App.swift',
    'apps/caligo/plugins/with-thing.js',
    'apps/caligo/package.json',
    'yarn.lock',
  ], board), [
    'apps/caligo/app.json',
    'apps/caligo/ios/App.swift',
    'apps/caligo/plugins/with-thing.js',
    'apps/caligo/package.json',
    'yarn.lock',
  ]);
});

test('promoting a stacked ticket lands only its own change, not the tickets it built on', async (t) => {
  const f = fixture(t);
  const basePage = makePage('00000000-0000-0000-0000-000000000201', 'Predecessor', '2026-01-01T00:00:00Z', 'Testing');
  const predecessor = addTicket(f, basePage, 'pred.txt', 'pred\n'); // implemented off main, not yet on main
  const page = makePage('00000000-0000-0000-0000-000000000202', 'Stacked', '2026-01-02T00:00:00Z', 'Done');
  const ref = addStackedTicket(f, page, predecessor.branch, 'own.txt', 'own\n'); // built on the predecessor
  const tracker = trackerFixture([page]);
  const ticket = extractTicket(page);

  const result = await integration.promoteTicket({ ...f, ticket, tracker, services, log: () => {} });
  assert.equal(result.status, 'merged');
  git(f.repoPath, ['fetch', 'origin', 'main']);
  // The ticket's own change is on main...
  assert.equal(git(f.repoPath, ['cat-file', '-e', 'origin/main:own.txt']), '');
  // ...but the predecessor it was stacked on was NOT dragged along.
  assert.throws(() => git(f.repoPath, ['cat-file', '-e', 'origin/main:pred.txt']));
  // and its head is not an ancestor of main (own change replayed, not merged wholesale).
  assert.throws(() => git(f.repoPath, ['merge-base', '--is-ancestor', ref.headSha, 'origin/main']));
  assert.equal(ticketState.readMeta(f.baseDir, ticket.shortId), null);
});

test('reconcileBoard auto-heals a head carrying a stale ancestor instead of parking', async (t) => {
  const f = fixture(t);
  const older = makePage('00000000-0000-0000-0000-000000000211', 'Older', '2026-01-01T00:00:00Z');
  addTicket(f, older, 'shared.txt', 'X\n'); // the stack changes shared.txt

  // A base commit that also touches shared.txt (a stale ancestor), then a ticket whose
  // OWN change is only bfile.txt on top of it — merging its head conflicts on shared.txt,
  // but replaying just its own commit does not.
  git(f.repoPath, ['switch', '-c', 'stale-base', 'main']);
  fs.writeFileSync(path.join(f.repoPath, 'shared.txt'), 'stale\n');
  git(f.repoPath, ['add', '.']);
  git(f.repoPath, ['commit', '-m', 'stale ancestor']);
  git(f.repoPath, ['switch', 'main']);
  const newer = makePage('00000000-0000-0000-0000-000000000212', 'Newer', '2026-01-02T00:00:00Z');
  addStackedTicket(f, newer, 'stale-base', 'bfile.txt', 'b\n');

  const tracker = trackerFixture([older, newer]);
  const result = await integration.reconcileBoard({ ...f, tracker, eas: { pushUpdate: () => ({ ok: true }) }, services, log: () => {} });

  assert.equal(result.status, 'deployed');
  // Both tickets made it in — the conflict was healed, not parked.
  assert.deepEqual(result.tickets.map((item) => item.title).sort(), ['Newer', 'Older']);
  assert.ok(!tracker.comments.some((c) => /conflicted/i.test(c.message)));
  // The stale ancestor's shared.txt edit was stripped (X's version stands) and the ticket's own file landed.
  assert.equal(git(integrationDir(f), ['show', 'HEAD:shared.txt']), 'X');
  assert.equal(git(integrationDir(f), ['cat-file', '-e', 'HEAD:bfile.txt']), '');
});

test('epic promotion drops files a child pulled in from unrelated stacked work', async (t) => {
  const f = fixture(t);
  // A base commit standing in for unrelated stacked work (a non-child ticket's change).
  git(f.repoPath, ['switch', '-c', 'other-work', 'main']);
  fs.writeFileSync(path.join(f.repoPath, 'other.txt'), 'other\n');
  git(f.repoPath, ['add', '.']);
  git(f.repoPath, ['commit', '-m', 'unrelated work']);
  git(f.repoPath, ['switch', 'main']);

  const p1 = makePage('00000000-0000-0000-0000-000000000221', 'Child', '2026-01-01T00:00:00Z');
  addStackedTicket(f, p1, 'other-work', 'child.txt', 'child\n'); // built on the unrelated work
  const tracker = trackerFixture([p1]);
  const epic = { shortId: 'epicc0000001', title: 'Epic', pageId: 'epic-c', projectKey: f.board.app };

  const before = git(f.repoPath, ['rev-parse', 'origin/main']);
  const result = await integration.promoteEpic({ ...f, epic, children: [extractTicket(p1)], tracker, services, log: () => {} });
  assert.equal(result.status, 'merged');
  git(f.repoPath, ['fetch', 'origin', 'main']);
  const after = git(f.repoPath, ['rev-parse', 'origin/main']);
  const newCommits = git(f.repoPath, ['rev-list', `${before}..${after}`]).split(/\r?\n/).filter(Boolean);
  assert.equal(newCommits.length, 1);
  // The child's own change landed...
  assert.equal(git(f.repoPath, ['cat-file', '-e', `${after}:child.txt`]), '');
  // ...but the unrelated work it was stacked on did NOT ride along into the squash.
  assert.throws(() => git(f.repoPath, ['cat-file', '-e', `${after}:other.txt`]));
});

test('native-sensitive ticket admission parks in Needs info to avoid review requeue loops', async (t) => {
  const f = fixture(t);
  const page = makePage('00000000-0000-0000-0000-000000000032', 'Native config', '2026-01-01T00:00:00Z', 'In review');
  const ref = addTicket(f, page, 'package.json', '{"native":true}\n');
  ticketState.writeMeta(f.baseDir, ref.shortId, {
    ...ticketState.readMeta(f.baseDir, ref.shortId),
    nativeSensitiveFiles: ['package.json'],
  });
  const tracker = trackerFixture([page]);
  const ticket = require('../lib/ticket').extractTicket(page);

  const result = await integration.admitTicket({ ...f, ticket, tracker, services, log: () => {} });

  assert.equal(result.status, 'excluded');
  assert.equal(result.reason, 'native_sensitive');
  assert.equal(page.properties.Status.status.name, 'Needs info');
  assert.match(tracker.comments[0].message, /runner does not repeatedly re-implement/i);
  assert.match(tracker.comments[0].message, /package\.json/);
});

test('native-sensitive ticket already in Testing is withdrawn to Needs info', async (t) => {
  const f = fixture(t);
  const page = makePage('00000000-0000-0000-0000-000000000033', 'Native stack entry', '2026-01-01T00:00:00Z');
  const ref = addTicket(f, page, 'package.json', '{"native":true}\n');
  ticketState.writeMeta(f.baseDir, ref.shortId, {
    ...ticketState.readMeta(f.baseDir, ref.shortId),
    nativeSensitiveFiles: ['package.json'],
  });
  const tracker = trackerFixture([page]);
  const eas = { pushUpdate: () => ({ ok: true }) };

  const result = await integration.reconcileBoard({ ...f, tracker, eas, services, log: () => {} });

  assert.equal(result.status, 'deployed');
  assert.deepEqual(result.tickets, []);
  assert.equal(page.properties.Status.status.name, 'Needs info');
  assert.match(tracker.comments[0].message, /requires human testing/i);
});

test('validation-only publisher composes a testing stack without EAS', async (t) => {
  const f = fixture(t);
  f.board = {
    ...f.board,
    key: 'leetcode-senpai',
    app: 'leetcode-senpai',
    scope: 'leetcode',
    publisher: { type: 'none' },
    easChannel: '',
    stackBlockPatterns: [],
  };
  const page = makePage('00000000-0000-0000-0000-000000000091', 'Generic', '2026-01-01T00:00:00Z');
  addTicket(f, page, 'generic.txt', 'generic\n');
  const tracker = trackerFixture([page]);
  const eas = { pushUpdate: () => { throw new Error('EAS should not run'); } };

  const result = await integration.reconcileBoard({ ...f, tracker, eas, services, log: () => {} });
  assert.equal(result.status, 'deployed');
  assert.equal(result.publisher, 'none');
  assert.equal(result.projectKey, 'leetcode-senpai');
});

test('stack status is read-only when metadata is missing', async (t) => {
  const f = fixture(t);
  const page = makePage('00000000-0000-0000-0000-000000000031', 'Missing', '2026-01-01T00:00:00Z');
  const tracker = trackerFixture([page]);
  const result = await integration.stackStatus({ ...f, tracker });
  assert.equal(result.desired.length, 1);
  assert.match(result.desired[0].issue, /missing metadata/);
  assert.equal(tracker.updates.length, 0);
  assert.equal(tracker.comments.length, 0);
  assert.equal(state.readState(f.baseDir, 'integration-caligo', null), null);
});

test('validation and EAS failures preserve the previous deployment state', async (t) => {
  const f = fixture(t);
  const page = makePage('00000000-0000-0000-0000-000000000041', 'Risky', '2026-01-01T00:00:00Z');
  addTicket(f, page, 'safe.txt', 'safe\n');
  const tracker = trackerFixture([page]);
  let publishes = 0;
  const eas = { pushUpdate: () => { publishes += 1; return { ok: false, error: 'EAS unavailable' }; } };

  const invalid = await integration.reconcileBoard({
    ...f, tracker, eas, log: () => {},
    services: { runSetup: () => {}, runValidation: () => { throw new Error('tests failed'); } },
  });
  assert.equal(invalid.status, 'validation_failed');
  assert.equal(publishes, 0);
  assert.equal(state.readState(f.baseDir, 'integration-caligo', null), null);

  const unpublished = await integration.reconcileBoard({ ...f, tracker, eas, services, log: () => {} });
  assert.equal(unpublished.status, 'publish_failed');
  assert.equal(publishes, 1);
  assert.equal(state.readState(f.baseDir, 'integration-caligo', null), null);
});

test('fetch failure blocks stack reconciliation without clearing previous deployment', async (t) => {
  const f = fixture(t);
  const page = makePage('00000000-0000-0000-0000-000000000045', 'Queued', '2026-01-01T00:00:00Z');
  addTicket(f, page, 'queued.txt', 'queued\n');
  const tracker = trackerFixture([page]);
  const previous = { status: 'deployed', baseSha: 'a'.repeat(40), tickets: [{ title: 'Previous' }] };
  state.writeState(f.baseDir, 'integration-caligo', previous);
  let publishes = 0;
  const eas = { pushUpdate: () => { publishes += 1; return { ok: true }; } };
  const logs = [];

  const result = await integration.reconcileBoard({
    ...f,
    tracker,
    eas,
    log: (message) => logs.push(message),
    services: {
      ...services,
      fetchBranch: () => {
        throw new Error('fatal: unable to access remote: Recv failure: Connection reset by peer');
      },
    },
  });

  assert.equal(result.status, 'fetch_failed');
  assert.match(result.error, /Connection reset by peer/);
  assert.equal(publishes, 0);
  assert.equal(tracker.updates.length, 0);
  assert.deepEqual(state.readState(f.baseDir, 'integration-caligo', null), previous);
  assert.match(logs[0], /testing stack fetch failed/);
});

test('promotion leaves Done pending when origin main advances', async (t) => {
  const f = fixture(t);
  const page = makePage('00000000-0000-0000-0000-000000000051', 'Race', '2026-01-01T00:00:00Z', 'Done');
  addTicket(f, page, 'race.txt', 'race\n');
  const tracker = trackerFixture([page]);
  const ticket = require('../lib/ticket').extractTicket(page);
  const actualBase = git(f.repoPath, ['rev-parse', 'origin/main']);
  let fetches = 0;
  const result = await integration.promoteTicket({
    ...f, ticket, tracker, log: () => {},
    services: {
      runSetup: () => {},
      runValidation: () => {},
      fetchBranch: () => (++fetches === 1 ? actualBase : 'f'.repeat(40)),
    },
  });
  assert.equal(result.status, 'remote_advanced');
  assert.equal(page.properties.Status.status.name, 'Done');
  assert.equal(tracker.updates.length, 0);
  assert.notEqual(ticketState.readMeta(f.baseDir, ticket.shortId), null);
});

test('promotion recovers idempotently when the ticket commit is already on main', async (t) => {
  const f = fixture(t);
  const page = makePage('00000000-0000-0000-0000-000000000061', 'Recovered', '2026-01-01T00:00:00Z', 'Done');
  const ref = addTicket(f, page, 'recovered.txt', 'recovered\n');
  git(f.repoPath, ['merge', '--no-ff', '--no-edit', ref.branch]);
  git(f.repoPath, ['push', 'origin', 'main']);
  const tracker = trackerFixture([page]);
  const ticket = require('../lib/ticket').extractTicket(page);

  const result = await integration.promoteTicket({ ...f, ticket, tracker, services, log: () => {} });
  assert.equal(result.status, 'already_merged');
  assert.equal(tracker.updates[0].payload.forAI, false);
  assert.equal(ticketState.readMeta(f.baseDir, ticket.shortId), null);
});

test('missing stack metadata parks the ticket instead of silently deploying it', async (t) => {
  const f = fixture(t);
  const page = makePage('00000000-0000-0000-0000-000000000071', 'Lost branch', '2026-01-01T00:00:00Z');
  const tracker = trackerFixture([page]);
  const eas = { pushUpdate: () => ({ ok: true }) };
  const result = await integration.reconcileBoard({ ...f, tracker, eas, services, log: () => {} });
  assert.equal(result.status, 'deployed');
  assert.equal(page.properties.Status.status.name, 'Needs info');
  assert.match(tracker.comments[0].message, /metadata is missing/i);
  assert.deepEqual(result.tickets, []);
});

test('first reconciliation adopts legacy metadata from an existing local branch', async (t) => {
  const f = fixture(t);
  const page = makePage('00000000-0000-0000-0000-000000000081', 'Legacy', '2026-01-01T00:00:00Z');
  const ref = addTicket(f, page, 'legacy.txt', 'legacy\n');
  ticketState.writeMeta(f.baseDir, ref.shortId, {
    pageId: page.id,
    app: f.board.app,
    branch: ref.branch,
    dir: path.join(f.baseDir, 'worktrees', ref.shortId),
    title: 'Legacy',
  });
  const tracker = trackerFixture([page]);
  const eas = { pushUpdate: () => ({ ok: true }) };

  const result = await integration.reconcileBoard({ ...f, tracker, eas, services, log: () => {} });
  assert.equal(result.tickets[0].headSha, ref.headSha);
  const adopted = ticketState.readMeta(f.baseDir, ref.shortId);
  assert.equal(adopted.headSha, ref.headSha);
  assert.deepEqual(adopted.changedFiles, ['legacy.txt']);
});
