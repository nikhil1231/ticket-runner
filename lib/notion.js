'use strict';

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const MODERN_VERSION = '2026-03-11';

let token = null;

function setToken(t) {
  token = t;
}

async function request(method, path, body, version = VERSION) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': version,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) return res.json();
      const text = await res.text().catch(() => '');
      const error = new Error(`Notion ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
      if (res.status !== 429 && res.status < 500) throw error;
      lastError = error;
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 500 * (2 ** attempt)));
    } catch (error) {
      if (/Notion .+ -> 4\d\d/.test(error.message) && !/-> 429/.test(error.message)) throw error;
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
    }
  }
  throw lastError;
}

async function queryDatabase(databaseId, filter) {
  const results = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const data = await request('POST', `/databases/${databaseId}/query`, body);
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

function getPage(pageId) {
  return request('GET', `/pages/${pageId}`);
}

function updatePage(pageId, properties) {
  return request('PATCH', `/pages/${pageId}`, { properties });
}

function getPageMarkdown(pageId) {
  return request('GET', `/pages/${pageId}/markdown`, undefined, MODERN_VERSION);
}

function updatePageMarkdown(pageId, command) {
  return request('PATCH', `/pages/${pageId}/markdown`, command, MODERN_VERSION);
}

async function getComments(blockId) {
  const results = [];
  let cursor;
  do {
    const params = new URLSearchParams({ block_id: blockId, page_size: '100' });
    if (cursor) params.set('start_cursor', cursor);
    const data = await request('GET', `/comments?${params}`, undefined, MODERN_VERSION);
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

let currentBot;
async function getCurrentBot() {
  if (!currentBot) currentBot = await request('GET', '/users/me', undefined, MODERN_VERSION);
  return currentBot;
}

async function getDataSourceId(databaseId) {
  const database = await request('GET', `/databases/${databaseId}`, undefined, MODERN_VERSION);
  if (!database.data_sources || database.data_sources.length !== 1) {
    throw new Error(`Expected exactly one data source for database ${databaseId}`);
  }
  return database.data_sources[0].id;
}

function movePage(pageId, dataSourceId) {
  return request('POST', `/pages/${pageId}/move`, {
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
  }, MODERN_VERSION);
}

// Notion caps a rich_text item at 2000 chars; stay under it and cap total size.
const COMMENT_CHUNK = 1800;
const COMMENT_MAX_CHUNKS = 10;

function createComment(pageId, text) {
  const chunks = [];
  for (let i = 0; i < text.length && chunks.length < COMMENT_MAX_CHUNKS; i += COMMENT_CHUNK) {
    chunks.push({ text: { content: text.slice(i, i + COMMENT_CHUNK) } });
  }
  return request('POST', '/comments', {
    parent: { page_id: pageId },
    rich_text: chunks.length ? chunks : [{ text: { content: '(empty)' } }],
  });
}

async function getBlockChildren(blockId, depth = 0) {
  const blocks = [];
  let cursor;
  do {
    const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : '?page_size=100';
    const data = await request('GET', `/blocks/${blockId}/children${qs}`);
    blocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  if (depth < 2) {
    for (const block of blocks) {
      if (block.has_children && block.type !== 'child_page' && block.type !== 'child_database') {
        block.children = await getBlockChildren(block.id, depth + 1);
      }
    }
  }
  return blocks;
}

// Comments are nice-to-have (summaries on the ticket) — never let a missing
// comment capability or a Notion hiccup fail an otherwise-completed run.
async function safeComment(pageId, text, log = console.log) {
  try {
    await createComment(pageId, text);
  } catch (e) {
    log(`comment failed (non-fatal): ${e.message}`);
  }
}

module.exports = {
  setToken, queryDatabase, getPage, updatePage, createComment, safeComment, getBlockChildren,
  getPageMarkdown, updatePageMarkdown, getComments, getCurrentBot, getDataSourceId, movePage,
};
