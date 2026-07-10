'use strict';

const fs = require('fs');
const path = require('path');
const notion = require('../lib/notion');
const github = require('../lib/github');
const { openDb, closeDb } = require('../lib/db');
const { createStore } = require('../lib/store');
const { resolveProjects, resolveIncubatorProject } = require('../lib/projects');
const { getProjectTracker, getIncubatorTracker } = require('../lib/trackers');
const { extractIncubatorTicket } = require('../lib/incubator');

const baseDir = path.resolve(__dirname, '..');
const OPEN_STATUSES = new Set(['queued', 'in_progress', 'needs_info', 'in_review', 'testing', 'failed']);

function loadEnv() {
  const envPath = path.join(baseDir, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(path.join(baseDir, 'config.json'), 'utf8'));
  config.baseDir = baseDir;
  if (config.repoPath) config.repoPath = path.resolve(baseDir, config.repoPath);
  return config;
}

function parseArgs(argv) {
  const opts = { toTracker: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--to-tracker') {
      opts.toTracker = argv[i + 1] || '';
      i += 1;
    }
  }
  return opts;
}

async function importTicket({ store, tracker, ticket, projectKey, kind = 'feature' }) {
  const status = tracker.boardToStatus(ticket.status) || 'queued';
  if (!OPEN_STATUSES.has(status)) return null;
  let row = store.getByTrackerId('notion', ticket.pageId) || store.getByShortId(ticket.shortId);
  if (!row) {
    row = store.upsertFromTracker({
      tracker: 'notion',
      trackerId: ticket.pageId,
      projectKey,
      kind,
      title: ticket.title,
      shortId: ticket.shortId,
      createdAt: ticket.createdTime,
      enginePin: ticket.cli || '',
      modelPin: ticket.model || '',
      trackerMeta: { url: ticket.url || '', databaseId: tracker.databaseId || '' },
      mirroredStatus: ticket.status,
      status,
    });
  }
  try {
    const body = kind === 'incubator'
      ? (await tracker.fetchPlanMarkdown(ticket)).markdown
      : await tracker.fetchBody(ticket);
    store.refreshIntent(row.id, { title: ticket.title, body, enginePin: ticket.cli || '', modelPin: ticket.model || '' });
  } catch {}
  return store.getById(row.id);
}

async function retargetToGithub({ store, tracker, ticket, board }) {
  if (board.tracker?.type !== 'github') {
    throw new Error(`${board.key || board.app}: --to-tracker github requires the project tracker to be github`);
  }
  const migrated = store.retargetTracker(ticket.id, {
    tracker: 'github',
    trackerId: null,
    trackerMeta: {
      migratedFrom: { tracker: 'notion', trackerId: ticket.trackerId || ticket.pageId },
      url: ticket.url || '',
    },
  });
  await tracker.comment(ticket, 'Migrated into the local SQLite runner store. A GitHub issue will be created by the runner outbox.');
  return migrated;
}

async function migrateProject({ config, store, board, opts }) {
  if (board.tracker?.type !== 'notion' && opts.toTracker !== 'github') return { imported: 0, retargeted: 0 };
  const notionConfig = board.tracker?.type === 'notion' ? board.tracker : { type: 'notion', databaseId: board.databaseId };
  if (!notionConfig.databaseId) return { imported: 0, retargeted: 0 };
  const tracker = getProjectTracker({ ...board, tracker: notionConfig }, { log: console.log });
  const pages = await tracker.listRaw({ property: 'For AI', checkbox: { equals: true } });
  let imported = 0;
  let retargeted = 0;
  for (const page of pages) {
    const extracted = require('../lib/ticket').extractTicket(page);
    const row = await importTicket({ store, tracker, ticket: extracted, projectKey: board.key || board.app });
    if (!row) continue;
    imported += 1;
    if (opts.toTracker === 'github' && row.tracker !== 'github') {
      await retargetToGithub({ store, tracker, ticket: row, board });
      retargeted += 1;
    }
  }
  return { imported, retargeted };
}

async function migrateIncubator({ config, store, opts }) {
  const tracker = getIncubatorTracker(config, { log: console.log });
  if (!tracker) return { imported: 0, retargeted: 0 };
  const pages = [
    ...(await tracker.pagesByStatus('Not started')),
    ...(await tracker.pagesByStatus('In progress')),
    ...(await tracker.pagesByStatus('In review')),
    ...(await tracker.pagesByStatus('Needs info')),
    ...(await tracker.pagesByStatus('Failed')),
  ];
  const seen = new Set();
  let imported = 0;
  let retargeted = 0;
  for (const page of pages) {
    if (seen.has(page.id)) continue;
    seen.add(page.id);
    const extracted = extractIncubatorTicket(page);
    const board = resolveIncubatorProject(config, page) || resolveIncubatorProject(config, extracted);
    const projectKey = board?.key || extracted.projectKey || 'incubator';
    const row = await importTicket({ store, tracker, ticket: extracted, projectKey, kind: 'incubator' });
    if (!row) continue;
    imported += 1;
    if (opts.toTracker === 'github' && board && row.tracker !== 'github') {
      await retargetToGithub({ store, tracker, ticket: row, board });
      retargeted += 1;
    }
  }
  return { imported, retargeted };
}

async function main() {
  loadEnv();
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.NOTION_TOKEN) throw new Error('NOTION_TOKEN is required to import Notion tickets');
  notion.setToken(process.env.NOTION_TOKEN);
  if (opts.toTracker === 'github') {
    if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required with --to-tracker github');
    github.setToken(process.env.GITHUB_TOKEN);
  }
  const config = loadConfig();
  await resolveProjects(config, notion);
  const db = openDb(baseDir);
  try {
    const store = createStore({ baseDir, db });
    const summary = { projects: {}, incubator: null, totalImported: 0, totalRetargeted: 0 };
    for (const board of config.projects) {
      const result = await migrateProject({ config, store, board, opts });
      summary.projects[board.key || board.app] = result;
      summary.totalImported += result.imported;
      summary.totalRetargeted += result.retargeted;
    }
    summary.incubator = await migrateIncubator({ config, store, opts });
    summary.totalImported += summary.incubator.imported;
    summary.totalRetargeted += summary.incubator.retargeted;
    summary.export = store.exportJsonl();
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    closeDb(db);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { parseArgs, importTicket, OPEN_STATUSES };
