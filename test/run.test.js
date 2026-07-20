'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, closeDb } = require('../lib/db');
const { createStore } = require('../lib/store');
const worktrees = require('../lib/worktree');
const integration = require('../lib/integration');
const { execFileSync } = require('child_process');
const { runTicket, buildPrompt, applyReviewOutcome, extractCommitMessage, compactAgentSummary, stackBaseForTestingDependencies } = require('../lib/run');

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

test('buildPrompt renders the full accumulated review history, oldest first', () => {
  const prompt = buildPrompt({
    ticket: {
      title: 'T', reviewFeedback: 'stale single note - should not appear',
      reviewHistory: [
        { round: 1, reviewer: 'codex', notes: 'missing guard in reapply' },
        { round: 2, reviewer: 'claude', notes: 'never stamps on first set' },
      ],
    },
    body: 'do the thing',
    board: { key: 'widgets', scope: 'widgets' },
  });
  assert.match(prompt, /reviewers have requested changes on this exact ticket before/);
  const first = prompt.indexOf('missing guard in reapply');
  const second = prompt.indexOf('never stamps on first set');
  assert.ok(first > -1 && second > -1 && first < second);
  assert.doesNotMatch(prompt, /stale single note/);
});

test('buildPrompt falls back to the single reviewFeedback note when there is no history yet', () => {
  const prompt = buildPrompt({
    ticket: { title: 'T', reviewFeedback: 'fix the thing', reviewHistory: [] },
    body: 'do the thing',
    board: { key: 'widgets', scope: 'widgets' },
  });
  assert.match(prompt, /a previous attempt was reviewed and changes were requested/);
  assert.match(prompt, /fix the thing/);
});

test('applyReviewOutcome: approve admits to the stack and resets round state', async (t) => {
  const { store } = fixture(t);
  const ticket = store.upsertFromTracker({
    tracker: 'github:acme/widgets', trackerId: '1', projectKey: 'widgets', kind: 'feature', title: 'T', status: 'in_progress',
  });
  const mirrored = [];
  const commented = [];
  const tracker = {
    mirror: async (tkt, payload) => mirrored.push(payload),
    comment: async (tkt, text) => commented.push(text),
  };
  const original = integration.admitTicket;
  integration.admitTicket = async () => ({ status: 'deployed', compositeSha: 'stack-sha' });
  try {
    const result = await applyReviewOutcome({
      config: { store }, store, tracker, board: { key: 'widgets' },
      ticket: store.getById(ticket.id),
      implemented: { cli: 'codex', model: '', commits: 'abc def', summary: 'SUMMARY: did it' },
      branch: 'ai/x', modelLabel: 'codex', baseMirror: { branch: 'ai/x' },
      rev: { verdict: 'approve', notes: 'LGTM', reviewer: { cli: 'claude', model: 'opus' } },
      log: () => {},
    });
    assert.equal(result.status, 'approved');
    assert.equal(mirrored[0].status, 'testing');
    assert.equal(mirrored[0].reviewFeedback, '');
    assert.match(commented[0], /Approved by claude \/ opus/);
  } finally {
    integration.admitTicket = original;
  }
});

test('applyReviewOutcome: request_changes within budget requeues and durably records the finding', async (t) => {
  const { store } = fixture(t);
  const ticket = store.upsertFromTracker({
    tracker: 'github:acme/widgets', trackerId: '2', projectKey: 'widgets', kind: 'feature', title: 'T', status: 'in_progress',
  });
  const mirrored = [];
  const tracker = { mirror: async (tkt, payload) => mirrored.push(payload), comment: async () => {} };
  const result = await applyReviewOutcome({
    config: { store, review: { maxRounds: 2 } }, store, tracker, board: { key: 'widgets' },
    ticket: store.getById(ticket.id),
    implemented: { cli: 'codex', model: '', commits: 'abc', summary: 'SUMMARY: did it' },
    branch: 'ai/x', modelLabel: 'codex', baseMirror: { branch: 'ai/x' },
    rev: { verdict: 'request_changes', notes: 'missing guard in reapply', reviewer: { cli: 'claude', model: '' } },
    log: () => {},
  });
  assert.equal(result.status, 'changes_requested');
  assert.equal(mirrored[0].status, 'queued');
  assert.equal(mirrored[0].reviewFeedback, 'missing guard in reapply');
  const stored = store.getById(ticket.id);
  assert.equal(stored.reviewHistory.length, 1);
  assert.equal(stored.reviewHistory[0].notes, 'missing guard in reapply');
});

