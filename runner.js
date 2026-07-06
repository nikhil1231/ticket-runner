'use strict';

const fs = require('fs');
const path = require('path');
const notion = require('./lib/notion');
const { extractTicket } = require('./lib/ticket');
const { runTicket } = require('./lib/run');
const { extractIncubatorTicket, recoveryStatus, runIncubatorTicket, handoffTicket } = require('./lib/incubator');
const worktrees = require('./lib/worktree');
const eas = require('./lib/eas');
const updater = require('./lib/update');
const { execFileSync } = require('child_process');

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
  config.repoPath = path.resolve(baseDir, config.repoPath);
  config.baseDir = baseDir;
  return config;
}

const QUEUE_FILTER = {
  and: [
    { property: 'For AI', checkbox: { equals: true } },
    {
      or: [
        { property: 'Status', status: { equals: 'Backlog' } },
        { property: 'Status', status: { equals: 'Not started' } },
      ],
    },
  ],
};

async function findCandidates(config) {
  const all = [];
  for (const board of config.boards) {
    const pages = await notion.queryDatabase(board.databaseId, QUEUE_FILTER);
    for (const page of pages) all.push({ board, page, ticket: extractTicket(page) });
  }
  if (config.incubator?.databaseId) {
    const pages = await notion.queryDatabase(config.incubator.databaseId, {
      property: 'Status', status: { equals: 'Not started' },
    });
    for (const page of pages) {
      const ticket = extractIncubatorTicket(page);
      const board = config.boards.find((item) => item.app === ticket.app);
      all.push({ type: 'incubator', board, page, ticket });
    }
  }
  all.sort((a, b) => a.ticket.createdTime.localeCompare(b.ticket.createdTime));
  return all;
}

// Single-runner assumption: any For AI ticket still "In progress" at startup is an orphan
// from a crash or forced shutdown.
async function recoverStaleClaims(config) {
  for (const board of config.boards) {
    const pages = await notion.queryDatabase(board.databaseId, {
      and: [
        { property: 'For AI', checkbox: { equals: true } },
        { property: 'Status', status: { equals: 'In progress' } },
      ],
    });
    for (const page of pages) {
      const ticket = extractTicket(page);
      if (ticket.attempts < config.maxAttempts) {
        log(`stale claim "${ticket.title}" (${board.app}) — requeuing`);
        await notion.updatePage(ticket.pageId, { Status: { status: { name: 'Not started' } } });
        await notion.safeComment(ticket.pageId, `♻ Runner restarted mid-run (attempt ${ticket.attempts}/${config.maxAttempts}). Requeued.`, log);
      } else {
        log(`stale claim "${ticket.title}" (${board.app}) — max attempts reached, marking Failed`);
        await notion.updatePage(ticket.pageId, { Status: { status: { name: 'Failed' } } });
        await notion.safeComment(ticket.pageId, `❌ Runner restarted mid-run and max attempts (${config.maxAttempts}) reached.`, log);
      }
    }
  }
  if (config.incubator?.databaseId) {
    const pages = await notion.queryDatabase(config.incubator.databaseId, {
      property: 'Status', status: { equals: 'In progress' },
    });
    for (const page of pages) {
      const ticket = extractIncubatorTicket(page);
      const status = recoveryStatus(ticket, config.maxAttempts);
      log(`stale incubator claim "${ticket.title}" — ${status === 'Not started' ? 'requeuing' : 'marking Failed'}`);
      await notion.updatePage(ticket.pageId, { Status: { status: { name: status } } });
      await notion.safeComment(ticket.pageId, status === 'Not started'
        ? `Runner restarted during planning (attempt ${ticket.attempts}/${config.maxAttempts}). Requeued.`
        : `Runner restarted during planning and max attempts (${config.maxAttempts}) were reached.`, log);
    }
  }
}

async function processIncubatorHandoffs(config) {
  if (!config.incubator?.databaseId) return;
  const pages = await notion.queryDatabase(config.incubator.databaseId, {
    property: 'Status', status: { equals: 'Done' },
  });
  for (const page of pages) {
    const ticket = extractIncubatorTicket(page);
    const board = config.boards.find((item) => item.app === ticket.app);
    await handoffTicket({ config, ticket, board, log });
  }
}

