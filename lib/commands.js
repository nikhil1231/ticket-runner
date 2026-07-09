'use strict';

const { execFileSync } = require('child_process');

function commandName(cmd) {
  return process.platform === 'win32' && !/\.(?:exe|cmd|bat)$/i.test(cmd) ? `${cmd}.cmd` : cmd;
}

function assertCommandArray(commands, label = 'commands') {
  if (commands == null) return [];
  if (!Array.isArray(commands)) throw new Error(`${label} must be an array`);
  for (const command of commands) {
    if (!Array.isArray(command) || !command.length || typeof command[0] !== 'string') {
      throw new Error(`${label} entries must be non-empty command arrays`);
    }
  }
  return commands;
}

function runCommands(dir, commands, timeoutMs, { execute = execFileSync, label = 'command' } = {}) {
  const output = [];
  for (const command of assertCommandArray(commands, label)) {
    const [cmd, ...args] = command;
    try {
      output.push(execute(commandName(cmd), args, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        windowsHide: true,
      }));
    } catch (error) {
      const details = [error.stderr, error.stdout, error.message]
        .filter(Boolean).map(String).join('\n').trim().slice(-5000);
      throw new Error(`${label} failed: ${command.join(' ')}\n${details}`);
    }
  }
  return output.join('\n');
}

module.exports = { commandName, assertCommandArray, runCommands };
