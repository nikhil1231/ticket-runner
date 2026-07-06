'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const state = require('../lib/healing-state');

const baseDir = path.resolve(__dirname, '..');

function git(args) {
  return execFileSync('git', ['-C', baseDir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim();
}

function config() {
  return JSON.parse(fs.readFileSync(path.join(baseDir, 'config.json'), 'utf8'));
}

function appendHistory(entry) {
  const history = state.readState(baseDir, 'deployment-history', []);
  history.push(entry);
  state.writeState(baseDir, 'deployment-history', history.slice(-100));
}

function applyPending(pending) {
  git(['fetch', '--quiet', pending.remote, pending.mainBranch]);
  const remoteSha = git(['rev-parse', `${pending.remote}/${pending.mainBranch}`]);
  if (remoteSha !== pending.repairSha) throw new Error('pending repair no longer matches remote main');
  const dirty = git(['status', '--porcelain']);
  if (dirty) throw new Error('runner checkout is dirty; cannot activate pending repair');
  const localSha = git(['rev-parse', 'HEAD']);
  if (localSha === pending.baseSha) git(['merge', '--ff-only', '--quiet', pending.repairSha]);
  else if (localSha !== pending.repairSha) throw new Error('runner checkout is not at repair base or candidate');
}

function reconcilePrepared(pending) {
  git(['fetch', '--quiet', pending.remote, pending.mainBranch]);
  const remoteSha = git(['rev-parse', `${pending.remote}/${pending.mainBranch}`]);
  if (remoteSha === pending.repairSha) {
    pending.status = 'pushed';
    pending.reconciledAt = new Date().toISOString();
    state.writeState(baseDir, 'pending-deployment', pending);
    return pending;
  }
  if (remoteSha === pending.baseSha) {
    state.removeState(baseDir, 'pending-deployment');
    return null;
  }
  pending.status = 'deployment_blocked';
  pending.observedRemote = remoteSha;
  state.writeState(baseDir, 'pending-deployment', pending);
  throw new Error('prepared repair is neither deployed nor based on current remote main');
}

function markHealthy(pending) {
  appendHistory({ ...pending, status: 'healthy', healthyAt: new Date().toISOString() });
  const repairs = state.readState(baseDir, 'repairs', {});
  if (repairs[pending.fingerprint]) {
    repairs[pending.fingerprint].status = 'healthy';
    state.writeState(baseDir, 'repairs', repairs);
  }
  state.removeState(baseDir, 'pending-deployment');
}

function rollback(pending, reason) {
  git(['fetch', '--quiet', pending.remote, pending.mainBranch]);
  const remoteSha = git(['rev-parse', `${pending.remote}/${pending.mainBranch}`]);
  if (remoteSha !== pending.repairSha) {
    const blocked = { ...pending, status: 'rollback_blocked', reason, observedRemote: remoteSha, failedAt: new Date().toISOString() };
    state.writeState(baseDir, 'pending-deployment', blocked);
    appendHistory(blocked);
    throw new Error('automatic rollback blocked because remote main advanced');
  }
  const localSha = git(['rev-parse', 'HEAD']);
  if (localSha !== pending.repairSha) throw new Error('automatic rollback blocked because local checkout is not the repair commit');
  git(['revert', '--no-edit', pending.repairSha]);
  const revertSha = git(['rev-parse', 'HEAD']);
  git(['push', pending.remote, `${revertSha}:refs/heads/${pending.mainBranch}`]);
  const rolledBack = { ...pending, status: 'reverted', reason, revertSha, revertedAt: new Date().toISOString() };
  appendHistory(rolledBack);
  const repairs = state.readState(baseDir, 'repairs', {});
  if (repairs[pending.fingerprint]) {
    repairs[pending.fingerprint].status = 'reverted';
    repairs[pending.fingerprint].revertSha = revertSha;
    state.writeState(baseDir, 'repairs', repairs);
  }
  state.removeState(baseDir, 'pending-deployment');
  return rolledBack;
}

function launchRunner() {
  return spawn(process.execPath, [path.join(baseDir, 'runner.js'), 'loop'], {
    cwd: baseDir,
    env: { ...process.env, TICKET_RUNNER_SUPERVISED: '1' },
    stdio: 'inherit',
    windowsHide: true,
  });
}

async function supervise() {
  for (;;) {
    let pending = state.readState(baseDir, 'pending-deployment');
    if (pending?.status === 'prepared') {
      try { pending = reconcilePrepared(pending); } catch (error) {
        console.error(`[supervisor] cannot reconcile prepared repair: ${error.message}`);
        return 1;
      }
    }
    if (pending?.status === 'pushed') {
      try { applyPending(pending); } catch (error) {
        console.error(`[supervisor] cannot activate repair: ${error.message}`);
        try { rollback(pending, `activation failed: ${error.message}`); } catch (rollbackError) {
          console.error(`[supervisor] ${rollbackError.message}`);
          return 1;
        }
        pending = null;
      }
    }

    if (pending?.status === 'pushed') state.removeState(baseDir, 'heartbeat');
    const started = Date.now();
    const timeoutMs = config().selfHealing?.healthTimeoutMs || 120000;
    const child = launchRunner();
    let healthFailure = '';
    const monitor = setInterval(() => {
      if (!pending || pending.status !== 'pushed') return;
      const heartbeat = state.readState(baseDir, 'heartbeat');
      if (heartbeat?.phase === 'ready' && heartbeat.sha === pending.repairSha) {
        console.log(`[supervisor] repair ${pending.repairSha.slice(0, 7)} is healthy`);
        markHealthy(pending);
        pending = null;
      } else if (Date.now() - started > timeoutMs) {
        healthFailure = `no healthy heartbeat within ${timeoutMs}ms`;
        child.kill('SIGKILL');
      }
    }, 1000);
    const code = await new Promise((resolve) => child.on('close', (value) => resolve(value ?? 1)));
    clearInterval(monitor);

    pending = pending || state.readState(baseDir, 'pending-deployment');
    if (pending?.status === 'pushed' && (healthFailure || code !== 75)) {
      const reason = healthFailure || `runner exited with code ${code} before becoming healthy`;
      console.error(`[supervisor] repair unhealthy: ${reason}`);
      try { rollback(pending, reason); } catch (error) {
        console.error(`[supervisor] rollback failed: ${error.message}`);
        return 1;
      }
      continue;
    }
    if (code === 75) continue;
    return code;
  }
}

if (require.main === module) {
  supervise().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { applyPending, reconcilePrepared, markHealthy, rollback, supervise };
