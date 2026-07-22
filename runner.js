'use strict';

const fs = require('fs');
const path = require('path');
const notion = require('./lib/notion');
const github = require('./lib/github');
const { extractTicket } = require('./lib/ticket');
const { runTicket } = require('./lib/run');
const { extractIncubatorTicket, recoveryStatus, runIncubatorTicket, handoffTicket } = require('./lib/incubator');
const { runFlywheelPass } = require('./lib/flywheel');
const { runArchivePass } = require('./lib/archive');
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
const { resolveProjects, findProject } = require('./lib/projects');
const { openDb, closeDb } = require('./lib/db');
const { createStore } = require('./lib/store');
const { getProjectTracker, getIncubatorTracker } = require('./lib/trackers');
const { flushOutbox } = require('./lib/sync');
const { createStoreBackedTracker } = require('./lib/store-tracker');
const { applyTrackerCommands, upsertSnapshot } = require('./lib/cutover');
const { importLegacyState } = require('./lib/import-legacy');
const bugReports = require('./lib/bug-reports');

const baseDir = __dirname;
const QUEUE_EMPTY_LOG_INTERVAL_MS = 10 * 60 * 1000;
let lastQueueEmptyLogAt = 0;
let lastQueueWasEmpty = false;
let queueEmptyPolls = 0;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function logQueueEmpty(config, { now = Date.now() } = {}) {
  queueEmptyPolls += 1;
  if (!lastQueueWasEmpty || now - lastQueueEmptyLogAt >= QUEUE_EMPTY_LOG_INTERVAL_MS) {
    log(`queue empty (${queueEmptyPolls} poll${queueEmptyPolls === 1 ? '' : 's'}, poll rate ${config.pollIntervalMs / 1000}s)`);
    lastQueueEmptyLogAt = now;
  }
  lastQueueWasEmpty = true;
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
  if (config.repoPath) config.repoPath = path.resolve(baseDir, config.repoPath);
  config.baseDir = baseDir;
  if (config.pollIntervalMs === undefined) {
    config.pollIntervalMs = 15000;
  }
  return config;
}

function configNeedsNotion(config) {
  if (config.projectRegistry?.databaseId) return true;
  if (config.incubator?.databaseId || config.incubator?.tracker?.type === 'notion') return true;
  return (config.projects || config.boards || []).some((project) => !project.tracker || project.tracker.type === 'notion');
}

function configNeedsGithub(config) {
  if (bugReports.bugConfig(config)) return true;
  if (config.incubator?.tracker?.type === 'github') return true;
  return (config.projects || config.boards || []).some((project) => project.tracker?.type === 'github');
}

async function withStore(config, fn) {
  const db = openDb(baseDir);
  const previous = config.store;
  try {
    const store = createStore({ baseDir, db });
    config.store = store;
    importLegacyState({ store, baseDir, log });
    return await fn(store);
  } finally {
    if (previous === undefined) delete config.store;
    else config.store = previous;
    closeDb(db);
  }
}

function trackerCache() {
  return new Map();
}

function realProjectTracker(board, cache) {
  return getProjectTracker(board, { log, cache });
}

function realIncubatorTracker(config, cache) {
  return getIncubatorTracker(config, { log, cache });
}

function projectTrackerFacade({ store, board, cache }) {
  const tracker = realProjectTracker(board, cache);
  return createStoreBackedTracker({ store, tracker, projectKey: board.key || board.app });
}

function incubatorTrackerFacade({ store, config, cache }) {
  const tracker = realIncubatorTracker(config, cache);
  if (!tracker) return null;
  return createStoreBackedTracker({ store, tracker, projectKey: null });
}

function trackerForStoreTicket(config, ticket, cache) {
  if (ticket.kind === 'incubator') {
    const tracker = realIncubatorTracker(config, cache);
    if (!tracker) throw new Error('incubator tracker is not configured');
    return tracker;
  }
  const board = findProject(config, ticket.projectKey);
  if (!board) throw new Error(`unknown project for ticket ${ticket.shortId}: ${ticket.projectKey}`);
  return realProjectTracker(board, cache);
}

