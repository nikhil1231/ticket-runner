'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const github = require('../lib/github');

test('rest retries a transient fetch failure', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { etag: 'etag-1' },
    });
  };

  github.setToken('test-token');
  const result = await github.rest('GET', '/repos/acme/widgets');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.github.com/repos/acme/widgets');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(result, { status: 200, etag: 'etag-1', data: { ok: true } });
});
