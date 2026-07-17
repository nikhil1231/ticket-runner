'use strict';

const path = require('path');

// Antigravity CLI (agy) 1.1.3 print mode. Flags per `agy --help`:
//   -p/--print                       run one prompt non-interactively, print response
//   --dangerously-skip-permissions   auto-approve file writes / command execution
//   --print-timeout <dur>            how long print mode waits (DEFAULT 5m — too short)
//   --add-dir <dir>                  add a directory to the session workspace
//   --model <id>                     model override (see `agy models`)
//
// As of 1.1.3, agy no longer treats the bare CWD as its workspace: with no
// workspace set it reports "no active workspace set" and can't even see files
// in the CWD, then exits 0 — a silent no-op that looks like success to the
// runner. So we pin the workspace to the worktree with `--add-dir` (ABSOLUTE
// path — a relative `.` does not resolve). We still drop the prompt INTO the
// worktree as `.agent-task.md` (runner writes/cleans it up) and reference it
// relatively; with the worktree as workspace agy opens it from the CWD.
// agy is unsandboxed and would happily run git, so the prompt tells it not to —
// the runner owns committing, same as the codex path.
// `model` (from the ticket or reviewer config) overrides config.model; empty
// keeps agy's default. Reviewer default is "Gemini 3.5 Flash (Low)".
function build({ config, timeoutMs, model, worktreeDir }) {
  const printTimeoutMin = Math.ceil((timeoutMs || 1500000) / 60000) + 5;
  const chosenModel = model || config.model;
  return {
    cmd: config.cmd || 'agy',
    args: [
      '-p', 'There is a file named .agent-task.md in your current working directory (the workspace root). Open that exact file directly — do NOT search other directories for it. Carry out the instructions in it exactly, then stop.',
      '--dangerously-skip-permissions',
      '--add-dir', path.resolve(worktreeDir),
      '--print-timeout', `${printTimeoutMin}m`,
      ...(chosenModel ? ['--model', chosenModel] : []),
      ...(config.extraArgs || []),
    ],
    stdinText: '',
    lastMessageFile: null,
    prepFiles: [{ path: '.agent-task.md' }],
  };
}

module.exports = { build };
