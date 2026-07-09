'use strict';

const fs = require('fs');
const path = require('path');
const notionDefault = require('./notion');
const { spawnEngine: spawnEngineDefault, readTail } = require('./engine');
const { buildCandidateChain, runWithFallback } = require('./fallback');

const QUERY_HEADING = '## AI query answer';

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}\n[...truncated]` : value;
}

function firstMeaningfulLine(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function stripQueryMarker(title) {
  return String(title || '')
    .replace(/^\s*\[(?:query|question|q)\]\s*/i, '')
    .replace(/^\s*query\s*(?:only\s*)?[:\-]\s*/i, '')
    .trim();
}

function isQueryOnlyTicket(ticket, body = '') {
  const title = ticket?.title || '';
  const firstBodyLine = firstMeaningfulLine(body);
  const queryPrefix = /^\s*(?:\[(?:query|question|q)\]|query\s*(?:only\s*)?[:\-])/i;
  return queryPrefix.test(title) || queryPrefix.test(firstBodyLine);
}

function buildQueryPrompt({ ticket, body, board, humanComments = [] }) {
  const question = stripQueryMarker(ticket.title) || ticket.title || '(untitled)';
  const workdir = board.workdir || board.appDir || '.';
  const comments = humanComments.length
    ? humanComments.map((comment, index) => `${index + 1}. ${comment}`).join('\n')
    : '(none)';
  return `You are answering a query-only Notion ticket. Work autonomously and non-interactively.

# Query: ${question}
# Target project: ${board.key || board.app}
# Workdir: ${workdir}

# Ticket body
${body || '(no further description)'}

# New human feedback
${comments}

