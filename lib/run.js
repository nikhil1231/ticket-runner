'use strict';

const fs = require('fs');
const path = require('path');
const { getProjectTracker } = require('./trackers');
const { spawnEngine, QUOTA_RE, readTail } = require('./engine');
const { buildCandidateChain, runWithFallback } = require('./fallback');
const worktrees = require('./worktree');
const review = require('./review');
const integration = require('./integration');
const ticketState = require('./ticket-state');
const { isQueryOnlyTicket, runQueryTicket } = require('./query');
const { classifyFailure, textOf } = require('./failure');
const { repairRunner } = require('./self-heal');

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n[...truncated]` : text;
}

function extractCommitMessage(lastMessage, defaultScope) {
  const marker = lastMessage.match(/^COMMIT_MESSAGE:\s*(.+)$/im)?.[1]
    ?.replace(/[`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!marker) return `${defaultScope}: implement ticket changes`;
  if (/^([a-z0-9][a-z0-9_-]{0,40}):\s+\S/i.test(marker)) {
    return marker.replace(/^([^:]+):/, (_, scope) => `${scope.toLowerCase()}:`).slice(0, 100);
  }
  return `${defaultScope}: ${marker}`.slice(0, 100);
}

function fileName(value) {
  const withoutAnchor = value.split('#')[0].replace(/:\d+(?::\d+)?$/, '');
  return path.basename(withoutAnchor.replace(/\\/g, '/'));
}

function compactAgentSummary(lastMessage, max = 1200) {
  let text = (lastMessage || '').trim();
  const structuredAt = text.lastIndexOf('SUMMARY:');
  if (structuredAt >= 0) text = text.slice(structuredAt);
  text = text
    .replace(/^COMMIT_MESSAGE:.*$/gim, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, target) => {
      return /^https?:\/\//i.test(target) ? label : (fileName(target) || label);
    })
    .replace(/`((?:[A-Za-z]:)?[^`\n]*[\\/][^`\n]+)`/g, (_, target) => `\`${fileName(target)}\``)
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > max) {
    text = `[Earlier detail omitted]\n${text.slice(-(max - 25))}`;
  }
  return text || 'No agent summary was provided.';
}

function buildPrompt({ ticket, body, board, humanComments = [] }) {
  const feedbackBlock = ticket.reviewFeedback
    ? `\n# IMPORTANT - a previous attempt was reviewed and changes were requested\nAddress this feedback specifically (it is the reason this ticket came back):\n${ticket.reviewFeedback}\n`
    : '';
  const commentsBlock = humanComments.length
    ? `\n# New human feedback\n${humanComments.map((comment, index) => `${index + 1}. ${comment}`).join('\n')}\n`
    : '';
  const workdir = board.workdir || board.appDir || '.';
  const setupCommands = (board.setupCommands || []).map((cmd) => `- ${cmd.join(' ')}`).join('\n') || '- (none configured)';
  const validationCommands = (board.validationCommands || board.integration?.validationCommands || []).map((cmd) => `- ${cmd.join(' ')}`).join('\n') || '- (none configured)';
  const notes = board.notes ? `\n# Project notes\n${board.notes}\n` : '';
  return `You are completing a ticket from a Notion board, autonomously and non-interactively.

# Ticket: ${ticket.title}
# Project: ${board.key || board.app}
# Workdir: ${workdir}

${body || '(no further description - go by the title)'}
${feedbackBlock}
${commentsBlock}
${notes}
# Context and rules

- You are in a git worktree for this project, on a dedicated branch.
- Before starting, read project conventions such as CLAUDE.md, AGENTS.md, docs, or README files when present.
- Use \`${workdir}\` as the primary project/work area. Only touch files outside it when the ticket clearly requires cross-cutting project changes.
- Never modify files outside this worktree.
- Setup commands already run before you started:
${setupCommands}
- Run the relevant validation commands before finishing when practical:
${validationCommands}
- Do NOT run git - no commits, branches, tags, or new repositories. Just make the file changes the ticket needs; the runner commits everything for you (using the \`${board.scope}:\` convention) after you finish.
- If the ticket is too vague or ambiguous to implement confidently, make NO changes and end your final message with a line starting with \`NEEDS_INFO:\` followed by what needs clarifying.
- Otherwise, keep your final response under 900 characters and use exactly this structure:
  SUMMARY: one or two sentences explaining the implemented behavior and why
  CHANGES:
  - concise implementation detail
  VALIDATION:
  - command and result
  COMMIT_MESSAGE: a specific lowercase scoped commit message based on the actual changes, following the repository conventions
- Do not include Markdown links or absolute paths in the final response. Refer to files by filename only.`;
}

