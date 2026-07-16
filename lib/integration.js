'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const easDefault = require('./eas');
const state = require('./healing-state');
const ticketState = require('./ticket-state');
const worktrees = require('./worktree');
const { runCommands } = require('./commands');
const { matchesAnyPattern } = require('./projects');
const { getProjectTracker } = require('./trackers');

// Resolve the tracker for a board, honoring an injected one (tests / callers)
// and otherwise building it from the project's tracker config.
function resolveTracker(args) {
  return args.tracker || getProjectTracker(args.board, { log: args.log || console.log });
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim();
}

function runValidation(dir, commands, timeoutMs, execute = execFileSync) {
  return runCommands(dir, commands, timeoutMs, { execute, label: 'validation' });
}

function integrationSettings(config, board) {
  const global = config.integration || {};
  const remote = board.remote || board.integration?.remote || global.remote || 'origin';
  const mainBranch = board.mainBranch || board.integration?.mainBranch || global.mainBranch || board.baseBranch || config.baseBranch || 'main';
  const validationCommands = board.validationCommands || board.integration?.validationCommands || [];
  return {
    enabled: board.integration?.enabled ?? (board.integrationMode !== 'disabled' && global.enabled !== false),
    remote,
    mainBranch,
    validationCommands,
    validationTimeoutMs: board.validationTimeoutMs || board.integration?.validationTimeoutMs || global.validationTimeoutMs || 20 * 60 * 1000,
    publisher: board.publisher || (board.easChannel ? { type: 'eas-update', channel: board.easChannel } : { type: 'none' }),
  };
}

function nativeSensitiveFiles(files, board) {
  return (files || []).filter((file) => matchesAnyPattern(file, board.stackBlockPatterns || []));
}

function projectKey(board) {
  return board.key || board.app;
}

function metaProjectKey(meta) {
  return meta?.projectKey || meta?.app;
}

function metaFromStoreTicket(ticket) {
  if (!ticket) return null;
  return {
    pageId: ticket.pageId,
    shortId: ticket.shortId,
    app: ticket.projectKey,
    projectKey: ticket.projectKey,
    repoPath: ticket.repoPath,
    branch: ticket.branch,
    dir: ticket.worktreeDir || ticket.dir,
    title: ticket.title,
    createdTime: ticket.createdTime,
    baseSha: ticket.baseSha,
    headSha: ticket.headSha,
    changedFiles: ticket.changedFiles || [],
    nativeSensitiveFiles: ticket.nativeSensitiveFiles || [],
    processedCommentIds: ticket.processedCommentIds || [],
    pendingCommentIds: ticket.pendingCommentIds || [],
  };
}

function repoPath(config, board) {
  return board.repoPath || config.repoPath;
}

function worktreesDir(config, board) {
  return path.join(config.baseDir, 'worktrees', projectKey(board));
}

function stateKey(board) {
  return `integration-${projectKey(board)}`;
}

function runSetup(dir, board, timeoutMs, execute = execFileSync) {
  return runCommands(dir, board.setupCommands || [], timeoutMs, { execute, label: 'setup' });
}

function isWithinDir(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function worktreesForBranch(repo, branch) {
  const output = git(repo, ['worktree', 'list', '--porcelain']);
  const matches = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { dir: line.slice('worktree '.length), branch: null };
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length);
    } else if (!line && current) {
      if (current.branch === `refs/heads/${branch}`) matches.push(current.dir);
      current = null;
    }
  }
  if (current?.branch === `refs/heads/${branch}`) matches.push(current.dir);
  return matches;
}