function incubatorSnapshot(ticket, status = 'queued') {
  return {
    tracker: 'notion',
    trackerId: ticket.pageId,
    projectKey: ticket.projectKey || ticket.app || 'incubator',
    kind: 'incubator',
    title: ticket.title,
    shortId: ticket.shortId,
    createdAt: ticket.createdTime,
    trackerMeta: {},
    mirroredStatus: ticket.status,
    status,
  };
}

async function pollIncubatorCommands(config, store, cache) {
  const tracker = realIncubatorTracker(config, cache);
  if (!tracker) return [];
  const commands = [];
  for (const page of await tracker.pagesByStatus('Not started')) {
    const ticket = extractIncubatorTicket(page);
    const existing = store.getByTrackerId('notion', ticket.pageId);
    const snapshot = incubatorSnapshot(ticket, 'queued');
    if (!existing) commands.push({ type: 'create', trackerId: ticket.pageId, snapshot });
    else if (existing.status !== 'queued') commands.push({ type: 'requeue', trackerId: ticket.pageId, ticket: existing, snapshot });
  }
  for (const page of await tracker.pagesByStatus('Done')) {
    const ticket = extractIncubatorTicket(page);
    let existing = store.getByTrackerId('notion', ticket.pageId);
    const snapshot = incubatorSnapshot(ticket, 'in_review');
    if (!existing) existing = upsertSnapshot(store, snapshot);
    commands.push({ type: 'incubator_approve', trackerId: ticket.pageId, ticket: existing, snapshot });
  }
  return commands;
}

async function pollAndApplyCommands(config, store, cache) {
  const combined = { promotions: [], forceDeploys: [], incubatorApprovals: [], epicMerges: [] };
  for (const board of config.projects) {
    const tracker = realProjectTracker(board, cache);
    if (!tracker.pollCommands) continue;
    const commands = await tracker.pollCommands({ store, projectKey: board.key || board.app, kind: 'feature' });
    const actions = applyTrackerCommands({ store, commands, log });
    combined.promotions.push(...actions.promotions);
    combined.forceDeploys.push(...actions.forceDeploys);
    combined.epicMerges.push(...actions.epicMerges);
  }
  const incubatorActions = applyTrackerCommands({ store, commands: await pollIncubatorCommands(config, store, cache), log });
  combined.incubatorApprovals.push(...incubatorActions.incubatorApprovals);
  return combined;
}

async function recoverStaleClaims(config, store = null) {
  if (store) {
    for (const ticket of store.listByStatus(null, 'in_progress')) {
      const requeue = ticket.attempts < config.maxAttempts;
      log(`stale claim "${ticket.title}" (${ticket.projectKey}) - ${requeue ? 'requeuing' : 'marking Failed'}`);
      store.transition(ticket.id, requeue ? 'queued' : 'failed');
      store.enqueueComment(ticket.id, requeue
        ? `Runner restarted mid-run (attempt ${ticket.attempts}/${config.maxAttempts}). Requeued.`
        : `Runner restarted mid-run and max attempts (${config.maxAttempts}) were reached.`);
    }
    return;
  }
  for (const board of config.projects) {
    const tracker = getProjectTracker(board, { log });
    for (const ticket of await tracker.listStale()) {
      if (ticket.attempts < config.maxAttempts) {
        log(`stale claim "${ticket.title}" (${board.key || board.app}) - requeuing`);
        await tracker.mirror(ticket, { status: 'queued' });
        await tracker.comment(ticket, `Runner restarted mid-run (attempt ${ticket.attempts}/${config.maxAttempts}). Requeued.`);
      } else {
        log(`stale claim "${ticket.title}" (${board.key || board.app}) - max attempts reached, marking Failed`);
        await tracker.mirror(ticket, { status: 'failed' });
        await tracker.comment(ticket, `Runner restarted mid-run and max attempts (${config.maxAttempts}) reached.`);
      }
    }
  }
  const incubatorTracker = getIncubatorTracker(config, { log });
  if (incubatorTracker) {
    for (const page of await incubatorTracker.pagesByStatus('In progress')) {
      const ticket = extractIncubatorTicket(page);
      const requeue = ticket.attempts < config.maxAttempts;
      log(`stale incubator claim "${ticket.title}" - ${requeue ? 'requeuing' : 'marking Failed'}`);
      await incubatorTracker.mirror(ticket, { status: requeue ? 'queued' : 'failed' });
      await incubatorTracker.comment(ticket, requeue
        ? `Runner restarted during planning (attempt ${ticket.attempts}/${config.maxAttempts}). Requeued.`
        : `Runner restarted during planning and max attempts (${config.maxAttempts}) were reached.`);
    }
  }
}

