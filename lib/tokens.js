'use strict';

const fs = require('fs');
const path = require('path');

// Token accounting is reconstructed from the per-invocation logs the runner
// already writes under runs/<runId>/<tag>/{stdout,stderr}.log. Nothing is added
// to the hot path: this module only reads what is already on disk. Coverage is
// whatever the CLIs report - codex prints a token total to stderr, claude (in
// --output-format json mode) reports input/output/cache tokens plus a real USD
// cost; antigravity reports nothing parseable, so its runs count but contribute
// zero tokens.

const KNOWN_PROVIDERS = new Set(['codex', 'claude', 'antigravity']);

// Map an invocation tag prefix (feature-0-codex, review-1-antigravity,
// epics-0-claude, plan-rescue-codex, ...) to the phase whose cost it represents.
const PHASE_BY_TAG_PREFIX = {
  feature: 'implementation',
  query: 'query',
  review: 'review',
  epics: 'planning',
  epic: 'planning',
  plan: 'planning',
};
const PHASE_BY_KIND = {
  ticket: 'implementation',
  review: 'review',
  planning: 'planning',
  other: 'other',
};
const PHASES = ['implementation', 'review', 'planning', 'query', 'other'];

function readTailBytes(file, maxBytes) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const length = size - start;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function readCapped(file, maxBytes) {
  try {
    if (fs.statSync(file).size > maxBytes) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// codex exec prints a trailing "tokens used\n<comma-formatted total>" to stderr.
function parseCodexTokens(stderrText) {
  const match = String(stderrText || '').match(/tokens used\s*[\r\n]+\s*([\d,]+)/i);
  if (!match) return null;
  const n = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// claude -p --output-format json emits a single result object carrying the
// final message, a usage breakdown, and a real total_cost_usd. Returns the
// message plus usage so the adapter can reuse it for lastMessage extraction.
function parseClaudeResult(stdoutText) {
  const text = String(stdoutText || '').trim();
  if (!text || text[0] !== '{') return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  const u = obj.usage || {};
  const tokens = (u.input_tokens || 0) + (u.output_tokens || 0)
    + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  return {
    lastMessage: typeof obj.result === 'string' ? obj.result : '',
    usage: {
      tokens,
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheReadTokens: u.cache_read_input_tokens || 0,
      costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
    },
  };
}

// Format-sniffing extraction: the output identifies itself (JSON parses or it
// doesn't; "tokens used" is present or not), so we don't have to trust the
// provider label to read the numbers correctly.
function extractUsage({ stdout, stderr }) {
  const claude = parseClaudeResult(stdout);
  if (claude && claude.usage.tokens) return claude.usage;
  const codexTokens = parseCodexTokens(stderr);
  if (codexTokens != null) return { tokens: codexTokens, costUsd: null };
  return null;
}

function phaseOfTag(tag) {
  return PHASE_BY_TAG_PREFIX[String(tag).split('-')[0]] || 'other';
}

function providerOfTag(tag) {
  const last = String(tag).split('-').pop();
  return KNOWN_PROVIDERS.has(last) ? last : 'unknown';
}

// A runDir is named for the work it belongs to. Order matters: the more
// specific patterns (flywheel/plan/review) must be tried before the generic
// "<shortId>-<timestamp>" ticket form, which would otherwise swallow them.
function parseRunDirName(name) {
  let m = name.match(/^(.+)-flywheel-.+-(\d+)$/);
  if (m) return { project: m[1], shortId: null, kind: 'planning' };
  m = name.match(/^(.+?)-plan-(\d+)$/);
  if (m) return { project: null, shortId: m[1], kind: 'planning' };
  m = name.match(/^(.+?)-review-(\d+)$/);
  if (m) return { project: null, shortId: m[1], kind: 'review' };
  if (/^service-\d+$/.test(name)) return { project: null, shortId: null, kind: 'other' };
  m = name.match(/^(.+?)-(\d+)$/);
  if (m) return { project: null, shortId: m[1], kind: 'ticket' };
  return { project: null, shortId: null, kind: 'other' };
}

// Every directory that directly holds a stdout.log/stderr.log is one engine
// invocation. Current runs nest these under a tag subdir (runDir/<tag>/); older
// runs wrote them flat in runDir. Handle both, one level deep.
function invocationsIn(runDir, dirName) {
  const meta = parseRunDirName(dirName);
  const out = [];
  const record = (dir, tag) => {
    const stdout = path.join(dir, 'stdout.log');
    const stderr = path.join(dir, 'stderr.log');
    if (!fs.existsSync(stdout) && !fs.existsSync(stderr)) return false;
    const usage = extractUsage({
      stdout: readCapped(stdout, 4 * 1024 * 1024),
      stderr: readTailBytes(stderr, 16 * 1024),
    });
    let mtimeMs = 0;
    for (const f of [stderr, stdout]) {
      try { mtimeMs = Math.max(mtimeMs, fs.statSync(f).mtimeMs); } catch {}
    }
    out.push({
      provider: tag ? providerOfTag(tag) : 'unknown',
      phase: tag ? phaseOfTag(tag) : (PHASE_BY_KIND[meta.kind] || 'other'),
      shortId: meta.shortId,
      project: meta.project,
      tokens: usage ? usage.tokens : 0,
      costUsd: usage && usage.costUsd != null ? usage.costUsd : 0,
      hasCost: !!(usage && usage.costUsd != null),
      mtimeMs,
    });
    return true;
  };
  // Nested tag subdirs first; fall back to a flat runDir.
  let entries = [];
  try { entries = fs.readdirSync(runDir, { withFileTypes: true }); } catch { return out; }
  let foundNested = false;
  for (const entry of entries) {
    if (entry.isDirectory()) foundNested = record(path.join(runDir, entry.name), entry.name) || foundNested;
  }
  if (!foundNested) record(runDir, null);
  return out;
}

function emptyBucket() {
  return { runs: 0, tokens: 0, costUsd: 0 };
}

function add(bucket, inv) {
  bucket.runs += 1;
  bucket.tokens += inv.tokens;
  bucket.costUsd += inv.costUsd;
}

// Walk the newest `limit` run directories and roll invocation usage up by
// provider, by phase (implementation vs review vs planning - the "how much is
// logistics" answer), and per ticket. Bounded and read-only; safe to call on
// every dashboard poll.
function collectTokenUsage(baseDir, { limit = 800, now = () => Date.now() } = {}) {
  const runsDir = path.join(baseDir, 'runs');
  const empty = {
    available: false, since: null, costTracked: false,
    totals: emptyBucket(), recent: emptyBucket(),
    byProvider: {}, byPhase: {}, perTicket: [],
  };
  let names;
  try {
    names = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return empty;
  }

  const dirs = names
    .map((name) => {
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(path.join(runsDir, name)).mtimeMs; } catch {}
      return { name, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);

  const cutoff = now() - 24 * 60 * 60 * 1000;
  const byProvider = {};
  const byPhase = Object.fromEntries(PHASES.map((p) => [p, emptyBucket()]));
  const perTicketMap = new Map();
  const totals = emptyBucket();
  const recent = emptyBucket();
  let costTracked = false;

  for (const { name } of dirs) {
    for (const inv of invocationsIn(path.join(runsDir, name), name)) {
      if (inv.hasCost) costTracked = true;
      add(totals, inv);
      (byProvider[inv.provider] ||= emptyBucket());
      add(byProvider[inv.provider], inv);
      add(byPhase[inv.phase] || (byPhase[inv.phase] = emptyBucket()), inv);
      if (inv.mtimeMs >= cutoff) add(recent, inv);
      if (inv.shortId) {
        const cur = perTicketMap.get(inv.shortId) || { shortId: inv.shortId, ...emptyBucket() };
        add(cur, inv);
        perTicketMap.set(inv.shortId, cur);
      }
    }
  }

  const perTicket = [...perTicketMap.values()]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 20);

  return {
    available: true,
    since: new Date(cutoff).toISOString(),
    costTracked,
    totals, recent, byProvider, byPhase, perTicket,
    scanned: dirs.length,
  };
}

module.exports = {
  parseCodexTokens, parseClaudeResult, extractUsage,
  phaseOfTag, providerOfTag, parseRunDirName,
  collectTokenUsage, PHASES,
};
