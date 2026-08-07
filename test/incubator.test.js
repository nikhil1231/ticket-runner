'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PLAN_HEADING, recoveryStatus, splitManagedPlan, extractPlan,
  buildPlanningPrompt, updateManagedPlan, approvePlan,
} = require('../lib/incubator');
const { nextKind } = require('../lib/cutover');

test('stale planning claims requeue until attempts are exhausted', () => {
  assert.equal(recoveryStatus({ attempts: 1 }, 2), 'Not started');
  assert.equal(recoveryStatus({ attempts: 2 }, 2), 'Failed');
});

test('separates the original brief from the managed plan', () => {
  assert.deepEqual(splitManagedPlan(`# Brief\n\nKeep this.\n\n${PLAN_HEADING}\n\n- Old plan`), {
    brief: '# Brief\n\nKeep this.',
    existingPlan: `${PLAN_HEADING}\n\n- Old plan`,
  });
  assert.throws(() => splitManagedPlan(`${PLAN_HEADING}\nA\n${PLAN_HEADING}\nB`), /Expected one/);
});

test('requires a substantive structured plan and recognizes needs-info', () => {
  assert.equal(extractPlan('NEEDS_INFO: Which screen?').status, 'needs_info');
  assert.equal(extractPlan('PLAN:\nshort').status, 'invalid');
  assert.equal(extractPlan(`PLAN:\n${'Detailed implementation step. '.repeat(5)}`).status, 'success');
});

test('planning prompt includes existing plan and review comments', () => {
  const prompt = buildPlanningPrompt({
    ticket: { title: 'Add reminders' },
    board: { app: 'caligo', appDir: 'apps/caligo' },
    brief: 'Notify users.',
    existingPlan: '- Use local notifications.',
    comments: ['Handle denied permissions.'],
  });
  assert.match(prompt, /Handle denied permissions/);
  assert.match(prompt, /Use local notifications/);
  assert.match(prompt, /apps\/caligo/);
});

test('managed plan appends initially and precisely replaces on revision', async () => {
  const calls = [];
  const tracker = { appendSection: async (_ticket, section) => calls.push(section) };
  const ticket = { pageId: 'page' };
  await updateManagedPlan(tracker, ticket, '', 'First detailed plan');
  await updateManagedPlan(tracker, ticket, `${PLAN_HEADING}\n\nOld plan`, 'Revised detailed plan');
  assert.equal(calls[0].existing, undefined);
  assert.match(calls[0].markdown, /First detailed plan/);
  assert.match(calls[0].markdown, new RegExp(PLAN_HEADING));
  assert.equal(calls[1].existing, `${PLAN_HEADING}\n\nOld plan`);
  assert.match(calls[1].markdown, /Revised detailed plan/);
});

function approvalTracker(calls, overrides = {}) {
  return {
    promoteIncubator: async (ticket) => calls.push(['promote', ticket.trackerId]),
    mirror: async (_ticket, payload) => calls.push(['mirror', payload.status]),
    comment: async () => calls.push(['comment']),
    ...overrides,
  };
}

test('approving a plan drops the incubator label and requeues it for implementation', async () => {
  const calls = [];
  const kinds = [];
  const store = { refreshIntent: (id, patch) => kinds.push([id, patch.kind]) };
  const ok = await approvePlan({
    ticket: { id: 7, trackerId: '42', title: 'Ticket', projectKey: 'caligo' },
    board: { app: 'caligo' },
    store,
    services: { tracker: approvalTracker(calls) },
  });

  assert.equal(ok, true);
  assert.deepEqual(kinds, [[7, 'feature']]);
  // Label removal must be enqueued before the requeue, so the ticket is never
  // back on Not started while still looking like an incubator ticket.
  assert.deepEqual(calls, [['promote', '42'], ['mirror', 'queued'], ['comment']]);
});

test('a failed approval parks the plan again instead of silently requeueing it', async () => {
  const calls = [];
  const kinds = [];
  const tracker = approvalTracker(calls, {
    promoteIncubator: async () => { throw new Error('github said no'); },
  });
  const ok = await approvePlan({
    ticket: { id: 7, trackerId: '42', title: 'Ticket', projectKey: 'caligo' },
    board: { app: 'caligo' },
    store: { refreshIntent: (id, patch) => kinds.push([id, patch.kind]) },
    services: { tracker },
  });

  assert.equal(ok, false);
  assert.deepEqual(kinds, []); // kind never flipped, so it stays an incubator ticket
  assert.deepEqual(calls, [['mirror', 'needs_info'], ['comment']]);
});

test('the incubator label only re-decides kind while a ticket is still waiting to be claimed', () => {
  assert.equal(nextKind({ kind: 'feature', status: 'queued' }, { kind: 'incubator' }), 'incubator');
  assert.equal(nextKind({ kind: 'incubator', status: 'queued' }, { kind: 'feature' }), 'feature');
  assert.equal(nextKind({ kind: 'incubator', status: 'queued' }, { kind: 'incubator' }), undefined);
  // A plan parked in Needs info is approved by moving it to Done, not by pulling
  // the label off - honouring the label here would read as a human-resolved
  // ticket and accept it straight to Done, throwing the plan away.
  assert.equal(nextKind({ kind: 'incubator', status: 'needs_info' }, { kind: 'feature' }), undefined);
  assert.equal(nextKind({ kind: 'feature', status: 'in_progress' }, { kind: 'incubator' }), undefined);
  // Epics and missions are runner-owned; a stray label must not reclassify them.
  assert.equal(nextKind({ kind: 'epic', status: 'queued' }, { kind: 'feature' }), undefined);
  assert.equal(nextKind({ kind: 'feature', status: 'queued' }, { kind: 'epic' }), undefined);
});
