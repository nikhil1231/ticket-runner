'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { forceDeploy } = require('../lib/force-deploy');

function fixture() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-deploy-'));
  fs.mkdirSync(path.join(baseDir, 'worktrees'));
  const ticket = { pageId: 'page-123', shortId: 'abc123', title: 'Ship it' };
  const meta = { pageId: ticket.pageId, app: 'caligo', branch: 'ai/abc123', dir: path.join(baseDir, 'tree') };
  fs.writeFileSync(path.join(baseDir, 'worktrees', 'abc123.json'), JSON.stringify(meta));
  const board = { app: 'caligo', appDir: 'apps/caligo', scope: 'caligo', easChannel: 'testing' };
  return { baseDir, ticket, meta, board };
}

test('a human override is one-shot and moves a successful push to Testing', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.baseDir, { recursive: true, force: true }));
  const updates = [];
  const comments = [];
  let admitArgs;
  const tracker = {
    mirror: async (_ticket, payload) => updates.push(payload),
    comment: async (_ticket, comment) => comments.push(comment),
  };
  const integration = { admitTicket: async (args) => { admitArgs = args; return { status: 'deployed', compositeSha: 'stack-123' }; } };

  const result = await forceDeploy({ ...f, config: { baseDir: f.baseDir }, tracker, integration, log: () => {} });

  assert.equal(result.status, 'deployed');
  assert.deepEqual(updates[0], { forceDeploy: false });
  assert.equal(updates[1].status, 'testing');
  assert.equal(admitArgs.ticket.pageId, f.ticket.pageId);
  assert.equal(admitArgs.allowNativeSensitive, true);
  assert.equal(result.compositeSha, 'stack-123');
  assert.match(comments[0], /cumulative Testing stack/);
});

test('a failed push parks in Needs info and requires another explicit checkbox tick', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.baseDir, { recursive: true, force: true }));
  const updates = [];
  const comments = [];
  const tracker = {
    mirror: async (_ticket, payload) => updates.push(payload),
    comment: async (_ticket, comment) => comments.push(comment),
  };
  const integration = { admitTicket: async () => ({ status: 'publish_failed', error: 'details\nEAS rejected update' }) };

  const result = await forceDeploy({ ...f, config: { baseDir: f.baseDir }, tracker, integration, log: () => {} });

  assert.equal(result.status, 'failed');
  assert.deepEqual(updates[0], { forceDeploy: false });
  assert.equal(updates[1].status, 'needs_info');
  assert.match(comments[0], /needs human intervention/);
  assert.match(comments[0], /EAS rejected update/);
});

test('a force deploy with missing metadata parks in Needs info', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.baseDir, { recursive: true, force: true }));
  fs.unlinkSync(path.join(f.baseDir, 'worktrees', 'abc123.json'));
  const updates = [];
  const comments = [];
  const tracker = {
    mirror: async (_ticket, payload) => updates.push(payload),
    comment: async (_ticket, comment) => comments.push(comment),
  };

  const result = await forceDeploy({ ...f, config: { baseDir: f.baseDir }, tracker, log: () => {} });

  assert.equal(result.status, 'failed');
  assert.deepEqual(updates[0], { forceDeploy: false });
  assert.equal(updates[1].status, 'needs_info');
  assert.match(comments[0], /metadata/i);
});