async function processStoreActions(config, store, actions, cache) {
  // A lone ticket moved straight to Done merges as-is: one merge commit that
  // preserves the ticket's own history.
  const promotions = (actions.promotions || [])
    .map((ticket) => store.getById(ticket.id))
    .filter(Boolean)
    .sort((a, b) => a.createdTime.localeCompare(b.createdTime));
  for (const ticket of promotions) {
    const board = findProject(config, ticket.projectKey);
    if (!board) {
      store.transition(ticket.id, 'needs_info');
      store.enqueueComment(ticket.id, `Automatic merge cannot start because project "${ticket.projectKey}" is not configured.`);
      continue;
    }
    const tracker = projectTrackerFacade({ store, board, cache });
    const result = await integration.promoteTicket({ config, board, ticket, tracker, log });
    if (result.status === 'remote_advanced') {
      log(`main advanced while promoting "${ticket.title}"; retrying next tick`);
      return { status: 'blocked', reason: 'remote_advanced' };
    }
  }

  // Moving an epic to Done is shorthand for "land everything under this epic on
  // main." Squash all of the epic's Testing children into a single commit on
  // main (rather than transferring each ticket's commits over as-is), then close
  // the epic. Children not yet in Testing are left for the human to merge.
  const epicMerges = (actions.epicMerges || [])
    .map((ref) => store.getById(ref.id))
    .filter((epic) => epic && epic.status !== 'done');
  for (const epicRef of epicMerges) {
    const epic = store.getById(epicRef.id);
    if (!epic || epic.status === 'done') continue;
    const board = findProject(config, epic.projectKey);
    if (!board) {
      store.enqueueComment(epic.id, `Automatic merge cannot start because project "${epic.projectKey}" is not configured.`);
      continue;
    }
    const children = store.childrenOf(epic.id).filter((child) => child.status === 'testing');
    const tracker = projectTrackerFacade({ store, board, cache });
    const result = await integration.promoteEpic({ config, board, epic, children, tracker, log });
    if (result.status === 'remote_advanced') {
      log(`main advanced while squashing epic "${epic.title}"; retrying next tick`);
      return { status: 'blocked', reason: 'remote_advanced' };
    }

    // Re-read children: the squash marked the merged ones Done; anything left in
    // Testing hit a conflict/validation failure and was parked individually.
    const after = store.childrenOf(epic.id);
    const mergedCount = after.filter((child) => child.status === 'done').length;
    const stragglers = after.filter((child) => !['done', 'cancelled'].includes(child.status));
    store.transition(epic.id, 'done');
    let note = `Epic marked Done. Squashed ${mergedCount} ticket(s) into a single commit on main.`;
    if (stragglers.length) {
      note += ` ${stragglers.length} ticket(s) were not in Testing yet and were left for you to merge individually: ${stragglers.map((child) => `"${child.title}"`).join(', ')}.`;
    }
    store.enqueueComment(epic.id, note);
    if (epic.parentId) store.enqueueComment(epic.parentId, `Epic "${epic.title}" is done (${mergedCount} ticket(s) merged).`);
  }

  for (const ticketRef of actions.forceDeploys) {
    const ticket = store.getById(ticketRef.id);
    if (!ticket) continue;
    const board = findProject(config, ticket.projectKey);
    if (!board) {
      store.enqueueComment(ticket.id, `Force deploy cannot start because project "${ticket.projectKey}" is not configured.`);
      continue;
    }
    await forceDeploy({
      baseDir, config, board, ticket,
      tracker: projectTrackerFacade({ store, board, cache }),
      integration,
      log,
    });
  }

  for (const ticketRef of actions.incubatorApprovals) {
    const ticket = store.getById(ticketRef.id);
    if (!ticket) continue;
    const board = findProject(config, ticket.projectKey || ticket.app);
    const tracker = incubatorTrackerFacade({ store, config, cache });
    const handedOff = await handoffTicket({ config, ticket, board, log, services: { tracker } });
    if (handedOff && ticket.status !== 'done') store.transition(ticket.id, 'done');
  }
  return { status: 'ok' };
}