test('applyReviewOutcome: past max rounds it parks in Needs info WITHOUT wiping reviewFeedback, and flags repeat bounces', async (t) => {
  const { store } = fixture(t);
  const ticket = store.upsertFromTracker({
    tracker: 'github:acme/widgets', trackerId: '3', projectKey: 'widgets', kind: 'feature', title: 'T', status: 'in_progress',
  });
  // Simulate two prior real do-overs (requeue_count = 2) so the cycle-note fires.
  store.recordImplementation(ticket.id, { headSha: 'head1' });
  store.transition(ticket.id, 'queued');
  store.transition(ticket.id, 'in_progress');
  store.transition(ticket.id, 'queued');
  store.transition(ticket.id, 'in_progress');

  const mirrored = [];
  const commented = [];
  const tracker = { mirror: async (tkt, payload) => mirrored.push(payload), comment: async (tkt, text) => commented.push(text) };
  const stale = store.getById(ticket.id); // reviewRounds: 2 -> round 3 > maxRounds 2
  const result = await applyReviewOutcome({
    config: { store, review: { maxRounds: 2 } }, store, tracker, board: { key: 'widgets' },
    ticket: { ...stale, reviewRounds: 2 },
    implemented: { cli: 'codex', model: '', commits: 'abc', summary: 'SUMMARY: did it' },
    branch: 'ai/x', modelLabel: 'codex', baseMirror: { branch: 'ai/x' },
    rev: { verdict: 'request_changes', notes: 'still missing the guard', reviewer: { cli: 'claude', model: '' } },
    log: () => {},
  });
  assert.equal(result.status, 'needs_info');
  assert.equal(mirrored[0].status, 'needs_info');
  // The core fix: reviewFeedback must NOT be wiped to '' here.
  assert.equal(mirrored[0].reviewFeedback, 'still missing the guard');
  assert.match(commented[0], /Needs info/);
  assert.match(commented[0], /already bounced back to implementation 2 time\(s\)/);
  const persisted = store.getById(ticket.id);
  assert.equal(persisted.reviewHistory.length, 1);
  assert.equal(persisted.reviewHistory[0].notes, 'still missing the guard');
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

test('runTicket bases same-epic sibling work on the deployed testing stack', async (t) => {
  const { baseDir, store } = fixture(t);
  const repoPath = path.join(baseDir, 'repo');
  fs.mkdirSync(repoPath);
  const epic = store.createLocalTicket({
    projectKey: 'widgets',
    kind: 'epic',
    title: 'Epic',
    status: 'queued',
    tracker: 'github:acme/widgets',
  });
  const sibling = store.createLocalTicket({
    projectKey: 'widgets',
    kind: 'feature',
    title: 'Sibling already testing',
    parentId: epic.id,
    status: 'testing',
    tracker: 'github:acme/widgets',
  });
  const ticket = store.createLocalTicket({
    projectKey: 'widgets',
    kind: 'feature',
    title: 'Next sibling',
    body: 'Implement this after the sibling stack.',
    parentId: epic.id,
    status: 'queued',
    tracker: 'github:acme/widgets',
  });
  store.saveStack('widgets', {
    status: 'deployed',
    baseSha: 'main-sha',
    compositeSha: 'stack-sha',
    tickets: [{ shortId: sibling.shortId, headSha: 'head-sha' }],
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
    return { dir: path.join(baseDir, 'wt'), branch: 'ai/next-sibling', baseSha: args.baseRef };
  };
  worktrees.head = () => 'stack-sha';

  const tracker = {
    mirror: async () => {},
    comment: async () => {},
    fetchBody: async () => 'Implement this after the sibling stack.',
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

test('stackBaseForTestingDependencies stacks on file overlap, not otherwise', (t) => {
  const { baseDir, store } = fixture(t);
  const repo = path.join(baseDir, 'repo');
  fs.mkdirSync(repo);
  const git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  const baseSha = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'stack change\n');
  git(['add', '.']);
  git(['commit', '-m', 'stack change']);
  const compositeSha = git(['rev-parse', 'HEAD']);

  const board = { app: 'proj', key: 'proj' };
  store.saveStack('proj', { status: 'deployed', baseSha, compositeSha, tickets: [] });

  // A ticket whose own changes (from a prior round) touch a file the stack changed
  // is rebased onto the composite so it is written against that change.
  const overlapping = store.createLocalTicket({ projectKey: 'proj', kind: 'feature', title: 'overlaps', status: 'queued', tracker: 'github:acme/proj' });
  store.recordImplementation(overlapping.id, { headSha: 'a'.repeat(40), changedFiles: ['shared.txt'] });
  assert.equal(stackBaseForTestingDependencies({ store, ticket: store.getById(overlapping.id), board, repo }), compositeSha);

  // A ticket touching only disjoint files stays based on main.
  const disjoint = store.createLocalTicket({ projectKey: 'proj', kind: 'feature', title: 'disjoint', status: 'queued', tracker: 'github:acme/proj' });
  store.recordImplementation(disjoint.id, { headSha: 'b'.repeat(40), changedFiles: ['other.txt'] });
  assert.equal(stackBaseForTestingDependencies({ store, ticket: store.getById(disjoint.id), board, repo }), null);

  // A first-round ticket with no recorded changes yet stays based on main.
  const fresh = store.createLocalTicket({ projectKey: 'proj', kind: 'feature', title: 'first round', status: 'queued', tracker: 'github:acme/proj' });
  assert.equal(stackBaseForTestingDependencies({ store, ticket: store.getById(fresh.id), board, repo }), null);
});

test('stackBaseForTestingDependencies always bases app bug reports on the integration stack', (t) => {
  const { baseDir, store } = fixture(t);
  const repo = path.join(baseDir, 'repo');
  fs.mkdirSync(repo);
  const git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  const baseSha = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'stack.txt'), 'stack\n');
  git(['add', '.']);
  git(['commit', '-m', 'stack']);
  const compositeSha = git(['rev-parse', 'HEAD']);
  store.saveStack('proj', { status: 'deployed', baseSha, compositeSha, tickets: [] });

  const ticket = store.createLocalTicket({
    projectKey: 'proj',
    kind: 'feature',
    title: 'in-app bug',
    status: 'queued',
    tracker: 'github:acme/proj',
    meta: { bugReport: { base: 'integration', docName: 'projects/p/databases/(default)/documents/bug_reports/1' } },
  });

  assert.equal(
    stackBaseForTestingDependencies({ store, ticket: store.getById(ticket.id), board: { key: 'proj' }, repo }),
    compositeSha
  );
});
