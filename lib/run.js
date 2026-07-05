'use strict';

const fs = require('fs');
const path = require('path');
const notion = require('./notion');
const { blocksToMarkdown } = require('./ticket');
const { runProcess } = require('./proc');
const worktrees = require('./worktree');

const adapters = {
  codex: require('./adapters/codex'),
  antigravity: require('./adapters/antigravity'),
};

// Signals that an engine is rate-limited / out of quota rather than failing on
// the task itself — the trigger to fall back to another engine and to skip this
// one for the rest of the runner process.
const QUOTA_RE = /you'?ve hit your usage limit|usage limit reached|rate[_\s-]?limit|quota exceeded|too many requests|insufficient[_\s]?quota|error 429|status 429|http 429/i;

function tail(text, lines) {
  return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
}

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

function readTail(file, lines) {
  try {
    return tail(fs.readFileSync(file, 'utf8'), lines);
  } catch {
    return '';
  }
}

function buildPrompt({ ticket, body, board }) {
  return `You are completing a ticket from a Notion board, autonomously and non-interactively.

# Ticket: ${ticket.title}

${body || '(no further description — go by the title)'}

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

// Ordered list of engines to try: the ticket's chosen CLI first, then the
// configured fallbacks, de-duplicated. We always start from the top (optimistic
// codex-first) and let a quota/failure fall through — no backoff state to keep.
function buildChain(primaryCli, config) {
  const seen = new Set();
  const chain = [];
  for (const cli of [primaryCli, ...(config.fallbackChain || [])]) {
    if (!cli || seen.has(cli) || !adapters[cli]) continue;
    seen.add(cli);
    chain.push(cli);
  }
  return chain;
}

async function runTicket({ config, board, ticket, log }) {
  const attempt = ticket.attempts + 1;
  const runId = `${ticket.shortId}-${Date.now()}`;
  const runDir = path.join(config.baseDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });

  log(`claiming "${ticket.title}" [${board.app}/${ticket.cli}] attempt ${attempt}/${config.maxAttempts} (${runId})`);
  await notion.updatePage(ticket.pageId, {
    'AI Status': { select: { name: 'Running' } },
    Status: { status: { name: 'In progress' } },
    Attempts: { number: attempt },
  });

  async function fail(reason, files = {}) {
    const logTail = readTail(files.errFile || '', 40) || readTail(files.outFile || '', 40);
    log(`FAILED attempt ${attempt}: ${reason}`);
    if (attempt >= config.maxAttempts) {
      await notion.updatePage(ticket.pageId, { 'AI Status': { select: { name: 'Failed' } } });
      await notion.safeComment(
        ticket.pageId,
        `❌ Failed (attempt ${attempt}/${config.maxAttempts}): ${reason}\n\nLogs: ${runDir}\n\n${truncate(logTail, 3000)}`,
        log
      );
    } else {
      await notion.updatePage(ticket.pageId, { 'AI Status': { select: null } });
      await notion.safeComment(
        ticket.pageId,
        `⚠ Attempt ${attempt}/${config.maxAttempts} failed: ${reason} — requeued.\n\nLogs: ${runDir}`,
        log
      );
    }
  }

  // Runs one engine to completion in the worktree and classifies the outcome.
  async function runEngine(cli, prompt, promptFile, worktreeDir) {
    const adapterConfig = config.adapters[cli] || {};
    const outFile = path.join(runDir, `${cli}.stdout.log`);
    const errFile = path.join(runDir, `${cli}.stderr.log`);
    const spec = adapters[cli].build({
      worktreeDir,
      promptText: prompt,
      promptFile,
      runDir,
      config: adapterConfig,
      timeoutMs: config.runTimeoutMs,
    });

    // Some engines (agy) need the prompt as a file inside the worktree. Write it
    // there before the run and delete it after, so it never lands in a commit.
    const prepPaths = (spec.prepFiles || []).map((f) => path.join(worktreeDir, f.path));
    for (const p of prepPaths) fs.writeFileSync(p, prompt, 'utf8');

    log(`spawning ${cli} (${spec.cmd}, timeout ${Math.round(config.runTimeoutMs / 60000)}m)...`);
    const result = await runProcess({
      cmd: spec.cmd,
      args: spec.args,
      cwd: worktreeDir,
      stdinText: spec.stdinText,
      stdoutFile: outFile,
      stderrFile: errFile,
      timeoutMs: config.runTimeoutMs,
    });
    for (const p of prepPaths) { try { fs.rmSync(p, { force: true }); } catch {} }

    let lastMessage = '';
    if (spec.lastMessageFile && fs.existsSync(spec.lastMessageFile)) {
      lastMessage = fs.readFileSync(spec.lastMessageFile, 'utf8').trim();
    }
    if (!lastMessage) lastMessage = readTail(outFile, 30);
    const quota = QUOTA_RE.test(`${readTail(errFile, 80)}\n${readTail(outFile, 80)}`);

    if (result.timedOut) {
      return { status: 'fail', reason: `${cli} timed out after ${Math.round(config.runTimeoutMs / 60000)} min (process tree killed)`, errFile, outFile };
    }
    if (result.code !== 0) {
      if (quota) return { status: 'quota', reason: `${cli} usage limit / rate limit`, errFile, outFile };
      return { status: 'fail', reason: `${spec.cmd} exited with code ${result.code}${result.spawnError ? ` (${result.spawnError})` : ''}`, errFile, outFile };
    }

    const needsInfo = lastMessage.split(/\r?\n/).find((l) => l.trim().startsWith('NEEDS_INFO:'));
    if (needsInfo) return { status: 'needs_info', message: needsInfo.trim() };

    // A non-sandboxed engine (agy) commits itself; a sandboxed one (codex) can't
    // reach the worktree's .git, so we commit its leftovers here.
    if (worktrees.isDirty(worktreeDir)) {
      worktrees.commitAll(worktreeDir, extractCommitMessage(lastMessage, board.scope));
    }
    const commits = worktrees.commitLog(worktreeDir, config.baseBranch);
    if (!commits) {
      if (quota) return { status: 'quota', reason: `${cli} usage limit / rate limit`, errFile, outFile };
      return { status: 'fail', reason: `${cli} exited successfully but made no changes`, errFile, outFile };
    }
    return { status: 'success', cli, commits, summary: compactAgentSummary(lastMessage) };
  }

  try {
    const blocks = await notion.getBlockChildren(ticket.pageId);
    const body = blocksToMarkdown(blocks);
    const prompt = buildPrompt({ ticket, body, board });
    const promptFile = path.join(runDir, 'prompt.txt');
    fs.writeFileSync(promptFile, prompt, 'utf8');

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

    const chain = buildChain(ticket.cli, config);
    log(`engine chain: ${chain.join(' -> ')}`);

    let last = { reason: 'no engine ran' };
    for (let i = 0; i < chain.length; i++) {
      const cli = chain[i];
      const next = chain[i + 1];
      const outcome = await runEngine(cli, prompt, promptFile, worktreeDir);

      if (outcome.status === 'success') {
        await notion.updatePage(ticket.pageId, {
          'AI Status': { select: { name: 'In Review' } },
          Branch: { rich_text: [{ text: { content: branch } }] },
        });
        await notion.safeComment(
          ticket.pageId,
          `✅ Ready for review\nEngine: ${outcome.cli} (attempt ${attempt})\nBranch: ${branch}\nCommit: ${truncate(outcome.commits, 500)}\n\nWhat changed\n${outcome.summary}`,
          log
        );
        log(`done: "${ticket.title}" -> In Review on ${branch} (via ${outcome.cli})`);
        return;
      }

      if (outcome.status === 'needs_info') {
        log(`needs info: "${ticket.title}"`);
        await notion.updatePage(ticket.pageId, { 'AI Status': { select: { name: 'Needs Info' } } });
        await notion.safeComment(
          ticket.pageId,
          `❓ The agent needs more info before it can implement this. Edit the ticket, then clear the AI Status field to requeue.\n\n${truncate(outcome.message, 3000)}`,
          log
        );
        return;
      }

      if (outcome.status === 'quota') {
        log(`${cli} hit usage limit — ${next ? `falling back to ${next}` : 'no engines left'}`);
      } else {
        log(`${cli} failed: ${outcome.reason}${next ? ` — falling back to ${next}` : ''}`);
      }
      last = outcome;
      if (next) worktrees.resetWorktree(worktreeDir);
    }

    await fail(`all engines failed (${chain.join(' -> ')}). Last: ${last.reason}`, last);
  } catch (e) {
    await fail(`runner error: ${e.message}`);
  }
}

module.exports = { runTicket, buildChain, QUOTA_RE, extractCommitMessage, compactAgentSummary };