async function reconcileBoards(config, onlyApp, cache = trackerCache()) {
  const blocked = [];
  for (const board of config.projects.filter((item) => !onlyApp || item.key === onlyApp || item.app === onlyApp)) {
    const tracker = config.store ? projectTrackerFacade({ store: config.store, board, cache }) : getProjectTracker(board, { log });
    const result = await integration.reconcileBoard({ config, board, tracker, eas, log });
    if (['fetch_failed', 'validation_failed', 'publish_failed'].includes(result.status)) {
      log(`${board.key || board.app} stack reconciliation blocked: ${result.error || result.status}`);
      blocked.push({ board: board.key || board.app, reason: result.status });
    }
  }
  return blocked.length ? { status: 'blocked', blocked } : { status: 'ok' };
}

function orderedProjects(config, store, key) {
  const projects = config.projects || [];
  const last = store.getKv(key, null);
  const index = projects.findIndex((board) => (board.key || board.app) === last);
  if (index < 0) return projects;
  return [...projects.slice(index + 1), ...projects.slice(0, index + 1)];
}

function flywheelResultMadeProgress(result, readyBefore, readyAfter) {
  return readyAfter > readyBefore
    || result?.status === 'epic_complete'
    || result?.status === 'epic_testing'
    || (result?.status === 'ok' && result.created > 0);
}

async function runFlywheelSlice({ config, store, cache, services }) {
  const runFlywheel = services.runFlywheelPass || runFlywheelPass;
  const key = 'flywheel:last-project';
  let fallback = null;
  for (const board of orderedProjects(config, store, key)) {
    const projectKey = board.key || board.app;
    const readyBefore = store.readyTickets().length;
    const result = await runFlywheel({ config, board, store, log, services: services.flywheelServices || {} });
    const readyAfter = store.readyTickets().length;
    if (!fallback || !['disabled', 'no_mission', 'cooldown'].includes(result?.status)) fallback = result;
    if (flywheelResultMadeProgress(result, readyBefore, readyAfter)) {
      store.setKv(key, projectKey);
      return result;
    }
  }
  return fallback || { status: 'idle' };
}

async function claimAndRunReadyTicket({ config, store, cache, trackerFor, dryRun = false, services }) {
  const flush = services.flushOutbox || flushOutbox;
  const syncBugStatuses = services.syncBugReportStatuses || bugReports.syncBugReportStatuses;
  const candidates = typeof store.fairReadyTickets === 'function' ? store.fairReadyTickets() : store.readyTickets();
  if (!candidates.length) {
    logQueueEmpty(config);
    return null;
  }
  lastQueueWasEmpty = false;
  queueEmptyPolls = 0;
  log(`queue (${candidates.length}): ${candidates.map((ticket) => `"${ticket.title}" [${ticket.kind}/${ticket.projectKey || 'no project'}, ${ticket.priority || 'Medium'}, attempt ${ticket.attempts}]`).join('; ')}`);
  if (dryRun) {
    log(`dry run - would claim "${candidates[0].title}"`);
    return { status: 'dry_run' };
  }

  const ticket = store.claimTicket(candidates[0].id);
  if (!ticket) return null;
  // Make externally-visible state catch up before a long implementation run.
  // Without this, the dashboard shows the local claim immediately, but GitHub
  // can remain "Not started" until the run finishes and the next tick flushes.
  await flush({ store, trackerFor, log });
  if (ticket.kind === 'incubator') {
    const board = findProject(config, ticket.projectKey || ticket.app);
    const tracker = incubatorTrackerFacade({ store, config, cache });
    if (!tracker) {
      store.transition(ticket.id, 'failed');
      store.enqueueComment(ticket.id, 'Incubator tracker is not configured; this planning ticket cannot run.');
      await flush({ store, trackerFor, log });
      return { status: 'failed' };
    }
    if (!board) {
      await tracker.mirror(ticket, { status: 'needs_info' });
      await tracker.comment(ticket, 'Select a Project, then return this ticket to Not started.');
      await flush({ store, trackerFor, log });
      return { status: 'needs_info' };
    }
    const runIncubator = services.runIncubatorTicket || runIncubatorTicket;
    const result = await runIncubator({ config, board, ticket, log, services: { tracker, store } });
    await flush({ store, trackerFor, log });
    store.exportJsonl();
    return result;
  }
  const board = findProject(config, ticket.projectKey);
  if (!board) {
    store.transition(ticket.id, 'failed');
    store.enqueueComment(ticket.id, `Project "${ticket.projectKey}" is not configured.`);
    await flush({ store, trackerFor, log });
    return { status: 'failed' };
  }
  const runFeature = services.runTicket || runTicket;
  const tracker = services.projectTrackerFacade
    ? services.projectTrackerFacade({ store, board, cache })
    : projectTrackerFacade({ store, board, cache });
  const result = await runFeature({
    config,
    board,
    ticket,
    log,
    services: { tracker, store },
  });
  await flush({ store, trackerFor, log });
  await syncBugStatuses({ config, store, log });
  store.exportJsonl();
  return result;
}