function removeGeneratedBranchWorktrees(config, board, branch) {
  const repo = repoPath(config, board);
  const root = worktreesDir(config, board);
  for (const dir of worktreesForBranch(repo, branch)) {
    if (!isWithinDir(root, dir)) continue;
    try { git(repo, ['worktree', 'remove', '--force', '--force', dir]); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function generatedWorktree(config, board, baseSha) {
  const repo = repoPath(config, board);
  const key = projectKey(board);
  const dir = path.join(worktreesDir(config, board), `integration-${key}`);
  const branch = `integration/${key}`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (fs.existsSync(dir)) {
    try { git(dir, ['merge', '--abort']); } catch {}
    try {
      git(dir, ['checkout', '-B', branch, baseSha]);
      git(dir, ['reset', '--hard', baseSha]);
      git(dir, ['clean', '-fd']);
      return { dir, branch };
    } catch {
      try { git(repo, ['worktree', 'remove', '--force', '--force', dir]); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  try { git(repo, ['worktree', 'prune']); } catch {}
  removeGeneratedBranchWorktrees(config, board, branch);
  try { git(repo, ['branch', '-D', branch]); } catch {}
  git(repo, ['worktree', 'add', '-b', branch, dir, baseSha]);
  return { dir, branch };
}

function removeGeneratedWorktree(config, dir, branch, board = null) {
  const repo = board ? repoPath(config, board) : config.repoPath;
  try { git(dir, ['merge', '--abort']); } catch {}
  try { git(repo, ['worktree', 'remove', '--force', '--force', dir]); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
  try { git(repo, ['worktree', 'prune']); } catch {}
  try { git(repo, ['branch', '-D', branch]); } catch {}
}

function conflictFiles(dir) {
  try {
    return git(dir, ['diff', '--name-only', '--diff-filter=U']).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stable(value[key]);
      return out;
    }, {});
  }
  return value;
}

function conflictFingerprint({ board, baseSha, appliedEntries, entry, files, error }) {
  const payload = stable({
    type: 'integration-stack-conflict',
    projectKey: projectKey(board),
    baseSha,
    stackPrefix: appliedEntries.map(({ ticket, meta }) => ({
      shortId: ticket.shortId,
      pageId: ticket.pageId,
      headSha: meta.headSha,
    })),
    ticket: {
      shortId: entry.ticket.shortId,
      pageId: entry.ticket.pageId,
      headSha: entry.meta.headSha,
    },
    files: [...files].sort(),
    error: files.length ? '' : String(error?.message || error || '').slice(0, 500),
  });
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function conflictMessage({ files, error, repair }) {
  const conflictList = files.length ? files.join('\n') : '(Git did not report file names)';
  const errorText = !files.length && error ? `\n\nGit error:\n${String(error.message || error).slice(-1200)}` : '';
  const repeatText = repair?.count > 1
    ? `\n\nThis same integration conflict has been seen ${repair.count} times for this ticket/head; the runner will keep excluding this ticket from the stack until it gets a new implementation.`
    : '';
  return `Warning: This ticket conflicted while composing the cumulative testing stack and needs human intervention.\n\nConflicting files:\n${conflictList}${errorText}${repeatText}`;
}

async function park(tracker, ticket, message, log) {
  await tracker.mirror(ticket, { status: 'needs_info' });
  await tracker.comment(ticket, message);
}

async function parkNativeSensitive(tracker, ticket, nativeFiles, log) {
  await tracker.mirror(ticket, { status: 'needs_info' });
  await tracker.comment(
    ticket,
    `📱 This ticket changes stack-blocked files and requires human testing before it can enter the cumulative stack.\n\n${nativeFiles.join('\n')}\n\nLeaving it in Needs info so the runner does not repeatedly re-implement and re-review the same stack-blocked change.`
  );
}

async function testingEntries({ config, board, tracker, extraTicket = null, log = console.log, parkInvalid = true, allowNativeSensitive = false }) {
  tracker = tracker || getProjectTracker(board, { log });
  const store = config.store;
  const tickets = store ? store.listByStatus(projectKey(board), 'testing') : await tracker.listByStatus('Testing');
  const byId = new Map(tickets.map((ticket) => [ticket.pageId, ticket]));
  if (extraTicket) byId.set(extraTicket.pageId, extraTicket);

  const entries = [];
  for (const ticket of byId.values()) {
    const freshTicket = store && ticket.id ? store.getById(ticket.id) : ticket;
    let meta = store ? metaFromStoreTicket(freshTicket) : ticketState.readMeta(config.baseDir, ticket.shortId);
    if (parkInvalid && meta && meta.pageId === ticket.pageId && metaProjectKey(meta) === projectKey(board) && !meta.headSha && meta.branch) {
      try {
        const settings = integrationSettings(config, board);
        const repo = repoPath(config, board);
        const headSha = worktrees.commitRef(repo, meta.branch);
        const baseSha = worktrees.mergeBase(repo, `${settings.remote}/${settings.mainBranch}`, headSha);
        const changedFiles = worktrees.changedFilesBetween(repo, baseSha, headSha);
        meta = {
          ...meta,
          shortId: ticket.shortId,
          projectKey: projectKey(board),
          createdTime: ticket.createdTime,
          baseSha,
          headSha,
          changedFiles,
          nativeSensitiveFiles: nativeSensitiveFiles(changedFiles, board),
          processedCommentIds: meta.processedCommentIds || [],
        };
        if (store && freshTicket?.id) {
          store.recordImplementation(freshTicket.id, {
            headSha,
            changedFiles,
            nativeSensitiveFiles: meta.nativeSensitiveFiles,
          });
        } else {
          ticketState.writeMeta(config.baseDir, ticket.shortId, meta);
        }
      } catch {}
    }
    if (!meta || meta.pageId !== ticket.pageId || metaProjectKey(meta) !== projectKey(board) || !meta.headSha) {
      if (parkInvalid) await park(tracker, ticket, '⚠ Cannot include this ticket in the testing stack because its branch metadata is missing or incomplete.', log);
      continue;
    }
    try {
      worktrees.commitRef(repoPath(config, board), meta.headSha);
    } catch {
      if (parkInvalid) await park(tracker, ticket, '⚠ Cannot include this ticket in the testing stack because its recorded commit no longer exists.', log);
      continue;
    }
    const nativeFiles = meta.nativeSensitiveFiles || nativeSensitiveFiles(meta.changedFiles, board);
    if (nativeFiles.length && !allowNativeSensitive) {
      if (parkInvalid) await parkNativeSensitive(tracker, ticket, nativeFiles, log);
      continue;
    }
    entries.push({ ticket: freshTicket || ticket, meta });
  }
  return entries.sort((a, b) => {
    const created = String(a.ticket.createdTime || a.meta.createdTime || '').localeCompare(String(b.ticket.createdTime || b.meta.createdTime || ''));
    return created || a.ticket.pageId.localeCompare(b.ticket.pageId);
  });
}

function ticketKey(ticket) {
  return ticket.pageId || ticket.trackerId || ticket.shortId || ticket.id;
}

function stackFingerprint(baseSha, entries) {
  return JSON.stringify({ baseSha, tickets: entries.map(({ ticket, meta }) => [ticketKey(ticket), meta.headSha]) });
}

async function reconcileBoard({ config, board, tracker, eas = easDefault, log = console.log, extraTicket = null, force = false, allowNativeSensitive = false, services = {} }) {
  tracker = tracker || getProjectTracker(board, { log });
  const settings = integrationSettings(config, board);
  if (!settings.enabled) return { status: 'disabled' };
  const fetchBranch = services.fetchBranch || worktrees.fetchBranch;
  const setup = services.runSetup || runSetup;
  const validate = services.runValidation || runValidation;
  const repo = repoPath(config, board);
  let baseSha;
  try {
    baseSha = fetchBranch(repo, settings.remote, settings.mainBranch);
  } catch (error) {
    const message = error?.message || String(error);
    log(`testing stack fetch failed for ${projectKey(board)}: ${message}`);
    return { status: 'fetch_failed', error: message };
  }
  let entries = await testingEntries({ config, board, tracker, extraTicket, log, allowNativeSensitive });
  const previous = config.store ? config.store.getStack(projectKey(board)) : state.readState(config.baseDir, stateKey(board), null);
  if (!force && previous?.status === 'deployed' && previous.fingerprint === stackFingerprint(baseSha, entries)) {
    return { status: 'unchanged', ...previous };
  }

  let built;
  while (true) {
    built = generatedWorktree(config, board, baseSha);
    let conflict = null;
    const appliedEntries = [];
    for (const entry of entries) {
      try {
        git(built.dir, ['merge', '--no-ff', '--no-edit', entry.meta.headSha]);
        appliedEntries.push(entry);
      } catch (error) {
        const files = conflictFiles(built.dir);
        conflict = { entry, files, error, appliedEntries: [...appliedEntries] };
        break;
      }
    }
    if (!conflict) break;
    const { ticket } = conflict.entry;
    let repair = null;
    if (config.store) {
      const fingerprint = conflictFingerprint({ board, baseSha, ...conflict });
      repair = config.store.recordRepair(fingerprint, {
        bumpCount: true,
        status: 'stack_conflict',
        meta: {
          projectKey: projectKey(board),
          baseSha,
          shortId: ticket.shortId,
          pageId: ticket.pageId,
          headSha: conflict.entry.meta.headSha,
          files: conflict.files,
          error: String(conflict.error?.message || conflict.error || '').slice(0, 1000),
        },
      });
      log(`integration conflict ${fingerprint.slice(0, 12)} for ${ticket.shortId} (${repair.count} time${repair.count === 1 ? '' : 's'})`);
    }
    try {
      await park(tracker, ticket, conflictMessage({ files: conflict.files, error: conflict.error, repair }), log);
    } catch (error) {
      log(`failed to park conflicted ticket ${ticket.shortId}; excluding from this stack pass anyway: ${error.message}`);
    }
    const conflictedKey = ticketKey(ticket);
    entries = entries.filter((entry) => ticketKey(entry.ticket) !== conflictedKey);
  }

  try {
    setup(built.dir, board, config.installTimeoutMs);
    validate(built.dir, settings.validationCommands, settings.validationTimeoutMs);
  } catch (error) {
    log(`testing stack validation failed for ${projectKey(board)}: ${error.message}`);
    return { status: 'validation_failed', error: error.message, entries };
  }

  const compositeSha = worktrees.head(built.dir);
  const titles = entries.map(({ ticket }) => ticket.title);
  const publisher = settings.publisher || { type: 'none' };
  if (publisher.type === 'eas-update') {
    const result = eas.pushUpdate({
      worktreeDir: built.dir,
      appDir: board.workdir || board.appDir || '.',
      channel: publisher.channel || board.easChannel,
      message: `${board.scope}: cumulative testing stack (${titles.length}: ${titles.join(', ') || 'main only'})`,
      log,
    });
    if (!result.ok) return { status: 'publish_failed', error: result.error, entries };
  } else if (publisher.type && publisher.type !== 'none') {
    return { status: 'publish_failed', error: `unsupported publisher: ${publisher.type}`, entries };
  }

  const deployed = {
    status: 'deployed',
    app: projectKey(board),
    projectKey: projectKey(board),
    baseSha,
    compositeSha,
    branch: built.branch,
    fingerprint: stackFingerprint(baseSha, entries),
    tickets: entries.map(({ ticket, meta }) => ({
      pageId: ticket.pageId, shortId: ticket.shortId, title: ticket.title, headSha: meta.headSha,
    })),
    deployedAt: new Date().toISOString(),
    publisher: publisher.type || 'none',
  };
  if (config.store) config.store.saveStack(projectKey(board), deployed);
  else state.writeState(config.baseDir, stateKey(board), deployed);
  return deployed;
}

async function admitTicket(args) {
  const tracker = resolveTracker(args);
  const log = args.log || console.log;
  const storeTicket = args.config.store && args.ticket.id ? args.config.store.getById(args.ticket.id) : args.ticket;
  const meta = args.config.store ? metaFromStoreTicket(storeTicket) : ticketState.readMeta(args.config.baseDir, args.ticket.shortId);
  if (!meta || meta.pageId !== args.ticket.pageId || metaProjectKey(meta) !== projectKey(args.board) || !meta.headSha) {
    await park(tracker, args.ticket, '⚠ Cannot add this ticket to the testing stack because its branch metadata is missing or incomplete.', log);
    return { status: 'excluded', reason: 'missing_metadata' };
  }
  const nativeFiles = meta.nativeSensitiveFiles || nativeSensitiveFiles(meta.changedFiles, args.board);
  if (nativeFiles.length && !args.allowNativeSensitive) {
    await parkNativeSensitive(tracker, args.ticket, nativeFiles, log);
    return { status: 'excluded', reason: 'native_sensitive' };
  }
  try {
    worktrees.commitRef(repoPath(args.config, args.board), meta.headSha);
  } catch {
    await park(tracker, args.ticket, '⚠ Cannot add this ticket to the testing stack because its recorded commit no longer exists.', log);
    return { status: 'excluded', reason: 'missing_commit' };
  }
  const result = await reconcileBoard({ ...args, tracker, extraTicket: args.ticket, force: true, allowNativeSensitive: !!args.allowNativeSensitive });
  const included = (result.tickets || []).some((item) => item.pageId === args.ticket.pageId);
  if (result.status === 'deployed' && !included) return { ...result, status: 'excluded' };
  if (!['deployed', 'unchanged'].includes(result.status)) {
    await park(tracker, args.ticket,
      `⚠ Review passed, but the cumulative testing stack could not be deployed. The ticket needs human intervention.\n\n${String(result.error || result.status).slice(-1800)}`,
      log);
  }
  return result;
}

function promotionWorktree(config, ticket, baseSha) {
  const key = ticket.projectKey || ticket.app || 'project';
  const dir = path.join(config.baseDir, 'worktrees', key, `promotion-${ticket.shortId}`);
  const branch = `promotion/${ticket.shortId}`;
  removeGeneratedWorktree(config, dir, branch, ticket.project || null);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(ticket.repoPath || config.repoPath, ['worktree', 'add', '-b', branch, dir, baseSha]);
  return { dir, branch };
}

async function promoteTicket({ config, board, ticket, tracker, log = console.log, services = {} }) {
  tracker = tracker || getProjectTracker(board, { log });
  const settings = integrationSettings(config, board);
  const storeTicket = config.store && ticket.id ? config.store.getById(ticket.id) : ticket;
  const meta = config.store ? metaFromStoreTicket(storeTicket) : ticketState.readMeta(config.baseDir, ticket.shortId);
  const repo = repoPath(config, board);
  if (!meta?.headSha || meta.pageId !== ticket.pageId || metaProjectKey(meta) !== projectKey(board)) {
    await park(tracker, ticket, '⚠ Automatic merge could not start because the ticket branch metadata is missing.', log);
    return { status: 'missing_metadata' };
  }
  try {
    worktrees.commitRef(repo, meta.headSha);
  } catch {
    await park(tracker, ticket, '⚠ Automatic merge could not start because the recorded ticket commit no longer exists.', log);
    return { status: 'missing_commit' };
  }

  const fetchBranch = services.fetchBranch || worktrees.fetchBranch;
  const setup = services.runSetup || runSetup;
  const validate = services.runValidation || runValidation;
  const baseSha = fetchBranch(repo, settings.remote, settings.mainBranch);
  if (worktrees.isAncestor(repo, meta.headSha, `${settings.remote}/${settings.mainBranch}`)) {
    await tracker.mirror(ticket, { status: 'done', forAI: false });
    await tracker.comment(ticket, `✅ Already present on ${settings.mainBranch}; finalized after recovery.\nTicket commit: ${meta.headSha}`);
    worktrees.removeWorktree({ repoPath: repo, dir: meta.dir, branch: meta.branch, ignoreErrors: true });
    if (config.store && storeTicket?.id) config.store.clearWorktree(storeTicket.id);
    else ticketState.removeMeta(config.baseDir, ticket.shortId);
    return { status: 'already_merged', mainSha: baseSha };
  }

  const promotion = promotionWorktree(config, { ...ticket, projectKey: projectKey(board), repoPath: repo, project: board }, baseSha);
  try {
    try {
      git(promotion.dir, ['merge', '--no-ff', '--no-edit', meta.headSha]);
    } catch (error) {
      const files = conflictFiles(promotion.dir);
      if (!files.length) throw error;
      await park(tracker, ticket, `⚠ Automatic merge conflicted with the latest ${settings.mainBranch}. The ticket needs human intervention.\n\nConflicting files:\n${files.join('\n') || '(Git did not report file names)'}`, log);
      return { status: 'conflict', files };
    }
    try {
      setup(promotion.dir, board, config.installTimeoutMs);
      validate(promotion.dir, settings.validationCommands, settings.validationTimeoutMs);
    } catch (error) {
      await park(tracker, ticket, `⚠ Automatic merge validation failed. The ticket needs human intervention.\n\n${error.message.slice(-1800)}`, log);
      return { status: 'validation_failed', error: error.message };
    }
    const mergeSha = worktrees.head(promotion.dir);
    const latest = fetchBranch(repo, settings.remote, settings.mainBranch);
    if (latest !== baseSha) return { status: 'remote_advanced', expected: baseSha, actual: latest };
    git(promotion.dir, ['push', settings.remote, `${mergeSha}:refs/heads/${settings.mainBranch}`]);
    await tracker.mirror(ticket, { status: 'done', forAI: false });
    await tracker.comment(ticket, `✅ Merged automatically to ${settings.mainBranch}.\nMerge: ${mergeSha}\nTicket commit: ${meta.headSha}`);
    worktrees.removeWorktree({ repoPath: repo, dir: meta.dir, branch: meta.branch, ignoreErrors: true });
    if (config.store && storeTicket?.id) config.store.clearWorktree(storeTicket.id);
    else ticketState.removeMeta(config.baseDir, ticket.shortId);
    return { status: 'merged', mainSha: mergeSha };
  } finally {
    removeGeneratedWorktree(config, promotion.dir, promotion.branch, board);
  }
}

async function stackStatus({ config, board, tracker, log = () => {} }) {
  tracker = tracker || getProjectTracker(board, { log });
  const tickets = config.store ? config.store.listByStatus(projectKey(board), 'testing') : await tracker.listByStatus('Testing');
  const desired = tickets.map((ticket) => {
    const meta = config.store ? metaFromStoreTicket(ticket) : ticketState.readMeta(config.baseDir, ticket.shortId);
    let issue = '';
    if (!meta?.headSha) issue = 'missing metadata or head SHA';
    else {
      const nativeFiles = meta.nativeSensitiveFiles || nativeSensitiveFiles(meta.changedFiles, board);
      if (nativeFiles.length) issue = `stack-blocked: ${nativeFiles.join(', ')}`;
    }
    return { title: ticket.title, shortId: ticket.shortId, headSha: meta?.headSha || '', issue, createdTime: ticket.createdTime };
  }).sort((a, b) => a.createdTime.localeCompare(b.createdTime) || a.shortId.localeCompare(b.shortId));
  return {
    app: projectKey(board),
    projectKey: projectKey(board),
    desired,
    deployed: config.store ? config.store.getStack(projectKey(board)) : state.readState(config.baseDir, stateKey(board), null),
  };
}

module.exports = {
  integrationSettings, nativeSensitiveFiles, runValidation, runSetup, stackFingerprint,
  testingEntries, reconcileBoard, admitTicket, promoteTicket, stackStatus,
};
