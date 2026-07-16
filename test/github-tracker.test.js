'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, closeDb } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createGithubTracker, markdownAppend } = require('../lib/trackers/github');
const { applyTrackerCommands } = require('../lib/cutover');

function fixture(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-gh-'));
  const db = openDb(baseDir);
  t.after(() => { closeDb(db); fs.rmSync(baseDir, { recursive: true, force: true }); });
  return { store: createStore({ baseDir, db }) };
}

function fakeTransport() {
  const calls = { rest: [], graphql: [] };
  const issues = new Map();
  let nextIssue = 42;
  return {
    calls,
    issues,
    async rest(method, apiPath, body, opts = {}) {
      calls.rest.push({ method, path: apiPath, body, opts });
      if (method === 'POST' && apiPath === '/repos/acme/widgets/issues') {
        const issue = {
          number: nextIssue,
          node_id: `ISSUE_${nextIssue}`,
          html_url: `https://github.com/acme/widgets/issues/${nextIssue}`,
          title: body.title,
          body: body.body,
          labels: (body.labels || []).map((name) => ({ name })),
          assignees: (body.assignees || []).map((login) => ({ login })),
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        };
        issues.set(nextIssue, issue);
        nextIssue += 1;
        return { status: 201, data: issue };
      }
      const issueMatch = apiPath.match(/^\/repos\/acme\/widgets\/issues\/(\d+)$/);
      if (method === 'PATCH' && issueMatch) {
        const issue = issues.get(Number(issueMatch[1])) || { number: Number(issueMatch[1]), labels: [] };
        Object.assign(issue, body);
        issues.set(issue.number, issue);
        return { status: 200, data: issue };
      }
      if (method === 'GET' && issueMatch) return { status: 200, data: issues.get(Number(issueMatch[1])) };
      if (method === 'POST' && /\/comments$/.test(apiPath)) return { status: 201, data: { id: 1, body: body.body } };
      if (method === 'GET' && /\/comments/.test(apiPath)) return { status: 200, data: [] };
      if (method === 'GET' && /\/issues\?/.test(apiPath)) {
        // A caller-supplied etag simulates "no issues updated since last poll".
        if (opts.etag) return { status: 304 };
        const query = new URLSearchParams(apiPath.slice(apiPath.indexOf('?') + 1));
        const assignee = query.get('assignee');
        const data = [...issues.values()].filter((issue) => {
          if (!assignee || assignee === '*') return (issue.assignees || []).length > 0;
          return (issue.assignees || []).some((item) => item.login === assignee);
        });
        return { status: 200, etag: 'etag-1', data };
      }
      if (method === 'DELETE' && /\/labels\//.test(apiPath)) return { status: 204, data: null };
      if (method === 'PUT' && /\/labels$/.test(apiPath)) return { status: 200, data: body.labels.map((name) => ({ name })) };
      if (method === 'GET' && apiPath === '/repos/acme/widgets') return { status: 200, data: { full_name: 'acme/widgets' } };
      throw new Error(`unexpected REST ${method} ${apiPath}`);
    },
    async graphql(query, variables) {
      calls.graphql.push({ query, variables });
      if (/ViewerLogin/.test(query)) return { viewer: { login: 'runner-bot' } };
      if (/AddProjectItem/.test(query)) return { addProjectV2ItemById: { item: { id: 'ITEM_1' } } };
      if (/UpdateProjectStatus/.test(query)) return { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } };
      if (/UpdateProjectText/.test(query)) return { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } };
      if (/ProjectItems/.test(query)) {
        return {
          node: {
            items: {
              nodes: [...issues.values()]
                .filter((issue) => !issue.skipProject)
                .map((issue) => ({
                  id: issue.projectItemId || 'ITEM_EXISTING',
                  content: { number: issue.number },
                  fieldValueByName: { name: issue.projectStatus || 'Not started' },
                })),
            },
          },
        };
      }
      throw new Error(`unexpected GraphQL ${query}`);
    },
  };
}

