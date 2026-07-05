'use strict';

const fs = require('fs');
const path = require('path');
const notion = require('./lib/notion');
const { extractTicket } = require('./lib/ticket');
const { runTicket } = require('./lib/run');
const worktrees = require('./lib/worktree');

const baseDir = __dirname;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function loadEnv() {
  const envPath = path.join(baseDir, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(path.join(baseDir, 'config.json'), 'utf8'));
  config.baseDir = baseDir;
  return config;
}

const QUEUE_FILTER = {
  and: [
    { property: 'For AI', checkbox: { equals: true } },
    { property: 'AI Status', select: { is_empty: true } },
    { property: 'Status', status: { does_not_equal: 'Done' } },
  ],
};

async function findCandidates(config) {
  const all = [];
  for (const board of config.boards) {
    const pages = await notion.queryDatabase(board.databaseId, QUEUE_FILTER);
    for (const page of pages) all.push({ board, page, ticket: extractTicket(page) });
  }
  all.sort((a, b) => a.ticket.createdTime.localeCompare(b.ticket.createdTime));
  return all;
}

// Single-runner assumption: anything still "Running" at startup is an orphan
// from a crash or forced shutdown.
async function recoverStaleClaims(config) {
  for (const board of config.boards) {
    const pages = await notion.queryDatabase(board.databaseId, {
      property: 'AI Status',
      select: { equals: 'Running' },
    });
    for (const page of pages) {
      const ticket = extractTicket(page);
      if (ticket.attempts < config.maxAttempts) {
        log(`stale claim "${ticket.title}" (${board.app}) — requeuing`);
        await notion.updatePage(ticket.pageId, { 'AI Status': { select: null } });
        await notion.safeComment(ticket.pageId, `♻ Runner restarted mid-run (attempt ${ticket.attempts}/${config.maxAttempts}). Requeued.`, log);
      } else {
        log(`stale claim "${ticket.title}" (${board.app}) — max attempts reached, marking Failed`);
        await notion.updatePage(ticket.pageId, { 'AI Status': { select: { name: 'Failed' } } });
        await notion.safeComment(ticket.pageId, `❌ Runner restarted mid-run and max attempts (${config.maxAttempts}) reached.`, log);
      }
    }
  }
}

async function tick(config, { dryRun = false } = {}) {
  const candidates = await findCandidates(config);
  if (!candidates.length) {
    log('queue empty');
    return;
  }
  log(`queue (${candidates.length}): ${candidates.map((c) => `"${c.ticket.title}" [${c.board.app}/${c.ticket.cli}, attempt ${c.ticket.attempts}]`).join('; ')}`);
  if (dryRun) {
    log(`dry run — would claim "${candidates[0].ticket.title}"`);
    return;
  }
  const { board, page, ticket } = candidates[0];
  await runTicket({ config, board, page, ticket, log });
}

// Removes worktrees + branches for tickets that were merged and marked Done.
async function cleanup(config) {
  const dir = path.join(baseDir, 'worktrees');
  if (!fs.existsSync(dir)) {
    log('no worktrees');
    return;
  }
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    let status;
    try {
      const page = await notion.getPage(meta.pageId);
      status = extractTicket(page).status;
    } catch (e) {
      log(`skipping ${meta.branch}: cannot fetch ticket (${e.message})`);
      continue;
    }
    if (status === 'Done') {
      log(`cleaning up ${meta.branch} ("${meta.title}")`);
      worktrees.removeWorktree({ repoPath: config.repoPath, dir: meta.dir, branch: meta.branch, ignoreErrors: true });
      fs.rmSync(path.join(dir, file));
    } else {
      log(`keeping ${meta.branch} ("${meta.title}") — Status is "${status}"`);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  loadEnv();
  if (!process.env.NOTION_TOKEN) {
    console.error('NOTION_TOKEN is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  notion.setToken(process.env.NOTION_TOKEN);
  const config = loadConfig();

  const cmd = process.argv[2] || 'loop';
  const dryRun = process.argv.includes('--dry-run');

  if (cmd === 'once') {
    await tick(config, { dryRun });
  } else if (cmd === 'cleanup') {
    await cleanup(config);
  } else if (cmd === 'loop') {
    log(`ticket-runner starting: ${config.boards.map((b) => b.app).join(', ')} | poll ${config.pollIntervalMs / 1000}s | timeout ${Math.round(config.runTimeoutMs / 60000)}m | max ${config.maxAttempts} attempts`);
    await recoverStaleClaims(config);
    // strictly serial: the next poll only happens after the current run ends
    for (;;) {
      try {
        await tick(config);
      } catch (e) {
        log(`tick failed: ${e.message}`);
      }
      await sleep(config.pollIntervalMs);
    }
  } else {
    console.error(`unknown command: ${cmd} (use: loop | once [--dry-run] | cleanup)`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
