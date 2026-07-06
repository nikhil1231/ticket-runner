'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const notion = require('../lib/notion');
const {
  PLAN_HEADING, extractIncubatorTicket, recoveryStatus, splitManagedPlan, extractPlan,
  buildPlanningPrompt, updateManagedPlan, handoffTicket,
} = require('../lib/incubator');

test('extracts incubator routing and attempt fields', () => {
  const ticket = extractIncubatorTicket({
    id: 'abcdef01-2345-6789-abcd-ef0123456789',
    created_time: '2026-07-05T00:00:00Z',
    properties: {
      Name: { title: [{ plain_text: 'Plan reminders' }] },
      Status: { status: { name: 'Not started' } },
      App: { select: { name: 'WorkoutTracker' } },
      Attempts: { number: 2 },
    },
  });
  assert.equal(ticket.app, 'workouttracker');
  assert.equal(ticket.attempts, 2);
});

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
  const original = notion.updatePageMarkdown;
  const calls = [];
  notion.updatePageMarkdown = async (...args) => calls.push(args);
  try {
    await updateManagedPlan('page', '', 'First detailed plan');
    await updateManagedPlan('page', `${PLAN_HEADING}\n\nOld plan`, 'Revised detailed plan');
    assert.equal(calls[0][1].type, 'insert_content');
    assert.match(calls[0][1].insert_content.content, /First detailed plan/);
    assert.equal(calls[1][1].type, 'update_content');
    assert.equal(calls[1][1].update_content.content_updates[0].old_str, `${PLAN_HEADING}\n\nOld plan`);
    assert.match(calls[1][1].update_content.content_updates[0].new_str, /Revised detailed plan/);
  } finally {
    notion.updatePageMarkdown = original;
  }
});

test('handoff moves the same page and queues it for feature processing', async () => {
  const original = {
    getDataSourceId: notion.getDataSourceId,
    movePage: notion.movePage,
    updatePage: notion.updatePage,
    safeComment: notion.safeComment,
  };
  const calls = [];
  notion.getDataSourceId = async (id) => { calls.push(['source', id]); return 'source-id'; };
  notion.movePage = async (page, source) => calls.push(['move', page, source]);
  notion.updatePage = async (page, properties) => calls.push(['update', page, properties]);
  notion.safeComment = async () => {};
  try {
    const ok = await handoffTicket({
      config: {},
      ticket: { pageId: 'page-id', title: 'Ticket' },
      board: { app: 'caligo', databaseId: 'db-id' },
      log: () => {},
    });
    assert.equal(ok, true);
    assert.deepEqual(calls[1], ['move', 'page-id', 'source-id']);
    assert.equal(calls[2][2].Status.status.name, 'Not started');
    assert.equal(calls[2][2]['For AI'].checkbox, true);
    assert.equal(calls[2][2].CLI.select, null);
  } finally {
    Object.assign(notion, original);
  }
});
