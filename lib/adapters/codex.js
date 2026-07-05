'use strict';

const path = require('path');

// codex exec reads the prompt from stdin ('-') and writes its final message
// to --output-last-message. stdout carries only the final message; progress
// streams on stderr. `model` (from the ticket or reviewer config) overrides the
// codex default; empty keeps codex's own default.
function build({ worktreeDir, promptText, runDir, config, model }) {
  const lastMessageFile = path.join(runDir, 'last-message.txt');
  const chosenModel = model || config.model;
  return {
    cmd: config.cmd || 'codex',
    args: [
      'exec',
      '--sandbox', process.env.CODEX_SANDBOX || config.sandbox || 'workspace-write',
      '--cd', worktreeDir,
      '--output-last-message', lastMessageFile,
      ...(chosenModel ? ['--model', chosenModel] : []),
      ...(config.extraArgs || []),
      '-',
    ],
    stdinText: promptText,
    lastMessageFile,
  };
}

module.exports = { build };
