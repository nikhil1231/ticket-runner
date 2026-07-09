'use strict';

const fs = require('fs');
const path = require('path');
const { spawnEngine } = require('./engine');
const { buildCandidateChain, runWithFallback } = require('./fallback');
const worktrees = require('./worktree');

function buildReviewCandidates(implementer, config) {
  return buildCandidateChain(config.fallbackPolicies?.review || [], {
    exclude: implementer ? [implementer] : [],
  });
}

function parseReviewVerdict(lastMessage) {
  const text = lastMessage || '';
  const verdict = text.match(/REVIEW_VERDICT:\s*(APPROVE|REQUEST_CHANGES)/i);
  const notesMatch = text.match(/REVIEW_NOTES:\s*([\s\S]*)$/i);
  const notes = (notesMatch ? notesMatch[1] : '').trim();
  if (!verdict) return { verdict: 'request_changes', notes: notes || 'Reviewer did not return a clear REVIEW_VERDICT.' };
  return { verdict: verdict[1].toUpperCase() === 'APPROVE' ? 'approve' : 'request_changes', notes };
}

function buildReviewPrompt({ ticket, body, board }) {
  const workdir = board.workdir || board.appDir || '.';
  return `You are reviewing a code change an AI made for a Notion ticket, in a git worktree for project ${board.key || board.app || 'unknown'}. Decide whether it correctly and safely implements the ticket.

# Ticket: ${ticket.title}
# Project: ${board.key || board.app || 'unknown'}
# Workdir: ${workdir}

${body || '(no description - judge against the title)'}

# How to review
- The full diff is in \`.review-diff.patch\`. Read it first.
- You MAY read other project files for context, especially under \`${workdir}\`. Do NOT modify files and do NOT run git.
- Check correctness, clear bugs, broken types, missed cases, and project conventions.
- Be pragmatic: request changes only for real problems, not style preferences.

# Output
End with exactly these two lines:
REVIEW_VERDICT: APPROVE   (or REQUEST_CHANGES)
REVIEW_NOTES: <specific fixes, or one short approval line>`;
}

async function runReview({ config, board, ticket, body, worktreeDir, implementer, baseRef, log }) {
  const runDir = path.join(config.baseDir, 'runs', `${ticket.shortId}-review-${Date.now()}`);
  fs.mkdirSync(runDir, { recursive: true });
  const patchPath = path.join(worktreeDir, '.review-diff.patch');
  const reviewBase = worktrees.head(worktreeDir);
  const reviewPatch = worktrees.diff(worktreeDir, baseRef || board.baseBranch || config.baseBranch);
  fs.writeFileSync(patchPath, reviewPatch, 'utf8');

  const prompt = buildReviewPrompt({ ticket, body, board });
  const candidates = buildReviewCandidates(implementer, config);
  const label = (c) => `${c.provider}${c.model ? ` / ${c.model}` : ''}`;
  log(`review chain: ${candidates.map(label).join(' -> ')}`);

  try {
    const fallback = await runWithFallback({
      candidates,
      invoke: (candidate, index) => spawnEngine({
        cli: candidate.provider,
        prompt,
        worktreeDir,
        runDir,
        model: candidate.model,
        tag: `review-${index}-${candidate.provider}`,
        config,
        timeoutMs: config.runTimeoutMs,
        log,
      }),
      classify: (result) => ({
        action: !result.timedOut && result.code === 0 && /REVIEW_VERDICT:/i.test(result.lastMessage) ? 'accept' : 'next',
        reason: result.quota ? 'usage limit' : `no verdict (code ${result.code}${result.timedOut ? ', timeout' : ''})`,
      }),
      onAdvance: ({ candidate, next, decision }) => log(`${label(candidate)} review ${decision.reason} - ${next ? `falling back to ${label(next)}` : 'no candidates left'}`),
      reset: () => {
        worktrees.resetWorktree(worktreeDir, reviewBase);
        fs.writeFileSync(patchPath, reviewPatch, 'utf8');
      },
    });

    if (fallback.status === 'accept') {
      return {
        ...parseReviewVerdict(fallback.result.lastMessage),
        reviewer: { cli: fallback.candidate.provider, model: fallback.candidate.model },
      };
    }
    const last = fallback.last;
    return {
      verdict: 'request_changes',
      inconclusive: true,
      notes: `Review could not complete. Last output tail:\n${(last?.result?.lastMessage || '').slice(-500)}`,
      reviewer: { cli: last?.candidate?.provider || '', model: last?.candidate?.model || '' },
    };
  } finally {
    try { fs.rmSync(patchPath, { force: true }); } catch {}
    worktrees.resetWorktree(worktreeDir, reviewBase);
  }
}

module.exports = { buildReviewCandidates, parseReviewVerdict, buildReviewPrompt, runReview };