async function runTicket({ config, board, ticket, log, services = {} }) {
  const tracker = services.tracker || getProjectTracker(board, { log });
  const store = services.store || config.store;
  const attempt = ticket.attempts;
  const runId = `${ticket.shortId}-${Date.now()}`;
  const runDir = path.join(config.baseDir, 'runs', runId);
  const repoPath = board.repoPath || config.repoPath;
  const baseBranch = board.baseBranch || config.baseBranch;
  let ticketBaseRef = baseBranch;
  fs.mkdirSync(runDir, { recursive: true });

  log(`claiming "${ticket.title}" [${board.key || board.app}/${ticket.cli}${ticket.model ? `/${ticket.model}` : ''}] attempt ${attempt}/${config.maxAttempts} (${runId})`);
  try {
    await tracker.mirror(ticket, { status: 'in_progress', attempts: attempt });
  } catch (error) {
    return parkInfrastructureFailure(error);
  }

  async function fail(reason, files = {}) {
    const logTail = files.errFile ? readTail(files.errFile, 40) : '';
    log(`FAILED attempt ${attempt}: ${reason}`);
    if (attempt >= config.maxAttempts) {
      await tracker.mirror(ticket, { status: 'failed' });
      await tracker.comment(
        ticket,
        `Failed (attempt ${attempt}/${config.maxAttempts}): ${reason}\n\nLogs: ${runDir}\n\n${truncate(logTail, 3000)}`
      );
    } else {
      await tracker.mirror(ticket, { status: 'queued' });
      await tracker.comment(
        ticket,
        `Attempt ${attempt}/${config.maxAttempts} failed: ${reason} - requeued.\n\nLogs: ${runDir}`
      );
    }
  }

  async function parkInfrastructureFailure(error) {
    const classification = classifyFailure(error, { runner: true });
    const originalAttempts = ticket.attempts;
    if (classification.transient) {
      try {
        await tracker.mirror(ticket, { status: 'queued', attempts: originalAttempts });
        await tracker.comment(ticket, `Transient infrastructure fault; requeued without consuming an attempt.\n\n${truncate(error.message, 1200)}`);
      } catch (requeueError) {
        log(`transient failure could not update ticket; it will be recovered on restart: ${requeueError.message}`);
      }
      return { status: 'transient_requeued' };
    }
    if (classification.kind === 'configuration' || classification.kind === 'user') {
      await tracker.mirror(ticket, { status: 'needs_info', attempts: originalAttempts });
      await tracker.comment(ticket, `Configuration prevents this ticket from running; no ticket attempt was consumed.\n\n${truncate(error.message, 1800)}`);
      return { status: 'needs_info' };
    }

    await tracker.comment(ticket, `Runner infrastructure fault detected; ticket attempt paused while guarded self-healing runs.\n\n${truncate(error.message, 1200)}\n\nLogs: ${runDir}`);
    const repaired = await repairRunner({ config, error, runDir, log });
    if (repaired.status === 'deployed') {
      await tracker.mirror(ticket, { status: 'queued', attempts: originalAttempts });
      await tracker.comment(ticket, `Runner repair ${repaired.repairSha.slice(0, 7)} passed validation and was deployed. This ticket was requeued without consuming an attempt.`);
      return { status: 'restart_required', repair: repaired };
    }
    await tracker.mirror(ticket, { status: 'failed', attempts: originalAttempts });
    await tracker.comment(ticket, `Self-healing stopped safely (${repaired.status}): ${repaired.reason || 'repair circuit is open'}. No ticket attempt was consumed.\n\nLogs: ${runDir}`);
    return { status: 'healing_failed', repair: repaired };
  }

  async function runEngine(candidate, prompt, worktreeDir, index) {
    const { provider: cli, model } = candidate;
    const r = await spawnEngine({
      cli, prompt, worktreeDir, runDir, model, tag: `impl-${index}-${cli}`,
      config, timeoutMs: config.runTimeoutMs, log,
    });
    if (r.timedOut) {
      return { status: 'fail', reason: `${cli} timed out after ${Math.round(config.runTimeoutMs / 60000)} min (process tree killed)`, errFile: r.errFile, outFile: r.outFile };
    }
    if (r.code !== 0) {
      if (r.quota) return { status: 'quota', reason: `${cli} usage limit / rate limit`, errFile: r.errFile, outFile: r.outFile };
      return { status: 'fail', reason: `${cli} exited with code ${r.code}`, errFile: r.errFile, outFile: r.outFile };
    }

    const needsInfo = r.lastMessage.split(/\r?\n/).find((l) => l.trim().startsWith('NEEDS_INFO:'));
    if (needsInfo) return { status: 'needs_info', message: needsInfo.trim() };

    if (worktrees.isDirty(worktreeDir)) {
      worktrees.commitAll(worktreeDir, extractCommitMessage(r.lastMessage, board.scope));
    }
    const commits = worktrees.commitLog(worktreeDir, ticketBaseRef);
    if (!commits) {
      if (r.quota) return { status: 'quota', reason: `${cli} usage limit / rate limit`, errFile: r.errFile, outFile: r.outFile };
      return { status: 'fail', reason: `${cli} exited successfully but made no changes`, errFile: r.errFile, outFile: r.outFile };
    }
    return { status: 'success', cli, model, commits, summary: compactAgentSummary(r.lastMessage) };
  }

  async function finalize(implemented, worktreeDir, branch, body) {
    const modelLabel = implemented.model ? `${implemented.cli} / ${implemented.model}` : implemented.cli;
    const baseMirror = { branch, lastAgent: modelLabel };
    const currentMeta = store && ticket.id
      ? (store.getById(ticket.id) || {})
      : (ticketState.readMeta(config.baseDir, ticket.shortId) || {});
    const headSha = worktrees.head(worktreeDir);
    const changedFiles = worktrees.changedFiles(worktreeDir, ticketBaseRef);
    const nativeSensitiveFiles = integration.nativeSensitiveFiles(changedFiles, board);
    if (store && ticket.id) {
      store.recordImplementation(ticket.id, { headSha, changedFiles, nativeSensitiveFiles, implementedAt: new Date().toISOString() });
      store.markCommentsProcessed(ticket.id, currentMeta.pendingCommentIds || []);
      store.setPendingComments(ticket.id, []);
    } else {
      ticketState.writeMeta(config.baseDir, ticket.shortId, {
        ...currentMeta,
        headSha,
        changedFiles,
        nativeSensitiveFiles,
        processedCommentIds: [...new Set([
          ...(currentMeta.processedCommentIds || []),
          ...(currentMeta.pendingCommentIds || []),
        ])],
        pendingCommentIds: [],
        implementedAt: new Date().toISOString(),
      });
    }

    if (config.review && config.review.enabled === false) {
      await tracker.mirror(ticket, { ...baseMirror, status: 'in_review' });
      await tracker.comment(ticket, `Implemented (${modelLabel}) - review disabled.\nBranch: ${branch}\nCommit: ${truncate(implemented.commits, 500)}\n\nWhat changed\n${implemented.summary}`);
      log(`done (no review): "${ticket.title}" -> In review on ${branch}`);
      return;
    }

    const implementer = { provider: implemented.cli, model: implemented.model || '' };
    const reviewer = review.buildReviewCandidates(implementer, config)[0];
    log(`reviewing "${ticket.title}" with ${reviewer.provider}${reviewer.model ? ` / ${reviewer.model}` : ''}`);
    const rev = await review.runReview({ config, board, ticket, body, worktreeDir, implementer, baseRef: ticketBaseRef, log });
    const reviewerLabel = `${rev.reviewer.cli}${rev.reviewer.model ? ` / ${rev.reviewer.model}` : ''}`;

    if (rev.verdict === 'approve') {
      const deployed = await integration.admitTicket({ config, board, ticket, tracker, log });
      if (!['deployed', 'unchanged'].includes(deployed.status)) return;
      await tracker.mirror(ticket, { ...baseMirror, status: 'testing', reviewRounds: 0, reviewFeedback: '' });
      await tracker.comment(ticket, `Approved by ${reviewerLabel} -> cumulative Testing stack\nEngine: ${modelLabel}\nBranch: ${branch}\nCommit: ${truncate(implemented.commits, 500)}\nStack: ${deployed.compositeSha || 'already current'}\n\nWhat changed\n${implemented.summary}\n\nReview\n${truncate(rev.notes || 'LGTM', 700)}`);
      log(`approved: "${ticket.title}" -> Testing on ${branch} (reviewer ${rev.reviewer.cli})`);
      return;
    }

    const maxRounds = (config.review && config.review.maxRounds) || 2;
    const round = ticket.reviewRounds + 1;
    if (rev.inconclusive || round > maxRounds) {
      const why = rev.inconclusive ? 'review could not complete' : `max review rounds (${maxRounds}) reached`;
      await tracker.mirror(ticket, { ...baseMirror, status: 'in_review', reviewRounds: 0, reviewFeedback: '' });
      await tracker.comment(ticket, `Needs a human - ${why}.\nEngine: ${modelLabel}\nBranch: ${branch}\n\nLast review notes\n${truncate(rev.notes, 1500)}`);
      log(`review -> human: "${ticket.title}" (${why})`);
      return;
    }

    await tracker.mirror(ticket, {
      ...baseMirror, status: 'queued', attempts: 0, reviewRounds: round, reviewFeedback: rev.notes || 'Changes requested.',
    });
    await tracker.comment(ticket, `Changes requested by ${reviewerLabel} (round ${round}/${maxRounds}) - requeued.\n\n${truncate(rev.notes, 1500)}`);
    log(`changes requested: "${ticket.title}" round ${round}/${maxRounds} -> Not started`);
  }

  try {
    const previousMeta = store && ticket.id
      ? (store.getById(ticket.id) || {})
      : (ticketState.readMeta(config.baseDir, ticket.shortId) || {});
    const [body, comments] = await Promise.all([
      tracker.fetchBody(ticket),
      tracker.fetchComments(ticket),
    ]);
    const processedCommentIds = new Set(previousMeta.processedCommentIds || []);
    const newHumanComments = comments
      .filter((comment) => !comment.isBot && !processedCommentIds.has(comment.id))
      .map((comment) => ({ id: comment.id, text: comment.text }))
      .filter((comment) => comment.text);

    if (isQueryOnlyTicket(ticket, body)) {
      return runQueryTicket({
        config,
        board,
        ticket,
        body,
        humanComments: newHumanComments.map((comment) => comment.text),
        runDir,
        log,
        services: { tracker, ...(services.queryServices || {}) },
      });
    }

    const prompt = buildPrompt({ ticket, body, board, humanComments: newHumanComments.map((comment) => comment.text) });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), prompt, 'utf8');

    const settings = integration.integrationSettings(config, board);
    ticketBaseRef = worktrees.fetchBranch(repoPath, settings.remote, settings.mainBranch);
    const { dir: worktreeDir, branch, baseSha } = worktrees.createWorktree({
      repoPath,
      baseBranch,
      baseRef: ticketBaseRef,
      worktreesDir: path.join(config.baseDir, 'worktrees', board.key || board.app),
      shortId: ticket.shortId,
    });
    if (store && ticket.id) {
      store.recordWorktree(ticket.id, { repoPath, branch, worktreeDir, baseSha });
      store.markCommentsProcessed(ticket.id, [...processedCommentIds]);
      store.setPendingComments(ticket.id, newHumanComments.map((comment) => comment.id));
    } else {
      ticketState.writeMeta(config.baseDir, ticket.shortId, {
        ...previousMeta,
        pageId: ticket.pageId,
        shortId: ticket.shortId,
        app: board.key || board.app,
        projectKey: board.key || board.app,
        repoPath,
        databaseId: board.databaseId,
        remote: settings.remote,
        mainBranch: settings.mainBranch,
        branch,
        dir: worktreeDir,
        title: ticket.title,
        createdTime: ticket.createdTime,
        baseSha,
        processedCommentIds: [...processedCommentIds],
        pendingCommentIds: newHumanComments.map((comment) => comment.id),
      });
    }

    log(`worktree ready at ${worktreeDir} (${branch}); running project setup...`);
    const runSetup = services.runSetup || integration.runSetup;
    runSetup(worktreeDir, board, config.installTimeoutMs);
    const fallbackBase = worktrees.head(worktreeDir);

    const policy = config.fallbackPolicies?.feature || [];
    const override = (ticket.cli || ticket.model)
      ? { provider: ticket.cli || policy[0]?.provider, model: ticket.model || '' }
      : undefined;
    const chain = buildCandidateChain(policy, { override });
    const label = (candidate) => `${candidate.provider}${candidate.model ? ` / ${candidate.model}` : ''}`;
    log(`engine chain: ${chain.map(label).join(' -> ')}`);

    const fallback = await runWithFallback({
      candidates: chain,
      invoke: (candidate, index) => runEngine(candidate, prompt, worktreeDir, index),
      classify: (outcome) => ({
        action: outcome.status === 'success' ? 'accept' : outcome.status === 'needs_info' ? 'stop' : 'next',
        value: outcome,
        reason: outcome.reason,
      }),
      onAdvance: ({ candidate, next, result: outcome }) => {
        const current = label(candidate);
        if (outcome.status === 'quota') log(`${current} hit usage limit - ${next ? `falling back to ${label(next)}` : 'no candidates left'}`);
        else log(`${current} failed: ${outcome.reason}${next ? ` - falling back to ${label(next)}` : ''}`);
      },
      reset: () => worktrees.resetWorktree(worktreeDir, fallbackBase),
    });

    if (fallback.status === 'accept') {
      await finalize(fallback.value, worktreeDir, branch, body);
      return { status: 'completed' };
    }
    if (fallback.status === 'stop') {
      const outcome = fallback.value;
      log(`needs info: "${ticket.title}"`);
      await tracker.mirror(ticket, { status: 'needs_info' });
      await tracker.comment(ticket, `The agent needs more info before it can implement this. Edit the ticket, then move it to Not started to requeue.\n\n${truncate(outcome.message, 3000)}`);
      return { status: 'needs_info' };
    }
    const last = fallback.last?.result || { reason: 'no candidate ran' };

    if (config.selfHealing?.enabled !== false && (config.selfHealing?.maxRescuePasses ?? 1) > 0) {
      const rescue = config.selfHealing?.rescueCandidate || { provider: 'codex', model: '' };
      const rescuePrompt = `${prompt}\n\n# Rescue context\nEvery normal implementation candidate failed. Diagnose the underlying ticket implementation problem and make one final, minimal attempt. Last failure: ${last.reason || 'unknown'}. Inspect any existing logs only if they are inside this worktree.`;
      log(`self-heal rescue pass: ${label(rescue)} after ${last.reason || 'unknown failure'}`);
      await tracker.comment(ticket, `Normal candidates were exhausted; running one bounded rescue pass with ${label(rescue)}.`);
      worktrees.resetWorktree(worktreeDir, fallbackBase);
      const rescued = await runEngine(rescue, rescuePrompt, worktreeDir, chain.length);
      if (rescued.status === 'success') {
        await finalize(rescued, worktreeDir, branch, body);
        return { status: 'completed_after_rescue' };
      }
      if (rescued.status === 'needs_info') {
        await tracker.mirror(ticket, { status: 'needs_info' });
        await tracker.comment(ticket, rescued.message);
        return { status: 'needs_info' };
      }
      Object.assign(last, rescued);
      last.reason = `rescue failed: ${rescued.reason}`;
    }
    await fail(`all candidates failed (${chain.map(label).join(' -> ')}). Last: ${last.reason}`, last);
    return { status: 'failed' };
  } catch (e) {
    log(`runner infrastructure error: ${textOf(e)}`);
    return parkInfrastructureFailure(e);
  }
}

module.exports = { runTicket, QUOTA_RE, buildPrompt, extractCommitMessage, compactAgentSummary };
