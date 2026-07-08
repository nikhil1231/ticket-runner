'use strict';

const fs = require('fs');
const path = require('path');
const notion = require('./lib/notion');
const { extractTicket } = require('./lib/ticket');
const { runTicket } = require('./lib/run');
const { extractIncubatorTicket, recoveryStatus, runIncubatorTicket, handoffTicket } = require('./lib/incubator');
const { forceDeploy } = require('./lib/force-deploy');
const worktrees = require('./lib/worktree');
const eas = require('./lib/eas');
const integration = require('./lib/integration');
const ticketState = require('./lib/ticket-state');
const { withOperationLock } = require('./lib/operation-lock');
const updater = require('./lib/update');
const { execFileSync } = require('child_process');
const healingState = require('./lib/healing-state');
const { classifyFailure } = require('./lib/failure');
const { repairRunner } = require('./lib/self-heal');

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

async function processForceDeploys(config) {
  for (const board of config.boards) {
    const pages = await notion.queryDatabase(board.databaseId, {
      and: [
        { property: 'Status', status: { equals: 'In review' } },
        { property: 'Force deploy', checkbox: { equals: true } },
      ],
    });
    for (const page of pages) {
      const ticket = extractTicket(page);
      await forceDeploy({ baseDir, config, board, ticket, notion, integration, log });
    }
  }
}

async function processPromotions(config) {
  const pending = [];
  for (const board of config.boards) {
    const pages = await notion.queryDatabase(board.databaseId, {
      and: [
        { property: 'For AI', checkbox: { equals: true } },
        { property: 'Status', status: { equals: 'Done' } },
      ],
    });
    for (const page of pages) pending.push({ board, ticket: extractTicket(page) });
  }
  pending.sort((a, b) => a.ticket.createdTime.localeCompare(b.ticket.createdTime));
  for (const item of pending) {
    const result = await integration.promoteTicket({ config, ...item, notion, log });
    if (result.status === 'remote_advanced') {
      log(`main advanced while promoting "${item.ticket.title}"; retrying next tick`);
      return { status: 'blocked', reason: 'remote_advanced' };
    }
  }
  return { status: 'ok' };
}

async function reconcileBoards(config, onlyApp) {
  for (const board of config.boards.filter((item) => !onlyApp || item.app === onlyApp)) {
    const result = await integration.reconcileBoard({ config, board, notion, eas, log });
    if (['fetch_failed', 'validation_failed', 'publish_failed'].includes(result.status)) {
      log(`${board.app} stack reconciliation blocked: ${result.error || result.status}`);
      return { status: 'blocked', board: board.app, reason: result.status };
    }
  }
  return { status: 'ok' };
}

async function tick(config, { dryRun = false } = {}) {
  if (!dryRun) {
    const promotions = await processPromotions(config);
    if (promotions.status === 'blocked') return promotions;
    await processForceDeploys(config);
    await processIncubatorHandoffs(config);
    const reconciled = await reconcileBoards(config);
    if (reconciled.status === 'blocked') return reconciled;
  }
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
    return runIncubatorTicket({ config, board, ticket, log });
  } else {
    return runTicket({ config, board, ticket, log });
  }
}

