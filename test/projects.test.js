'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  normalizeProject,
  projectFromRegistryPage,
  resolveProjects,
  resolveIncubatorProject,
  matchesAnyPattern,
} = require('../lib/projects');

function page(id, props) {
  return { id, properties: props };
}

function title(text) {
  return { type: 'title', title: [{ plain_text: text }] };
}

function rich(text) {
  return { type: 'rich_text', rich_text: [{ plain_text: text }] };
}

test('normalizes a generic project with validation-only publishing', () => {
  const project = normalizeProject({ baseDir: 'C:/runner', integration: { validationTimeoutMs: 123 } }, {
    key: 'LeetCode-Senpai',
    databaseId: 'tickets',
    repoPath: '../Learning/leetcode',
    baseBranch: 'main',
    remote: 'origin',
    mainBranch: 'main',
    scope: 'leetcode',
    setupCommands: [['py', '-3', '-m', 'venv', '.venv']],
    validationCommands: [['.venv\\Scripts\\python.exe', '-m', 'pytest']],
    publisher: { type: 'none' },
  });

  assert.equal(project.key, 'leetcode-senpai');
  assert.equal(project.scope, 'leetcode');
  assert.equal(project.publisher.type, 'none');
  assert.equal(project.validationTimeoutMs, 123);
  assert.equal(path.isAbsolute(project.repoPath), true);
});

test('parses project registry rows and command JSON', () => {
  const project = projectFromRegistryPage({ baseDir: process.cwd(), integration: {} }, page('project-page', {
    Key: title('leetcode-senpai'),
    Enabled: { type: 'checkbox', checkbox: true },
    'Ticket database ID': rich('ticket-db'),
    'Repo path': rich('C:\\Users\\Nikhil\\Documents\\Programming\\Learning\\leetcode'),
    'Base branch': rich('main'),
    Remote: rich('origin'),
    'Main branch': rich('main'),
    Scope: rich('leetcode'),
    Workdir: rich('.'),
    'Setup commands JSON': rich('[["py","-3","-m","venv",".venv"]]'),
    'Validation commands JSON': rich('[[".venv\\\\Scripts\\\\python.exe","-m","pytest"]]'),
    'Integration mode': { type: 'select', select: { name: 'testing-stack' } },
    Publisher: { type: 'select', select: { name: 'none' } },
    'Stack block patterns JSON': rich('["firebase.json","Dockerfile"]'),
  }));

  assert.equal(project.key, 'leetcode-senpai');
  assert.equal(project.databaseId, 'ticket-db');
  assert.deepEqual(project.validationCommands[0], ['.venv\\Scripts\\python.exe', '-m', 'pytest']);
  assert.equal(project.projectPageId, 'project-page');
});

test('resolveProjects prefers Notion registry and filters enabled rows', async () => {
  const notion = {
    queryDatabase: async (databaseId, filter) => {
      assert.equal(databaseId, 'registry-db');
      assert.deepEqual(filter, { property: 'Enabled', checkbox: { equals: true } });
      return [page('p1', {
        Key: title('demo'),
        Enabled: { type: 'checkbox', checkbox: true },
        'Ticket database ID': rich('ticket-db'),
        'Repo path': rich('.'),
      })];
    },
  };
  const config = { baseDir: process.cwd(), projectRegistry: { databaseId: 'registry-db' } };
  const projects = await resolveProjects(config, notion);
  assert.equal(projects.length, 1);
  assert.equal(config.projectsByKey.demo.databaseId, 'ticket-db');
});

test('resolveProjects prefers local config projects over legacy Notion registry', async () => {
  let queried = false;
  const notion = {
    queryDatabase: async () => {
      queried = true;
      return [];
    },
  };
  const config = {
    baseDir: process.cwd(),
    projectRegistry: { databaseId: 'legacy-registry' },
    projects: [{
      key: 'local',
      tracker: { type: 'github', owner: 'acme', repo: 'widgets', projectNumber: 1 },
      repoPath: '.',
    }],
  };
  const projects = await resolveProjects(config, notion);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].key, 'local');
  assert.equal(projects[0].tracker.type, 'github');
  assert.equal(queried, false);
});

test('normalizes explicit GitHub trackers without a Notion database ID', () => {
  const project = normalizeProject({ baseDir: process.cwd() }, {
    key: 'widgets',
    repoPath: '.',
    tracker: { type: 'github', owner: 'acme', repo: 'widgets', projectNumber: 7 },
  });
  assert.equal(project.databaseId, '');
  assert.equal(project.tracker.owner, 'acme');
});

test('resolveProjects keeps legacy boards working', async () => {
  const config = {
    baseDir: process.cwd(),
    repoPath: process.cwd(),
    baseBranch: 'main',
    boards: [{
      app: 'caligo',
      databaseId: 'db',
      appDir: 'apps/caligo',
      scope: 'caligo',
      easChannel: 'testing',
      integration: { validationCommands: [['yarn', 'test']] },
    }],
  };
  const projects = await resolveProjects(config, {});
  assert.equal(projects[0].key, 'caligo');
  assert.equal(projects[0].publisher.type, 'eas-update');
  assert.equal(projects[0].publisher.channel, 'testing');
  assert.equal(projects[0].setupCommands[0][0], 'yarn');
});

test('incubator project routing supports relation and key fallbacks', async () => {
  const config = {
    projects: [
      { key: 'leetcode-senpai', projectPageId: 'project-page' },
      { key: 'caligo', projectPageId: 'other' },
    ],
  };
  assert.equal(resolveIncubatorProject(config, page('ticket', {
    Project: { type: 'relation', relation: [{ id: 'project-page' }] },
  })).key, 'leetcode-senpai');
  assert.equal(resolveIncubatorProject(config, page('ticket', {
    'Project key': { type: 'select', select: { name: 'Caligo' } },
  })).key, 'caligo');
});

test('stack block patterns match exact, directory, and glob forms', () => {
  assert.equal(matchesAnyPattern('firebase.json', ['firebase.json']), true);
  assert.equal(matchesAnyPattern('server/config.py', ['server/**']), true);
  assert.equal(matchesAnyPattern('server/config.py', ['static/**']), false);
  assert.equal(matchesAnyPattern('apps/caligo/ios/App.swift', ['apps/caligo/ios/**']), true);
});
