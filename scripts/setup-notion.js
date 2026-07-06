'use strict';

const fs = require('fs');
const path = require('path');

const baseDir = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(baseDir, 'config.json'), 'utf8'));
const VERSION = '2026-03-11';

function loadEnv() {
  const envPath = path.join(baseDir, '.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

async function request(method, apiPath, body) {
  const response = await fetch(`https://api.notion.com/v1${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': VERSION,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${apiPath} -> ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function dataSource(databaseId) {
  const database = await request('GET', `/databases/${databaseId}`);
  if (database.data_sources?.length !== 1) throw new Error(`Expected one data source for ${databaseId}`);
  return request('GET', `/data_sources/${database.data_sources[0].id}`);
}

async function addProperties(databaseId, properties) {
  const source = await dataSource(databaseId);
  const missing = Object.fromEntries(Object.entries(properties).filter(([name]) => !source.properties[name]));
  if (!Object.keys(missing).length) return source;
  await request('PATCH', `/data_sources/${source.id}`, { properties: missing });
  return dataSource(databaseId);
}

async function setupAppBoard(board) {
  await addProperties(board.databaseId, {
    'Last agent': { rich_text: {} },
    'Force deploy': { checkbox: {} },
  });
  console.log(`${board.app}: Last agent + Force deploy ready`);
}

async function setupIncubator() {
  let source = await addProperties(config.incubator.databaseId, {
    App: { select: { options: [
      { name: 'caligo', color: 'blue' },
      { name: 'workouttracker', color: 'green' },
    ] } },
    Attempts: { number: { format: 'number' } },
    'Last agent': { rich_text: {} },
  });
  const status = source.properties.Status?.status;
  if (!status) throw new Error('Ticket Incubator is missing a Status property');
  const additions = [
    { name: 'In review', color: 'yellow' },
    { name: 'Needs info', color: 'orange' },
    { name: 'Failed', color: 'red' },
  ].filter((item) => !status.options.some((option) => option.name === item.name));
  if (additions.length) {
    await request('PATCH', `/data_sources/${source.id}`, {
      properties: { Status: { status: { options: [...status.options.map(({ id }) => ({ id })), ...additions] } } },
    });
    source = await dataSource(config.incubator.databaseId);
  }
  const required = ['In review', 'Needs info', 'Failed'];
  const names = new Set(source.properties.Status.status.options.map((option) => option.name));
  for (const name of required) if (!names.has(name)) throw new Error(`Failed to add incubator status ${name}`);
  console.log('incubator: schema ready');
}

async function main() {
  loadEnv();
  if (!process.env.NOTION_TOKEN) throw new Error('NOTION_TOKEN is not set');
  for (const board of config.boards) await setupAppBoard(board);
  await setupIncubator();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
