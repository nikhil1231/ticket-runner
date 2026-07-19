'use strict';

const fs = require('fs');
const path = require('path');
const { spawnEngine, readTail } = require('./engine');
const { buildCandidateChain, runWithFallback } = require('./fallback');
const worktrees = require('./worktree');
const { classifyFailure } = require('./failure');
const { repairRunner } = require('./self-heal');
const { getIncubatorTracker } = require('./trackers');

const PLAN_HEADING = '## AI implementation plan';

function recoveryStatus(ticket, maxAttempts) {
  return ticket.attempts < maxAttempts ? 'Not started' : 'Failed';
}

function splitManagedPlan(markdown) {
  const positions = [];
  let from = 0;
  while ((from = markdown.indexOf(PLAN_HEADING, from)) !== -1) {
    positions.push(from);
    from += PLAN_HEADING.length;
  }
  if (!positions.length) return { brief: markdown.trim(), existingPlan: '' };
  if (positions.length !== 1) throw new Error(`Expected one ${PLAN_HEADING} section, found ${positions.length}`);
  return {
    brief: markdown.slice(0, positions[0]).trim(),
    existingPlan: markdown.slice(positions[0]).trim(),
  };
}

function extractPlan(lastMessage) {
  const text = (lastMessage || '').trim();
  const needsInfo = text.split(/\r?\n/).find((line) => line.trim().startsWith('NEEDS_INFO:'));
  if (needsInfo) return { status: 'needs_info', message: needsInfo.trim() };
  const marker = text.match(/(?:^|\n)PLAN:\s*\n([\s\S]+)$/i);
  const plan = (marker ? marker[1] : '').trim();
  if (!plan || plan.length < 80) return { status: 'invalid', reason: 'agent did not return a substantive PLAN section' };
  return { status: 'success', plan };
}

function buildPlanningPrompt({ ticket, board, brief, existingPlan, comments }) {
  const feedback = comments.length ? comments.map((text, i) => `${i + 1}. ${text}`).join('\n') : '(none)';
  const workdir = board.workdir || board.appDir || '.';
  const notes = board.notes ? `\n# Project notes\n${board.notes}\n` : '';
  return `You are planning a software ticket from the ticket incubator. Work autonomously and non-interactively.

# Ticket: ${ticket.title}
# Target project: ${board.key || board.app}
# Workdir: ${workdir}

# Original brief
${brief || '(empty)'}

# Existing plan
${existingPlan || '(first planning pass)'}

# Open review comments
${feedback}
${notes}

# Instructions
- Inspect the repository and relevant project code so the plan is grounded in the current implementation.
- Read project conventions such as CLAUDE.md, AGENTS.md, docs, or README files when present.
- Do not edit files and do not run git. This is planning only.
- Incorporate all relevant review comments into a complete replacement plan.
- Make it decision-complete: describe behavior, key implementation changes, interfaces/data flow, failures, and tests.
- Do not repeat the ticket title or original brief as filler.
- If the brief is too vague to plan safely, output one line: NEEDS_INFO: <specific questions>.
- Otherwise output exactly PLAN: on its own line followed by Markdown for the implementation plan.`;
}

async function updateManagedPlan(tracker, ticket, existingPlan, plan) {
  const section = `${PLAN_HEADING}\n\n${plan}`;
  return tracker.appendSection(ticket, { markdown: section, existing: existingPlan || undefined });
}

async function humanComments(tracker, ticket) {
  const comments = await tracker.fetchComments(ticket);
  return comments.filter((comment) => !comment.isBot).map((comment) => comment.text).filter(Boolean);
}

