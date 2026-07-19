'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  normalizeProject,
  resolveProjects,
  matchesAnyPattern,
} = require('../lib/projects');

const tracker = { type: 'github', owner: 'acme', repo: 'widgets', projectNumber: 7 };

test('normalizes a github-backed project with validation-only publishing', () => {
  const project = normalizeProject({ baseDir: 'C:/runner', integration: { validationTimeoutMs: 123 } }, {
    key: 'LeetCode-Senpai',
    tracker,
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
  assert.equal(project.tracker.owner, 'acme');
  assert.equal(path.isAbsolute(project.repoPath), true);
});

test('passes through a flywheel block, defaulting to empty when absent', () => {
  const withFlywheel = normalizeProject({ baseDir: process.cwd() }, {
    key: 'caligo',
    tracker,
    flywheel: { enabled: true, backlogThreshold: 3 },
  });
  assert.deepEqual(withFlywheel.flywheel, { enabled: true, backlogThreshold: 3 });

  const withoutFlywheel = normalizeProject({ baseDir: process.cwd() }, { key: 'caligo', tracker });
  assert.deepEqual(withoutFlywheel.flywheel, {});
});

test('requires local projects with supported github trackers', async () => {
  await assert.rejects(() => resolveProjects({ baseDir: process.cwd(), projects: [] }), /config\.projects/);
  assert.throws(() => normalizeProject({ baseDir: process.cwd() }, { key: 'missing' }), /tracker config is required/);
  assert.throws(() => normalizeProject({ baseDir: process.cwd() }, { key: 'bad', tracker: { type: 'jira' } }), /unsupported tracker type/);
  assert.throws(() => normalizeProject({ baseDir: process.cwd() }, { key: 'bad', tracker: { type: 'github', owner: 'acme' } }), /owner and repo/);
});

test('resolveProjects normalizes local config projects', async () => {
  const config = {
    baseDir: process.cwd(),
    projects: [{
      key: 'local',
      tracker,
      repoPath: '.',
    }],
  };
  const projects = await resolveProjects(config);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].key, 'local');
  assert.equal(projects[0].tracker.type, 'github');
  assert.equal(config.projectsByKey.local, projects[0]);
});

test('stack block patterns match exact, directory, and glob forms', () => {
  assert.equal(matchesAnyPattern('firebase.json', ['firebase.json']), true);
  assert.equal(matchesAnyPattern('server/config.py', ['server/**']), true);
  assert.equal(matchesAnyPattern('server/config.py', ['static/**']), false);
  assert.equal(matchesAnyPattern('apps/caligo/ios/App.swift', ['apps/caligo/ios/**']), true);
});
