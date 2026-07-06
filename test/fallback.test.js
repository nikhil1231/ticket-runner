'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCandidateChain, runWithFallback } = require('../lib/fallback');

const policy = [
  { provider: 'codex', model: '' },
  { provider: 'antigravity', model: 'Claude' },
  { provider: 'antigravity', model: 'Pro' },
];

test('builds provider/model order and keeps models from the same provider', () => {
  assert.deepEqual(buildCandidateChain(policy), policy);
});

test('prepends an override, de-duplicates it, and applies exclusions', () => {
  assert.deepEqual(buildCandidateChain(policy, {
    override: { provider: 'antigravity', model: 'Pro' },
    exclude: [{ provider: 'codex', model: '' }],
  }), [
    { provider: 'antigravity', model: 'Pro' },
    { provider: 'antigravity', model: 'Claude' },
  ]);
});

test('falls through failures and returns the successful candidate', async () => {
  const invoked = [];
  const resets = [];
  const result = await runWithFallback({
    candidates: policy,
    invoke: async (candidate) => { invoked.push(candidate.model || 'codex'); return { ok: candidate.model === 'Pro' }; },
    classify: (value) => ({ action: value.ok ? 'accept' : 'next', value }),
    reset: ({ candidate }) => resets.push(candidate.model || 'codex'),
  });
  assert.equal(result.status, 'accept');
  assert.equal(result.candidate.model, 'Pro');
  assert.deepEqual(invoked, ['codex', 'Claude', 'Pro']);
  assert.deepEqual(resets, ['codex', 'Claude']);
});

test('can stop without trying later candidates', async () => {
  let calls = 0;
  const result = await runWithFallback({
    candidates: policy,
    invoke: async () => { calls += 1; return {}; },
    classify: () => ({ action: 'stop', value: 'needs info' }),
  });
  assert.equal(result.status, 'stop');
  assert.equal(result.value, 'needs info');
  assert.equal(calls, 1);
});