async function tick(config, { dryRun = false, services = {} } = {}) {
  if (!config.store) return withStore(config, () => tick(config, { dryRun, services }));
  const store = config.store;
  const cache = trackerCache();
  const trackerFor = (ticket) => trackerForStoreTicket(config, ticket, cache);
  const flush = services.flushOutbox || flushOutbox;
  const pollCommands = services.pollAndApplyCommands || pollAndApplyCommands;
  const processActions = services.processStoreActions || processStoreActions;
  const importBugs = services.importBugReports || bugReports.importBugReports;
  const syncBugStatuses = services.syncBugReportStatuses || bugReports.syncBugReportStatuses;
  const reconcile = services.reconcileBoards || reconcileBoards;
  const archive = services.runArchivePass || runArchivePass;

  if (dryRun) {
    return claimAndRunReadyTicket({ config, store, cache, trackerFor, dryRun, services });
  }

  await flush({ store, trackerFor, log });
  const actions = await pollCommands(config, store, cache);
  const processed = await processActions(config, store, actions, cache);
  if (processed.status === 'blocked') return processed;
  await importBugs({ config, store, log });
  await flush({ store, trackerFor, log });
  await syncBugStatuses({ config, store, log });

  let result = await claimAndRunReadyTicket({ config, store, cache, trackerFor, services });
  if (result) return result;

  await runFlywheelSlice({ config, store, cache, services });
  result = await claimAndRunReadyTicket({ config, store, cache, trackerFor, services });
  if (result) return result;

  const reconciled = await reconcile(config, undefined, cache);
  if (reconciled.status === 'blocked') log(`stack deploy blocked for ${reconciled.blocked.map((b) => b.board).join(', ')}; continuing to claim other work`);
  await syncBugStatuses({ config, store, log });
  for (const board of config.projects || []) await archive({ config, board, store, log });
  await flush({ store, trackerFor, log });
  store.exportJsonl();
  return reconciled.status === 'blocked' ? reconciled : undefined;
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
  if (!Array.isArray(config.projects) || !config.projects.length) throw new Error('config.projects must contain at least one project');
  for (const board of config.projects) {
    execFileSync('git', ['-C', board.repoPath, 'rev-parse', '--verify', `${board.baseBranch}^{commit}`], { stdio: 'ignore' });
    if (integration.integrationSettings(config, board).enabled) {
      const publisher = board.publisher || {};
      if (publisher.type === 'eas-update' && !(publisher.channel || board.easChannel)) {
        throw new Error(`${board.key || board.app}: EAS channel is required for eas-update publishing`);
      }
      const commands = board.validationCommands || board.integration?.validationCommands;
      if (!Array.isArray(commands) || !commands.length || commands.some((command) => !Array.isArray(command) || !command.length)) {
        throw new Error(`${board.key || board.app}: validationCommands must contain command arrays`);
      }
    }
  }
  if ((config.projects || []).some((project) => project.tracker?.type === 'notion') || config.incubator?.tracker?.type === 'notion' || config.incubator?.databaseId) {
    await notion.getCurrentBot();
  }
  for (const board of config.projects || []) {
    if (board.tracker?.type === 'github') {
      await getProjectTracker(board, { log }).healthcheck();
    }
  }
  const db = openDb(baseDir);
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') throw new Error(`ticket store integrity check failed: ${integrity}`);
  } finally {
    closeDb(db);
  }
  console.log('healthcheck ok: config, target repositories, ticket store, and trackers are reachable');
}

