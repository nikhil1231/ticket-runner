'use strict';

const { execFileSync } = require('child_process');

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runGit(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

function buildDashboard(repoPath, run = execFileSync) {
  try {
    const options = {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    };
    run(npmCommand(), ['install', '--silent'], options);
    run(npmCommand(), ['run', 'dashboard:build', '--silent'], options);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: String(error.stderr || error.stdout || error.message || error),
    };
  }
}

function checkForUpdate({ repoPath, remote = 'origin', branch = 'main', git = runGit, build = null }) {
  git(repoPath, ['fetch', '--quiet', remote, branch]);
  const target = `${remote}/${branch}`;
  const headSha = git(repoPath, ['rev-parse', 'HEAD']);
  const targetSha = git(repoPath, ['rev-parse', target]);
  if (headSha === targetSha) return { updated: false, reason: 'current', headSha };

  const dirty = git(repoPath, ['status', '--porcelain']);
  if (dirty) return { updated: false, reason: 'dirty', headSha, targetSha };

  try {
    git(repoPath, ['merge-base', '--is-ancestor', 'HEAD', target]);
  } catch {
    return { updated: false, reason: 'diverged', headSha, targetSha };
  }

  git(repoPath, ['merge', '--ff-only', '--quiet', target]);
  const newHeadSha = git(repoPath, ['rev-parse', 'HEAD']);
  const result = { updated: true, reason: 'fast-forward', headSha: newHeadSha };
  if (build) result.build = build(repoPath);
  return result;
}

module.exports = { buildDashboard, checkForUpdate, runGit };