async function tick(config, { dryRun = false } = {}) {
  if (!dryRun) await processIncubatorHandoffs(config);
  const candidates = await findCandidates(config);
  if (!candidates.length) {
    log('queue empty');
    return;
  }
  log(`queue (${candidates.length}): ${candidates.map((c) => c.type === 'incubator'
    ? `"${c.ticket.title}" [incubator/${c.ticket.app || 'no app'}, attempt ${c.ticket.attempts}]`
    : `"${c.ticket.title}" [${c.board.app}/${c.ticket.cli || 'policy default'}, attempt ${c.ticket.attempts}]`).join('; ')}`);
  if (dryRun) {
    log(`dry run — would claim "${candidates[0].ticket.title}"`);
    return;
  }
  const { board, ticket } = candidates[0];
  if (candidates[0].type === 'incubator') {
    if (!board) {
      await notion.updatePage(ticket.pageId, { Status: { status: { name: 'Needs info' } } });
      await notion.safeComment(ticket.pageId, 'Select Caligo or WorkoutTracker in App, then return this ticket to Not started.', log);
      return;
    }
    await runIncubatorTicket({ config, board, ticket, log });
  } else {
    await runTicket({ config, board, ticket, log });
  }
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

// Manually publish a worktree's current code to its board's EAS channel.
async function pushCmd(config, shortId, channelOverride) {
  if (!shortId) {
    console.error('usage: node runner.js push <shortId> [channel]');
    process.exit(1);
  }
  const metaPath = path.join(baseDir, 'worktrees', `${shortId}.json`);
  if (!fs.existsSync(metaPath)) {
    console.error(`no worktree metadata for ${shortId} (looked in worktrees/${shortId}.json)`);
    process.exit(1);
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const board = config.boards.find((b) => b.app === meta.app);
  const channel = channelOverride || (board && board.easChannel);
  if (!board || !channel) {
    console.error(`no EAS channel configured for app "${meta.app}" (set easChannel in config or pass one)`);
    process.exit(1);
  }
  const res = eas.pushUpdate({ worktreeDir: meta.dir, appDir: board.appDir, channel, message: `${board.scope}: ${meta.title} [${meta.branch}]`, log });
  if (!res.ok) process.exit(1);
  log(`pushed ${meta.branch} to "${channel}"`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function checkForSelfUpdate(config) {
  if (!config.autoUpdate?.enabled) return false;
  try {
    const result = updater.checkForUpdate({
      repoPath: baseDir,
      remote: config.autoUpdate.remote || 'origin',
      branch: config.autoUpdate.branch || 'main',
    });
    if (result.updated) {
      log(`updated runner to ${result.headSha.slice(0, 7)}; restarting service`);
      if (process.platform !== 'win32') {
        try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }); } catch {}
      }
      return true;
    }
    if (result.reason === 'dirty') log('auto-update skipped: runner checkout has local changes');
    if (result.reason === 'diverged') log('auto-update skipped: local and remote histories have diverged');
  } catch (e) {
    log(`auto-update check failed (non-fatal): ${e.message}`);
  }
  return false;
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
  } else if (cmd === 'push') {
    await pushCmd(config, process.argv[3], process.argv[4]);
  } else if (cmd === 'cleanup') {
    await cleanup(config);
  } else if (cmd === 'loop') {
    log(`ticket-runner starting: ${config.boards.map((b) => b.app).join(', ')} | poll ${config.pollIntervalMs / 1000}s | timeout ${Math.round(config.runTimeoutMs / 60000)}m | max ${config.maxAttempts} attempts`);
    if (checkForSelfUpdate(config)) process.exit(75);
    await recoverStaleClaims(config);
    // strictly serial: the next poll only happens after the current run ends
    for (;;) {
      try {
        if (checkForSelfUpdate(config)) process.exit(75);
        await tick(config);
      } catch (e) {
        log(`tick failed: ${e.message}`);
      }
      await sleep(config.pollIntervalMs);
    }
  } else {
    console.error(`unknown command: ${cmd} (use: loop | once [--dry-run] | push <shortId> [channel] | cleanup)`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
