'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkForUpdate } = require('../lib/update');

function fakeGit({ head = 'aaa', target = 'bbb', dirty = '', diverged = false } = {}) {
  const calls = [];
  const git = (_repo, args) => {
    calls.push(args.join(' '));
    const command = args.join(' ');
    if (command === 'rev-parse HEAD') return head;
    if (command === 'rev-parse origin/main') return target;
    if (command === 'status --porcelain') return dirty;
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
