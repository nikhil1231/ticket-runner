'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquire, withOperationLock } = require('../lib/operation-lock');

test('operation lock rejects overlap and releases after completion', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const release = acquire(dir);
  assert.throws(() => acquire(dir), /held by pid/);
  release();
  const value = await withOperationLock(dir, async () => 42);
  assert.equal(value, 42);
  const again = acquire(dir);
  again();
});
