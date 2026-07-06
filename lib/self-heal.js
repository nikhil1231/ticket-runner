'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { spawnEngine } = require('./engine');
const { failureFingerprint, normalizeFailure, textOf } = require('./failure');
const state = require('./healing-state');

const DEFAULT_PROTECTED = [
  '.env', 'config.json', 'package.json', 'package-lock.json', 'ticket-runner.service', 'scripts/supervisor.js',
  'lib/self-heal.js', 'lib/healing-state.js',
];

function git(dir, args, opts = {}) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts,
  }).trim();
}

function command(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function changedFiles(dir, baseSha) {
  const committed = git(dir, ['diff', '--name-only', `${baseSha}..HEAD`]).split(/\r?\n/).filter(Boolean);
  const tracked = git(dir, ['diff', '--name-only', 'HEAD']).split(/\r?\n/).filter(Boolean);
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean);
  return [...new Set([...committed, ...tracked, ...untracked])];
}

function isProtected(file, protectedPaths) {
  const normalized = file.replace(/\\/g, '/');
  return protectedPaths.some((item) => normalized === item || normalized.startsWith(`${item.replace(/\/$/, '')}/`));
}

function validateRepair({ dir, baseSha, protectedPaths, artifactDir }) {
  const headSha = git(dir, ['rev-parse', 'HEAD']);
  if (headSha !== baseSha) throw new Error('repair agent created commits; the controller must create the single deployment commit');
  const files = changedFiles(dir, baseSha);
  if (!files.length) throw new Error('repair agent made no changes');
  const blocked = files.filter((file) => isProtected(file, protectedPaths));
  if (blocked.length) throw new Error(`repair touched protected paths: ${blocked.join(', ')}`);
  const regressionTests = files.filter((file) => /^test\/.+\.test\.js$/.test(file.replace(/\\/g, '/')) && fs.existsSync(path.join(dir, file)));
  if (!regressionTests.length) throw new Error('repair did not add or update a regression test');

  fs.mkdirSync(artifactDir, { recursive: true });
  const testLog = path.join(artifactDir, 'validation.log');
  try {
    const output = execFileSync(command('npm'), ['test'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      timeout: 120000,
    });
    fs.writeFileSync(testLog, output, 'utf8');
  } catch (error) {
    fs.writeFileSync(testLog, textOf(error), 'utf8');
    throw new Error(`repair validation failed: ${error.message}`);
  }

  for (const file of files.filter((item) => item.endsWith('.js'))) {
    execFileSync(process.execPath, ['--check', path.join(dir, file)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  }
  return files;
}

function repairPrompt({ error, fingerprint }) {
  return `You are repairing the ticket-runner service itself after an operational failure.

FAILURE FINGERPRINT: ${fingerprint}
FAILURE:
${textOf(error).slice(0, 12000)}

Inspect the repository and implement the smallest root-cause fix. Add a regression test that fails before the fix and passes after it. Do not edit .env, config.json, ticket-runner.service, scripts/supervisor.js, lib/self-heal.js, or lib/healing-state.js. Do not run git or change dependencies. Run npm test before finishing. If the failure is external or cannot be safely fixed in this repository, make no changes and explain why.`;
}

async function repairRunner({ config, error, runDir, log = () => {} }) {
  const settings = config.selfHealing || {};
  if (settings.enabled === false) return { status: 'disabled' };
  if (process.env.TICKET_RUNNER_SUPERVISED !== '1') {
    return { status: 'supervisor_required', reason: 'guarded deployment requires scripts/supervisor.js to be the service entrypoint' };
  }

  const fingerprint = failureFingerprint(error, 'infrastructure');
  const ledger = state.readState(config.baseDir, 'repairs', {});
  const prior = ledger[fingerprint];
  const cooldownMs = settings.cooldownMs ?? 24 * 60 * 60 * 1000;
  const maxRepairs = settings.maxRepairsPerFingerprint ?? 1;
  if (prior && prior.attempts >= maxRepairs && Date.now() - prior.lastAt < cooldownMs) {
    return { status: 'circuit_open', fingerprint, reason: 'repair limit reached during cooldown' };
  }
  ledger[fingerprint] = { attempts: (prior?.attempts || 0) + 1, lastAt: Date.now(), status: 'running' };
  state.writeState(config.baseDir, 'repairs', ledger);

  const artifactDir = path.join(runDir, 'repair');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'failure.json'), `${JSON.stringify({ fingerprint, failure: normalizeFailure(error), stack: error?.stack || '' }, null, 2)}\n`);

  const remote = settings.remote || config.autoUpdate?.remote || 'origin';
  const mainBranch = settings.branch || config.autoUpdate?.branch || 'main';
  const branch = `self-heal/${fingerprint}-${Date.now()}`;
  const dir = path.join(config.baseDir, 'self-heal-worktrees', `${fingerprint}-${Date.now()}`);
  const protectedPaths = [...new Set([...DEFAULT_PROTECTED, ...(settings.protectedPaths || [])])];

  try {
    git(config.baseDir, ['fetch', '--quiet', remote, mainBranch]);
    const baseSha = git(config.baseDir, ['rev-parse', '--verify', `${remote}/${mainBranch}^{commit}`]);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(config.baseDir, ['worktree', 'add', '-b', branch, dir, baseSha]);

    const candidate = settings.repairCandidate || { provider: 'codex', model: '' };
    log(`self-heal ${fingerprint}: running ${candidate.provider}${candidate.model ? ` / ${candidate.model}` : ''}`);
    const prompt = repairPrompt({ error, fingerprint });
    fs.writeFileSync(path.join(artifactDir, 'prompt.txt'), prompt, 'utf8');
    const result = await spawnEngine({
      cli: candidate.provider,
      model: candidate.model || '',
      prompt,
      worktreeDir: dir,
      runDir: artifactDir,
      tag: 'agent',
      config,
      timeoutMs: settings.repairTimeoutMs || config.runTimeoutMs,
      log,
    });
    if (result.timedOut || result.code !== 0) {
      throw new Error(`repair agent failed${result.timedOut ? ' (timeout)' : ` (code ${result.code})`}`);
    }

    const files = validateRepair({ dir, baseSha, protectedPaths, artifactDir });
    git(dir, ['add', '-A']);
    fs.writeFileSync(path.join(artifactDir, 'repair.patch'), git(dir, ['diff', '--cached', '--binary', baseSha]), 'utf8');
    git(dir, ['commit', '-m', `bug: self-heal ${fingerprint}`]);
    const repairSha = git(dir, ['rev-parse', 'HEAD']);
    git(config.baseDir, ['fetch', '--quiet', remote, mainBranch]);
    const currentRemote = git(config.baseDir, ['rev-parse', `${remote}/${mainBranch}`]);
    if (currentRemote !== baseSha) throw new Error('origin/main advanced while repair was running; refusing deployment');

    const pending = { fingerprint, baseSha, repairSha, branch, remote, mainBranch, files, createdAt: new Date().toISOString(), status: 'prepared' };
    state.writeState(config.baseDir, 'pending-deployment', pending);
    git(dir, ['push', remote, `${repairSha}:refs/heads/${mainBranch}`]);
    pending.status = 'pushed';
    pending.pushedAt = new Date().toISOString();
    state.writeState(config.baseDir, 'pending-deployment', pending);
    ledger[fingerprint].status = 'deployed';
    ledger[fingerprint].repairSha = repairSha;
    state.writeState(config.baseDir, 'repairs', ledger);
    return { status: 'deployed', fingerprint, repairSha, files };
  } catch (errorCaught) {
    ledger[fingerprint].status = 'failed';
    ledger[fingerprint].reason = errorCaught.message;
    state.writeState(config.baseDir, 'repairs', ledger);
    return { status: 'failed', fingerprint, reason: errorCaught.message };
  } finally {
    try { git(config.baseDir, ['worktree', 'remove', '--force', dir]); } catch {}
    try { git(config.baseDir, ['branch', '-D', branch]); } catch {}
    try { git(config.baseDir, ['worktree', 'prune']); } catch {}
  }
}

module.exports = { DEFAULT_PROTECTED, changedFiles, isProtected, validateRepair, repairRunner };
