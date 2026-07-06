'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pushUpdate } = require('../lib/eas');

test('publishes by channel only and forces non-interactive mode', () => {
  let invocation;
  const result = pushUpdate({
    worktreeDir: '/runner/worktree',
    appDir: 'apps/workouttracker',
    channel: 'testing',
    message: 'workout: fix library list',
    platform: 'linux',
    executeFile: (cmd, args, opts) => {
      invocation = { cmd, args, opts };
      return 'published';
    },
  });

  assert.equal(result.ok, true);
  assert.equal(invocation.cmd, 'eas');
  assert.deepEqual(invocation.args, [
    'update', '--channel', 'testing', '--platform', 'all',
    '--message', 'workout: fix library list', '--non-interactive',
  ]);
  assert.equal(invocation.args.includes('--branch'), false);
  assert.match(invocation.opts.cwd.replace(/\\/g, '/'), /worktree\/apps\/workouttracker$/);
});

test('failure diagnostics retain useful stdout as well as stderr', () => {
  const error = new Error('command failed');
  error.stderr = Buffer.from('Error: update command failed.\n');
  error.stdout = Buffer.from('Cannot specify both --channel and --branch.\n');
  const result = pushUpdate({
    worktreeDir: '/runner/worktree',
    appDir: 'apps/workouttracker',
    channel: 'testing',
    message: 'test',
    platform: 'linux',
    executeFile: () => { throw error; },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /update command failed/);
  assert.match(result.error, /Cannot specify both/);
  assert.match(result.error.split(/\r?\n/).at(-1), /Cannot specify both/);
});
