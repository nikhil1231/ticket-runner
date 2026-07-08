'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const easDefault = require('./eas');
const notionDefault = require('./notion');
const state = require('./healing-state');
const ticketState = require('./ticket-state');
const worktrees = require('./worktree');
const { extractTicket } = require('./ticket');

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim();
}

function commandName(cmd) {
  return process.platform === 'win32' && !/\.(?:exe|cmd|bat)$/i.test(cmd) ? `${cmd}.cmd` : cmd;
}

function runValidation(dir, commands, timeoutMs, execute = execFileSync) {
  const output = [];
  for (const command of commands || []) {
    if (!Array.isArray(command) || !command.length) throw new Error('validationCommands entries must be non-empty arrays');
    const [cmd, ...args] = command;
    try {
      output.push(execute(commandName(cmd), args, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        windowsHide: true,
      }));
    } catch (error) {
      const details = [error.stderr, error.stdout, error.message]
        .filter(Boolean).map(String).join('\n').trim().slice(-5000);
      throw new Error(`validation failed: ${command.join(' ')}\n${details}`);
    }
  }
  return output.join('\n');
}

function integrationSettings(config, board) {
  const global = config.integration || {};
  return {
    enabled: board.integration?.enabled ?? global.enabled !== false,
    remote: board.integration?.remote || global.remote || 'origin',
    mainBranch: board.integration?.mainBranch || global.mainBranch || config.baseBranch || 'main',
    validationCommands: board.integration?.validationCommands || [],
    validationTimeoutMs: board.integration?.validationTimeoutMs || global.validationTimeoutMs || 20 * 60 * 1000,
  };
}

function nativeSensitiveFiles(files, board) {
  const app = board.appDir.replace(/\\/g, '/').replace(/\/$/, '');
  return (files || []).filter((file) => {
    const normalized = file.replace(/\\/g, '/');
    return normalized === 'package.json'
      || /^(?:yarn\.lock|package-lock\.json|pnpm-lock\.yaml)$/.test(normalized)
      || normalized === `${app}/package.json`
      || normalized === `${app}/app.json`
      || normalized === `${app}/app.config.js`
      || normalized === `${app}/app.config.ts`
      || normalized === `${app}/eas.json`
      || normalized.startsWith(`${app}/ios/`)
      || normalized.startsWith(`${app}/android/`)
      || normalized.startsWith(`${app}/plugins/`);
  });
}

