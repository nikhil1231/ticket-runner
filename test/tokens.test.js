'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseCodexTokens, parseClaudeResult, extractUsage,
  phaseOfTag, providerOfTag, parseRunDirName, collectTokenUsage,
} = require('../lib/tokens');

test('parseCodexTokens reads the trailing comma-formatted total from stderr', () => {
  assert.equal(parseCodexTokens('diff...\ntokens used\n57,120\n'), 57120);
  assert.equal(parseCodexTokens('no token line here'), null);
});

test('parseClaudeResult extracts message, summed tokens, and USD cost from JSON', () => {
  const stdout = JSON.stringify({
    result: 'PLAN: ...',
    total_cost_usd: 0.034,
    usage: { input_tokens: 200, output_tokens: 80, cache_creation_input_tokens: 10, cache_read_input_tokens: 300 },
  });
  const parsed = parseClaudeResult(stdout);
  assert.equal(parsed.lastMessage, 'PLAN: ...');
  assert.equal(parsed.usage.tokens, 590);
  assert.equal(parsed.usage.costUsd, 0.034);
});

test('parseClaudeResult returns null for non-JSON (e.g. plain text or truncation)', () => {
  assert.equal(parseClaudeResult('just some text'), null);
  assert.equal(parseClaudeResult('{ not: valid'), null);
});

test('extractUsage sniffs format: JSON wins, else codex stderr, else null', () => {
  const claude = extractUsage({ stdout: JSON.stringify({ result: 'x', usage: { output_tokens: 5 } }), stderr: '' });
  assert.equal(claude.tokens, 5);
  const codex = extractUsage({ stdout: 'the diff', stderr: 'tokens used\n1,234' });
  assert.equal(codex.tokens, 1234);
  assert.equal(codex.costUsd, null);
  assert.equal(extractUsage({ stdout: 'x', stderr: 'y' }), null);
});

test('phaseOfTag and providerOfTag decode the invocation tag', () => {
  assert.equal(phaseOfTag('feature-0-codex'), 'implementation');
  assert.equal(phaseOfTag('review-1-antigravity'), 'review');
  assert.equal(phaseOfTag('epics-0-claude'), 'planning');
  assert.equal(phaseOfTag('epic-abc123-0-claude'), 'planning');
  assert.equal(phaseOfTag('query-0-codex'), 'query');
  assert.equal(providerOfTag('feature-0-codex'), 'codex');
  assert.equal(providerOfTag('epics-0-claude'), 'claude');
  assert.equal(providerOfTag('feature-0-mystery'), 'unknown');
});

test('parseRunDirName classifies flywheel, incubator, review, ticket, and service runs', () => {
  assert.deepEqual(parseRunDirName('leetcode-senpai-flywheel-epics-1783000000000'), { project: 'leetcode-senpai', shortId: null, kind: 'planning' });
  assert.deepEqual(parseRunDirName('abc123-plan-1783000000000'), { project: null, shortId: 'abc123', kind: 'planning' });
  assert.deepEqual(parseRunDirName('abc123-review-1783000000000'), { project: null, shortId: 'abc123', kind: 'review' });
  assert.deepEqual(parseRunDirName('abc123-1783000000000'), { project: null, shortId: 'abc123', kind: 'ticket' });
  assert.deepEqual(parseRunDirName('service-1783000000000'), { project: null, shortId: null, kind: 'other' });
});

function writeInvocation(runsDir, runDirName, tag, { stderr = '', stdout = '' }) {
  const dir = path.join(runsDir, runDirName, tag);
  fs.mkdirSync(dir, { recursive: true });
  if (stderr) fs.writeFileSync(path.join(dir, 'stderr.log'), stderr);
  if (stdout) fs.writeFileSync(path.join(dir, 'stdout.log'), stdout);
}

test('collectTokenUsage rolls up by provider, phase, and ticket across a runs tree', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-tokens-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const runsDir = path.join(baseDir, 'runs');

  writeInvocation(runsDir, 'abc123-1783000000000', 'feature-0-codex', { stderr: 'the diff\ntokens used\n1,000\n', stdout: 'ok' });
  writeInvocation(runsDir, 'abc123-review-1783000100000', 'review-0-codex', { stderr: 'tokens used\n200\n' });
  writeInvocation(runsDir, 'caligo-flywheel-epics-1783000200000', 'epics-0-claude', {
    stdout: JSON.stringify({ result: 'TICKETS: ...', total_cost_usd: 0.05, usage: { input_tokens: 300, output_tokens: 200 } }),
  });
  writeInvocation(runsDir, 'def456-1783000300000', 'feature-0-antigravity', { stdout: 'built it', stderr: '(no token report)' });

  const roll = collectTokenUsage(baseDir);
  assert.equal(roll.available, true);
  assert.equal(roll.costTracked, true);

  assert.equal(roll.byProvider.codex.tokens, 1200);
  assert.equal(roll.byProvider.claude.tokens, 500);
  assert.equal(roll.byProvider.claude.costUsd, 0.05);
  assert.equal(roll.byProvider.antigravity.tokens, 0);
  assert.equal(roll.byProvider.antigravity.runs, 1);

  assert.equal(roll.byPhase.implementation.tokens, 1000);
  assert.equal(roll.byPhase.review.tokens, 200);
  assert.equal(roll.byPhase.planning.tokens, 500);

  assert.equal(roll.totals.tokens, 1700);
  assert.equal(roll.totals.runs, 4);
  assert.ok(Math.abs(roll.totals.costUsd - 0.05) < 1e-9);

  // The ticket rolls its implementation + review runs together; planning has no shortId.
  const abc = roll.perTicket.find((r) => r.shortId === 'abc123');
  assert.equal(abc.tokens, 1200);
  assert.equal(abc.runs, 2);
  assert.ok(!roll.perTicket.some((r) => r.shortId === null));
});

test('collectTokenUsage is safe when runs/ does not exist', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-tokens-empty-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const roll = collectTokenUsage(baseDir);
  assert.equal(roll.available, false);
  assert.deepEqual(roll.totals, { runs: 0, tokens: 0, costUsd: 0 });
});
