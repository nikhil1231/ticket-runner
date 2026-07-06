'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const worktrees = require('../lib/worktree');
const { classifyFailure, failureFingerprint, normalizeFailure } = require('../lib/failure');
const healingState = require('../lib/healing-state');
const { DEFAULT_PROTECTED, changedFiles, isProtected, repairRunner } = require('../lib/self-heal');

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-runner-heal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '--quiet']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'base\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '--quiet', '-m', 'base']);
  return dir;
}

test('head trims command output and reset accepts a newline-bearing SHA', (t) => {
  const dir = repo(t);
  const sha = worktrees.head(dir);
  assert.match(sha, /^[a-f0-9]{40}$/);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'changed\n');
  worktrees.resetWorktree(dir, `${sha}\n`);
  assert.equal(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8'), 'base\n');
});

test('reset rejects empty and unknown revisions before destructive Git runs', (t) => {
  const dir = repo(t);
  assert.throws(() => worktrees.resetWorktree(dir, '\n'), /reference is empty/);
  assert.throws(() => worktrees.resetWorktree(dir, 'a'.repeat(40)), /rev-parse/);
});

test('classifies runner, provider, configuration, and task failures', () => {
  assert.equal(classifyFailure(new Error('fatal: worktree reset failed'), { runner: true }).kind, 'infrastructure');
  assert.equal(classifyFailure(new Error('codex usage limit reached'), { provider: true }).kind, 'provider');
  assert.equal(classifyFailure(new Error('NOTION_TOKEN is not set')).kind, 'configuration');
  assert.equal(classifyFailure(new Error('tests failed'), { task: true }).kind, 'task');
  assert.equal(classifyFailure(new Error('page content is truncated or contains unsupported blocks')).kind, 'user');
});

test('runner repair refuses deployment without the protected supervisor', async () => {
  const previous = process.env.TICKET_RUNNER_SUPERVISED;
  delete process.env.TICKET_RUNNER_SUPERVISED;
  try {
    const result = await repairRunner({ config: { selfHealing: { enabled: true } }, error: new Error('boom'), runDir: 'unused' });
    assert.equal(result.status, 'supervisor_required');
  } finally {
    if (previous === undefined) delete process.env.TICKET_RUNNER_SUPERVISED;
    else process.env.TICKET_RUNNER_SUPERVISED = previous;
  }
});

test('fingerprints normalize paths, SHAs, and run-specific numbers', () => {
  const one = new Error(`git /tmp/run/123456789012 failed ${'a'.repeat(40)}`);
  const two = new Error(`git /home/me/run/999999999999 failed ${'b'.repeat(40)}`);
  assert.equal(normalizeFailure(one), normalizeFailure(two));
  assert.equal(failureFingerprint(one, 'infrastructure'), failureFingerprint(two, 'infrastructure'));
});

test('healing state writes atomically and can be removed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-runner-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  healingState.writeState(dir, 'sample', { ok: true });
  assert.deepEqual(healingState.readState(dir, 'sample'), { ok: true });
  healingState.writeState(dir, 'sample', { ok: 'updated' });
  assert.deepEqual(healingState.readState(dir, 'sample'), { ok: 'updated' });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'state')), ['sample.json']);
  healingState.removeState(dir, 'sample');
  assert.equal(healingState.readState(dir, 'sample'), null);
});

test('repair diff includes committed and uncommitted files and protects the controller', (t) => {
  const dir = repo(t);
  const base = git(dir, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(dir, 'committed.js'), 'module.exports = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '--quiet', '-m', 'agent commit']);
  fs.writeFileSync(path.join(dir, 'untracked.js'), 'module.exports = 2;\n');
  assert.deepEqual(changedFiles(dir, base).sort(), ['committed.js', 'untracked.js']);
  assert.equal(isProtected('scripts/supervisor.js', DEFAULT_PROTECTED), true);
  assert.equal(isProtected('lib/run.js', DEFAULT_PROTECTED), false);
});
