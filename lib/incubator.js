'use strict';

const fs = require('fs');
const path = require('path');
const notion = require('./notion');
const { spawnEngine, readTail } = require('./engine');
const { buildCandidateChain, runWithFallback } = require('./fallback');
const { richTextToPlain } = require('./ticket');
const worktrees = require('./worktree');

const PLAN_HEADING = '## AI implementation plan';

function property(page, name) {
  return page.properties?.[name];
}

function extractIncubatorTicket(page) {
  return {
    pageId: page.id,
    shortId: page.id.replace(/-/g, '').slice(-12),
    createdTime: page.created_time,
    title: richTextToPlain(property(page, 'Name')?.title) || '(untitled)',
    status: property(page, 'Status')?.status?.name,
    app: (property(page, 'App')?.select?.name || '').toLowerCase(),
    attempts: property(page, 'Attempts')?.number || 0,
  };
}

function recoveryStatus(ticket, maxAttempts) {
  return ticket.attempts < maxAttempts ? 'Not started' : 'Failed';
}

function commentText(comment) {
  return richTextToPlain(comment.rich_text).trim();
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
  return `You are planning a software ticket from a Notion incubator. Work autonomously and non-interactively.

# Ticket: ${ticket.title}
# Target app: ${board.app} (${board.appDir})

# Original brief
${brief || '(empty)'}

# Existing plan
${existingPlan || '(first planning pass)'}

# Open review comments
${feedback}

# Instructions
- Inspect the repository and relevant app code so the plan is grounded in the current implementation.
- Read root CLAUDE.md, docs/git-conventions.md, and ${board.appDir}/AGENTS.md when present.
- Do not edit files and do not run git. This is planning only.
- Incorporate all relevant review comments into a complete replacement plan.
- Make it decision-complete: describe behavior, key implementation changes, interfaces/data flow, failures, and tests.
- Do not repeat the ticket title or original brief as filler.
- If the brief is too vague to plan safely, output one line: NEEDS_INFO: <specific questions>.
- Otherwise output exactly PLAN: on its own line followed by Markdown for the implementation plan.`;
}

async function updateManagedPlan(pageId, existingPlan, plan) {
  const section = `${PLAN_HEADING}\n\n${plan}`;
  if (!existingPlan) {
    return notion.updatePageMarkdown(pageId, {
      type: 'insert_content',
      insert_content: { content: `\n\n${section}`, position: { type: 'end' } },
    });
  }
  return notion.updatePageMarkdown(pageId, {
    type: 'update_content',
    update_content: { content_updates: [{ old_str: existingPlan, new_str: section }] },
  });
}

async function humanComments(pageId) {
  const [comments, bot] = await Promise.all([notion.getComments(pageId), notion.getCurrentBot()]);
  return comments
    .filter((comment) => comment.created_by?.id !== bot.id)
    .map(commentText)
    .filter(Boolean);
}

async function runIncubatorTicket({ config, board, ticket, log }) {
  const attempt = ticket.attempts + 1;
  const runDir = path.join(config.baseDir, 'runs', `${ticket.shortId}-plan-${Date.now()}`);
  fs.mkdirSync(runDir, { recursive: true });
  await notion.updatePage(ticket.pageId, {
    Status: { status: { name: 'In progress' } },
    Attempts: { number: attempt },
  });

  let workspaceDir;
  try {
    const [pageMarkdown, comments] = await Promise.all([
      notion.getPageMarkdown(ticket.pageId),
      humanComments(ticket.pageId),
    ]);
    if (pageMarkdown.truncated || pageMarkdown.unknown_block_ids?.length) {
      throw new Error('page content is truncated or contains unsupported blocks');
    }
    const { brief, existingPlan } = splitManagedPlan(pageMarkdown.markdown || '');
    if (ticket.title === '(untitled)' && !brief) {
      await notion.updatePage(ticket.pageId, { Status: { status: { name: 'Needs info' } } });
      await notion.safeComment(ticket.pageId, 'Add a title or brief, then return this ticket to Not started.', log);
      return;
    }

    const prompt = buildPlanningPrompt({ ticket, board, brief, existingPlan, comments });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), prompt, 'utf8');
    workspaceDir = worktrees.createDetachedWorktree({
      repoPath: config.repoPath,
      baseBranch: config.baseBranch,
      worktreesDir: path.join(config.baseDir, 'worktrees'),
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
      onAdvance: ({ candidate, next, decision }) => log(`${label(candidate)} planning ${decision.reason} — ${next ? `falling back to ${label(next)}` : 'no candidates left'}`),
      reset: () => worktrees.resetWorktree(workspaceDir, fallbackBase),
    });

    if (fallback.status === 'accept') {
      await updateManagedPlan(ticket.pageId, existingPlan, fallback.value.plan);
      await notion.updatePage(ticket.pageId, {
        Status: { status: { name: 'In review' } },
        'Last agent': { rich_text: [{ text: { content: label(fallback.candidate).slice(0, 200) } }] },
      });
      await notion.safeComment(ticket.pageId, `Plan ready for review (${label(fallback.candidate)}). Add page comments and return it to Not started for another pass, or move it to Done to hand it off.`, log);
      return;
    }
    if (fallback.status === 'stop') {
      await notion.updatePage(ticket.pageId, { Status: { status: { name: 'Needs info' } } });
      await notion.safeComment(ticket.pageId, fallback.value.message, log);
      return;
    }
    throw new Error(`all planning candidates failed; last output: ${readTail(fallback.last?.result?.errFile || '', 10)}`);
  } catch (error) {
    const final = attempt >= config.maxAttempts;
    await notion.updatePage(ticket.pageId, { Status: { status: { name: final ? 'Failed' : 'Not started' } } });
    await notion.safeComment(ticket.pageId, `${final ? 'Planning failed' : 'Planning attempt failed and was requeued'} (${attempt}/${config.maxAttempts}): ${error.message}`, log);
  } finally {
    if (workspaceDir) worktrees.removeDetachedWorktree({ repoPath: config.repoPath, dir: workspaceDir, ignoreErrors: true });
  }
}

async function handoffTicket({ config, ticket, board, log }) {
  if (!board) {
    await notion.updatePage(ticket.pageId, { Status: { status: { name: 'Needs info' } } });
    await notion.safeComment(ticket.pageId, 'Select an App before moving this ticket to Done.', log);
    return false;
  }
  try {
    const dataSourceId = await notion.getDataSourceId(board.databaseId);
    await notion.movePage(ticket.pageId, dataSourceId);
    await notion.updatePage(ticket.pageId, {
      Status: { status: { name: 'Not started' } },
      'For AI': { checkbox: true },
      Attempts: { number: 0 },
      Branch: { rich_text: [] },
      CLI: { select: null },
      Model: { rich_text: [] },
      'Review rounds': { number: 0 },
      'Review feedback': { rich_text: [] },
    });
    log(`handed off "${ticket.title}" to ${board.app}`);
    return true;
  } catch (error) {
    try { await notion.updatePage(ticket.pageId, { Status: { status: { name: 'Failed' } } }); } catch {}
    await notion.safeComment(ticket.pageId, `Handoff to ${board.app} failed: ${error.message}`, log);
    return false;
  }
}

module.exports = {
  PLAN_HEADING, extractIncubatorTicket, recoveryStatus, splitManagedPlan, extractPlan, buildPlanningPrompt,
  updateManagedPlan, runIncubatorTicket, handoffTicket,
};