function tracker(transport, overrides = {}) {
  return createGithubTracker({
    owner: 'acme',
    repo: 'widgets',
    projectId: 'PROJECT_1',
    statusFieldId: 'STATUS_FIELD',
    statusOptions: { Testing: 'OPT_TESTING', 'In progress': 'OPT_PROGRESS', 'Not started': 'OPT_QUEUE' },
    engineFieldId: 'ENGINE_FIELD',
    modelFieldId: 'MODEL_FIELD',
    transport,
    ...overrides,
  });
}

test('upsertMirror creates an issue, adds it to Project v2, and updates status', async () => {
  const transport = fakeTransport();
  const gh = tracker(transport);
  const result = await gh.upsertMirror({ title: 'Build thing', body: 'Brief', kind: 'feature', trackerMeta: {} }, {
    status: 'testing',
    lastAgent: 'codex / gpt-5',
  });

  assert.equal(result.trackerId, '42');
  assert.equal(result.trackerMeta.projectItemId, 'ITEM_1');
  assert.deepEqual(transport.calls.rest[0], {
    method: 'POST',
    path: '/repos/acme/widgets/issues',
    body: { title: 'Build thing', body: 'Brief', labels: [], assignees: ['ticket-runner-bot'] },
    opts: {},
  });
  assert.ok(transport.calls.graphql.some((call) => /addProjectV2ItemById/.test(call.query)));
  assert.ok(transport.calls.graphql.some((call) => /updateProjectV2ItemFieldValue/.test(call.query) && call.variables.optionId === 'OPT_TESTING'));
});

test('upsertMirror labels a new epic issue with the epic label', async () => {
  const transport = fakeTransport();
  const gh = tracker(transport);
  await gh.upsertMirror({ title: 'Epic one', body: 'Scope', kind: 'epic', trackerMeta: {} }, { status: 'in_review' });
  const create = transport.calls.rest.find((call) => call.method === 'POST' && call.path === '/repos/acme/widgets/issues');
  assert.deepEqual(create.body.labels, ['epic']);
});

test('pollCommands emits cancel when the board moves an open ticket to Cancelled', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  transport.issues.set(9, {
    number: 9,
    node_id: 'ISSUE_9',
    title: 'Rejected epic',
    body: 'Brief',
    labels: [{ name: 'epic' }],
    assignees: [{ login: 'ticket-runner-bot' }],
    projectStatus: 'Cancelled',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  const existing = store.upsertFromTracker({ tracker: 'github:acme/widgets', trackerId: '9', projectKey: 'widgets', kind: 'epic', title: 'Rejected epic', status: 'in_review' });
  const gh = tracker(transport);
  const commands = await gh.pollCommands({ store, projectKey: 'widgets' });

  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'cancel');
  assert.equal(commands[0].ticket.id, existing.id);
});

test('pollCommands requeues an approved ticket from the board status even when the issue list is unchanged (304)', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  transport.issues.set(9, {
    number: 9,
    node_id: 'ISSUE_9',
    title: 'Approved epic',
    body: 'Brief',
    labels: [{ name: 'epic' }],
    assignees: [{ login: 'ticket-runner-bot' }],
    projectStatus: 'Not started', // human moved it In review -> Not started (approve)
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  const existing = store.upsertFromTracker({ tracker: 'github:acme/widgets', trackerId: '9', projectKey: 'widgets', kind: 'epic', title: 'Approved epic', status: 'in_review' });
  // Simulate the issue list returning 304: the board-status change didn't bump
  // the issue's updatedAt, so an etag/since-based issue poll sees nothing new.
  store.setKv('cursor:github:acme/widgets:issues:etag', 'etag-1');
  const gh = tracker(transport);
  const commands = await gh.pollCommands({ store, projectKey: 'widgets' });

  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'requeue');
  assert.equal(commands[0].ticket.id, existing.id);
});

