'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const worktrees = require('../lib/worktree');
const { runTicket } = require('../lib/run');
const {
  QUERY_HEADING,
  isQueryOnlyTicket,
  stripQueryMarker,
  buildQueryPrompt,
  extractQueryAnswer,
  appendQueryAnswer,
  buildQueryCandidates,
  runQueryTicket,
} = require('../lib/query');

test('recognizes current bracketed query ticket titles', () => {
  assert.equal(isQueryOnlyTicket({ title: '[Query] Volume too low?' }), true);
  assert.equal(stripQueryMarker('[Query] Volume too low?'), 'Volume too low?');
  assert.equal(isQueryOnlyTicket({ title: 'Query: Volume too low?' }), true);
  assert.equal(isQueryOnlyTicket({ title: 'Fix low volume playback' }), false);
});

test('query prompt is answer-only and includes comments plus app context', () => {
  const prompt = buildQueryPrompt({
    ticket: { title: '[Query] Volume too low?' },
    board: { app: 'caligo', appDir: 'apps/caligo' },
    body: 'Speaker volume seems quiet.',
    humanComments: ['This happens after the countdown.'],
  });
  assert.match(prompt, /# Query: Volume too low\?/);
  assert.match(prompt, /apps\/caligo/);
  assert.match(prompt, /This happens after the countdown/);
  assert.match(prompt, /Do not implement anything/);
  assert.match(prompt, /FOLLOW_UP:/);
});

test('extracts structured query answers and one follow-up', () => {
  const parsed = extractQueryAnswer(`Some preamble
ANSWER:
The volume is likely capped by the current audio session settings in the playback path.
FOLLOW_UP:
Which device and OS version reproduces it?`);
  assert.equal(parsed.status, 'success');
  assert.match(parsed.answer, /audio session/);
  assert.equal(parsed.followUp, 'Which device and OS version reproduces it?');

  const needsInfo = extractQueryAnswer('NEEDS_INFO: Which screen is too quiet?');
  assert.equal(needsInfo.status, 'needs_info');
  assert.equal(needsInfo.followUp, 'Which screen is too quiet?');
});

test('query answer appends a formatted page-body section', async () => {
  const calls = [];
  const tracker = { appendSection: async (_ticket, section) => calls.push(section) };
  await appendQueryAnswer(tracker, { pageId: 'page-id' }, {
    answer: 'The sound is currently limited by the configured gain.',
    followUp: 'Does this happen with silent mode off?',
  });
  assert.match(calls[0].markdown, new RegExp(QUERY_HEADING));
  assert.match(calls[0].markdown, /Follow-up needed/);
});

test('query runner answers bracketed query tickets without creating implementation state', async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-query-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const repoPath = path.join(baseDir, 'repo');
  fs.mkdirSync(repoPath);
  const runDir = path.join(baseDir, 'runs', 'query');
  fs.mkdirSync(runDir, { recursive: true });

  const updates = [];
  const comments = [];
  const sections = [];
  const config = {
    baseDir,
    repoPath,
    runTimeoutMs: 1000,
    maxAttempts: 2,
    fallbackPolicies: { feature: [{ provider: 'codex', model: '' }, { provider: 'antigravity', model: 'Claude' }] },
    adapters: { codex: { sandbox: 'workspace-write' } },
  };
  const ticket = {
    pageId: 'page-id',
    shortId: 'abc123',
    title: '[Query] Volume too low?',
    attempts: 1,
    cli: '',
    model: '',
  };

  const result = await runQueryTicket({
    config,
    board: { app: 'caligo', appDir: 'apps/caligo' },
    ticket,
    body: 'Is this expected on iOS?',
    humanComments: ['It is most obvious during workout cues.'],
    runDir,
    log: () => {},
    services: {
      tracker: {
        appendSection: async (_ticket, section) => sections.push(section),
        mirror: async (_ticket, payload) => updates.push(payload),
        comment: async (_ticket, message) => comments.push(message),
      },
      spawnEngine: async (args) => {
        assert.equal(args.worktreeDir, repoPath);
        assert.equal(args.config.adapters.codex.sandbox, 'read-only');
        assert.equal(args.config.adapters.codex.sandboxOverride, undefined);
        assert.equal(args.cli, 'codex');
        return {
          code: 0,
          timedOut: false,
          lastMessage: `ANSWER:
The volume is probably low because the current cue path uses the existing sound asset without additional gain.
FOLLOW_UP:
NONE`,
        };
      },
    },
  });

  assert.equal(result.status, 'answered');
  assert.equal(buildQueryCandidates(config, ticket).length, 1);
  assert.equal(updates.at(-1).status, 'needs_info');
  assert.equal(updates.at(-1).attempts, 1);
  assert.match(sections[0].markdown, /AI query answer/);
  assert.match(sections[0].markdown, /current cue path/);
  assert.match(comments[0], /Query answered/);
  assert.equal(fs.existsSync(path.join(baseDir, 'worktrees')), false);
});

test('runTicket routes bracketed query tickets before creating a worktree', async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-run-query-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const repoPath = path.join(baseDir, 'repo');
  fs.mkdirSync(repoPath);

  const originalWorktrees = {
    fetchBranch: worktrees.fetchBranch,
    createWorktree: worktrees.createWorktree,
    installDeps: worktrees.installDeps,
  };
  const updates = [];
  let worktreeTouched = false;

  const tracker = {
    mirror: async (_ticket, payload) => updates.push(payload),
    comment: async () => {},
    appendSection: async () => {},
    fetchBody: async () => 'Can we explain the quiet cue volume?',
    fetchComments: async () => [],
  };
  worktrees.fetchBranch = () => { worktreeTouched = true; throw new Error('fetch should not run'); };
  worktrees.createWorktree = () => { worktreeTouched = true; throw new Error('worktree should not run'); };
  worktrees.installDeps = () => { worktreeTouched = true; throw new Error('install should not run'); };

  try {
    const result = await runTicket({
      config: {
        baseDir,
        repoPath,
        runTimeoutMs: 1000,
        maxAttempts: 2,
        fallbackPolicies: { feature: [{ provider: 'codex', model: '' }] },
        adapters: { codex: {} },
      },
      board: { app: 'caligo', appDir: 'apps/caligo', scope: 'caligo' },
      ticket: {
        pageId: 'page-id',
        shortId: 'abc123',
        title: '[Query] Volume too low?',
        attempts: 0,
        cli: '',
        model: '',
      },
      log: () => {},
      services: {
        tracker,
        queryServices: {
          spawnEngine: async () => ({
            code: 0,
            timedOut: false,
            lastMessage: `ANSWER:
The runner should answer this without entering the implementation path.
FOLLOW_UP:
NONE`,
          }),
        },
      },
    });
    assert.equal(result.status, 'answered');
    assert.equal(worktreeTouched, false);
    assert.equal(updates[0].status, 'in_progress');
    assert.equal(updates.at(-1).status, 'needs_info');
  } finally {
    Object.assign(worktrees, originalWorktrees);
  }
});
