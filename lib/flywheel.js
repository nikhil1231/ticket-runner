'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnEngine: spawnEngineDefault } = require('./engine');
const { buildCandidateChain, runWithFallback } = require('./fallback');
const worktreesDefault = require('./worktree');
const { classifyFailure } = require('./failure');

const FLYWHEEL_DEFAULTS = {
  enabled: false,
  backlogThreshold: 2,
  maxOpenTickets: 10,
  maxEpics: 7,
  maxTicketsPerPass: 3,
  cooldownMs: 15 * 60 * 1000,
};

const OPEN_STATUSES = ['done', 'failed', 'cancelled'];
const isOpen = (ticket) => !OPEN_STATUSES.includes(ticket.status);

function flywheelSettings(config, board) {
  return { ...FLYWHEEL_DEFAULTS, ...(config.flywheel || {}), ...(board.flywheel || {}) };
}

function missionHash(mission) {
  return crypto.createHash('sha256').update(`${mission.title || ''}\0${mission.body || ''}`).digest('hex');
}

function trackerKeyFor(board) {
  if (board.tracker?.type === 'github') return `github:${board.tracker.owner}/${board.tracker.repo}`;
  return 'notion';
}

function normalizeTitle(title) {
  return String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Drops proposed items that duplicate an existing title (siblings, backlog, or
// earlier items in this same batch) while keeping track of each survivor's
// position in the *original* list, so dependsOn indexes (which are relative to
// that original list) can still be resolved after some items are dropped.
function dedupeAgainst(items, existingTitles) {
  const seen = new Set(existingTitles.map(normalizeTitle));
  const kept = [];
  items.forEach((item, originalIndex) => {
    const norm = normalizeTitle(item.title);
    if (seen.has(norm)) return;
    seen.add(norm);
    kept.push({ ...item, originalIndex });
  });
  return kept;
}

function withParentLink(body, parent) {
  if (!parent) return body;
  const link = parent.trackerMeta?.url ? `**Parent:** ${parent.trackerMeta.url}` : `**Parent:** ${parent.title}`;
  return `${link}\n\n${body}`;
}

function formatList(items) {
  return items.length ? items.map((item, i) => `${i + 1}. ${item}`).join('\n') : '(none)';
}

function labelEpic(epic) {
  return `${epic.title} [${epic.status}]${epic.status === 'cancelled' ? ' — rejected, do not re-propose' : ''}`;
}

// ---- output contract ----
// The final message is exactly one of:
//   NEEDS_INFO: <one line>
//   TICKETS:\n```json\n{"<key>":[{...}]}\n```
function extractItems(lastMessage, { key, max }) {
  const text = String(lastMessage || '').trim();
  const needsInfo = text.split(/\r?\n/).find((line) => line.trim().startsWith('NEEDS_INFO:'));
  if (needsInfo) return { status: 'needs_info', message: needsInfo.trim() };

  const markerIndex = text.lastIndexOf('TICKETS:');
  if (markerIndex === -1) return { status: 'invalid', reason: 'no TICKETS: marker found' };
  const after = text.slice(markerIndex);
  const fenceMatch = after.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (!fenceMatch) return { status: 'invalid', reason: 'no fenced JSON block after TICKETS:' };

  let parsed;
  try {
    parsed = JSON.parse(fenceMatch[1]);
  } catch (error) {
    return { status: 'invalid', reason: `invalid JSON: ${error.message}` };
  }
  const items = parsed?.[key];
  if (!Array.isArray(items) || items.length < 1 || items.length > max) {
    return { status: 'invalid', reason: `expected 1-${max} items under "${key}"` };
  }
  const bodyField = key === 'epics' ? 'summary' : 'body';
  for (const [index, item] of items.entries()) {
    if (!item || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 120) {
      return { status: 'invalid', reason: `item ${index} has an invalid title` };
    }
    if (typeof item[bodyField] !== 'string' || item[bodyField].trim().length < 50) {
      return { status: 'invalid', reason: `item ${index} has an insufficient ${bodyField}` };
    }
    if (item.dependsOn !== undefined) {
      const bad = !Array.isArray(item.dependsOn)
        || item.dependsOn.some((dep) => !Number.isInteger(dep) || dep < 0 || dep >= index);
      if (bad) return { status: 'invalid', reason: `item ${index} has invalid dependsOn (must reference earlier items)` };
    }
  }
  return { status: 'success', items };
}

// ---- prompts ----
function buildEpicPrompt({ mission, board, epics }) {
  const workdir = board.workdir || board.appDir || '.';
  const existing = formatList(epics.map(labelEpic));
  const notes = board.notes ? `\n# Project notes\n${board.notes}\n` : '';
  return `You are decomposing a product mission into epics for an autonomous coding runner. Work autonomously and non-interactively.

# Mission: ${mission.title}
# Target project: ${board.key || board.app}
# Workdir: ${workdir}

# Mission statement
${mission.body || '(no further description)'}

# Existing epics
${existing}
${notes}
# Instructions
- Inspect the repository read-only to understand the current state of the codebase before proposing epics.
- Read project conventions such as CLAUDE.md, AGENTS.md, docs, or README files when present.
- Do not edit files and do not run git. This is planning only.
- Propose the epics needed to make meaningful, durable progress toward the mission from where the codebase stands today.
- Do not repeat existing or rejected epics.
- Each epic must be a coherent, independently valuable slice of work with a clear scope boundary and definition of done.
- If the mission is too vague to decompose safely, output one line: NEEDS_INFO: <specific questions>.
- Otherwise output exactly:
TICKETS:
\`\`\`json
{"epics":[{"title":"<=120 chars, imperative","summary":"markdown: goal, scope boundary, definition of done","dependsOn":[]}]}
\`\`\`
- dependsOn holds zero-based indexes of earlier epics in this same list that must land first; omit or leave empty if none.`;
}

function buildTicketPrompt({ mission, board, epic, siblings, backlogTitles, recentTitles }) {
  const workdir = board.workdir || board.appDir || '.';
  const siblingList = formatList(siblings.map(labelEpic));
  const backlogList = formatList(backlogTitles);
  const recentList = formatList(recentTitles);
  const notes = board.notes ? `\n# Project notes\n${board.notes}\n` : '';
  return `You are breaking an approved epic into concrete implementation tickets for an autonomous coding runner. Work autonomously and non-interactively.

# Mission: ${mission.title}
# Epic: ${epic.title}
# Target project: ${board.key || board.app}
# Workdir: ${workdir}

# Epic scope
${epic.body || '(no further description)'}

# Tickets already under this epic
${siblingList}

# Current project backlog (do not duplicate)
${backlogList}

# Recently completed or failed tickets (context, do not duplicate)
${recentList}
${notes}
# Instructions
- Inspect the repository read-only and ground every ticket in the actual current code.
- Read project conventions such as CLAUDE.md, AGENTS.md, docs, or README files when present.
- Do not edit files and do not run git. This is planning only.
- Propose the next slice of tickets that make concrete progress on this epic's remaining scope.
- Do not repeat tickets already listed above.
- Each ticket must be independently implementable by a single coding agent in one sitting: a clear, decision-complete unit of work.
- Sequence dependent tickets with dependsOn (zero-based indexes within this same list); most tickets should have none.
- If the epic is too vague to break down safely, output one line: NEEDS_INFO: <specific questions>.
- Otherwise output exactly:
TICKETS:
\`\`\`json
{"tickets":[{"title":"<=120 chars","body":"markdown, decision-complete: behavior, key implementation changes, interfaces/data flow, and how to verify it","dependsOn":[]}]}
\`\`\``;
}

// ---- planning-run execution (read-only worktree + fallback chain) ----
function plannerRunConfig(config) {
  return {
    ...config,
    adapters: {
      ...(config.adapters || {}),
      claude: {
        ...((config.adapters && config.adapters.claude) || {}),
        permissionModeOverride: 'plan',
        disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash'],
      },
      codex: {
        ...((config.adapters && config.adapters.codex) || {}),
        sandbox: 'read-only',
        sandboxOverride: 'read-only',
      },
    },
  };
}

async function runPlannerAgent({ config, board, log, services, prompt, tag, key, max }) {
  const spawnEngine = services.spawnEngine || spawnEngineDefault;
  const wt = services.worktrees || worktreesDefault;
  const runDir = path.join(config.baseDir, 'runs', `${board.key || board.app}-flywheel-${tag}-${Date.now()}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'prompt.txt'), prompt, 'utf8');

  let workspaceDir;
  try {
    workspaceDir = wt.createDetachedWorktree({
      repoPath: board.repoPath || config.repoPath,
      baseBranch: board.baseBranch || config.baseBranch,
      worktreesDir: path.join(config.baseDir, 'worktrees', board.key || board.app),
      shortId: `flywheel-${tag}`,
    });
    const fallbackBase = wt.head(workspaceDir);
    const candidates = buildCandidateChain(config.fallbackPolicies?.planner || [{ provider: 'claude' }, { provider: 'codex' }]);
    const label = (c) => `${c.provider}${c.model ? ` / ${c.model}` : ''}`;
    log(`flywheel planning (${tag}) with ${candidates.map(label).join(' -> ')}`);
    return await runWithFallback({
      candidates,
      invoke: (candidate, index) => spawnEngine({
        cli: candidate.provider,
        prompt,
        worktreeDir: workspaceDir,
        runDir,
        model: candidate.model,
        tag: `${tag}-${index}-${candidate.provider}`,
        config: plannerRunConfig(config),
        timeoutMs: config.runTimeoutMs,
        log,
      }),
      classify: (result) => {
        if (result.timedOut || result.code !== 0) return { action: 'next', reason: result.quota ? 'usage limit' : 'execution failed' };
        const parsed = extractItems(result.lastMessage, { key, max });
        return {
          action: parsed.status === 'success' ? 'accept' : parsed.status === 'needs_info' ? 'stop' : 'next',
          value: parsed,
          reason: parsed.reason,
        };
      },
      onAdvance: ({ candidate, next, decision }) => log(`${label(candidate)} flywheel ${decision.reason} - ${next ? `falling back to ${label(next)}` : 'no candidates left'}`),
      reset: () => wt.resetWorktree(workspaceDir, fallbackBase),
    });
  } finally {
    if (workspaceDir) wt.removeDetachedWorktree({ repoPath: board.repoPath || config.repoPath, dir: workspaceDir, ignoreErrors: true });
  }
}

// ---- phases ----
async function runEpicPhase({ config, board, store, log, services, mission, epics, settings }) {
  const prompt = buildEpicPrompt({ mission, board, epics });
  const fallback = await runPlannerAgent({ config, board, log, services, prompt, tag: 'epics', key: 'epics', max: settings.maxEpics });
  if (fallback.status === 'stop') {
    store.enqueueComment(mission.id, fallback.value.message);
    return { status: 'needs_info' };
  }
  if (fallback.status !== 'accept') {
    throw new Error(`all flywheel planning candidates failed while proposing epics for ${board.key || board.app}`);
  }

  const existingTitles = epics.map((epic) => epic.title);
  const kept = dedupeAgainst(fallback.value.items, existingTitles).slice(0, settings.maxEpics);
  const trackerKey = trackerKeyFor(board);
  const projectKey = board.key || board.app;
  const idByOriginalIndex = new Map();
  const created = [];
  for (const item of kept) {
    const epic = store.createLocalTicket({
      projectKey,
      kind: 'epic',
      title: item.title.trim(),
      body: withParentLink(item.summary.trim(), mission),
      parentId: mission.id,
      status: 'in_review',
      tracker: trackerKey,
    });
    idByOriginalIndex.set(item.originalIndex, epic.id);
    created.push(epic);
  }
  for (const item of kept) {
    for (const depIndex of item.dependsOn || []) {
      const depId = idByOriginalIndex.get(depIndex);
      if (depId) store.addDependency(idByOriginalIndex.get(item.originalIndex), depId, 'blocks');
    }
  }
  if (created.length) {
    store.enqueueComment(mission.id, `Flywheel proposed ${created.length} epic(s) for review: ${created.map((epic) => epic.title).join(', ')}. Move each to Not started to approve, or Cancelled to reject.`);
  }
  return { status: 'ok', created: created.length };
}

async function runTicketPhase({ config, board, store, log, services, mission, epic, settings }) {
  const projectKey = board.key || board.app;
  const siblings = store.childrenOf(epic.id);
  const allFeatures = store.ticketsByKind(projectKey, 'feature');
  const backlogTitles = allFeatures.filter((ticket) => ticket.status === 'queued').map((ticket) => ticket.title);
  const recentTitles = allFeatures
    .filter((ticket) => ['done', 'failed'].includes(ticket.status))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 15)
    .map((ticket) => ticket.title);
  const openCount = allFeatures.filter(isOpen).length;
  const max = Math.max(1, Math.min(settings.maxTicketsPerPass, Math.max(1, settings.maxOpenTickets - openCount)));

  const prompt = buildTicketPrompt({ mission, board, epic, siblings, backlogTitles, recentTitles });
  const fallback = await runPlannerAgent({ config, board, log, services, prompt, tag: `epic-${epic.shortId}`, key: 'tickets', max });
  if (fallback.status === 'stop') {
    store.enqueueComment(epic.id, fallback.value.message);
    return { status: 'needs_info' };
  }
  if (fallback.status !== 'accept') {
    throw new Error(`all flywheel planning candidates failed while breaking down epic "${epic.title}" for ${board.key || board.app}`);
  }

  const existingTitles = [...siblings.map((ticket) => ticket.title), ...backlogTitles];
  const kept = dedupeAgainst(fallback.value.items, existingTitles).slice(0, max);
  const trackerKey = trackerKeyFor(board);
  const idByOriginalIndex = new Map();
  const created = [];
  for (const item of kept) {
    const ticket = store.createLocalTicket({
      projectKey,
      kind: 'feature',
      title: item.title.trim(),
      body: withParentLink(item.body.trim(), epic),
      parentId: epic.id,
      status: 'queued',
      tracker: trackerKey,
    });
    idByOriginalIndex.set(item.originalIndex, ticket.id);
    created.push(ticket);
  }
  for (const item of kept) {
    for (const depIndex of item.dependsOn || []) {
      const depId = idByOriginalIndex.get(depIndex);
      if (depId) store.addDependency(idByOriginalIndex.get(item.originalIndex), depId, 'blocks');
    }
  }
  if (created.length) {
    store.enqueueComment(epic.id, `Flywheel generated ${created.length} new ticket(s): ${created.map((ticket) => ticket.title).join(', ')}.`);
  }
  return { status: 'ok', created: created.length };
}

// ---- epic lifecycle (auto-completion + mission idle reporting) ----
function reconcileEpics({ store, board, log = () => {} }) {
  const projectKey = board.key || board.app;
  const epics = store.ticketsByKind(projectKey, 'epic').filter((epic) => epic.status === 'queued' || epic.status === 'in_progress');
  for (const epic of epics) {
    const children = store.childrenOf(epic.id);
    if (!children.length) continue;
    const allSettled = children.every((child) => ['done', 'cancelled'].includes(child.status));
    const anyDone = children.some((child) => child.status === 'done');
    if (!allSettled || !anyDone) continue;
    store.transition(epic.id, 'done');
    store.enqueueComment(epic.id, `All ${children.length} ticket(s) under this epic are complete. Marking the epic done.`);
    if (epic.parentId) {
      const doneCount = children.filter((child) => child.status === 'done').length;
      store.enqueueComment(epic.parentId, `Epic "${epic.title}" is complete (${doneCount}/${children.length} tickets done).`);
    }
    log(`flywheel: epic "${epic.title}" auto-completed (${projectKey})`);
  }

  const missions = store.ticketsByKind(projectKey, 'mission');
  for (const mission of missions) {
    if (mission.status === 'cancelled') continue;
    const missionEpics = store.ticketsByKind(projectKey, 'epic').filter((epic) => epic.parentId === mission.id);
    if (!missionEpics.length) continue;
    const allSettled = missionEpics.every((epic) => ['done', 'cancelled'].includes(epic.status));
    if (!allSettled) continue;
    const idleHashKey = `flywheel:mission-idle-hash:${mission.id}`;
    const currentIdleHash = crypto.createHash('sha256')
      .update(missionEpics.map((epic) => `${epic.id}:${epic.status}`).sort().join(','))
      .digest('hex');
    if (store.getKv(idleHashKey, null) === currentIdleHash) continue;
    store.enqueueComment(mission.id, 'All epics under this mission are complete or rejected. Update the mission body to propose new epics, or add one manually.');
    store.setKv(idleHashKey, currentIdleHash);
  }
}

// ---- orchestration ----
async function runFlywheelPass({ config, board, store, log = () => {}, services = {} } = {}) {
  const projectKey = board.key || board.app;
  const settings = flywheelSettings(config, board);
  if (!settings.enabled) return { status: 'disabled' };

  reconcileEpics({ store, board, log });

  const cooldownKey = `flywheel:cooldown:${projectKey}`;
  const failuresKey = `flywheel:failures:${projectKey}`;
  const cooldownUntil = store.getKv(cooldownKey, null);
  if (cooldownUntil && cooldownUntil > new Date().toISOString()) return { status: 'cooldown' };

  const missions = store.ticketsByKind(projectKey, 'mission').filter((mission) => mission.status !== 'cancelled');
  const mission = missions[0];
  if (!mission) return { status: 'no_mission' };

  const epics = store.ticketsByKind(projectKey, 'epic').filter((epic) => epic.parentId === mission.id);
  const activeEpics = epics.filter((epic) => epic.status !== 'cancelled');
  const anyInReview = epics.some((epic) => epic.status === 'in_review');
  const hashKey = `flywheel:mission-hash:${mission.id}`;
  const currentHash = missionHash(mission);
  const missionChanged = store.getKv(hashKey, null) !== currentHash;

  try {
    let result;
    if (!anyInReview && (activeEpics.length === 0 || missionChanged)) {
      result = await runEpicPhase({ config, board, store, log, services, mission, epics, settings });
      store.setKv(hashKey, currentHash);
    } else {
      const approved = activeEpics
        .filter((epic) => epic.status === 'queued')
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      const targetEpic = approved[0];
      const allFeatures = store.ticketsByKind(projectKey, 'feature');
      const queuedCount = allFeatures.filter((ticket) => ticket.status === 'queued').length;
      const openCount = allFeatures.filter(isOpen).length;
      if (!targetEpic) {
        result = { status: 'awaiting_epic_approval' };
      } else if (queuedCount >= settings.backlogThreshold) {
        result = { status: 'backlog_full' };
      } else if (openCount >= settings.maxOpenTickets) {
        result = { status: 'open_ticket_cap' };
      } else {
        result = await runTicketPhase({ config, board, store, log, services, mission, epic: targetEpic, settings });
      }
    }

    if (result.status === 'needs_info' || (result.status === 'ok' && result.created === 0)) {
      store.setKv(cooldownKey, new Date(Date.now() + settings.cooldownMs).toISOString());
      store.setKv(failuresKey, 0);
    } else if (result.status === 'ok') {
      store.deleteKv(cooldownKey);
      store.setKv(failuresKey, 0);
    }
    return result;
  } catch (error) {
    const failures = (store.getKv(failuresKey, 0) || 0) + 1;
    store.setKv(failuresKey, failures);
    const delay = Math.min(settings.cooldownMs * (2 ** (failures - 1)), 24 * 60 * 60 * 1000);
    store.setKv(cooldownKey, new Date(Date.now() + delay).toISOString());
    const classification = classifyFailure(error, { runner: true });
    log(`flywheel pass failed for ${projectKey} (${classification.kind}): ${error.message}`);
    try {
      store.enqueueComment(mission.id, `Flywheel pass failed for ${projectKey}; will retry after a cooldown.\n\n${error.message}`);
    } catch {}
    return { status: 'error', error: error.message };
  }
}

module.exports = {
  FLYWHEEL_DEFAULTS,
  flywheelSettings,
  missionHash,
  trackerKeyFor,
  dedupeAgainst,
  extractItems,
  buildEpicPrompt,
  buildTicketPrompt,
  reconcileEpics,
  runFlywheelPass,
};
