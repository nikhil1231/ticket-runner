'use strict';

const path = require('path');

// codex exec reads the prompt from stdin ('-') and writes its final message
// to --output-last-message. stdout carries only the final message; progress
// streams on stderr.
function build({ worktreeDir, promptText, runDir, config }) {
  const lastMessageFile = path.join(runDir, 'last-message.txt');
  return {
    cmd: config.cmd || 'codex',
    args: [
      'exec',
      '--sandbox', config.sandbox || 'workspace-write',
      '--cd', worktreeDir,
      '--output-last-message', lastMessageFile,
      ...(config.extraArgs || []),
      '-',
    ],
    stdinText: promptText,
    lastMessageFile,
  };
}

module.exports = { build };
