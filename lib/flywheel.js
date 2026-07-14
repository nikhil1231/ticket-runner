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
  // continuous: an indefinite "keep improving this app" mission. When true, a
  // fresh epic-proposal round fires automatically once every epic is
  // done/cancelled (the flywheel keeps spinning). When false (one-shot),
  // completing every epic idles the mission until a human edits it or adds an
  // epic by hand.
  continuous: false,
  backlogThreshold: 2,
  maxOpenTickets: 10,
  maxEpics: 7,
  maxTicketsPerPass: 3,
  cooldownMs: 15 * 60 * 1000,
};

const SETTLED_STATUSES = ['done', 'cancelled'];
const OPEN_STATUSES = ['done', 'failed', 'cancelled'];
const isOpen = (ticket) => !OPEN_STATUSES.includes(ticket.status);
const isSettled = (ticket) => SETTLED_STATUSES.includes(ticket.status);

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
//   EPIC_COMPLETE: <one line>   (ticket phase only, when allowComplete is set)
//   TICKETS:\n```json\n{"<key>":[{...}]}\n```
function extractItems(lastMessage, { key, max, allowComplete = false }) {
  const text = String(lastMessage || '').trim();
  const needsInfo = text.split(/\r?\n/).find((line) => line.trim().startsWith('NEEDS_INFO:'));
  if (needsInfo) return { status: 'needs_info', message: needsInfo.trim() };

  if (allowComplete) {
    const complete = text.split(/\r?\n/).find((line) => line.trim().startsWith('EPIC_COMPLETE:'));
    if (complete) return { status: 'complete', message: complete.trim() };
  }

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
  if (!Array.isArray(items) || items.length < 1) {
    return { status: 'invalid', reason: `expected a non-empty "${key}" array` };
  }
  // Over-generation is not a failure: the model may propose more than the
  // budget, and the caller dedupes and truncates to `max`. Rejecting good work
  // over a count would waste the whole run. (`max` still shapes the prompt.)
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
function buildEpicPrompt({ mission, board, epics, max = 3 }) {
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
- Propose at most ${max} epic(s), ordered most valuable first — this is one focused round, not the whole roadmap. More rounds follow as epics complete.
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

function buildTicketPrompt({ mission, board, epic, siblings, backlogTitles, recentTitles, max = 3 }) {
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
- Propose at most ${max} ticket(s), ordered most valuable first — just the next slice of concrete progress on this epic's remaining scope, not its entire breakdown.
- Do not repeat tickets already listed above.
- Each ticket must be independently implementable by a single coding agent in one sitting: a clear, decision-complete unit of work.
- Sequence dependent tickets with dependsOn (zero-based indexes within this same list); most tickets should have none.
- If the epic is too vague to break down safely, output one line: NEEDS_INFO: <specific questions>.
- If this epic's scope is genuinely fully delivered by the code and the tickets already listed above — nothing valuable is left to add for it — output one line: EPIC_COMPLETE: <one-line reason>. Do not invent filler tickets to keep an epic alive.
- Otherwise output exactly:
TICKETS:
\`\`\`json
{"tickets":[{"title":"<=120 chars","body":"markdown, decision-complete: behavior, key implementation changes, interfaces/data flow, and how to verify it","dependsOn":[]}]}
\`\`\``;
}

// ---- planning-run execution (read-only worktree + fallback chain) ----
// Planning is read-only by intent, but the enforcement is the throwaway detached
// worktree (any edits are discarded, never committed) plus the prompt's "do not
// edit files, do not run git" — the same approach the incubator uses. We
// deliberately do NOT force codex's `--sandbox read-only`: that path runs
// commands under bubblewrap, which fails on kernels without unprivileged user
// namespaces (so codex can't even inspect the repo and bails with NEEDS_INFO).
// Leaving codex on its configured sandbox lets it read the workspace wherever
// normal implementation runs work. claude keeps plan mode + no edit/bash tools,
// which is app-level and always available.
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
    },
  };
}

