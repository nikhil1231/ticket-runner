'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReviewCandidates, parseReviewVerdict } = require('../lib/review');
const { extractTicket } = require('./helpers/ticket-fixture');
const { buildPrompt } = require('../lib/run');

const config = {
  fallbackPolicies: { review: [
    { provider: 'antigravity', model: 'Gemini 3.5 Flash (Low)' },
    { provider: 'codex', model: '' },
    { provider: 'antigravity', model: 'Gemini 3.1 Pro (High)' },
  ] },
};

test('reviewer defaults to agy Flash when the implementer used codex', () => {
  assert.deepEqual(buildReviewCandidates({ provider: 'codex', model: '' }, config)[0], {
    provider: 'antigravity',
    model: 'Gemini 3.5 Flash (Low)',
  });
});

test('review excludes the exact implementation candidate', () => {
  assert.deepEqual(buildReviewCandidates({ provider: 'antigravity', model: 'Gemini 3.5 Flash (Low)' }, config)[0], {
    provider: 'codex',
    model: '',
  });
});

test('reviewer stays on agy Flash when implementer used a different agy model', () => {
  assert.deepEqual(buildReviewCandidates({ provider: 'antigravity', model: 'Gemini 3.1 Pro (High)' }, config)[0], {
    provider: 'antigravity',
    model: 'Gemini 3.5 Flash (Low)',
  });
});

test('parses an APPROVE verdict', () => {
  const r = parseReviewVerdict('SUMMARY: looks fine\nREVIEW_VERDICT: APPROVE\nREVIEW_NOTES: solid');
  assert.equal(r.verdict, 'approve');
  assert.equal(r.notes, 'solid');
});

test('parses REQUEST_CHANGES with multi-line notes', () => {
  const r = parseReviewVerdict('REVIEW_VERDICT: REQUEST_CHANGES\nREVIEW_NOTES: fix A\n- and B');
  assert.equal(r.verdict, 'request_changes');
  assert.match(r.notes, /fix A/);
  assert.match(r.notes, /and B/);
});

test('a missing verdict is treated as changes requested (never auto-approves)', () => {
  const r = parseReviewVerdict('the model rambled without a verdict');
  assert.equal(r.verdict, 'request_changes');
});

test('extractTicket reads the new Model, Review rounds and Review feedback fields', () => {
  const page = {
    id: 'abcdef01-2345-6789-abcd-ef0123456789',
    created_time: '2026-07-05T00:00:00.000Z',
    properties: {
      Name: { title: [{ plain_text: 'Test ticket' }] },
      CLI: { select: { name: 'antigravity' } },
      Attempts: { number: 1 },
      Model: { rich_text: [{ plain_text: 'Gemini 3.1 Pro (High)' }] },
      'Review rounds': { number: 2 },
      'Review feedback': { rich_text: [{ plain_text: 'handle the empty case' }] },
      'Last agent': { rich_text: [{ plain_text: 'codex' }] },
    },
  };
  const t = extractTicket(page);
  assert.equal(t.cli, 'antigravity');
  assert.equal(t.model, 'Gemini 3.1 Pro (High)');
  assert.equal(t.reviewRounds, 2);
  assert.equal(t.reviewFeedback, 'handle the empty case');
  assert.equal(t.lastAgent, 'codex');
});

test('extractTicket defaults the new fields when absent', () => {
  const t = extractTicket({ id: 'x'.repeat(32), created_time: '2026-07-05T00:00:00.000Z', properties: {} });
  assert.equal(t.model, '');
  assert.equal(t.reviewRounds, 0);
  assert.equal(t.reviewFeedback, '');
});

test('buildPrompt injects prior review feedback so the redo addresses it', () => {
  const prompt = buildPrompt({
    ticket: { title: 'Add toggle', reviewFeedback: 'the toggle does not persist across restarts' },
    body: 'Add a mute toggle',
    board: { appDir: 'apps/workouttracker', scope: 'workout' },
  });
  assert.match(prompt, /changes were requested/i);
  assert.match(prompt, /persist across restarts/);
});

test('buildPrompt omits the feedback block on a first attempt', () => {
  const prompt = buildPrompt({
    ticket: { title: 'Add toggle', reviewFeedback: '' },
    body: 'Add a mute toggle',
    board: { appDir: 'apps/workouttracker', scope: 'workout' },
  });
  assert.doesNotMatch(prompt, /changes were requested/i);
});

test('buildPrompt includes new human comments as implementation feedback', () => {
  const prompt = buildPrompt({
    ticket: { title: 'Tune chimes', reviewFeedback: '' },
    body: 'Add sound controls',
    board: { appDir: 'apps/workouttracker', scope: 'workout' },
    humanComments: ['The mute option resets after relaunch.', 'Keep vibration enabled.'],
  });
  assert.match(prompt, /New human feedback/);
  assert.match(prompt, /resets after relaunch/);
  assert.match(prompt, /Keep vibration enabled/);
});
