'use strict';

// agy takes the prompt as a -p argument. Prompts contain newlines/quotes that
// don't survive a cmd.exe command line, so the arg just points the agent at
// the prompt file instead. Final message = stdout tail (no last-message flag).
function build({ promptFile, config }) {
  return {
    cmd: config.cmd || 'agy',
    args: [
      '-p', `Read the file ${promptFile} and follow the instructions in it exactly.`,
      '--headless',
      '--approve', 'all',
      ...(config.extraArgs || []),
    ],
    stdinText: '',
    lastMessageFile: null,
  };
}

module.exports = { build };