function heartbeat(config, phase = 'ready') {
  let sha = '';
  try { sha = execFileSync('git', ['-C', baseDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  healingState.writeState(baseDir, 'heartbeat', {
    pid: process.pid,
    sha,
    phase,
    at: new Date().toISOString(),
  });
}

async function healServiceFailure(config, error) {
  const classification = classifyFailure(error, { runner: true });
  if (classification.kind !== 'infrastructure' || classification.transient) return null;
  const runDir = path.join(baseDir, 'runs', `service-${Date.now()}`);
  fs.mkdirSync(runDir, { recursive: true });
  log(`service-level infrastructure failure; invoking guarded self-healing (${error.message})`);
  return repairRunner({ config, error, runDir, log });
}

async function healthcheck(config) {
  execFileSync('git', ['-C', config.repoPath, 'rev-parse', '--verify', `${config.baseBranch}^{commit}`], { stdio: 'ignore' });
  if (!Array.isArray(config.boards) || !config.boards.length) throw new Error('config.boards must contain at least one board');
  for (const board of config.boards) {
    if (integration.integrationSettings(config, board).enabled) {
      if (!board.easChannel) throw new Error(`${board.app}: easChannel is required for cumulative integration`);
      const commands = board.integration?.validationCommands;
      if (!Array.isArray(commands) || !commands.length || commands.some((command) => !Array.isArray(command) || !command.length)) {
        throw new Error(`${board.app}: integration.validationCommands must contain command arrays`);
      }
    }
  }
  await notion.getCurrentBot();
  console.log('healthcheck ok: config, target repository, and Notion are reachable');
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
      const board = config.boards.find((item) => item.app === meta.app);
      let headSha = meta.headSha;
      try {
        if (!board) throw new Error(`unknown app ${meta.app}`);
        const settings = integration.integrationSettings(config, board);
        worktrees.fetchBranch(config.repoPath, settings.remote, settings.mainBranch);
        if (!headSha) headSha = worktrees.commitRef(config.repoPath, meta.branch);
        if (!worktrees.isAncestor(config.repoPath, headSha, `${settings.remote}/${settings.mainBranch}`)) {
          log(`keeping ${meta.branch} ("${meta.title}") — Done but not merged to ${settings.remote}/${settings.mainBranch}`);
          continue;
        }
      } catch (error) {
        log(`keeping ${meta.branch} ("${meta.title}") — cannot verify merge (${error.message})`);
        continue;
      }
      log(`cleaning up ${meta.branch} ("${meta.title}")`);
      worktrees.removeWorktree({ repoPath: config.repoPath, dir: meta.dir, branch: meta.branch, ignoreErrors: true });
      ticketState.removeMeta(baseDir, meta.shortId || path.basename(file, '.json'));
    } else {
      log(`keeping ${meta.branch} ("${meta.title}") — Status is "${status}"`);
    }
  }
}

// Manually publish a worktree's current code to its board's EAS channel.
async function pushCmd(config, shortId, channelOverride) {
  if (integration.integrationSettings(config, config.boards[0]).enabled) {
    throw new Error('isolated push is disabled while cumulative integration is enabled; use `node runner.js reconcile [app]`');
  }
  if (!shortId) {
    throw new Error('usage: node runner.js push <shortId> [channel]');
  }
  const metaPath = path.join(baseDir, 'worktrees', `${shortId}.json`);
  if (!fs.existsSync(metaPath)) {
    throw new Error(`no worktree metadata for ${shortId} (looked in worktrees/${shortId}.json)`);
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const board = config.boards.find((b) => b.app === meta.app);
  const channel = channelOverride || (board && board.easChannel);
  if (!board || !channel) {
    throw new Error(`no EAS channel configured for app "${meta.app}" (set easChannel in config or pass one)`);
  }
  const res = eas.pushUpdate({ worktreeDir: meta.dir, appDir: board.appDir, channel, message: `${board.scope}: ${meta.title} [${meta.branch}]`, log });
  if (!res.ok) throw new Error(`EAS push failed: ${res.error || 'unknown error'}`);
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
    const result = await (dryRun ? tick(config, { dryRun }) : withOperationLock(baseDir, () => tick(config)));
    if (result?.status === 'blocked') throw new Error(`tick blocked: ${result.reason || 'reconciliation failed'}`);
  } else if (cmd === 'healthcheck') {
    await healthcheck(config);
  } else if (cmd === 'push') {
    await withOperationLock(baseDir, () => pushCmd(config, process.argv[3], process.argv[4]));
  } else if (cmd === 'cleanup') {
    await withOperationLock(baseDir, () => cleanup(config));
  } else if (cmd === 'reconcile') {
    const app = process.argv[3];
    if (app && !config.boards.some((board) => board.app === app)) throw new Error(`unknown app: ${app}`);
    const result = await withOperationLock(baseDir, () => reconcileBoards(config, app));
    if (result.status === 'blocked') throw new Error(`${result.board} reconciliation failed: ${result.reason}`);
  } else if (cmd === 'stack') {
    const app = process.argv[3];
    const boards = config.boards.filter((board) => !app || board.app === app);
    if (!boards.length) throw new Error(`unknown app: ${app}`);
    for (const board of boards) console.log(JSON.stringify(await integration.stackStatus({ config, board, notion }), null, 2));
  } else if (cmd === 'loop') {
    log(`ticket-runner starting: ${config.boards.map((b) => b.app).join(', ')} | poll ${config.pollIntervalMs / 1000}s | timeout ${Math.round(config.runTimeoutMs / 60000)}m | max ${config.maxAttempts} attempts`);
    if (checkForSelfUpdate(config)) process.exit(75);
    try {
      await recoverStaleClaims(config);
    } catch (error) {
      const repaired = await healServiceFailure(config, error);
      if (repaired?.status === 'deployed') process.exit(75);
      throw error;
    }
    heartbeat(config);
    // strictly serial: the next poll only happens after the current run ends
    for (;;) {
      try {
        if (checkForSelfUpdate(config)) process.exit(75);
        const outcome = await withOperationLock(baseDir, () => tick(config));
        heartbeat(config);
        if (outcome?.status === 'restart_required') process.exit(75);
      } catch (e) {
        log(`tick failed: ${e.message}`);
        if (e.code === 'OPERATION_LOCKED') {
          await sleep(config.pollIntervalMs);
          continue;
        }
        const repaired = await healServiceFailure(config, e);
        if (repaired?.status === 'deployed') process.exit(75);
      }
      await sleep(config.pollIntervalMs);
    }
  } else {
    console.error(`unknown command: ${cmd} (use: loop | once [--dry-run] | healthcheck | stack [app] | reconcile [app] | cleanup)`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
