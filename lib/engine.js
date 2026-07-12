'use strict';

const fs = require('fs');
const path = require('path');
const { runProcess } = require('./proc');

const adapters = {
  codex: require('./adapters/codex'),
  antigravity: require('./adapters/antigravity'),
  claude: require('./adapters/claude'),
};

// Signals that an engine is rate-limited / out of quota rather than failing on
// the task itself — the trigger to fall back to the next engine in the chain.
const QUOTA_RE = /you'?ve hit your usage limit|usage limit reached|rate[_\s-]?limit|quota exceeded|too many requests|insufficient[_\s]?quota|error 429|status 429|http 429/i;

function tail(text, lines) {
  return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
}

function readTail(file, lines) {
  try {
    return tail(fs.readFileSync(file, 'utf8'), lines);
  } catch {
    return '';
  }
}

// Runs one engine once in the worktree and returns the raw result + captured
// output. It does NOT interpret success/commits/verdict — callers (implement vs
// review) classify. Each invocation gets its own subdir under runDir (keyed by
// `tag`) so per-engine logs and codex's last-message file never collide.
async function spawnEngine({ cli, prompt, worktreeDir, runDir, model, tag, config, timeoutMs, log }) {
  const adapterConfig = (config.adapters && config.adapters[cli]) || {};
  const invDir = path.join(runDir, tag);
  fs.mkdirSync(invDir, { recursive: true });
  const outFile = path.join(invDir, 'stdout.log');
  const errFile = path.join(invDir, 'stderr.log');

  const spec = adapters[cli].build({
    worktreeDir,
    promptText: prompt,
    runDir: invDir,
    config: adapterConfig,
    model,
    timeoutMs,
  });

  // Some engines (agy) need the prompt as a file inside the worktree. Write it
  // there before the run and delete it after, so it never lands in a commit.
  const prepPaths = (spec.prepFiles || []).map((f) => path.join(worktreeDir, f.path));
  for (const p of prepPaths) fs.writeFileSync(p, prompt, 'utf8');

  if (log) log(`spawning ${cli}${model ? ` (${model})` : ''} — ${spec.cmd}, timeout ${Math.round(timeoutMs / 60000)}m`);
  const result = await runProcess({
    cmd: spec.cmd,
    args: spec.args,
    cwd: worktreeDir,
    stdinText: spec.stdinText,
    stdoutFile: outFile,
    stderrFile: errFile,
    timeoutMs,
  });
  for (const p of prepPaths) { try { fs.rmSync(p, { force: true }); } catch {} }

  let lastMessage = '';
  if (spec.lastMessageFile && fs.existsSync(spec.lastMessageFile)) {
    lastMessage = fs.readFileSync(spec.lastMessageFile, 'utf8').trim();
  }
  if (!lastMessage) lastMessage = readTail(outFile, 30);
  const quota = QUOTA_RE.test(`${readTail(errFile, 80)}\n${readTail(outFile, 80)}`);

  return { ...result, lastMessage, quota, outFile, errFile };
}

module.exports = { adapters, QUOTA_RE, spawnEngine, tail, readTail };
