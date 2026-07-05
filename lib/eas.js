'use strict';

const { execFileSync, execSync } = require('child_process');
const path = require('path');

// Publishes the worktree's current JS/assets to an EAS Update channel (branch and
// channel share the name). Non-fatal — never throws; returns { ok, output|error }.
// Needs EXPO_TOKEN in the environment for non-interactive auth on a server.
// Only ships JS/asset changes; native changes need a fresh `eas build`.
function pushUpdate({ worktreeDir, appDir, channel, message, log }) {
  const cwd = path.join(worktreeDir, appDir);
  const args = ['update', '--branch', channel, '--channel', channel, '--platform', 'all', '--message', message];
  const opts = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60 * 1000, windowsHide: true, env: process.env };
  try {
    let output;
    if (process.platform === 'win32') {
      // .cmd shim + a message with spaces: quote via the shell instead of execFile.
      output = execSync(`eas ${args.slice(0, -1).join(' ')} ${JSON.stringify(message)}`, opts);
    } else {
      output = execFileSync('eas', args, opts);
    }
    if (log) log(`eas update pushed to "${channel}"`);
    return { ok: true, output: String(output) };
  } catch (e) {
    const err = (e.stderr || e.stdout || e.message || '').toString().slice(-800);
    if (log) log(`eas update failed: ${err.split(/\r?\n/).slice(-3).join(' ')}`);
    return { ok: false, error: err };
  }
}

module.exports = { pushUpdate };
