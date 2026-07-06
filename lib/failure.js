'use strict';

const crypto = require('crypto');

const USER_RE = /NEEDS_INFO:|ticket.+(?:vague|ambiguous)|missing (?:title|brief|app)|select an app|content is truncated|unsupported blocks/i;
const CONFIG_RE = /NOTION_TOKEN|EXPO_TOKEN|authentication|unauthorized|forbidden|permission denied|not found in PATH|ENOENT|unknown (?:provider|adapter|model)|Notion .+ -> (?:400|401|403|404)/i;
const PROVIDER_RE = /usage limit|rate.?limit|quota|status 429|timed out|exited with code|spawn error|model.+not found/i;
const TRANSIENT_RE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|HTTP 5\d\d|Notion .+ -> 5\d\d|index\.lock|could not resolve host/i;
const INFRA_RE = /runner error|git .+(?:failed|fatal)|worktree|rev-parse|reset --hard|yarn install|npm install|Notion (?:GET|POST|PATCH)|EACCES|ENOSPC|corrupt/i;

function textOf(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return [error.message, error.stack, error.stderr, error.stdout].filter(Boolean).join('\n');
}

function classifyFailure(error, context = {}) {
  const text = textOf(error);
  if (context.needsInfo || USER_RE.test(text)) return { kind: 'user', transient: false };
  if (CONFIG_RE.test(text)) return { kind: 'configuration', transient: false };
  if (context.provider || PROVIDER_RE.test(text)) return { kind: 'provider', transient: TRANSIENT_RE.test(text) };
  if (context.task) return { kind: 'task', transient: false };
  if (TRANSIENT_RE.test(text)) return { kind: 'infrastructure', transient: true };
  if (context.runner || INFRA_RE.test(text)) return { kind: 'infrastructure', transient: false };
  return { kind: 'infrastructure', transient: false };
}

function normalizeFailure(error) {
  return textOf(error)
    .replace(/[a-f0-9]{40}/gi, '<sha>')
    .replace(/\b\d{10,}\b/g, '<number>')
    .replace(/[A-Za-z]:\\[^\n:]+|\/(?:[^\s:\n]+\/)+[^\s:\n]*/g, '<path>')
    .replace(/:\d+:\d+/g, ':<line>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

function failureFingerprint(error, kind = 'unknown') {
  return crypto.createHash('sha256').update(`${kind}\0${normalizeFailure(error)}`).digest('hex').slice(0, 16);
}

module.exports = { classifyFailure, failureFingerprint, normalizeFailure, textOf };
