'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function git(dir, args, opts = {}) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...opts,
  });
}

function commitRef(dir, ref) {
  const normalized = String(ref || '').trim();
  if (!normalized) throw new Error('Git commit reference is empty');
  return git(dir, ['rev-parse', '--verify', `${normalized}^{commit}`]).trim();
}

function createWorktree({ repoPath, baseBranch, worktreesDir, shortId }) {
  const dir = path.join(worktreesDir, shortId);
  const branch = `ai/${shortId}`;
  // retries reuse the same id — clear leftovers from the previous attempt
  removeWorktree({ repoPath, dir, branch, ignoreErrors: true });
  fs.mkdirSync(worktreesDir, { recursive: true });
  git(repoPath, ['worktree', 'add', dir, '-b', branch, baseBranch]);
  return { dir, branch };
}

function createDetachedWorktree({ repoPath, baseBranch, worktreesDir, shortId }) {
  const dir = path.join(worktreesDir, `incubator-${shortId}`);
  removeDetachedWorktree({ repoPath, dir, ignoreErrors: true });
  fs.mkdirSync(worktreesDir, { recursive: true });
  git(repoPath, ['worktree', 'add', '--detach', dir, baseBranch]);
  return dir;
}

function removeDetachedWorktree({ repoPath, dir, ignoreErrors = false }) {
  try {
    if (fs.existsSync(dir)) git(repoPath, ['worktree', 'remove', '--force', '--force', dir]);
  } catch (e) {
    if (!ignoreErrors) throw e;
  }
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  try { git(repoPath, ['worktree', 'prune']); } catch {}
}

function removeWorktree({ repoPath, dir, branch, ignoreErrors = false }) {
  try {
    if (fs.existsSync(dir)) git(repoPath, ['worktree', 'remove', '--force', '--force', dir]);
  } catch (e) {
    if (!ignoreErrors) throw e;
  }
  // On Windows, `git worktree remove` can drop the admin metadata but fail to
  // fully delete the dir (node_modules locks/long paths) — finish the job.
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  try {
    git(repoPath, ['worktree', 'prune']);
  } catch {}
  try {
    git(repoPath, ['branch', '-D', branch]);
  } catch (e) {
    if (!ignoreErrors) throw e;
  }
}

function installDeps(worktreeDir, timeoutMs) {
  const cmd = process.platform === 'win32' ? 'cmd.exe' : 'yarn';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'yarn install'] : ['install'];
  execFileSync(cmd, args, {
    cwd: worktreeDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    windowsHide: true,
  });
}

function commitLog(worktreeDir, baseBranch) {
  return git(worktreeDir, ['log', '--oneline', `${baseBranch}..HEAD`]).trim();
}

// Full diff of the branch vs the base's merge-base — what a reviewer should judge.
function diff(worktreeDir, baseBranch) {
  return git(worktreeDir, ['diff', `${baseBranch}...HEAD`], { maxBuffer: 32 * 1024 * 1024 });
}

function isDirty(worktreeDir) {
  return git(worktreeDir, ['status', '--porcelain']).trim().length > 0;
}

function commitAll(worktreeDir, message) {
  git(worktreeDir, ['add', '-A']);
  git(worktreeDir, ['commit', '-m', message]);
}

function head(worktreeDir) {
  return commitRef(worktreeDir, 'HEAD');
}

// Wipe an engine's leftovers so the next engine in the fallback chain starts
// from the base branch. `clean -fd` (no -x) preserves gitignored node_modules,
// so we don't have to reinstall between engines.
function resetWorktree(worktreeDir, ref = 'HEAD') {
  const sha = commitRef(worktreeDir, ref);
  git(worktreeDir, ['reset', '--hard', sha]);
  git(worktreeDir, ['clean', '-fd']);
}

module.exports = {
  createWorktree, removeWorktree, createDetachedWorktree, removeDetachedWorktree,
  installDeps, commitLog, diff, isDirty, commitAll, head, resetWorktree, commitRef,
};
