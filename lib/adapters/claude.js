'use strict';

const { parseClaudeResult } = require('../tokens');

// Claude Code CLI print mode (`claude -p`). Prompt goes in via stdin. We use
// --output-format json so a single result object comes back on stdout carrying
// the final message, a token usage breakdown, and a real total_cost_usd. The
// parseResult hook (below) pulls the assistant text out of that object for
// lastMessage and hands the usage to the engine; if the JSON is missing or
// truncated (e.g. a killed run) it returns nothing and spawnEngine falls back
// to the raw stdout tail.
// `config.permissionModeOverride` lets planning callers force a read-only pass
// (e.g. 'plan') without touching the adapter's own default, which stays
// permissive for implementation/review runs where the runner already trusts the
// sandboxed worktree.
function build({ promptText, config, model }) {
  const chosenModel = model || config.model;
  const permissionMode = config.permissionModeOverride || config.permissionMode || 'bypassPermissions';
  const disallowedTools = config.disallowedTools || [];
  return {
    cmd: config.cmd || 'claude',
    args: [
      '-p',
      '--output-format', 'json',
      '--permission-mode', permissionMode,
      ...(chosenModel ? ['--model', chosenModel] : []),
      ...(disallowedTools.length ? ['--disallowedTools', disallowedTools.join(',')] : []),
      ...(config.extraArgs || []),
    ],
    stdinText: promptText,
    parseResult: ({ stdout }) => parseClaudeResult(stdout) || {},
  };
}

module.exports = { build };
