'use strict';

const fs = require('fs');
const path = require('path');
const { buildChain, spawnEngine } = require('./engine');
const worktrees = require('./worktree');

const DEFAULT_REVIEWER = { cli: 'antigravity', model: 'Gemini 3.5 Flash (Low)' };
const DEFAULT_ALT = { cli: 'codex', model: '' };

// Deterministically choose a reviewer that differs from the implementer. Default
// is agy Gemini Flash; if the implementer already used exactly that engine+model,
// fall back to the configured alternate (codex) so review is never same-on-same.
function pickReviewer(implementer, config) {
  const reviewer = (config.review && config.review.reviewer) || DEFAULT_REVIEWER;
  const alt = (config.review && config.review.alt) || DEFAULT_ALT;
  const sameCli = reviewer.cli === implementer.cli;
  const sameModel = (reviewer.model || '') === (implementer.model || '');
  return sameCli && sameModel ? alt : reviewer;
}

// Parse the reviewer's structured verdict. No clear verdict → treat as changes
// requested so nothing auto-advances on a garbled review.
function parseReviewVerdict(lastMessage) {
  const text = lastMessage || '';
  const verdict = text.match(/REVIEW_VERDICT:\s*(APPROVE|REQUEST_CHANGES)/i);
  const notesMatch = text.match(/REVIEW_NOTES:\s*([\s\S]*)$/i);
  const notes = (notesMatch ? notesMatch[1] : '').trim();
  if (!verdict) {
    return { verdict: 'request_changes', notes: notes || 'Reviewer did not return a clear REVIEW_VERDICT.' };
  }
  return { verdict: verdict[1].toUpperCase() === 'APPROVE' ? 'approve' : 'request_changes', notes };
}

function buildReviewPrompt({ ticket, body, board }) {
  return `You are reviewing a code change an AI made for a Notion ticket, in a git worktree of a yarn-workspaces monorepo. Decide whether it correctly and safely implements the ticket.

# Ticket: ${ticket.title}

${body || '(no description — judge against the title)'}

# How to review
- The full diff of the change is in the file \`.review-diff.patch\` in your current working directory. Read it first.
- You MAY read other files in \`${board.appDir}\` for context. Do NOT modify any files and do NOT run git.
- Check: does it actually implement the ticket? Any clear bugs, broken types, missed cases, or violations of the conventions in root CLAUDE.md and \`${board.appDir}/AGENTS.md\`?
- Be pragmatic — approve reasonable, working changes. Only request changes for real problems, not style preferences.

# Output
End your reply with exactly these two lines:
REVIEW_VERDICT: APPROVE   (or REQUEST_CHANGES)
REVIEW_NOTES: <if REQUEST_CHANGES: specific, actionable fixes the next agent must make; if APPROVE: one short line>`;
}

// Runs the reviewer through the same fallback chain as implementation, starting
// from the chosen reviewer engine. Cleans up the diff file and discards any files
// the reviewer wrote (keeping the implement commit) before returning.
async function runReview({ config, board, ticket, body, worktreeDir, reviewer, log }) {
  const runDir = path.join(config.baseDir, 'runs', `${ticket.shortId}-review-${Date.now()}`);
  fs.mkdirSync(runDir, { recursive: true });
  const patchPath = path.join(worktreeDir, '.review-diff.patch');
  fs.writeFileSync(patchPath, worktrees.diff(worktreeDir, config.baseBranch), 'utf8');

  const prompt = buildReviewPrompt({ ticket, body, board });
  const chain = buildChain(reviewer.cli, config);
  log(`review chain: ${chain.join(' -> ')} (start ${reviewer.cli}${reviewer.model ? ` / ${reviewer.model}` : ''})`);

  let last = { lastMessage: '' };
  try {
    for (let i = 0; i < chain.length; i++) {
      const cli = chain[i];
      const next = chain[i + 1];
      // the reviewer's chosen model applies only to its primary engine; a
      // fallback engine uses its own default model
      const model = cli === reviewer.cli ? reviewer.model : '';
      const r = await spawnEngine({
        cli, prompt, worktreeDir, runDir, model, tag: `review-${cli}`,
        config, timeoutMs: config.runTimeoutMs, log,
      });
      last = r;
      if (!r.timedOut && r.code === 0 && /REVIEW_VERDICT:/i.test(r.lastMessage)) {
        return { ...parseReviewVerdict(r.lastMessage), reviewer: { cli, model } };
      }
      if (r.quota) log(`${cli} review hit usage limit — ${next ? `falling back to ${next}` : 'no engines left'}`);
      else log(`${cli} review did not produce a verdict (code ${r.code}${r.timedOut ? ', timeout' : ''}) — ${next ? `falling back to ${next}` : 'no engines left'}`);
      if (next) worktrees.resetWorktree(worktreeDir);
    }
    // Reviewer couldn't run at all — inconclusive; caller sends it to a human
    // rather than requeuing for changes (which would re-implement pointlessly).
    return {
      verdict: 'request_changes',
      inconclusive: true,
      notes: `Review could not complete. Last output tail:\n${(last.lastMessage || '').slice(-500)}`,
      reviewer: { cli: reviewer.cli, model: reviewer.model },
    };
  } finally {
    try { fs.rmSync(patchPath, { force: true }); } catch {}
    // discard anything the reviewer wrote; the implement commit stays (it's HEAD)
    worktrees.resetWorktree(worktreeDir);
  }
}

module.exports = { pickReviewer, parseReviewVerdict, buildReviewPrompt, runReview, DEFAULT_REVIEWER, DEFAULT_ALT };
