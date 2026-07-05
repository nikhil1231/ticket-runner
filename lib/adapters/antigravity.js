'use strict';

// Antigravity CLI (agy) 1.0.16 print mode. Flags per `agy --help`:
//   -p/--print                       run one prompt non-interactively, print response
//   --dangerously-skip-permissions   auto-approve file writes / command execution
//   --print-timeout <dur>            how long print mode waits (DEFAULT 5m — too short)
//   --model <id>                     model override (see `agy models`)
//
// agy treats its workspace as the CWD, but if pointed at a prompt file elsewhere
// it wanders into that file's directory (verified: with --add-dir it edited and
// even `git init`-ed the wrong folder). So we drop the prompt file INTO the
// worktree as `.agent-task.md` (runner writes/cleans it up) and reference it
// relatively. agy is unsandboxed and would happily run git, so the prompt tells
// it not to — the runner owns committing, same as the codex path.
function build({ config, timeoutMs }) {
  const printTimeoutMin = Math.ceil((timeoutMs || 1500000) / 60000) + 5;
  return {
    cmd: config.cmd || 'agy',
    args: [
      '-p', 'There is a file named .agent-task.md in your current working directory (the workspace root). Open that exact file directly — do NOT search other directories for it. Carry out the instructions in it exactly, then stop.',
      '--dangerously-skip-permissions',
      '--print-timeout', `${printTimeoutMin}m`,
      ...(config.model ? ['--model', config.model] : []),
      ...(config.extraArgs || []),
    ],
    stdinText: '',
    lastMessageFile: null,
    prepFiles: [{ path: '.agent-task.md' }],
  };
}

module.exports = { build };
