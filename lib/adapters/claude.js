'use strict';

const path = require('path');

// Claude Code CLI print mode (`claude -p`). Prompt goes in via stdin; stdout
// carries only the final assistant message with --output-format text, so we
// point lastMessageFile at the captured stdout (same file spawnEngine already
// writes for us) rather than a separate CLI-managed file like codex uses.
// `config.permissionModeOverride` lets planning callers force a read-only
// pass (e.g. 'plan') without touching the adapter's own default, which stays
// permissive for implementation/review runs where the runner already trusts
// the sandboxed worktree.
function build({ runDir, promptText, config, model }) {
  const lastMessageFile = path.join(runDir, 'stdout.log');
  const chosenModel = model || config.model;
  const permissionMode = config.permissionModeOverride || config.permissionMode || 'bypassPermissions';
  const disallowedTools = config.disallowedTools || [];
  return {
    cmd: config.cmd || 'claude',
    args: [
      '-p',
      '--output-format', 'text',
      '--permission-mode', permissionMode,
      ...(chosenModel ? ['--model', chosenModel] : []),
      ...(disallowedTools.length ? ['--disallowedTools', disallowedTools.join(',')] : []),
      ...(config.extraArgs || []),
    ],
    stdinText: promptText,
    lastMessageFile,
  };
}

module.exports = { build };
