'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, closeDb } = require('../lib/db');
const { createStore } = require('../lib/store');
const bugs = require('../lib/bug-reports');

function fixture(t) {
  const db = openDb(':memory:');
  const store = createStore({ baseDir: ':memory:', db });
  t.after(() => closeDb(db));
  const config = {
    baseDir: ':memory:',
    bugReports: { projectId: 'firebase-project', collection: 'bug_reports' },
    projects: [{
      key: 'workouttracker',
      app: 'workouttracker',
      tracker: { type: 'github', owner: 'nikhil', repo: 'workouttracker' },
    }],
    store,
  };
  return { store, config };
}

function fakeFirebase(docs) {
  const patches = [];
  return {
    patches,
    accessToken: async () => 'token',
    listNewReports: async () => docs,
    patchReport: async (_settings, patch) => {
      patches.push(patch);
      return {};
    },
  };
}

test('importBugReports claims Firestore reports as GitHub-backed local tickets', async (t) => {
  const { store, config } = fixture(t);
  const firebase = fakeFirebase([{
    id: 'report-1',
    name: 'projects/firebase-project/databases/(default)/documents/bug_reports/report-1',
    updateTime: '2026-07-20T10:00:00Z',
    data: {
      app: 'workouttracker',
      title: 'Timer froze',
      body: 'Timer stopped after editing a set.',
      route: '/workout/session',
      logs: ['tap edit', 'timer froze'],
    },
  }]);

  const result = await bugs.importBugReports({ config, store, services: { firebase } });
  assert.equal(result.imported, 1);
  const [ticket] = store.readyTickets();
  assert.equal(ticket.projectKey, 'workouttracker');
  assert.equal(ticket.tracker, 'github:nikhil/workouttracker');
  assert.equal(ticket.meta.bugReport.docId, 'report-1');
  assert.equal(ticket.meta.bugReport.base, 'integration');
  assert.deepEqual(ticket.trackerMeta.labels, ['bug', 'from-app']);
  assert.match(ticket.body, /Timer stopped after editing a set/);
  assert.match(ticket.body, /Build and reason against the current cumulative integration stack/);
  assert.equal(firebase.patches[0].updateTime, '2026-07-20T10:00:00Z');
  assert.equal(firebase.patches[0].fields.status, 'claimed');
  assert.equal(firebase.patches[1].fields.runnerTicketId, ticket.shortId);
});

test('syncBugReportStatuses writes runner and GitHub visibility back to Firestore', async (t) => {
  const { store, config } = fixture(t);
  const ticket = store.createLocalTicket({
    projectKey: 'workouttracker',
    kind: 'feature',
    title: 'Timer froze',
    tracker: 'github:nikhil/workouttracker',
    trackerMeta: { url: 'https://github.com/nikhil/workouttracker/issues/12', issueNumber: 12 },
    meta: { bugReport: { docName: 'projects/firebase-project/databases/(default)/documents/bug_reports/report-1', base: 'integration' } },
  });
  store.transition(ticket.id, 'in_progress');
  const firebase = fakeFirebase([]);

  const result = await bugs.syncBugReportStatuses({ config, store, services: { firebase } });
  assert.equal(result.updated, 1);
  assert.equal(firebase.patches[0].fields.status, 'fixing');
  assert.equal(firebase.patches[0].fields.runnerTicketId, ticket.shortId);
  assert.equal(firebase.patches[0].fields.githubIssueUrl, 'https://github.com/nikhil/workouttracker/issues/12');
  assert.equal(firebase.patches[0].fields.githubIssueNumber, 12);
});

test('Firestore value conversion handles nested report fields', () => {
  assert.deepEqual(bugs.firestoreFields({
    title: { stringValue: 'Bug' },
    count: { integerValue: '2' },
    state: { mapValue: { fields: { screen: { stringValue: 'session' } } } },
    logs: { arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } },
  }), {
    title: 'Bug',
    count: 2,
    state: { screen: 'session' },
    logs: ['a', 'b'],
  });
});