function generatedWorktree(config, board, baseSha) {
  const dir = path.join(config.baseDir, 'worktrees', `integration-${board.app}`);
  const branch = `integration/${board.app}`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (fs.existsSync(dir)) {
    try { git(dir, ['merge', '--abort']); } catch {}
    try {
      git(dir, ['checkout', '-B', branch, baseSha]);
      git(dir, ['reset', '--hard', baseSha]);
      git(dir, ['clean', '-fd']);
      return { dir, branch };
    } catch {
      try { git(config.repoPath, ['worktree', 'remove', '--force', '--force', dir]); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  try { git(config.repoPath, ['worktree', 'prune']); } catch {}
  try { git(config.repoPath, ['branch', '-D', branch]); } catch {}
  git(config.repoPath, ['worktree', 'add', '-b', branch, dir, baseSha]);
  return { dir, branch };
}

function removeGeneratedWorktree(config, dir, branch) {
  try { git(dir, ['merge', '--abort']); } catch {}
  try { git(config.repoPath, ['worktree', 'remove', '--force', '--force', dir]); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
  try { git(config.repoPath, ['worktree', 'prune']); } catch {}
  try { git(config.repoPath, ['branch', '-D', branch]); } catch {}
}

function conflictFiles(dir) {
  try {
    return git(dir, ['diff', '--name-only', '--diff-filter=U']).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

async function park(notion, ticket, message, log) {
  await notion.updatePage(ticket.pageId, { Status: { status: { name: 'In review' } } });
  await notion.safeComment(ticket.pageId, message, log);
}

async function testingEntries({ config, board, notion = notionDefault, extraTicket = null, log = console.log, parkInvalid = true }) {
  const pages = await notion.queryDatabase(board.databaseId, {
    property: 'Status', status: { equals: 'Testing' },
  });
  const byId = new Map(pages.map((page) => {
    const ticket = extractTicket(page);
    return [ticket.pageId, ticket];
  }));
  if (extraTicket) byId.set(extraTicket.pageId, extraTicket);

  const entries = [];
  for (const ticket of byId.values()) {
    let meta = ticketState.readMeta(config.baseDir, ticket.shortId);
    if (parkInvalid && meta && meta.pageId === ticket.pageId && meta.app === board.app && !meta.headSha && meta.branch) {
      try {
        const settings = integrationSettings(config, board);
        const headSha = worktrees.commitRef(config.repoPath, meta.branch);
        const baseSha = worktrees.mergeBase(config.repoPath, `${settings.remote}/${settings.mainBranch}`, headSha);
        const changedFiles = worktrees.changedFilesBetween(config.repoPath, baseSha, headSha);
        meta = {
          ...meta,
          shortId: ticket.shortId,
          createdTime: ticket.createdTime,
          baseSha,
          headSha,
          changedFiles,
          nativeSensitiveFiles: nativeSensitiveFiles(changedFiles, board),
          processedCommentIds: meta.processedCommentIds || [],
        };
        ticketState.writeMeta(config.baseDir, ticket.shortId, meta);
      } catch {}
    }
    if (!meta || meta.pageId !== ticket.pageId || meta.app !== board.app || !meta.headSha) {
      if (parkInvalid) await park(notion, ticket, '⚠ Cannot include this ticket in the testing stack because its branch metadata is missing or incomplete.', log);
      continue;
    }
    try {
      worktrees.commitRef(config.repoPath, meta.headSha);
    } catch {
      if (parkInvalid) await park(notion, ticket, '⚠ Cannot include this ticket in the testing stack because its recorded commit no longer exists.', log);
      continue;
    }
    const nativeFiles = meta.nativeSensitiveFiles || nativeSensitiveFiles(meta.changedFiles, board);
    if (nativeFiles.length) {
      if (parkInvalid) await park(notion, ticket, `📱 This ticket changes native-sensitive files and requires a new testing binary. It was not added to the OTA stack.\n\n${nativeFiles.join('\n')}`, log);
      continue;
    }
    entries.push({ ticket, meta });
  }
  return entries.sort((a, b) => {
    const created = String(a.ticket.createdTime || a.meta.createdTime || '').localeCompare(String(b.ticket.createdTime || b.meta.createdTime || ''));
    return created || a.ticket.pageId.localeCompare(b.ticket.pageId);
  });
}

function stackFingerprint(baseSha, entries) {
  return JSON.stringify({ baseSha, tickets: entries.map(({ ticket, meta }) => [ticket.pageId, meta.headSha]) });
}

async function reconcileBoard({ config, board, notion = notionDefault, eas = easDefault, log = console.log, extraTicket = null, force = false, services = {} }) {
  const settings = integrationSettings(config, board);
  if (!settings.enabled) return { status: 'disabled' };
  const fetchBranch = services.fetchBranch || worktrees.fetchBranch;
  const installDeps = services.installDeps || worktrees.installDeps;
  const validate = services.runValidation || runValidation;
  let baseSha;
  try {
    baseSha = fetchBranch(config.repoPath, settings.remote, settings.mainBranch);
  } catch (error) {
    const message = error?.message || String(error);
    log(`testing stack fetch failed for ${board.app}: ${message}`);
    return { status: 'fetch_failed', error: message };
  }
  let entries = await testingEntries({ config, board, notion, extraTicket, log });
  const previous = state.readState(config.baseDir, `integration-${board.app}`, null);
  if (!force && previous?.status === 'deployed' && previous.fingerprint === stackFingerprint(baseSha, entries)) {
    return { status: 'unchanged', ...previous };
  }

  let built;
  while (true) {
    built = generatedWorktree(config, board, baseSha);
    let conflict = null;
    for (const entry of entries) {
      try {
        git(built.dir, ['merge', '--no-ff', '--no-edit', entry.meta.headSha]);
      } catch (error) {
        const files = conflictFiles(built.dir);
        if (!files.length) throw error;
        conflict = { entry, files, error };
        break;
      }
    }
    if (!conflict) break;
    const { ticket } = conflict.entry;
    await park(notion, ticket, `⚠ This ticket conflicted while composing the cumulative testing stack and was removed for human review.\n\nConflicting files:\n${conflict.files.join('\n') || '(Git did not report file names)'}`, log);
    entries = entries.filter((entry) => entry.ticket.pageId !== ticket.pageId);
  }

  try {
    installDeps(built.dir, config.installTimeoutMs, { frozenLockfile: true });
    validate(built.dir, settings.validationCommands, settings.validationTimeoutMs);
  } catch (error) {
    log(`testing stack validation failed for ${board.app}: ${error.message}`);
    return { status: 'validation_failed', error: error.message, entries };
  }

  const compositeSha = worktrees.head(built.dir);
  const titles = entries.map(({ ticket }) => ticket.title);
  const result = eas.pushUpdate({
    worktreeDir: built.dir,
    appDir: board.appDir,
    channel: board.easChannel,
    message: `${board.scope}: cumulative testing stack (${titles.length}: ${titles.join(', ') || 'main only'})`,
    log,
  });
  if (!result.ok) return { status: 'publish_failed', error: result.error, entries };

  const deployed = {
    status: 'deployed',
    app: board.app,
    baseSha,
    compositeSha,
    branch: built.branch,
    fingerprint: stackFingerprint(baseSha, entries),
    tickets: entries.map(({ ticket, meta }) => ({
      pageId: ticket.pageId, shortId: ticket.shortId, title: ticket.title, headSha: meta.headSha,
    })),
    deployedAt: new Date().toISOString(),
  };
  state.writeState(config.baseDir, `integration-${board.app}`, deployed);
  return deployed;
}

async function admitTicket(args) {
  const notion = args.notion || notionDefault;
  const log = args.log || console.log;
  const meta = ticketState.readMeta(args.config.baseDir, args.ticket.shortId);
  if (!meta || meta.pageId !== args.ticket.pageId || meta.app !== args.board.app || !meta.headSha) {
    await park(notion, args.ticket, '⚠ Cannot add this ticket to the testing stack because its branch metadata is missing or incomplete.', log);
    return { status: 'excluded', reason: 'missing_metadata' };
  }
  const nativeFiles = meta.nativeSensitiveFiles || nativeSensitiveFiles(meta.changedFiles, args.board);
  if (nativeFiles.length) {
    await park(notion, args.ticket, `📱 This ticket changes native-sensitive files and requires a new testing binary. It was not added to the OTA stack.\n\n${nativeFiles.join('\n')}`, log);
    return { status: 'excluded', reason: 'native_sensitive' };
  }
  try {
    worktrees.commitRef(args.config.repoPath, meta.headSha);
  } catch {
    await park(notion, args.ticket, '⚠ Cannot add this ticket to the testing stack because its recorded commit no longer exists.', log);
    return { status: 'excluded', reason: 'missing_commit' };
  }
  const result = await reconcileBoard({ ...args, extraTicket: args.ticket, force: true });
  const included = (result.tickets || []).some((item) => item.pageId === args.ticket.pageId);
  if (result.status === 'deployed' && !included) return { ...result, status: 'excluded' };
  if (!['deployed', 'unchanged'].includes(result.status)) {
    await park(notion, args.ticket,
      `⚠ Review passed, but the cumulative testing stack could not be deployed. The ticket remains In review.\n\n${String(result.error || result.status).slice(-1800)}`,
      log);
  }
  return result;
}

function promotionWorktree(config, ticket, baseSha) {
  const dir = path.join(config.baseDir, 'worktrees', `promotion-${ticket.shortId}`);
  const branch = `promotion/${ticket.shortId}`;
  removeGeneratedWorktree(config, dir, branch);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(config.repoPath, ['worktree', 'add', '-b', branch, dir, baseSha]);
  return { dir, branch };
}

async function promoteTicket({ config, board, ticket, notion = notionDefault, log = console.log, services = {} }) {
  const settings = integrationSettings(config, board);
  const meta = ticketState.readMeta(config.baseDir, ticket.shortId);
  if (!meta?.headSha || meta.pageId !== ticket.pageId || meta.app !== board.app) {
    await park(notion, ticket, '⚠ Automatic merge could not start because the ticket branch metadata is missing.', log);
    return { status: 'missing_metadata' };
  }
  try {
    worktrees.commitRef(config.repoPath, meta.headSha);
  } catch {
    await park(notion, ticket, '⚠ Automatic merge could not start because the recorded ticket commit no longer exists.', log);
    return { status: 'missing_commit' };
  }

  const fetchBranch = services.fetchBranch || worktrees.fetchBranch;
  const installDeps = services.installDeps || worktrees.installDeps;
  const validate = services.runValidation || runValidation;
  const baseSha = fetchBranch(config.repoPath, settings.remote, settings.mainBranch);
  if (worktrees.isAncestor(config.repoPath, meta.headSha, `${settings.remote}/${settings.mainBranch}`)) {
    await notion.updatePage(ticket.pageId, { Status: { status: { name: 'Done' } }, 'For AI': { checkbox: false } });
    await notion.safeComment(ticket.pageId, `✅ Already present on ${settings.mainBranch}; finalized after recovery.\nTicket commit: ${meta.headSha}`, log);
    worktrees.removeWorktree({ repoPath: config.repoPath, dir: meta.dir, branch: meta.branch, ignoreErrors: true });
    ticketState.removeMeta(config.baseDir, ticket.shortId);
    return { status: 'already_merged', mainSha: baseSha };
  }

  const promotion = promotionWorktree(config, ticket, baseSha);
  try {
    try {
      git(promotion.dir, ['merge', '--no-ff', '--no-edit', meta.headSha]);
    } catch (error) {
      const files = conflictFiles(promotion.dir);
      if (!files.length) throw error;
      await park(notion, ticket, `⚠ Automatic merge conflicted with the latest ${settings.mainBranch}. The ticket was returned to In review.\n\nConflicting files:\n${files.join('\n') || '(Git did not report file names)'}`, log);
      return { status: 'conflict', files };
    }
    try {
      installDeps(promotion.dir, config.installTimeoutMs, { frozenLockfile: true });
      validate(promotion.dir, settings.validationCommands, settings.validationTimeoutMs);
    } catch (error) {
      await park(notion, ticket, `⚠ Automatic merge validation failed. The ticket was returned to In review.\n\n${error.message.slice(-1800)}`, log);
      return { status: 'validation_failed', error: error.message };
    }
    const mergeSha = worktrees.head(promotion.dir);
    const latest = fetchBranch(config.repoPath, settings.remote, settings.mainBranch);
    if (latest !== baseSha) return { status: 'remote_advanced', expected: baseSha, actual: latest };
    git(promotion.dir, ['push', settings.remote, `${mergeSha}:refs/heads/${settings.mainBranch}`]);
    await notion.updatePage(ticket.pageId, { Status: { status: { name: 'Done' } }, 'For AI': { checkbox: false } });
    await notion.safeComment(ticket.pageId, `✅ Merged automatically to ${settings.mainBranch}.\nMerge: ${mergeSha}\nTicket commit: ${meta.headSha}`, log);
    worktrees.removeWorktree({ repoPath: config.repoPath, dir: meta.dir, branch: meta.branch, ignoreErrors: true });
    ticketState.removeMeta(config.baseDir, ticket.shortId);
    return { status: 'merged', mainSha: mergeSha };
  } finally {
    removeGeneratedWorktree(config, promotion.dir, promotion.branch);
  }
}

async function stackStatus({ config, board, notion = notionDefault, log = () => {} }) {
  const pages = await notion.queryDatabase(board.databaseId, {
    property: 'Status', status: { equals: 'Testing' },
  });
  const desired = pages.map((page) => {
    const ticket = extractTicket(page);
    const meta = ticketState.readMeta(config.baseDir, ticket.shortId);
    let issue = '';
    if (!meta?.headSha) issue = 'missing metadata or head SHA';
    else {
      const nativeFiles = meta.nativeSensitiveFiles || nativeSensitiveFiles(meta.changedFiles, board);
      if (nativeFiles.length) issue = `native-sensitive: ${nativeFiles.join(', ')}`;
    }
    return { title: ticket.title, shortId: ticket.shortId, headSha: meta?.headSha || '', issue, createdTime: ticket.createdTime };
  }).sort((a, b) => a.createdTime.localeCompare(b.createdTime) || a.shortId.localeCompare(b.shortId));
  return {
    app: board.app,
    desired,
    deployed: state.readState(config.baseDir, `integration-${board.app}`, null),
  };
}

module.exports = {
  integrationSettings, nativeSensitiveFiles, runValidation, stackFingerprint,
  testingEntries, reconcileBoard, admitTicket, promoteTicket, stackStatus,
};
