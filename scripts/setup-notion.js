'use strict';

const fs = require('fs');
const path = require('path');
const notion = require('../lib/notion');
const { resolveProjects } = require('../lib/projects');

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

async function ensureSelectOptions(databaseId, propertyName, options) {
  let source = await dataSource(databaseId);
  const select = source.properties[propertyName]?.select;
  if (!select) return source;
  const existing = new Set(select.options.map((option) => option.name));
  const additions = options.filter((option) => !existing.has(option.name));
  if (!additions.length) return source;
  await request('PATCH', `/data_sources/${source.id}`, {
    properties: {
      [propertyName]: {
        select: { options: [...select.options.map(({ id }) => ({ id })), ...additions] },
      },
    },
  });
  return dataSource(databaseId);
}

async function ensureMultiSelectOptions(databaseId, propertyName, options) {
  let source = await dataSource(databaseId);
  const multiSelect = source.properties[propertyName]?.multi_select;
  if (!multiSelect) return source;
  const existing = new Set(multiSelect.options.map((option) => option.name));
  const additions = options.filter((option) => !existing.has(option.name));
  if (!additions.length) return source;
  await request('PATCH', `/data_sources/${source.id}`, {
    properties: {
      [propertyName]: {
        multi_select: { options: [...multiSelect.options.map(({ id }) => ({ id })), ...additions] },
      },
    },
  });
  return dataSource(databaseId);
}

const KIND_OPTIONS = [
  { name: 'feature', color: 'blue' },
  { name: 'query', color: 'gray' },
  { name: 'incubator', color: 'purple' },
  { name: 'epic', color: 'orange' },
  { name: 'mission', color: 'red' },
];

const TAG_OPTIONS = [
  { name: 'Perpetual', color: 'green' },
];

async function setupAppBoard(board) {
  await addProperties(board.databaseId, {
    'Last agent': { rich_text: {} },
    'Force deploy': { checkbox: {} },
    Kind: { select: { options: KIND_OPTIONS } },
    Tags: { multi_select: { options: TAG_OPTIONS } },
  });
  await ensureSelectOptions(board.databaseId, 'Kind', KIND_OPTIONS);
  await ensureMultiSelectOptions(board.databaseId, 'Tags', TAG_OPTIONS);
  console.log(`${board.key || board.app}: Last agent + Force deploy + Kind + Tags ready`);
}

async function setupIncubator(projects) {
  const projectOptions = projects.map((project, index) => ({
    name: project.key || project.app,
    color: ['blue', 'green', 'purple', 'yellow', 'pink', 'orange', 'gray'][index % 7],
  }));
  let source = await addProperties(config.incubator.databaseId, {
    'Project key': { select: { options: projectOptions } },
    Attempts: { number: { format: 'number' } },
    'Last agent': { rich_text: {} },
  });
  source = await ensureSelectOptions(config.incubator.databaseId, 'Project key', projectOptions);
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
  config.baseDir = baseDir;
  if (config.repoPath) config.repoPath = path.resolve(baseDir, config.repoPath);
  notion.setToken(process.env.NOTION_TOKEN);
  const projects = await resolveProjects(config, notion);
  for (const board of projects) await setupAppBoard(board);
  await setupIncubator(projects);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
