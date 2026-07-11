'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, closeDb } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createGithubTracker, markdownAppend } = require('../lib/trackers/github');

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
        return { status: 200, etag: 'etag-1', data: [...issues.values()] };
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
    body: { title: 'Build thing', body: 'Brief', labels: ['for-ai'] },
    opts: {},
  });
  assert.ok(transport.calls.graphql.some((call) => /addProjectV2ItemById/.test(call.query)));
  assert.ok(transport.calls.graphql.some((call) => /updateProjectV2ItemFieldValue/.test(call.query) && call.variables.optionId === 'OPT_TESTING'));
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
    labels: [{ name: 'for-ai' }],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  transport.issues.set(6, {
    number: 6,
    node_id: 'ISSUE_6',
    title: 'Force me',
    body: 'Brief',
    labels: [{ name: 'for-ai' }, { name: 'force-deploy' }],
    created_at: '2026-01-02T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  });
  const existing = store.upsertFromTracker({ tracker: 'github:acme/widgets', trackerId: '6', projectKey: 'widgets', title: 'Force me', status: 'in_review' });
  const gh = tracker(transport);
  const commands = await gh.pollCommands({ store, projectKey: 'widgets' });

  assert.equal(commands[0].type, 'create');
  assert.equal(commands[0].snapshot.trackerId, '5');
  assert.ok(commands.some((command) => command.type === 'force_deploy' && command.ticket.id === existing.id));
  assert.ok(transport.calls.rest.some((call) => call.method === 'DELETE' && call.path.includes('/labels/force-deploy')));
  assert.deepEqual(store.getKv('cursor:github:acme/widgets:issues:etag'), 'etag-1');
});

test('pollCommands ignores issues outside the configured Project v2 project', async (t) => {
  const { store } = fixture(t);
  const transport = fakeTransport();
  transport.issues.set(5, {
    number: 5,
    node_id: 'ISSUE_5',
    title: 'In project',
    body: 'Brief',
    labels: [{ name: 'for-ai' }],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  transport.issues.set(6, {
    number: 6,
    node_id: 'ISSUE_6',
    title: 'Other project',
    body: 'Brief',
    labels: [{ name: 'for-ai' }],
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
    labels: [{ name: 'for-ai' }],
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
    labels: [{ name: 'for-ai' }],
    projectStatus: 'In Progress',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  const gh = tracker(transport);
  const commands = await gh.pollCommands({ store, projectKey: 'widgets' });

  assert.equal(commands[0].snapshot.status, 'in_progress');
});