# Instructions
- This is query-only. Do not implement anything, do not edit files, and do not run git.
- Inspect the repository and relevant app code only as needed to answer accurately.
- Read project conventions such as CLAUDE.md, AGENTS.md, docs, or README files when present if they affect the answer.
- Answer the question directly and include concise evidence from the code or ticket context.
- If one missing detail would materially change the answer, include exactly one follow-up question.
- If the ticket cannot be answered safely without more information, output one line: NEEDS_INFO: <one specific question>.
- Otherwise output exactly:
ANSWER:
<Markdown answer for the ticket page>
FOLLOW_UP:
<one question, or NONE>`;
}

function extractQueryAnswer(lastMessage) {
  const text = String(lastMessage || '').trim();
  const needsInfo = text.split(/\r?\n/).find((line) => line.trim().startsWith('NEEDS_INFO:'));
  if (needsInfo) {
    return { status: 'needs_info', answer: '', followUp: needsInfo.replace(/^\s*NEEDS_INFO:\s*/i, '').trim() };
  }

  const answerMatch = text.match(/(?:^|\n)ANSWER:\s*\n([\s\S]*?)(?:\nFOLLOW_UP:\s*\n?([\s\S]*))?$/i);
  const answer = (answerMatch?.[1] || '').trim();
  let followUp = (answerMatch?.[2] || '').trim();
  if (/^(?:none|n\/a|no follow-?up\.?)$/i.test(followUp)) followUp = '';

  if (!answer || answer.length < 20) {
    return { status: 'invalid', reason: 'agent did not return a substantive ANSWER section' };
  }
  return { status: 'success', answer, followUp };
}

function formatQueryAnswer({ answer, followUp }) {
  const parts = [QUERY_HEADING];
  if (answer) parts.push(truncate(answer.trim(), 5000));
  if (followUp) parts.push(`**Follow-up needed:** ${truncate(followUp.trim(), 1000)}`);
  return parts.join('\n\n');
}

async function appendQueryAnswer(pageId, parsed, notion = notionDefault) {
  return notion.updatePageMarkdown(pageId, {
    type: 'insert_content',
    insert_content: {
      content: `\n\n${formatQueryAnswer(parsed)}`,
      position: { type: 'end' },
    },
  });
}

function buildQueryCandidates(config, ticket) {
  const policy = config.fallbackPolicies?.query || config.fallbackPolicies?.feature || [];
  const override = (ticket.cli || ticket.model)
    ? { provider: ticket.cli || policy[0]?.provider, model: ticket.model || '' }
    : undefined;
  const chain = buildCandidateChain(policy, { override }).filter((candidate) => candidate.provider === 'codex');
  return chain.length ? chain : [{ provider: 'codex', model: '' }];
}

function queryRunConfig(config) {
  return {
    ...config,
    adapters: {
      ...(config.adapters || {}),
      codex: {
        ...((config.adapters && config.adapters.codex) || {}),
        sandbox: 'read-only',
        sandboxOverride: 'read-only',
      },
    },
  };
}

async function runQueryTicket({
  config,
  board,
  ticket,
  body,
  humanComments = [],
  runDir,
  log = console.log,
  services = {},
}) {
  const notion = services.notion || notionDefault;
  const spawnEngine = services.spawnEngine || spawnEngineDefault;
  const candidates = buildQueryCandidates(config, ticket);
  const label = (candidate) => `${candidate.provider}${candidate.model ? ` / ${candidate.model}` : ''}`;
  const prompt = buildQueryPrompt({ ticket, body, board, humanComments });
  fs.writeFileSync(path.join(runDir, 'prompt.txt'), prompt, 'utf8');

  log(`query-only ticket "${ticket.title}" with ${candidates.map(label).join(' -> ')}`);
  const fallback = await runWithFallback({
    candidates,
    invoke: (candidate, index) => spawnEngine({
      cli: candidate.provider,
      prompt,
      worktreeDir: board.repoPath || config.repoPath,
      runDir,
      model: candidate.model,
      tag: `query-${index}-${candidate.provider}`,
      config: queryRunConfig(config),
      timeoutMs: config.runTimeoutMs,
      log,
    }),
    classify: (result) => {
      if (result.timedOut || result.code !== 0) {
        return { action: 'next', reason: result.quota ? 'usage limit' : 'execution failed' };
      }
      const parsed = extractQueryAnswer(result.lastMessage);
      return {
        action: parsed.status === 'success' || parsed.status === 'needs_info' ? 'accept' : 'next',
        value: parsed,
        reason: parsed.reason,
      };
    },
    onAdvance: ({ candidate, next, decision }) => log(`${label(candidate)} query ${decision.reason} - ${next ? `falling back to ${label(next)}` : 'no candidates left'}`),
  });

  if (fallback.status !== 'accept') {
    const last = fallback.last?.result;
    const logTail = last?.errFile ? readTail(last.errFile, 40) : '';
    const final = ticket.attempts + 1 >= config.maxAttempts;
    await notion.updatePage(ticket.pageId, {
      Status: { status: { name: final ? 'Failed' : 'Not started' } },
    });
    await notion.safeComment(
      ticket.pageId,
      `${final ? 'Query failed' : 'Query attempt failed and was requeued'}: all query candidates failed.\n\n${truncate(logTail, 1800)}`,
      log
    );
    return { status: final ? 'failed' : 'requeued' };
  }

  const parsed = fallback.value;
  if (parsed.status === 'needs_info') {
    await appendQueryAnswer(ticket.pageId, {
      answer: 'I need one detail before I can answer this confidently.',
      followUp: parsed.followUp,
    }, notion);
  } else {
    await appendQueryAnswer(ticket.pageId, parsed, notion);
  }

  const modelLabel = label(fallback.candidate);
  await notion.updatePage(ticket.pageId, {
    Status: { status: { name: 'Needs info' } },
    Attempts: { number: ticket.attempts },
    'Last agent': { rich_text: [{ text: { content: modelLabel.slice(0, 200) } }] },
  });
  await notion.safeComment(
    ticket.pageId,
    parsed.followUp
      ? `Query answered and a follow-up was added to the page body.\n\n${truncate(parsed.followUp, 1000)}`
      : 'Query answered in the page body. Move it back to Not started if you want the runner to take another pass.',
    log
  );
  return { status: parsed.followUp ? 'needs_info' : 'answered' };
}

module.exports = {
  QUERY_HEADING,
  isQueryOnlyTicket,
  stripQueryMarker,
  buildQueryPrompt,
  extractQueryAnswer,
  formatQueryAnswer,
  appendQueryAnswer,
  buildQueryCandidates,
  runQueryTicket,
};