// Introspection over the local ticket store. Read-only except `export`, which
// writes the JSONL snapshot. `doctor` runs an integrity check and surfaces
// parked mirror ops that would otherwise only appear in logs.
function dbCommand(action) {
  const db = openDb(baseDir);
  try {
    const store = createStore({ baseDir, db });
    if (!action || action === 'status') {
      console.log(JSON.stringify(store.stats(), null, 2));
    } else if (action === 'export') {
      console.log(JSON.stringify(store.exportJsonl(), null, 2));
    } else if (action === 'doctor') {
      const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
      const stats = store.stats();
      console.log(JSON.stringify({ integrity, ...stats }, null, 2));
      if (integrity !== 'ok') throw new Error(`integrity check failed: ${integrity}`);
      if (stats.outboxParked > 0) log(`WARNING: ${stats.outboxParked} parked mirror op(s) — a tracker artifact may be unreachable`);
    } else {
      throw new Error(`unknown db action: ${action} (use: status | export | doctor)`);
    }
  } finally {
    closeDb(db);
  }
}

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
      const board = findProject(config, meta.projectKey || meta.app);
      let headSha = meta.headSha;
      try {
        if (!board) throw new Error(`unknown project ${meta.projectKey || meta.app}`);
        const settings = integration.integrationSettings(config, board);
        worktrees.fetchBranch(board.repoPath, settings.remote, settings.mainBranch);
        if (!headSha) headSha = worktrees.commitRef(board.repoPath, meta.branch);
        if (!worktrees.isAncestor(board.repoPath, headSha, `${settings.remote}/${settings.mainBranch}`)) {
          log(`keeping ${meta.branch} ("${meta.title}") - Done but not merged to ${settings.remote}/${settings.mainBranch}`);
          continue;
        }
      } catch (error) {
        log(`keeping ${meta.branch} ("${meta.title}") - cannot verify merge (${error.message})`);
        continue;
      }
      log(`cleaning up ${meta.branch} ("${meta.title}")`);
      worktrees.removeWorktree({ repoPath: board.repoPath, dir: meta.dir, branch: meta.branch, ignoreErrors: true });
      ticketState.removeMeta(baseDir, meta.shortId || path.basename(file, '.json'));
    } else {
      log(`keeping ${meta.branch} ("${meta.title}") - Status is "${status}"`);
    }
  }
}

