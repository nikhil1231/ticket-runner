'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');

// Prompts never travel on the command line (stdin for codex, file for agy),
// so args here are paths and plain words — simple quoting is enough.
function quoteArg(arg) {
  if (arg === '') return '""';
  if (!/[\s&|<>()^]/.test(arg)) return arg;
  return `"${arg}"`;
}

function killTree(pid) {
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
  } catch {
    // already gone
  }
}

// Spawns via the shell (codex/agy are .cmd shims on Windows), streams output
// to files, and hard-kills the whole process tree on wall-clock timeout.
function runProcess({ cmd, args, cwd, stdinText, stdoutFile, stderrFile, timeoutMs }) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(stdoutFile, { flags: 'a' });
    const err = fs.createWriteStream(stderrFile, { flags: 'a' });
    const commandLine = [cmd, ...args].map(quoteArg).join(' ');
    const child = spawn(commandLine, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    child.stdout.pipe(out);
    child.stderr.pipe(err);

    child.stdin.on('error', () => {}); // child may exit before reading stdin
    if (stdinText) child.stdin.write(stdinText);
    child.stdin.end();

    child.on('error', (e) => {
      clearTimeout(timer);
      err.write(`\n[runner] spawn error: ${e.message}\n`);
      resolve({ code: -1, timedOut, spawnError: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      out.end();
      err.end();
      resolve({ code, timedOut });
    });
  });
}

module.exports = { runProcess, killTree };
