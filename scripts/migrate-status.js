'use strict';

const fs = require('fs');
const path = require('path');

const baseDir = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(baseDir, 'config.json'), 'utf8'));
const OLD_VERSION = '2022-06-28';
const NEW_VERSION = '2026-03-11';
const NEW_STATUSES = [
  { name: 'In review', color: 'yellow' },
  { name: 'Needs info', color: 'orange' },
  { name: 'Failed', color: 'red' },
];
const AI_TO_STATUS = {
  Running: 'In progress',
  'In Review': 'In review',
  'Needs Info': 'Needs info',
  Failed: 'Failed',
};

function loadEnv() {
  const envPath = path.join(baseDir, '.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

async function request(version, method, apiPath, body) {
  const response = await fetch(`https://api.notion.com/v1${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': version,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${apiPath} -> ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function getPages(databaseId) {
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await request(OLD_VERSION, 'POST', `/databases/${databaseId}/query`, body);
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function getDataSource(databaseId) {
  const database = await request(NEW_VERSION, 'GET', `/databases/${databaseId}`);
  if (database.data_sources?.length !== 1) {
    throw new Error(`Expected one data source for ${databaseId}, found ${database.data_sources?.length || 0}`);
  }
  return request(NEW_VERSION, 'GET', `/data_sources/${database.data_sources[0].id}`);
}

function title(page) {
  return (page.properties.Name?.title || []).map((item) => item.plain_text).join('') || '(untitled)';
}

async function snapshot() {
  const backup = { createdAt: new Date().toISOString(), boards: [] };
  for (const board of config.boards) {
    const [database, dataSource, pages] = await Promise.all([
      request(OLD_VERSION, 'GET', `/databases/${board.databaseId}`),
      getDataSource(board.databaseId),
      getPages(board.databaseId),
    ]);
    backup.boards.push({ app: board.app, databaseId: board.databaseId, database, dataSource, pages });
    console.log(`${board.app}: snapshotted ${pages.length} tickets`);
  }
  const runsDir = path.join(baseDir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(runsDir, `status-migration-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`Backup: ${backupPath}`);
  return { backup, backupPath };
}

async function addStatusOptions(board) {
  const source = await getDataSource(board.databaseId);
  const status = source.properties.Status?.status;
  if (!status) throw new Error(`${board.app}: Status property is missing`);
  const existingNames = new Set(status.options.map((option) => option.name));
  const options = status.options.map((option) => ({ id: option.id }));
  for (const option of NEW_STATUSES) {
    if (!existingNames.has(option.name)) options.push(option);
  }
  await request(NEW_VERSION, 'PATCH', `/data_sources/${source.id}`, {
    properties: { Status: { status: { options } } },
  });
  const updated = await getDataSource(board.databaseId);
  const names = new Set(updated.properties.Status.status.options.map((option) => option.name));
  for (const option of NEW_STATUSES) {
    if (!names.has(option.name)) throw new Error(`${board.app}: failed to add ${option.name}`);
  }
  console.log(`${board.app}: status options ready`);
}

async function migratePages(board, originalPages) {
  let migrated = 0;
  for (const page of originalPages) {
    const aiStatus = page.properties['AI Status']?.select?.name;
    if (!aiStatus) continue;
    const nextStatus = AI_TO_STATUS[aiStatus];
    if (!nextStatus) throw new Error(`${board.app}: unknown AI Status ${aiStatus} on ${title(page)}`);
    await request(OLD_VERSION, 'PATCH', `/pages/${page.id}`, {
      properties: { Status: { status: { name: nextStatus } } },
    });
    migrated += 1;
    console.log(`${board.app}: ${title(page)} -> ${nextStatus}`);
  }
  console.log(`${board.app}: migrated ${migrated} tickets`);
}

async function renameLegacyProperty(board) {
  const source = await getDataSource(board.databaseId);
  if (source.properties['Legacy AI Status']) {
    console.log(`${board.app}: legacy property already renamed`);
    return;
  }
  if (!source.properties['AI Status']) throw new Error(`${board.app}: AI Status property is missing`);
  await request(NEW_VERSION, 'PATCH', `/data_sources/${source.id}`, {
    properties: { 'AI Status': { name: 'Legacy AI Status' } },
  });
  console.log(`${board.app}: renamed AI Status to Legacy AI Status`);
}

async function verify(backup) {
  for (const original of backup.boards) {
    const pages = await getPages(original.databaseId);
    if (pages.length !== original.pages.length) {
      throw new Error(`${original.app}: ticket count changed (${original.pages.length} -> ${pages.length})`);
    }
    const currentById = new Map(pages.map((page) => [page.id, page]));
    for (const oldPage of original.pages) {
      const page = currentById.get(oldPage.id);
      if (!page) throw new Error(`${original.app}: missing ticket ${oldPage.id}`);
      const aiStatus = oldPage.properties['AI Status']?.select?.name;
      if (aiStatus && page.properties.Status?.status?.name !== AI_TO_STATUS[aiStatus]) {
        throw new Error(`${original.app}: incorrect mapping for ${title(oldPage)}`);
      }
      const legacy = page.properties['Legacy AI Status']?.select?.name;
      if (aiStatus && legacy !== aiStatus) {
        throw new Error(`${original.app}: legacy value was not preserved for ${title(oldPage)}`);
      }
    }
    console.log(`${original.app}: verified ${pages.length} tickets with all legacy values preserved`);
  }
}

async function main() {
  loadEnv();
  if (!process.env.NOTION_TOKEN) throw new Error('NOTION_TOKEN is not set');
  const action = process.argv[2] || 'snapshot';
  const { backup, backupPath } = await snapshot();
  if (action === 'snapshot') return;
  if (action !== 'apply') throw new Error('Usage: node scripts/migrate-status.js [snapshot|apply]');
  for (const board of config.boards) await addStatusOptions(board);
  for (const board of config.boards) {
    const original = backup.boards.find((item) => item.databaseId === board.databaseId);
    await migratePages(board, original.pages);
  }
  for (const board of config.boards) await renameLegacyProperty(board);
  await verify(backup);
  console.log(`Migration complete. Rollback snapshot: ${backupPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