async function pushCmd(config, shortId, channelOverride) {
  if (!shortId) {
    throw new Error('usage: node runner.js push <shortId> [channel]');
  }
  const metaPath = path.join(baseDir, 'worktrees', `${shortId}.json`);
  if (!fs.existsSync(metaPath)) {
    throw new Error(`no worktree metadata for ${shortId} (looked in worktrees/${shortId}.json)`);
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const board = findProject(config, meta.projectKey || meta.app);
  if (!board) throw new Error(`unknown project "${meta.projectKey || meta.app}"`);
  const publisher = board.publisher || {};
  const channel = channelOverride || (publisher.channel || board.easChannel);
  if (integration.integrationSettings(config, board).enabled) {
    throw new Error('isolated push is disabled while cumulative integration is enabled; use `node runner.js reconcile [project]`');
  }
  if (publisher.type !== 'eas-update') {
    throw new Error(`isolated push only supports eas-update projects (project "${meta.projectKey || meta.app}" uses ${publisher.type || 'none'})`);
  }
  if (!channel) {
    throw new Error(`no EAS channel configured for project "${meta.projectKey || meta.app}" (set publisher channel or pass one)`);
  }
  const res = eas.pushUpdate({ worktreeDir: meta.dir, appDir: board.workdir || board.appDir || '.', channel, message: `${board.scope}: ${meta.title} [${meta.branch}]`, log });
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
      build: updater.buildDashboard,
    });
    if (result.updated) {
      if (result.build && !result.build.ok) {
        log(`dashboard build failed after update (non-fatal): ${result.build.error.trim()}`);
      }
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
  // `db` introspection is purely local — no Notion token or project resolution needed.
  if (process.argv[2] === 'db') {
    dbCommand(process.argv[3]);
    return;
  }
  // `dashboard` is a read-only local view; like `db` it must not require any
  // tracker token or reach out to Notion/GitHub to resolve projects.
  if (process.argv[2] === 'dashboard') {
    const config = loadConfig();
    const port = Number(process.argv[3]) || Number(process.env.DASHBOARD_PORT) || 4600;
    const host = process.env.DASHBOARD_HOST || '127.0.0.1';
    const { startServer } = require('./lib/dashboard');
    const { url } = await startServer(config, { baseDir, port, host });
    log(`dashboard live at ${url} (Ctrl+C to stop)`);
    return;
  }
  const config = loadConfig();
  if (configNeedsNotion(config)) {
    if (!process.env.NOTION_TOKEN) {
      console.error('NOTION_TOKEN is not set. Copy .env.example to .env and fill it in.');
      process.exit(1);
    }
    notion.setToken(process.env.NOTION_TOKEN);
  }
  if (configNeedsGithub(config)) {
    if (!process.env.GITHUB_TOKEN) {
      console.error('GITHUB_TOKEN is not set for a GitHub tracker project.');
      process.exit(1);
    }
    github.setToken(process.env.GITHUB_TOKEN);
  }
  await resolveProjects(config, notion);
  if (configNeedsGithub(config)) {
    if (!process.env.GITHUB_TOKEN) {
      console.error('GITHUB_TOKEN is not set for a GitHub tracker project.');
      process.exit(1);
    }
    github.setToken(process.env.GITHUB_TOKEN);
  }

  const cmd = process.argv[2] || 'loop';
  const dryRun = process.argv.includes('--dry-run');

  if (cmd === 'once') {
    const result = await (dryRun
      ? withStore(config, () => tick(config, { dryRun }))
      : withOperationLock(baseDir, () => withStore(config, () => tick(config))));
    if (result?.status === 'blocked') throw new Error(`tick blocked: ${result.reason || 'reconciliation failed'}`);
  } else if (cmd === 'healthcheck') {
    await healthcheck(config);
  } else if (cmd === 'push') {
    await withOperationLock(baseDir, () => pushCmd(config, process.argv[3], process.argv[4]));
  } else if (cmd === 'cleanup') {
    await withOperationLock(baseDir, () => cleanup(config));
  } else if (cmd === 'reconcile') {
    const app = process.argv[3];
    if (app && !config.projects.some((board) => board.key === app || board.app === app)) throw new Error(`unknown project: ${app}`);
    const result = await withOperationLock(baseDir, () => withStore(config, () => reconcileBoards(config, app)));
    if (result.status === 'blocked') throw new Error(`reconciliation failed: ${result.blocked.map((b) => `${b.board} (${b.reason})`).join(', ')}`);
  } else if (cmd === 'stack') {
    const app = process.argv[3];
    const boards = config.projects.filter((board) => !app || board.key === app || board.app === app);
    if (!boards.length) throw new Error(`unknown project: ${app}`);
    await withStore(config, async () => {
      const cache = trackerCache();
      for (const board of boards) console.log(JSON.stringify(await integration.stackStatus({ config, board, tracker: projectTrackerFacade({ store: config.store, board, cache }) }), null, 2));
    });
  } else if (cmd === 'loop') {
    log(`ticket-runner starting: ${config.projects.map((b) => b.key || b.app).join(', ')} | poll ${config.pollIntervalMs / 1000}s | timeout ${Math.round(config.runTimeoutMs / 60000)}m | max ${config.maxAttempts} attempts`);
    if (checkForSelfUpdate(config)) process.exit(75);
    try {
      await withStore(config, (store) => recoverStaleClaims(config, store));
    } catch (error) {
      const repaired = await healServiceFailure(config, error);
      if (repaired?.status === 'deployed') process.exit(75);
      throw error;
    }
    heartbeat(config);
    for (;;) {
      try {
        if (checkForSelfUpdate(config)) process.exit(75);
        const outcome = await withOperationLock(baseDir, () => withStore(config, () => tick(config)));
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
    console.error(`unknown command: ${cmd} (use: loop | once [--dry-run] | healthcheck | stack [project] | reconcile [project] | cleanup | dashboard [port] | db [status|export|doctor])`);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly (node runner.js ...). Requiring the
// module (tests) just exposes the internals below without kicking off a poll.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { processStoreActions, pollAndApplyCommands, trackerCache, tick, claimAndRunReadyTicket, runFlywheelSlice };