test('pollCommands does not requeue when the board still matches the last mirrored status (mirror lag)', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  transport.issues.set(11, {
    number: 11,
    node_id: 'ISSUE_11',
    title: 'Just-claimed ticket',
    body: 'Brief',
    labels: [],
    assignees: [{ login: 'ticket-runner-bot' }],
    projectStatus: 'Not started', // board hasn't caught up to "In progress" yet
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  const existing = store.upsertFromTracker({ tracker: 'github:acme/widgets', trackerId: '11', projectKey: 'widgets', title: 'Just-claimed ticket', status: 'queued', mirroredStatus: 'Not started' });
  store.transition(existing.id, 'in_progress'); // runner claimed it; the "In progress" mirror hasn't propagated
  store.setKv('cursor:github:acme/widgets:issues:etag', 'etag-1'); // 304: no issue update
  const gh = tracker(transport);
  const commands = await gh.pollCommands({ store, projectKey: 'widgets' });

  assert.equal(commands.length, 0); // board == last mirrored -> not a human action, no requeue
});

test('pollCommands ignores stale board status shortly after a mirror write', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  transport.issues.set(12, {
    number: 12,
    node_id: 'ISSUE_12',
    title: 'Recently mirrored',
    body: 'Brief',
    labels: [],
    assignees: [{ login: 'ticket-runner-bot' }],
    projectStatus: 'Not started', // stale board value after we mirrored "Needs info"
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  const existing = store.upsertFromTracker({
    tracker: 'github:acme/widgets',
    trackerId: '12',
    projectKey: 'widgets',
    title: 'Recently mirrored',
    status: 'needs_info',
    mirroredStatus: 'Not started',
  });
  store.setMirrorState(existing.id, { mirroredStatus: 'Needs info' });
  store.setKv('cursor:github:acme/widgets:issues:etag', 'etag-1');
  const gh = tracker(transport);
  const commands = await gh.pollCommands({ store, projectKey: 'widgets' });

  assert.equal(commands.length, 0);
});

test('pollCommands does not requeue stack-blocked Needs info tickets from the board', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  transport.issues.set(13, {
    number: 13,
    node_id: 'ISSUE_13',
    title: 'Stack blocked',
    body: 'Brief',
    labels: [],
    assignees: [{ login: 'ticket-runner-bot' }],
    projectStatus: 'Not started',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  const existing = store.upsertFromTracker({
    tracker: 'github:acme/widgets',
    trackerId: '13',
    projectKey: 'widgets',
    title: 'Stack blocked',
    status: 'needs_info',
    mirroredStatus: 'Needs info',
  });
  store.recordImplementation(existing.id, { headSha: 'a'.repeat(40), nativeSensitiveFiles: ['package.json'] });
  store.setKv('cursor:github:acme/widgets:issues:etag', 'etag-1');
  const gh = tracker(transport);
  const commands = await gh.pollCommands({ store, projectKey: 'widgets' });

  assert.equal(commands.length, 0);
});

test('pollCommands does not requeue a Testing ticket from a stale Not started board status', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  transport.issues.set(14, {
    number: 14,
    node_id: 'ISSUE_14',
    title: 'Already in testing',
    body: 'Brief',
    labels: [],
    assignees: [{ login: 'ticket-runner-bot' }],
    projectStatus: 'Not started',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  store.upsertFromTracker({
    tracker: 'github:acme/widgets',
    trackerId: '14',
    projectKey: 'widgets',
    title: 'Already in testing',
    status: 'testing',
    mirroredStatus: 'Testing',
  });
  store.setKv('cursor:github:acme/widgets:issues:etag', 'etag-1');
  const gh = tracker(transport);
  const commands = await gh.pollCommands({ store, projectKey: 'widgets' });

  assert.equal(commands.length, 0);
});

test('pollCommands does not requeue a Failed ticket from a stale Not started board status', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  transport.issues.set(15, {
    number: 15,
    node_id: 'ISSUE_15',
    title: 'Already failed',
    body: 'Brief',
    labels: [],
    assignees: [{ login: 'ticket-runner-bot' }],
    projectStatus: 'Not started',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  store.upsertFromTracker({
    tracker: 'github:acme/widgets',
    trackerId: '15',
    projectKey: 'widgets',
    title: 'Already failed',
    status: 'failed',
    mirroredStatus: 'Failed',
  });
  store.setKv('cursor:github:acme/widgets:issues:etag', 'etag-1');
  const gh = tracker(transport);
  const commands = await gh.pollCommands({ store, projectKey: 'widgets' });

  assert.equal(commands.length, 0);
});

test('pollCommands does not re-cancel a ticket already in a terminal state', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  transport.issues.set(10, {
    number: 10,
    node_id: 'ISSUE_10',
    title: 'Already cancelled',
    body: 'Brief',
    labels: [],
    assignees: [{ login: 'ticket-runner-bot' }],
    projectStatus: 'Cancelled',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  store.upsertFromTracker({ tracker: 'github:acme/widgets', trackerId: '10', projectKey: 'widgets', title: 'Already cancelled', status: 'cancelled' });
  const gh = tracker(transport);
  const commands = await gh.pollCommands({ store, projectKey: 'widgets' });

  assert.equal(commands.length, 0);
});

test('appendSection replaces a managed body section', async () => {
  const transport = fakeTransport();
  const gh = tracker(transport);
  transport.issues.set(7, { number: 7, body: 'Intro\n\n## AI query answer\n\nOld', labels: [] });

  await gh.appendSection({ trackerId: '7' }, { markdown: '## AI query answer\n\nNew' });
  const patch = transport.calls.rest.find((call) => call.method === 'PATCH' && call.path.endsWith('/issues/7'));
  assert.equal(patch.body.body, 'Intro\n\n## AI query answer\n\nNew');
  assert.equal(markdownAppend('Intro', '## AI implementation plan', '## AI implementation plan\n\nPlan'), 'Intro\n\n## AI implementation plan\n\nPlan');
});

test('pollCommands creates unknown issues and detects force deploy labels', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  transport.issues.set(5, {
    number: 5,
    node_id: 'ISSUE_5',
    title: 'New issue',
    body: 'Brief',
    labels: [],
    assignees: [{ login: 'ticket-runner-bot' }],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  transport.issues.set(6, {
    number: 6,
    node_id: 'ISSUE_6',
    title: 'Force me',
    body: 'Brief',
    labels: [{ name: 'force-deploy' }],
    assignees: [{ login: 'ticket-runner-bot' }],
    created_at: '2026-01-02T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  });
  transport.issues.set(7, {
    number: 7,
    node_id: 'ISSUE_7',
    title: 'Unassigned',
    body: 'Brief',
    labels: [{ name: 'force-deploy' }],
    assignees: [],
    created_at: '2026-01-03T00:00:00Z',
    updated_at: '2026-01-03T00:00:00Z',
  });
  const existing = store.upsertFromTracker({ tracker: 'github:acme/widgets', trackerId: '6', projectKey: 'widgets', title: 'Force me', status: 'in_review' });
  const gh = tracker(transport);
  const commands = await gh.pollCommands({ store, projectKey: 'widgets' });

  assert.equal(commands[0].type, 'create');
  assert.equal(commands[0].snapshot.trackerId, '5');
  assert.ok(!commands.some((command) => command.trackerId === '7'));
  assert.ok(transport.calls.rest.some((call) => call.method === 'GET' && call.path.includes('assignee=ticket-runner-bot')));
  assert.ok(commands.some((command) => command.type === 'force_deploy' && command.ticket.id === existing.id));
  assert.ok(transport.calls.rest.some((call) => call.method === 'DELETE' && call.path.includes('/labels/force-deploy')));
  assert.deepEqual(store.getKv('cursor:github:acme/widgets:issues:etag'), 'etag-1');
});

test('pollCommands links GitHub issues that declare a parent issue', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  const parent = store.upsertFromTracker({
    tracker: 'github:acme/widgets',
    trackerId: '10',
    projectKey: 'widgets',
    kind: 'epic',
    title: 'Parent epic',
    status: 'queued',
  });
  transport.issues.set(24, {
    number: 24,
    node_id: 'ISSUE_24',
    title: 'Child ticket',
    body: 'parent #10\n\nDo the thing.',
    labels: [],
    assignees: [{ login: 'ticket-runner-bot' }],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  const gh = tracker(transport);
  const commands = await gh.pollCommands({ store, projectKey: 'widgets' });

  assert.equal(commands[0].type, 'create');
  assert.equal(commands[0].snapshot.parentTrackerId, '10');
  applyTrackerCommands({ store, commands });
  const child = store.getByTrackerId('github:acme/widgets', '24');
  assert.equal(child.parentId, parent.id);
});

test('pollCommands repairs existing GitHub issue parent links from body text', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  const parent = store.upsertFromTracker({
    tracker: 'github:acme/widgets',
    trackerId: '10',
    projectKey: 'widgets',
    kind: 'epic',
    title: 'Parent epic',
    status: 'queued',
  });
  const child = store.upsertFromTracker({
    tracker: 'github:acme/widgets',
    trackerId: '24',
    projectKey: 'widgets',
    title: 'Child ticket',
    status: 'needs_info',
  });
  transport.issues.set(24, {
    number: 24,
    node_id: 'ISSUE_24',
    title: 'Child ticket',
    body: 'Parent: https://github.com/acme/widgets/issues/10',
    labels: [],
    assignees: [{ login: 'ticket-runner-bot' }],
    projectStatus: 'Needs info',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  });
  const gh = tracker(transport);
  const commands = await gh.pollCommands({ store, projectKey: 'widgets' });

  const link = commands.find((command) => command.type === 'link_parent');
  assert.ok(link);
  assert.equal(link.ticket.id, child.id);
  applyTrackerCommands({ store, commands: [link] });
  assert.equal(store.getById(child.id).parentId, parent.id);
});

test('pollCommands ignores issues outside the configured Project v2 project', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  transport.issues.set(5, {
    number: 5,
    node_id: 'ISSUE_5',
    title: 'In project',
    body: 'Brief',
    labels: [],
    assignees: [{ login: 'ticket-runner-bot' }],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  transport.issues.set(6, {
    number: 6,
    node_id: 'ISSUE_6',
    title: 'Other project',
    body: 'Brief',
    labels: [],
    assignees: [{ login: 'ticket-runner-bot' }],
    created_at: '2026-01-02T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    skipProject: true,
  });
  const gh = tracker(transport);
  const commands = await gh.pollCommands({ store, projectKey: 'widgets' });

  assert.deepEqual(commands.map((command) => command.trackerId), ['5']);
});

test('pollCommands skips project-filtered polling when the configured Project v2 node is missing', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  const logs = [];
  transport.issues.set(5, {
    number: 5,
    node_id: 'ISSUE_5',
    title: 'In project',
    body: 'Brief',
    labels: [],
    assignees: [{ login: 'ticket-runner-bot' }],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  const originalGraphql = transport.graphql;
  transport.graphql = async (query, variables) => {
    if (/ProjectItems/.test(query)) {
      throw new Error(`GitHub GraphQL errors: [{"type":"NOT_FOUND","path":["node"],"message":"Could not resolve to a node with the global id of 'PROJECT_1'."}]`);
    }
    return originalGraphql(query, variables);
  };
  const gh = tracker(transport, { log: (message) => logs.push(message) });
  const commands = await gh.pollCommands({ store, projectKey: 'widgets' });

  assert.deepEqual(commands, []);
  assert.equal(store.getKv('cursor:github:acme/widgets:issues:since', null), null);
  assert.ok(logs.some((message) => message.includes('github project lookup failed')));
});

test('pollCommands parses GitHub default capitalization for in-progress status', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  transport.issues.set(5, {
    number: 5,
    node_id: 'ISSUE_5',
    title: 'Moving',
    body: 'Brief',
    labels: [],
    assignees: [{ login: 'ticket-runner-bot' }],
    projectStatus: 'In Progress',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  const gh = tracker(transport);
  const commands = await gh.pollCommands({ store, projectKey: 'widgets' });

  assert.equal(commands[0].snapshot.status, 'in_progress');
});