async function runIncubatorTicket({ config, board, ticket, log, services = {} }) {
  const tracker = services.tracker || getIncubatorTracker(config, { log });
  const attempt = ticket.attempts;
  const runDir = path.join(config.baseDir, 'runs', `${ticket.shortId}-plan-${Date.now()}`);
  fs.mkdirSync(runDir, { recursive: true });
  let workspaceDir;
  try {
    await tracker.mirror(ticket, { status: 'in_progress', attempts: attempt });
    const [pageMarkdown, comments] = await Promise.all([
      tracker.fetchPlanMarkdown(ticket),
      humanComments(tracker, ticket),
    ]);
    if (pageMarkdown.truncated || pageMarkdown.unknownBlockIds?.length) {
      throw new Error('page content is truncated or contains unsupported blocks');
    }
    const { brief, existingPlan } = splitManagedPlan(pageMarkdown.markdown || '');
    if (ticket.title === '(untitled)' && !brief) {
      await tracker.mirror(ticket, { status: 'needs_info' });
      await tracker.comment(ticket, 'Add a title or brief, then return this ticket to Not started.');
      return;
    }

    const prompt = buildPlanningPrompt({ ticket, board, brief, existingPlan, comments });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), prompt, 'utf8');
    workspaceDir = worktrees.createDetachedWorktree({
      repoPath: board.repoPath || config.repoPath,
      baseBranch: board.baseBranch || config.baseBranch,
      worktreesDir: path.join(config.baseDir, 'worktrees', board.key || board.app),
      shortId: ticket.shortId,
    });
    const fallbackBase = worktrees.head(workspaceDir);

    const candidates = buildCandidateChain(config.fallbackPolicies?.incubator || []);
    const label = (c) => `${c.provider}${c.model ? ` / ${c.model}` : ''}`;
    log(`planning "${ticket.title}" with ${candidates.map(label).join(' -> ')}`);
    const fallback = await runWithFallback({
      candidates,
      invoke: (candidate, index) => spawnEngine({
        cli: candidate.provider,
        prompt,
        worktreeDir: workspaceDir,
        runDir,
        model: candidate.model,
        tag: `plan-${index}-${candidate.provider}`,
        config,
        timeoutMs: config.runTimeoutMs,
        log,
      }),
      classify: (result) => {
        if (result.timedOut || result.code !== 0) return { action: 'next', reason: result.quota ? 'usage limit' : 'execution failed' };
        const parsed = extractPlan(result.lastMessage);
        return {
          action: parsed.status === 'success' ? 'accept' : parsed.status === 'needs_info' ? 'stop' : 'next',
          value: parsed,
          reason: parsed.reason,
        };
      },
      onAdvance: ({ candidate, next, decision }) => log(`${label(candidate)} planning ${decision.reason} - ${next ? `falling back to ${label(next)}` : 'no candidates left'}`),
      reset: () => worktrees.resetWorktree(workspaceDir, fallbackBase),
    });

    if (fallback.status === 'accept') {
      await updateManagedPlan(tracker, ticket, existingPlan, fallback.value.plan);
      await tracker.mirror(ticket, { status: 'in_review', lastAgent: label(fallback.candidate) });
      await tracker.comment(ticket, `Plan ready for review (${label(fallback.candidate)}). Add page comments and return it to Not started for another pass, or move it to Done to hand it off.`);
      return { status: 'completed' };
    }
    if (fallback.status === 'stop') {
      await tracker.mirror(ticket, { status: 'needs_info' });
      await tracker.comment(ticket, fallback.value.message);
      return { status: 'needs_info' };
    }

    if (config.selfHealing?.enabled !== false && (config.selfHealing?.maxRescuePasses ?? 1) > 0) {
      const rescue = config.selfHealing?.rescueCandidate || { provider: 'codex', model: '' };
      await tracker.comment(ticket, `Running one bounded planning rescue pass with ${label(rescue)}.`);
      worktrees.resetWorktree(workspaceDir, fallbackBase);
      const result = await spawnEngine({
        cli: rescue.provider,
        prompt: `${prompt}\n\n# Rescue context\nAll normal planning candidates failed. Make one final attempt to diagnose the failure and return a valid plan or NEEDS_INFO.`,
        worktreeDir: workspaceDir,
        runDir,
        model: rescue.model || '',
        tag: `plan-rescue-${rescue.provider}`,
        config,
        timeoutMs: config.runTimeoutMs,
        log,
      });
      if (!result.timedOut && result.code === 0) {
        const parsed = extractPlan(result.lastMessage);
        if (parsed.status === 'success') {
          await updateManagedPlan(tracker, ticket, existingPlan, parsed.plan);
          await tracker.mirror(ticket, { status: 'in_review', lastAgent: label(rescue) });
          await tracker.comment(ticket, `Plan ready after rescue (${label(rescue)}).`);
          return { status: 'completed_after_rescue' };
        }
        if (parsed.status === 'needs_info') {
          await tracker.mirror(ticket, { status: 'needs_info' });
          await tracker.comment(ticket, parsed.message);
          return { status: 'needs_info' };
        }
      }
    }
    throw new Error(`all planning candidates failed; last output: ${readTail(fallback.last?.result?.errFile || '', 10)}`);
  } catch (error) {
    const classification = classifyFailure(error, { runner: !/^all planning candidates failed/.test(error.message) });
    if (classification.kind === 'infrastructure') {
      if (classification.transient) {
        try {
          await tracker.mirror(ticket, { status: 'queued', attempts: ticket.attempts });
          await tracker.comment(ticket, `Transient planning infrastructure fault; requeued without consuming an attempt.\n\n${error.message}`);
        } catch (requeueError) {
          log(`transient planning failure could not update ticket: ${requeueError.message}`);
        }
        return { status: 'transient_requeued' };
      }
      await tracker.comment(ticket, `Runner infrastructure fault detected during planning; attempting guarded self-healing.\n\n${error.message}`);
      const repaired = await repairRunner({ config, error, runDir, log });
      await tracker.mirror(ticket, { status: repaired.status === 'deployed' ? 'queued' : 'failed', attempts: ticket.attempts });
      await tracker.comment(ticket, repaired.status === 'deployed'
        ? `Runner repair ${repaired.repairSha.slice(0, 7)} deployed; planning was requeued without consuming an attempt.`
        : `Self-healing stopped safely (${repaired.status}): ${repaired.reason || 'repair circuit is open'}.`);
      return { status: repaired.status === 'deployed' ? 'restart_required' : 'healing_failed' };
    }
    const final = attempt >= config.maxAttempts;
    await tracker.mirror(ticket, { status: final ? 'failed' : 'queued' });
    await tracker.comment(ticket, `${final ? 'Planning failed' : 'Planning attempt failed and was requeued'} (${attempt}/${config.maxAttempts}): ${error.message}`);
    return { status: final ? 'failed' : 'requeued' };
  } finally {
    if (workspaceDir) worktrees.removeDetachedWorktree({ repoPath: board.repoPath || config.repoPath, dir: workspaceDir, ignoreErrors: true });
  }
}

async function handoffTicket({ config, ticket, board, log, services = {} }) {
  const tracker = services.tracker || getIncubatorTracker(config, { log });
  if (!board) {
    await tracker.mirror(ticket, { status: 'needs_info' });
    await tracker.comment(ticket, 'Select a Project before moving this ticket to Done.');
    return false;
  }
  try {
    await tracker.promoteIncubator(ticket, board.key || board.app);
    log(`handed off "${ticket.title}" to ${board.key || board.app}`);
    return true;
  } catch (error) {
    try { await tracker.mirror(ticket, { status: 'failed' }); } catch {}
    await tracker.comment(ticket, `Handoff to ${board.key || board.app} failed: ${error.message}`);
    return false;
  }
}

module.exports = {
  PLAN_HEADING, recoveryStatus, splitManagedPlan, extractPlan, buildPlanningPrompt,
  updateManagedPlan, runIncubatorTicket, handoffTicket,
};