// Resolve the provider/model chain for a planning phase. Epic decomposition and
// ticket breakdown can use different engines (e.g. a stronger model for the
// rarer, higher-leverage epic round), each with its own fallback list; both fall
// back to a shared `planner` policy, then to a built-in default.
function plannerPolicy(config, phaseKey) {
  const fp = config.fallbackPolicies || {};
  return fp[phaseKey] || fp.planner || [{ provider: 'claude' }, { provider: 'codex' }];
}

async function runPlannerAgent({ config, board, log, services, prompt, tag, key, max, allowComplete = false, policy }) {
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
    const candidates = buildCandidateChain(policy || plannerPolicy(config, 'planner'));
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
        const parsed = extractItems(result.lastMessage, { key, max, allowComplete });
        // 'complete' is a definitive terminal answer, not a failure: accept it
        // (stop the fallback chain) and let the phase handler act on it.
        return {
          action: parsed.status === 'success' || parsed.status === 'complete' ? 'accept'
            : parsed.status === 'needs_info' ? 'stop' : 'next',
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
  // Under an indefinite mission the done/cancelled epic list grows without
  // bound. Show the model every open epic plus the most-recent settled ones
  // (epics arrive newest-first) so the prompt stays bounded, but dedupe
  // proposals against *every* past epic title so nothing already built or
  // rejected gets re-proposed.
  const openEpics = epics.filter((epic) => !isSettled(epic));
  const recentSettled = epics.filter(isSettled).slice(0, 15);
  const displayEpics = [...openEpics, ...recentSettled];
  const prompt = buildEpicPrompt({ mission, board, epics: displayEpics, max: settings.maxEpics });
  const fallback = await runPlannerAgent({ config, board, log, services, prompt, tag: 'epics', key: 'epics', max: settings.maxEpics, policy: plannerPolicy(config, 'epicPlanner') });
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

  const prompt = buildTicketPrompt({ mission, board, epic, siblings, backlogTitles, recentTitles, max });
  const fallback = await runPlannerAgent({ config, board, log, services, prompt, tag: `epic-${epic.shortId}`, key: 'tickets', max, allowComplete: true, policy: plannerPolicy(config, 'ticketPlanner') });
  if (fallback.status === 'stop') {
    store.enqueueComment(epic.id, fallback.value.message);
    return { status: 'needs_info' };
  }
  if (fallback.status !== 'accept') {
    throw new Error(`all flywheel planning candidates failed while breaking down epic "${epic.title}" for ${board.key || board.app}`);
  }

  // The planner reports the epic's scope is fully delivered. If nothing is
  // still open under it, close it now so the flywheel rotates to the next
  // epic; if children are still queued/in progress, stop adding tickets and
  // let them drain (reconcileEpics closes the epic once they finish).
  if (fallback.value.status === 'complete') {
    const openChildren = store.childrenOf(epic.id).filter(isOpen);
    const reason = fallback.value.message.replace(/^EPIC_COMPLETE:\s*/i, '').trim();
    if (!openChildren.length) {
      store.transition(epic.id, 'done');
      store.enqueueComment(epic.id, `Flywheel marked this epic complete${reason ? `: ${reason}` : ''}. Rotating to the next epic.`);
      if (epic.parentId) store.enqueueComment(epic.parentId, `Epic "${epic.title}" is complete${reason ? ` (${reason})` : ''}.`);
      return { status: 'epic_complete' };
    }
    store.enqueueComment(epic.id, `Flywheel has no more tickets to add here${reason ? `: ${reason}` : ''}; waiting for the ${openChildren.length} open ticket(s) to finish.`);
    return { status: 'epic_draining' };
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
function reconcileEpics({ store, board, log = () => {}, continuous = false }) {
  const projectKey = board.key || board.app;
  const epics = store.ticketsByKind(projectKey, 'epic').filter((epic) => epic.status === 'queued' || epic.status === 'in_progress');
  for (const epic of epics) {
    const children = store.childrenOf(epic.id);
    if (!children.length) continue;
    const allSettled = children.every((child) => isSettled(child));
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

  // In continuous mode the epic phase auto-regenerates once every epic
  // settles, so there is nothing to idle-notify about. Only a one-shot
  // mission needs the "you're all done, edit the mission to continue" nudge.
  if (continuous) return;
  const missions = store.ticketsByKind(projectKey, 'mission');
  for (const mission of missions) {
    if (mission.status === 'cancelled') continue;
    const missionEpics = store.ticketsByKind(projectKey, 'epic').filter((epic) => epic.parentId === mission.id);
    if (!missionEpics.length) continue;
    const allSettled = missionEpics.every((epic) => isSettled(epic));
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

  reconcileEpics({ store, board, log, continuous: settings.continuous });

  const cooldownKey = `flywheel:cooldown:${projectKey}`;
  const failuresKey = `flywheel:failures:${projectKey}`;
  const cooldownUntil = store.getKv(cooldownKey, null);
  if (cooldownUntil && cooldownUntil > new Date().toISOString()) return { status: 'cooldown' };

  const missions = store.ticketsByKind(projectKey, 'mission').filter((mission) => mission.status !== 'cancelled');
  const mission = missions[0];
  if (!mission) return { status: 'no_mission' };

  const epics = store.ticketsByKind(projectKey, 'epic').filter((epic) => epic.parentId === mission.id);
  const openEpics = epics.filter((epic) => !isSettled(epic)); // in_review / queued / in_progress
  const anyInReview = epics.some((epic) => epic.status === 'in_review');
  const hashKey = `flywheel:mission-hash:${mission.id}`;
  const currentHash = missionHash(mission);
  const missionChanged = store.getKv(hashKey, null) !== currentHash;

  // Propose epics when: none exist yet (first run), the mission was edited, or
  // (continuous only) every epic has settled and the flywheel should spin up a
  // fresh round grounded in the now-changed codebase. Never while a proposal
  // is still awaiting human review.
  const noEpicsYet = epics.length === 0;
  const allEpicsSettled = epics.length > 0 && openEpics.length === 0;
  const shouldProposeEpics = !anyInReview
    && (noEpicsYet || missionChanged || (allEpicsSettled && settings.continuous));

  try {
    let result;
    if (shouldProposeEpics) {
      result = await runEpicPhase({ config, board, store, log, services, mission, epics, settings });
      store.setKv(hashKey, currentHash);
    } else {
      const approved = epics
        .filter((epic) => epic.status === 'queued')
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      const targetEpic = approved[0];
      const allFeatures = store.ticketsByKind(projectKey, 'feature');
      const queuedCount = allFeatures.filter((ticket) => ticket.status === 'queued').length;
      const openCount = allFeatures.filter(isOpen).length;
      if (!targetEpic) {
        result = { status: allEpicsSettled ? 'mission_idle' : 'awaiting_epic_approval' };
      } else if (queuedCount >= settings.backlogThreshold) {
        result = { status: 'backlog_full' };
      } else if (openCount >= settings.maxOpenTickets) {
        result = { status: 'open_ticket_cap' };
      } else {
        result = await runTicketPhase({ config, board, store, log, services, mission, epic: targetEpic, settings });
      }
    }

    const idled = result.status === 'needs_info'
      || result.status === 'epic_draining'
      || (result.status === 'ok' && result.created === 0);
    const progressed = result.status === 'epic_complete'
      || (result.status === 'ok' && result.created > 0);
    if (idled) {
      store.setKv(cooldownKey, new Date(Date.now() + settings.cooldownMs).toISOString());
      store.setKv(failuresKey, 0);
    } else if (progressed) {
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
  plannerPolicy,
  missionHash,
  trackerKeyFor,
  dedupeAgainst,
  extractItems,
  buildEpicPrompt,
  buildTicketPrompt,
  reconcileEpics,
  runFlywheelPass,
};
