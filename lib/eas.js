'use strict';

const { execFileSync, execSync } = require('child_process');
const path = require('path');

// Publishes the worktree's current JS/assets to an EAS Update channel (branch and
// channel share the name). Non-fatal — never throws; returns { ok, output|error }.
// Needs EXPO_TOKEN in the environment for non-interactive auth on a server.
// Only ships JS/asset changes; native changes need a fresh `eas build`.
function pushUpdate({ worktreeDir, appDir, channel, message, log, executeFile = execFileSync, executeShell = execSync, platform = process.platform }) {
  const cwd = path.join(worktreeDir, appDir);
  // A channel already resolves to its mapped EAS branch. Current eas-cli rejects
  // passing --branch and --channel together.
  const args = ['update', '--channel', channel, '--platform', 'all', '--message', message, '--non-interactive'];
  const opts = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60 * 1000, windowsHide: true, env: process.env };
  try {
    let output;
    if (platform === 'win32') {
      // .cmd shim + a message with spaces: quote via the shell instead of execFile.
      output = executeShell(`eas ${args.map((arg) => JSON.stringify(arg)).join(' ')}`, opts);
    } else {
      output = executeFile('eas', args, opts);
    }
    if (log) log(`eas update pushed to "${channel}"`);
    return { ok: true, output: String(output) };
  } catch (e) {
    // eas-cli often puts the useful diagnosis on stdout and only the generic
    // "update command failed" footer on stderr, so retain both in that order.
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    const stdout = e.stdout ? e.stdout.toString().trim() : '';
    const err = [stderr, stdout, (!stderr && !stdout) ? e.message : ''].filter(Boolean).join('\n').slice(-4000);
    if (log) log(`eas update failed: ${err.split(/\r?\n/).filter(Boolean).slice(-6).join(' ')}`);
    return { ok: false, error: err };
  }
}

module.exports = { pushUpdate };
