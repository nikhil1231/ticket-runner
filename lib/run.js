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

function tail(text, lines) {
  return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n[...truncated]` : text;
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
- Dependencies are already installed (yarn). Run the app's typecheck/lint scripts (see its package.json) before committing.
- Commit ALL of your work with lowercase scoped commit messages: \`${board.scope}: <description>\`. If \`git commit\` is blocked by your sandbox (the worktree's .git lives outside the workspace), do NOT fight it — leave the changes uncommitted and finish; the runner commits them for you.
- Do not push, do not create tags, stay on the current branch.
- If the ticket is too vague or ambiguous to implement confidently, make NO changes and end your final message with a line starting with \`NEEDS_INFO:\` followed by what needs clarifying.`;
}

async function runTicket({ config, board, page, ticket, log }) {
  const attempt = ticket.attempts + 1;
  const runId = `${ticket.shortId}-${Date.now()}`;
  const runDir = path.join(config.baseDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const stdoutFile = path.join(runDir, 'stdout.log');
  const stderrFile = path.join(runDir, 'stderr.log');

  log(`claiming "${ticket.title}" [${board.app}/${ticket.cli}] attempt ${attempt}/${config.maxAttempts} (${runId})`);
  await notion.updatePage(ticket.pageId, {
    'AI Status': { select: { name: 'Running' } },
    Status: { status: { name: 'In progress' } },
    Attempts: { number: attempt },
  });

  async function fail(reason) {
    const logTail = readTail(stderrFile, 40) || readTail(stdoutFile, 40);
    log(`FAILED attempt ${attempt}: ${reason}`);
    if (attempt >= config.maxAttempts) {
      await notion.updatePage(ticket.pageId, { 'AI Status': { select: { name: 'Failed' } } });
      await notion.safeComment(
        ticket.pageId,
        `❌ Failed (attempt ${attempt}/${config.maxAttempts}, ${ticket.cli}): ${reason}\n\nLogs: ${runDir}\n\n${truncate(logTail, 3000)}`,
        log
      );
    } else {
      // clearing AI Status requeues it on the next poll
      await notion.updatePage(ticket.pageId, { 'AI Status': { select: null } });
      await notion.safeComment(
        ticket.pageId,
        `⚠ Attempt ${attempt}/${config.maxAttempts} failed (${ticket.cli}): ${reason} — requeued.\n\nLogs: ${runDir}`,
        log
      );
    }
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

    const adapterConfig = config.adapters[ticket.cli] || config.adapters.codex;
    const adapter = adapters[ticket.cli] || adapters.codex;
    const spec = adapter.build({ worktreeDir, promptText: prompt, promptFile, runDir, config: adapterConfig });

    log(`spawning ${spec.cmd} (timeout ${Math.round(config.runTimeoutMs / 60000)}m)...`);
    const result = await runProcess({
      cmd: spec.cmd,
      args: spec.args,
      cwd: worktreeDir,
      stdinText: spec.stdinText,
      stdoutFile,
      stderrFile,
      timeoutMs: config.runTimeoutMs,
    });

    let lastMessage = '';
    if (spec.lastMessageFile && fs.existsSync(spec.lastMessageFile)) {
      lastMessage = fs.readFileSync(spec.lastMessageFile, 'utf8').trim();
    }
    if (!lastMessage) lastMessage = readTail(stdoutFile, 30);

    if (result.timedOut) return await fail(`timed out after ${Math.round(config.runTimeoutMs / 60000)} min (process tree killed)`);
    if (result.code !== 0) return await fail(`${spec.cmd} exited with code ${result.code}${result.spawnError ? ` (${result.spawnError})` : ''}`);

    const needsInfo = lastMessage.split(/\r?\n/).find((l) => l.trim().startsWith('NEEDS_INFO:'));
    if (needsInfo) {
      log(`needs info: "${ticket.title}"`);
      await notion.updatePage(ticket.pageId, { 'AI Status': { select: { name: 'Needs Info' } } });
      await notion.safeComment(
        ticket.pageId,
        `❓ The agent needs more info before it can implement this. Edit the ticket, then clear the AI Status field to requeue.\n\n${truncate(lastMessage, 3000)}`,
        log
      );
      return;
    }

    // codex's sandbox can't write to the worktree's .git (it lives in the main
    // repo), so uncommitted work is the normal codex outcome, not an anomaly.
    let leftoverNote = '';
    if (worktrees.isDirty(worktreeDir)) {
      worktrees.commitAll(worktreeDir, `${board.scope}: ${ticket.title.toLowerCase().slice(0, 60)} (ai)`);
      leftoverNote = '\n\nℹ The runner committed the agent’s changes (agent could not commit itself).';
    }
    const commits = worktrees.commitLog(worktreeDir, config.baseBranch);
    if (!commits) return await fail('agent exited successfully but made no changes');

    await notion.updatePage(ticket.pageId, {
      'AI Status': { select: { name: 'In Review' } },
      Branch: { rich_text: [{ text: { content: branch } }] },
    });
    await notion.safeComment(
      ticket.pageId,
      `✅ Ready for review (attempt ${attempt}, ${ticket.cli})\n\nBranch: ${branch}\nWorktree: ${worktreeDir}\n\nCommits:\n${truncate(commits, 1000)}${leftoverNote}\n\nAgent summary:\n${truncate(lastMessage, 2500)}`,
      log
    );
    log(`done: "${ticket.title}" -> In Review on ${branch}`);
  } catch (e) {
    await fail(`runner error: ${e.message}`);
  }
}

module.exports = { runTicket };
