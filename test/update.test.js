'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDashboard, checkForUpdate } = require('../lib/update');

function fakeGit({ head = 'aaa', target = 'bbb', dirty = '', diverged = false } = {}) {
  const calls = [];
  const git = (_repo, args) => {
    calls.push(args.join(' '));
    const command = args.join(' ');
    if (command === 'rev-parse HEAD') return head;
    if (command === 'rev-parse origin/main') return target;
    if (command === 'status --porcelain') return dirty;
    if (command === 'checkout -- package-lock.json') {
      dirty = dirty.split('\n').filter((line) => !line.endsWith('package-lock.json')).join('\n');
      return '';
    }
    if (command === 'merge-base --is-ancestor HEAD origin/main' && diverged) throw new Error('not ancestor');
    if (command === 'merge --ff-only --quiet origin/main') head = target;
    return command === 'rev-parse HEAD' ? head : '';
  };
  return { git, calls };
}

test('does nothing when already current', () => {
  const fake = fakeGit({ head: 'aaa', target: 'aaa' });
  assert.deepEqual(checkForUpdate({ repoPath: '/repo', git: fake.git }), {
    updated: false, reason: 'current', headSha: 'aaa',
  });
  assert.equal(fake.calls.some((call) => call.startsWith('merge ')), false);
});

test('does not overwrite local changes', () => {
  const fake = fakeGit({ dirty: ' M runner.js' });
  assert.equal(checkForUpdate({ repoPath: '/repo', git: fake.git }).reason, 'dirty');
  assert.equal(fake.calls.some((call) => call.startsWith('merge ')), false);
});

test('restores an npm-rewritten package-lock.json and proceeds with the update', () => {
  const fake = fakeGit({ dirty: ' M package-lock.json' });
  assert.deepEqual(checkForUpdate({ repoPath: '/repo', git: fake.git }), {
    updated: true, reason: 'fast-forward', headSha: 'bbb',
  });
  assert.equal(fake.calls.includes('checkout -- package-lock.json'), true);
});

test('a dirty package-lock.json alongside real local changes still blocks the update', () => {
  const fake = fakeGit({ dirty: ' M package-lock.json\n M runner.js' });
  assert.equal(checkForUpdate({ repoPath: '/repo', git: fake.git }).reason, 'dirty');
  assert.equal(fake.calls.includes('checkout -- package-lock.json'), false);
  assert.equal(fake.calls.some((call) => call.startsWith('merge ')), false);
});

test('does not merge diverged history', () => {
  const fake = fakeGit({ diverged: true });
  assert.equal(checkForUpdate({ repoPath: '/repo', git: fake.git }).reason, 'diverged');
  assert.equal(fake.calls.some((call) => call.startsWith('merge ')), false);
});

test('fast-forwards a clean checkout', () => {
  const fake = fakeGit();
  assert.deepEqual(checkForUpdate({ repoPath: '/repo', git: fake.git }), {
    updated: true, reason: 'fast-forward', headSha: 'bbb',
  });
  assert.equal(fake.calls.includes('merge --ff-only --quiet origin/main'), true);
});

test('runs dashboard build after a fast-forward when requested', () => {
  const fake = fakeGit();
  const builds = [];
  assert.deepEqual(checkForUpdate({
    repoPath: '/repo',
    git: fake.git,
    build: (repoPath) => {
      builds.push(repoPath);
      return { ok: true };
    },
  }), {
    updated: true, reason: 'fast-forward', headSha: 'bbb', build: { ok: true },
  });
  assert.deepEqual(builds, ['/repo']);
});

test('reports dashboard build failures without undoing the update', () => {
  const fake = fakeGit();
  const result = checkForUpdate({
    repoPath: '/repo',
    git: fake.git,
    build: () => ({ ok: false, error: 'vite exploded' }),
  });
  assert.equal(result.updated, true);
  assert.equal(result.build.ok, false);
  assert.equal(result.build.error, 'vite exploded');
});

test('dashboard build bootstraps npm dependencies before building', () => {
  const calls = [];
  const gitCalls = [];
  const result = buildDashboard('/repo', (_cmd, args, options) => {
    calls.push({ args, cwd: options.cwd });
  }, (_repo, args) => gitCalls.push(args.join(' ')));
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    { args: ['install', '--silent'], cwd: '/repo' },
    { args: ['run', 'dashboard:build', '--silent'], cwd: '/repo' },
  ]);
  // npm install may rewrite lock metadata; the build must put it back so the
  // checkout stays clean for the next auto-update.
  assert.deepEqual(gitCalls, ['checkout -- package-lock.json']);
});
