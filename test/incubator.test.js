'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PLAN_HEADING, recoveryStatus, splitManagedPlan, extractPlan,
  buildPlanningPrompt, updateManagedPlan, handoffTicket,
} = require('../lib/incubator');

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

test('handoff promotes the incubator ticket through its tracker', async () => {
  const calls = [];
  const tracker = {
    promoteIncubator: async (ticket, target) => calls.push(['promote', ticket.trackerId, target]),
    mirror: async () => {},
    comment: async () => {},
  };
  const ok = await handoffTicket({
    config: {},
    ticket: { trackerId: '42', title: 'Ticket' },
    board: { app: 'caligo' },
    log: () => {},
    services: { tracker },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, [['promote', '42', 'caligo']]);
});
