'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCommitMessage, compactAgentSummary } = require('../lib/run');

test('uses the agent commit message and enforces a lowercase scope', () => {
  const message = extractCommitMessage(
    'SUMMARY: Fixed the timer.\nCOMMIT_MESSAGE: WORKOUT: switch expired rest timers to log mode',
    'workout'
  );
  assert.equal(message, 'workout: switch expired rest timers to log mode');
});

test('adds the board scope when the agent omits one', () => {
  assert.equal(
    extractCommitMessage('COMMIT_MESSAGE: distinguish saved values from placeholders', 'workout'),
    'workout: distinguish saved values from placeholders'
  );
});

test('keeps the structured summary and removes file links and paths', () => {
  const summary = compactAgentSummary(`Discard this preamble.
SUMMARY: Expired timers now enter log mode.
CHANGES:
- Updated [useTimer.ts](/home/me/app/useTimer.ts:42) and \`apps/workout/test.tsx\`.
VALIDATION:
- Tests pass.
COMMIT_MESSAGE: workout: switch expired timers to log mode`);

  assert.match(summary, /^SUMMARY:/);
  assert.match(summary, /useTimer\.ts/);
  assert.match(summary, /test\.tsx/);
  assert.doesNotMatch(summary, /\/home\/|apps\/workout|COMMIT_MESSAGE|preamble/);
});

test('preserves the end when an unstructured summary must be shortened', () => {
  const summary = compactAgentSummary(`${'noise '.repeat(100)}IMPORTANT RESULT`, 100);
  assert.match(summary, /^\[Earlier detail omitted\]/);
  assert.match(summary, /IMPORTANT RESULT$/);
});
