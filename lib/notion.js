'use strict';

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

let token = null;

function setToken(t) {
  token = t;
}

async function request(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': VERSION,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Notion ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
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

module.exports = { setToken, queryDatabase, getPage, updatePage, createComment, getBlockChildren };
