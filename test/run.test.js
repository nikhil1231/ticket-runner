'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, closeDb } = require('../lib/db');
const { createStore } = require('../lib/store');
const worktrees = require('../lib/worktree');
const { runTicket, extractCommitMessage, compactAgentSummary } = require('../lib/run');

function fixture(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-run-'));
  const db = openDb(baseDir);
  t.after(() => { closeDb(db); fs.rmSync(baseDir, { recursive: true, force: true }); });
  return { baseDir, store: createStore({ baseDir, db }) };
}

test('uses the agent commit message and enforces a lowercase scope', () => {
  const message = extractCommitMessage(
    'SUMMARY: Fixed the timer.\nCOMMIT_MESSAGE: WORKOUT: switch expired rest timers to log mode',
    'workout'
  );
  assert.equal(message, 'workout: switch expired rest timers to log mode');
});

test('adds the board scope when the agent omits one', () => {
  assert.equal(
    extractCommitMessage('COMMIT_MESSAGE: distinguish saved values from placeholders', 'workout'),
    'workout: distinguish saved values from placeholders'
  );
});

test('keeps the structured summary and removes file links and paths', () => {
  const summary = compactAgentSummary(`Discard this preamble.
SUMMARY: Expired timers now enter log mode.
CHANGES:
- Updated [useTimer.ts](/home/me/app/useTimer.ts:42) and \`apps/workout/test.tsx\`.
VALIDATION:
- Tests pass.
COMMIT_MESSAGE: workout: switch expired timers to log mode`);

  assert.match(summary, /^SUMMARY:/);
  assert.match(summary, /useTimer\.ts/);
  assert.match(summary, /test\.tsx/);
  assert.doesNotMatch(summary, /\/home\/|apps\/workout|COMMIT_MESSAGE|preamble/);
});

test('preserves the end when an unstructured summary must be shortened', () => {
  const summary = compactAgentSummary(`${'noise '.repeat(100)}IMPORTANT RESULT`, 100);
  assert.match(summary, /^\[Earlier detail omitted\]/);
  assert.match(summary, /IMPORTANT RESULT$/);
});

test('runTicket bases dependent work on the deployed testing stack', async (t) => {
  const { baseDir, store } = fixture(t);
  const repoPath = path.join(baseDir, 'repo');
  fs.mkdirSync(repoPath);
  const blocker = store.upsertFromTracker({
    tracker: 'github:acme/widgets',
    trackerId: '1',
    projectKey: 'widgets',
    kind: 'feature',
    title: 'Base feature',
    status: 'testing',
  });
  const ticket = store.upsertFromTracker({
    tracker: 'github:acme/widgets',
    trackerId: '2',
    projectKey: 'widgets',
    kind: 'feature',
    title: 'Dependent feature',
    status: 'queued',
  });
  store.addDependency(ticket.id, blocker.id);
  store.saveStack('widgets', {
    status: 'deployed',
    baseSha: 'main-sha',
    compositeSha: 'stack-sha',
    tickets: [{ pageId: blocker.pageId, shortId: blocker.shortId, headSha: 'head-sha' }],
  });

  const original = {
    fetchBranch: worktrees.fetchBranch,
    createWorktree: worktrees.createWorktree,
    head: worktrees.head,
  };
  const seen = {};
  worktrees.fetchBranch = () => 'main-sha';
  worktrees.createWorktree = (args) => {
    Object.assign(seen, args);
    return { dir: path.join(baseDir, 'wt'), branch: 'ai/dependent', baseSha: args.baseRef };
  };
  worktrees.head = () => 'stack-sha';

  const tracker = {
    mirror: async () => {},
    comment: async () => {},
    fetchBody: async () => 'Implement this on top of the base feature.',
    fetchComments: async () => [],
  };

  try {
    const result = await runTicket({
      config: {
        baseDir,
        repoPath,
        runTimeoutMs: 1000,
        maxAttempts: 2,
        fallbackPolicies: { feature: [] },
        adapters: {},
        selfHealing: { enabled: false, maxRescuePasses: 0 },
        store,
      },
      board: { key: 'widgets', scope: 'widgets', integration: { enabled: true, remote: 'origin', mainBranch: 'main' } },
      ticket: store.getById(ticket.id),
      log: () => {},
      services: { tracker, store, runSetup: () => {} },
    });

    assert.equal(seen.baseRef, 'stack-sha');
    assert.equal(result.status, 'failed');
  } finally {
    Object.assign(worktrees, original);
  }
});
