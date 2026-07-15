'use strict';

const API = 'https://api.github.com';
const GRAPHQL = 'https://api.github.com/graphql';

let token = null;

function setToken(value) {
  token = value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headers(extra = {}) {
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(url, options, label) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(500 * (2 ** attempt));
      continue;
    }
    const data = await parseResponse(response);
    const etag = response.headers.get('etag') || '';
    if (response.status === 304) return { status: 304, etag, data: null };
    if (response.ok) return { status: response.status, etag, data };
    const message = typeof data === 'string' ? data : JSON.stringify(data);
    const error = new Error(`${label} -> ${response.status}: ${String(message || '').slice(0, 500)}`);
    if (response.status !== 429 && response.status < 500) throw error;
    lastError = error;
    const retryAfter = Number(response.headers.get('retry-after')) * 1000;
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 500 * (2 ** attempt));
  }
  throw lastError;
}

async function rest(method, path, body, opts = {}) {
  const extra = {};
  if (opts.etag) extra['If-None-Match'] = opts.etag;
  return request(`${API}${path}`, {
    method,
    headers: headers(extra),
    body: body === undefined ? undefined : JSON.stringify(body),
  }, `GitHub ${method} ${path}`);
}

async function graphql(query, variables = {}) {
  const result = await request(GRAPHQL, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query, variables }),
  }, 'GitHub GraphQL');
  if (result.data?.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${JSON.stringify(result.data.errors).slice(0, 800)}`);
  }
  return result.data?.data;
}

module.exports = { setToken, rest, graphql };
