'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { build } = require('../lib/adapters/claude');

const runDir = path.join('runs', 'r1', 'tag-0-claude');

test('prompt goes over stdin, not argv', () => {
  const spec = build({ runDir, promptText: 'do the thing', config: {}, model: '' });
  assert.equal(spec.stdinText, 'do the thing');
  assert.ok(!spec.args.includes('do the thing'));
});

test('uses JSON output and a parseResult hook that recovers the message and usage', () => {
  const spec = build({ runDir, promptText: '', config: {}, model: '' });
  assert.deepEqual(spec.args.slice(0, 3), ['-p', '--output-format', 'json']);
  assert.equal(typeof spec.parseResult, 'function');
  const stdout = JSON.stringify({
    result: 'TICKETS: here',
    total_cost_usd: 0.012,
    usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 60 },
  });
  const parsed = spec.parseResult({ stdout });
  assert.equal(parsed.lastMessage, 'TICKETS: here');
  assert.equal(parsed.usage.tokens, 200);
  assert.equal(parsed.usage.costUsd, 0.012);
});

test('parseResult tolerates malformed/truncated JSON by returning nothing usable', () => {
  const spec = build({ runDir, promptText: '', config: {}, model: '' });
  const parsed = spec.parseResult({ stdout: '{ truncated' });
  assert.deepEqual(parsed, {});
});

test('defaults to bypassPermissions and omits --model when none given', () => {
  const spec = build({ runDir, promptText: '', config: {}, model: '' });
  assert.deepEqual(spec.args, ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions']);
});

test('ticket/candidate model overrides config.model', () => {
  const spec = build({ runDir, promptText: '', config: { model: 'claude-sonnet-5' }, model: 'claude-opus-4-8' });
  assert.deepEqual(spec.args.slice(-2), ['--model', 'claude-opus-4-8']);
});

test('falls back to config.model when no per-call model given', () => {
  const spec = build({ runDir, promptText: '', config: { model: 'claude-sonnet-5' }, model: '' });
  assert.deepEqual(spec.args.slice(-2), ['--model', 'claude-sonnet-5']);
});

test('permissionModeOverride wins over permissionMode and the default', () => {
  const spec = build({ runDir, promptText: '', config: { permissionMode: 'acceptEdits', permissionModeOverride: 'plan' }, model: '' });
  assert.ok(spec.args.includes('--permission-mode'));
  assert.equal(spec.args[spec.args.indexOf('--permission-mode') + 1], 'plan');
});

test('disallowedTools are joined into a single flag value', () => {
  const spec = build({ runDir, promptText: '', config: { disallowedTools: ['Edit', 'Write', 'Bash'] }, model: '' });
  const idx = spec.args.indexOf('--disallowedTools');
  assert.ok(idx !== -1);
  assert.equal(spec.args[idx + 1], 'Edit,Write,Bash');
});

test('cmd and extraArgs are configurable', () => {
  const spec = build({ runDir, promptText: '', config: { cmd: '/opt/claude/bin/claude', extraArgs: ['--verbose'] }, model: '' });
  assert.equal(spec.cmd, '/opt/claude/bin/claude');
  assert.ok(spec.args.includes('--verbose'));
});
