'use strict';

const { execFileSync } = require('child_process');

function runGit(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

function checkForUpdate({ repoPath, remote = 'origin', branch = 'main', git = runGit }) {
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
  return { updated: true, reason: 'fast-forward', headSha: newHeadSha };
}

module.exports = { checkForUpdate, runGit };
