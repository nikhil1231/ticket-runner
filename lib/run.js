'use strict';

const fs = require('fs');
const path = require('path');
const notion = require('./notion');
const { blocksToMarkdown } = require('./ticket');
const { spawnEngine, QUOTA_RE, readTail } = require('./engine');
const { buildCandidateChain, runWithFallback } = require('./fallback');
const worktrees = require('./worktree');
const review = require('./review');
const eas = require('./eas');

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n[...truncated]` : text;
}

function extractCommitMessage(lastMessage, defaultScope) {
  const marker = lastMessage.match(/^COMMIT_MESSAGE:\s*(.+)$/im)?.[1]
    ?.replace(/[`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!marker) return `${defaultScope}: implement ticket changes`;
  if (/^(caligo|workout|shared|config|test|chore):\s+\S/i.test(marker)) {
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

function buildPrompt({ ticket, body, board }) {
  const feedbackBlock = ticket.reviewFeedback
    ? `\n# IMPORTANT — a previous attempt was reviewed and changes were requested\nAddress this feedback specifically (it is the reason this ticket came back):\n${ticket.reviewFeedback}\n`
    : '';
  return `You are completing a ticket from a Notion board, autonomously and non-interactively.

# Ticket: ${ticket.title}

${body || '(no further description — go by the title)'}
${feedbackBlock}
# Context and rules

- You are in a git worktree of a yarn-workspaces monorepo, on a dedicated branch. The app this ticket belongs to is \`${board.appDir}\`.
- Before starting, read the project conventions: root CLAUDE.md, docs/git-conventions.md, and \`${board.appDir}/AGENTS.md\` if present.
- Work only inside \`${board.appDir}\`. Touch \`packages/\` only if the ticket strictly requires shared code changes.
- Never modify files outside this worktree.
- Dependencies are already installed (yarn). Run the app's typecheck/lint scripts (see its package.json) to validate your work.
- Do NOT run git — no commits, branches, tags, or new repositories. Just make the file changes the ticket needs; the runner commits everything for you (using the \`${board.scope}:\` convention) after you finish.
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

async function runTicket({ config, board, ticket, log }) {
  const attempt = ticket.attempts + 1;
  const runId = `${ticket.shortId}-${Date.now()}`;
  const runDir = path.join(config.baseDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });

  log(`claiming "${ticket.title}" [${board.app}/${ticket.cli}${ticket.model ? `/${ticket.model}` : ''}] attempt ${attempt}/${config.maxAttempts} (${runId})`);
  await notion.updatePage(ticket.pageId, {
    Status: { status: { name: 'In progress' } },
    Attempts: { number: attempt },
  });

  async function fail(reason, files = {}) {
    const logTail = files.errFile ? readTail(files.errFile, 40) : '';
    log(`FAILED attempt ${attempt}: ${reason}`);
    if (attempt >= config.maxAttempts) {
      await notion.updatePage(ticket.pageId, { Status: { status: { name: 'Failed' } } });
      await notion.safeComment(
        ticket.pageId,
        `❌ Failed (attempt ${attempt}/${config.maxAttempts}): ${reason}\n\nLogs: ${runDir}\n\n${truncate(logTail, 3000)}`,
        log
      );
    } else {
      await notion.updatePage(ticket.pageId, { Status: { status: { name: 'Not started' } } });
      await notion.safeComment(
        ticket.pageId,
        `⚠ Attempt ${attempt}/${config.maxAttempts} failed: ${reason} — requeued.\n\nLogs: ${runDir}`,
        log
      );
    }
  }

  // Runs one engine to completion in the worktree and classifies the outcome.
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

    // A non-sandboxed engine (agy) commits itself; a sandboxed one (codex) can't
    // reach the worktree's .git, so we commit its leftovers here.
    if (worktrees.isDirty(worktreeDir)) {
      worktrees.commitAll(worktreeDir, extractCommitMessage(r.lastMessage, board.scope));
    }
    const commits = worktrees.commitLog(worktreeDir, config.baseBranch);
    if (!commits) {
      if (r.quota) return { status: 'quota', reason: `${cli} usage limit / rate limit`, errFile: r.errFile, outFile: r.outFile };
      return { status: 'fail', reason: `${cli} exited successfully but made no changes`, errFile: r.errFile, outFile: r.outFile };
    }
    return { status: 'success', cli, model, commits, summary: compactAgentSummary(r.lastMessage) };
  }

  // Reviews the implemented branch and drives the final status: Testing (approved
  // + pushed), Not started (changes requested, requeued), or In review (human).
  async function finalize(implemented, worktreeDir, branch, body) {
    const modelLabel = implemented.model ? `${implemented.cli} / ${implemented.model}` : implemented.cli;
    const baseProps = {
      Branch: { rich_text: [{ text: { content: branch } }] },
      'Last agent': { rich_text: [{ text: { content: modelLabel.slice(0, 200) } }] },
    };

    if (config.review && config.review.enabled === false) {
      await notion.updatePage(ticket.pageId, { ...baseProps, Status: { status: { name: 'In review' } } });
      await notion.safeComment(ticket.pageId, `✅ Implemented (${modelLabel}) — review disabled.\nBranch: ${branch}\nCommit: ${truncate(implemented.commits, 500)}\n\nWhat changed\n${implemented.summary}`, log);
      log(`done (no review): "${ticket.title}" -> In review on ${branch}`);
      return;
    }

    const implementer = { provider: implemented.cli, model: implemented.model || '' };
    const reviewer = review.buildReviewCandidates(implementer, config)[0];
    log(`reviewing "${ticket.title}" with ${reviewer.provider}${reviewer.model ? ` / ${reviewer.model}` : ''}`);
    const rev = await review.runReview({ config, board, ticket, body, worktreeDir, implementer, log });
    const reviewerLabel = `${rev.reviewer.cli}${rev.reviewer.model ? ` / ${rev.reviewer.model}` : ''}`;

    if (rev.verdict === 'approve') {
      let pushNote = '';
      if (board.easChannel) {
        const res = eas.pushUpdate({ worktreeDir, appDir: board.appDir, channel: board.easChannel, message: `${board.scope}: ${ticket.title} [${branch}]`, log });
        pushNote = res.ok
          ? `\n📲 Pushed to EAS channel "${board.easChannel}".`
          : `\n⚠ EAS push failed: ${(res.error || '').split(/\r?\n/).filter(Boolean).slice(-1)[0] || 'see logs'}`;
      }
      await notion.updatePage(ticket.pageId, {
        ...baseProps,
        Status: { status: { name: 'Testing' } },
        'Review rounds': { number: 0 },
        'Review feedback': { rich_text: [] },
      });
      await notion.safeComment(ticket.pageId, `✅ Approved by ${reviewerLabel} → Testing\nEngine: ${modelLabel}\nBranch: ${branch}\nCommit: ${truncate(implemented.commits, 500)}${pushNote}\n\nWhat changed\n${implemented.summary}\n\nReview\n${truncate(rev.notes || 'LGTM', 700)}`, log);
      log(`approved: "${ticket.title}" -> Testing on ${branch} (reviewer ${rev.reviewer.cli})`);
      return;
    }

    // request_changes / inconclusive
    const maxRounds = (config.review && config.review.maxRounds) || 2;
    const round = ticket.reviewRounds + 1;
    if (rev.inconclusive || round > maxRounds) {
      const why = rev.inconclusive ? 'review could not complete' : `max review rounds (${maxRounds}) reached`;
      await notion.updatePage(ticket.pageId, {
        ...baseProps,
        Status: { status: { name: 'In review' } },
        'Review rounds': { number: 0 },
        'Review feedback': { rich_text: [] },
      });
      await notion.safeComment(ticket.pageId, `🔁 Needs a human — ${why}.\nEngine: ${modelLabel}\nBranch: ${branch}\n\nLast review notes\n${truncate(rev.notes, 1500)}`, log);
      log(`review -> human: "${ticket.title}" (${why})`);
      return;
    }

    await notion.updatePage(ticket.pageId, {
      ...baseProps,
      Status: { status: { name: 'Not started' } },
      Attempts: { number: 0 },
      'Review rounds': { number: round },
      'Review feedback': { rich_text: [{ text: { content: (rev.notes || 'Changes requested.').slice(0, 1900) } }] },
    });
    await notion.safeComment(ticket.pageId, `🔧 Changes requested by ${reviewerLabel} (round ${round}/${maxRounds}) — requeued.\n\n${truncate(rev.notes, 1500)}`, log);
    log(`changes requested: "${ticket.title}" round ${round}/${maxRounds} -> Not started`);
  }

  try {
    const blocks = await notion.getBlockChildren(ticket.pageId);
    const body = blocksToMarkdown(blocks);
    const prompt = buildPrompt({ ticket, body, board });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), prompt, 'utf8');

    const { dir: worktreeDir, branch } = worktrees.createWorktree({
      repoPath: config.repoPath,
      baseBranch: config.baseBranch,
      worktreesDir: path.join(config.baseDir, 'worktrees'),
      shortId: ticket.shortId,
    });
    fs.writeFileSync(
      path.join(config.baseDir, 'worktrees', `${ticket.shortId}.json`),
      JSON.stringify({ pageId: ticket.pageId, app: board.app, branch, dir: worktreeDir, title: ticket.title }, null, 2)
    );

    log(`worktree ready at ${worktreeDir} (${branch}); running yarn install...`);
    worktrees.installDeps(worktreeDir, config.installTimeoutMs);
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
        if (outcome.status === 'quota') log(`${current} hit usage limit — ${next ? `falling back to ${label(next)}` : 'no candidates left'}`);
        else log(`${current} failed: ${outcome.reason}${next ? ` — falling back to ${label(next)}` : ''}`);
      },
      reset: () => worktrees.resetWorktree(worktreeDir, fallbackBase),
    });

    if (fallback.status === 'accept') {
      await finalize(fallback.value, worktreeDir, branch, body);
      return;
    }
    if (fallback.status === 'stop') {
      const outcome = fallback.value;
      log(`needs info: "${ticket.title}"`);
      await notion.updatePage(ticket.pageId, { Status: { status: { name: 'Needs info' } } });
      await notion.safeComment(ticket.pageId, `❓ The agent needs more info before it can implement this. Edit the ticket, then move it to Not started to requeue.\n\n${truncate(outcome.message, 3000)}`, log);
      return;
    }
    const last = fallback.last?.result || { reason: 'no candidate ran' };
    await fail(`all candidates failed (${chain.map(label).join(' -> ')}). Last: ${last.reason}`, last);
  } catch (e) {
    await fail(`runner error: ${e.message}`);
  }
}

module.exports = { runTicket, QUOTA_RE, buildPrompt, extractCommitMessage, compactAgentSummary };
