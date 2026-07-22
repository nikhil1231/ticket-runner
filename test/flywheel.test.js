'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, closeDb } = require('../lib/db');
const { createStore } = require('../lib/store');
const {
  flywheelSettings, plannerPolicy, missionHash, dedupeAgainst, extractItems, reconcileEpics, runFlywheelPass,
} = require('../lib/flywheel');

function fixture(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-planner-'));
  const db = openDb(baseDir);
  t.after(() => { closeDb(db); fs.rmSync(baseDir, { recursive: true, force: true }); });
  return { baseDir, store: createStore({ baseDir, db }) };
}

function board(overrides = {}) {
  return {
    key: 'caligo', app: 'caligo', repoPath: '/repo', baseBranch: 'main', workdir: '.',
    tracker: { type: 'github', owner: 'acme', repo: 'caligo' },
    flywheel: { enabled: true, backlogThreshold: 2, maxOpenTickets: 10, maxEpics: 7, maxTicketsPerPass: 3, cooldownMs: 900000 },
    ...overrides,
  };
}

function fakeWorktrees() {
  const calls = { create: [], reset: [], remove: [] };
  return {
    calls,
    createDetachedWorktree: (opts) => { calls.create.push(opts); return `/fake-worktree/${opts.shortId}`; },
    head: () => 'basesha',
    resetWorktree: (dir, ref) => calls.reset.push([dir, ref]),
    removeDetachedWorktree: (opts) => calls.remove.push(opts),
  };
}

// Each call to spawnEngine pops the next scripted response (last one repeats).
function scriptedSpawnEngine(responses) {
  const calls = [];
  let i = 0;
  const spawnEngine = async (opts) => {
    calls.push(opts);
    const response = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { code: 0, timedOut: false, quota: false, ...response };
  };
  spawnEngine.calls = calls;
  return spawnEngine;
}

function ticketsMessage(key, items) {
  return `TICKETS:\n\`\`\`json\n${JSON.stringify({ [key]: items })}\n\`\`\``;
}

function seedMission(store, overrides = {}) {
  return store.upsertFromTracker({
    tracker: 'github:acme/caligo', trackerId: 'mission-1', projectKey: 'caligo', kind: 'mission',
    title: 'Ship a great app', createdAt: '2026-01-01T00:00:00Z', status: 'queued',
    trackerMeta: { url: 'https://github.com/acme/caligo/issues/1' },
    ...overrides,
  });
}

// In production the mission-hash kv key is only ever stamped by a real epic
// phase run. Tests that seed an already-approved epic directly (skipping the
// epic phase) must stamp it too, or the pass sees `missionChanged` and
// regenerates epics instead of moving on to the ticket phase.
function markMissionHashCurrent(store, mission) {
  store.setKv(`flywheel:mission-hash:${mission.id}`, missionHash(mission));
}

function missionCooldownKey(mission, projectKey = 'caligo') {
  return `flywheel:cooldown:${projectKey}:${mission.id}`;
}

function missionFailuresKey(mission, projectKey = 'caligo') {
  return `flywheel:failures:${projectKey}:${mission.id}`;
}

// ---- pure helpers ----

test('extractItems parses a valid TICKETS contract and enforces bounds', () => {
  const msg = ticketsMessage('tickets', [
    { title: 'Add login screen', body: 'A'.repeat(60) },
    { title: 'Wire up API client', body: 'B'.repeat(60), dependsOn: [0] },
  ]);
  const parsed = extractItems(msg, { key: 'tickets', max: 5 });
  assert.equal(parsed.status, 'success');
  assert.equal(parsed.items.length, 2);
  assert.deepEqual(parsed.items[1].dependsOn, [0]);
});

test('extractItems recognizes NEEDS_INFO', () => {
  const parsed = extractItems('NEEDS_INFO: what platform is this for?', { key: 'epics', max: 5 });
  assert.equal(parsed.status, 'needs_info');
  assert.match(parsed.message, /NEEDS_INFO:/);
});

test('extractItems recognizes EPIC_COMPLETE only when allowComplete is set', () => {
  const msg = 'EPIC_COMPLETE: scope already delivered by existing code';
  const withFlag = extractItems(msg, { key: 'tickets', max: 5, allowComplete: true });
  assert.equal(withFlag.status, 'complete');
  assert.match(withFlag.message, /EPIC_COMPLETE:/);
  // Without the flag it is not a special signal - and with no TICKETS block it's invalid.
  assert.equal(extractItems(msg, { key: 'tickets', max: 5 }).status, 'invalid');
});

test('extractItems rejects missing marker, bad JSON, short bodies, and forward dependsOn', () => {
  assert.equal(extractItems('just some text', { key: 'tickets', max: 5 }).status, 'invalid');
  assert.equal(extractItems('TICKETS:\n```json\n{not json}\n```', { key: 'tickets', max: 5 }).status, 'invalid');
  const shortBody = ticketsMessage('tickets', [{ title: 'T', body: 'too short' }]);
  assert.equal(extractItems(shortBody, { key: 'tickets', max: 5 }).status, 'invalid');
  const forwardRef = ticketsMessage('tickets', [{ title: 'T0', body: 'x'.repeat(60), dependsOn: [1] }, { title: 'T1', body: 'y'.repeat(60) }]);
  assert.equal(extractItems(forwardRef, { key: 'tickets', max: 5 }).status, 'invalid');
});

test('extractItems accepts over-budget batches (caller truncates to the budget)', () => {
  const tooMany = ticketsMessage('tickets', Array.from({ length: 6 }, (_, i) => ({ title: `T${i}`, body: 'x'.repeat(60) })));
  const parsed = extractItems(tooMany, { key: 'tickets', max: 3 });
  assert.equal(parsed.status, 'success');
  assert.equal(parsed.items.length, 6);
});

test('dedupeAgainst drops case/whitespace-insensitive duplicates and preserves original indexes', () => {
  const items = [
    { title: 'Add Login Screen', body: 'x' },
    { title: '  add login screen  ', body: 'y' },
    { title: 'Wire up API client', body: 'z' },
  ];
  const kept = dedupeAgainst(items, ['Existing ticket']);
  assert.deepEqual(kept.map((item) => item.title), ['Add Login Screen', 'Wire up API client']);
  assert.deepEqual(kept.map((item) => item.originalIndex), [0, 2]);
});

test('flywheelSettings layers defaults, config, and board overrides', () => {
  const settings = flywheelSettings({ flywheel: { backlogThreshold: 5 } }, { flywheel: { maxEpics: 1 } });
  assert.equal(settings.enabled, false);
  assert.equal(settings.backlogThreshold, 5);
  assert.equal(settings.maxEpics, 1);
  assert.equal(settings.cooldownMs, 15 * 60 * 1000);
});

test('missionHash changes with title or body and is stable otherwise', () => {
  const a = missionHash({ title: 'Mission', body: 'Do things' });
  const b = missionHash({ title: 'Mission', body: 'Do things' });
  const c = missionHash({ title: 'Mission', body: 'Do other things' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('plannerPolicy resolves phase-specific chains, falling back to planner then a default', () => {
  const cfg = { fallbackPolicies: {
    epicPlanner: [{ provider: 'claude', model: 'claude-opus-4-8' }],
    ticketPlanner: [{ provider: 'codex', model: '' }],
    planner: [{ provider: 'antigravity' }],
  } };
  assert.deepEqual(plannerPolicy(cfg, 'epicPlanner'), [{ provider: 'claude', model: 'claude-opus-4-8' }]);
  assert.deepEqual(plannerPolicy(cfg, 'ticketPlanner'), [{ provider: 'codex', model: '' }]);
  assert.deepEqual(plannerPolicy({ fallbackPolicies: { planner: [{ provider: 'codex' }] } }, 'epicPlanner'), [{ provider: 'codex' }]);
  assert.deepEqual(plannerPolicy({}, 'ticketPlanner'), [{ provider: 'claude' }, { provider: 'codex' }]);
});

// ---- reconcileEpics ----

test('reconcileEpics auto-completes an epic once all children are done/cancelled and reports to the mission', (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  const epic = store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Epic 1', parentId: mission.id, status: 'queued', tracker: 'github:acme/caligo' });
  const child1 = store.createLocalTicket({ projectKey: 'caligo', kind: 'feature', title: 'Ticket A', parentId: epic.id, status: 'queued', tracker: 'github:acme/caligo' });
  const child2 = store.createLocalTicket({ projectKey: 'caligo', kind: 'feature', title: 'Ticket B', parentId: epic.id, status: 'queued', tracker: 'github:acme/caligo' });
  store.transition(child1.id, 'in_progress');
  store.transition(child1.id, 'testing');
  store.transition(child1.id, 'done');
  store.transition(child2.id, 'cancelled');

  reconcileEpics({ store, board: board() });
  assert.equal(store.getById(epic.id).status, 'done');
  const epicComments = store.pendingOutbox(epic.id).filter((op) => op.op === 'comment');
  const missionComments = store.pendingOutbox(mission.id).filter((op) => op.op === 'comment');
  assert.ok(epicComments.length >= 1);
  assert.ok(missionComments.length >= 1);
});

test('reconcileEpics posts a mission idle notice once all epics settle, and only once', (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  const epic = store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Only epic', parentId: mission.id, status: 'in_review', tracker: 'github:acme/caligo' });
  store.transition(epic.id, 'cancelled');

  reconcileEpics({ store, board: board() });
  const first = store.pendingOutbox(mission.id).filter((op) => op.op === 'comment').length;
  assert.ok(first >= 1);
  for (const op of store.pendingOutbox(mission.id)) store.outboxDone(op.id);

  reconcileEpics({ store, board: board() });
  const second = store.pendingOutbox(mission.id).filter((op) => op.op === 'comment').length;
  assert.equal(second, 0);
});

// ---- runFlywheelPass orchestration ----

test('disabled flywheel is a no-op', async (t) => {
  const { store, baseDir } = fixture(t);
  seedMission(store);
  const spawnEngine = scriptedSpawnEngine([]);
  const result = await runFlywheelPass({ config: { baseDir }, board: board({ flywheel: { enabled: false } }), store, services: { spawnEngine } });
  assert.equal(result.status, 'disabled');
  assert.equal(spawnEngine.calls.length, 0);
});

test('no mission ticket is a no-op', async (t) => {
  const { store, baseDir } = fixture(t);
  const spawnEngine = scriptedSpawnEngine([]);
  const result = await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine } });
  assert.equal(result.status, 'no_mission');
});

test('flywheel skips an idle mission and decomposes the next actionable mission', async (t) => {
  const { store, baseDir } = fixture(t);
  const idleMission = seedMission(store, { trackerId: 'mission-idle', title: 'Waiting mission', createdAt: '2026-01-01T00:00:00Z' });
  const actionableMission = seedMission(store, { trackerId: 'mission-action', title: 'Actionable mission', createdAt: '2026-01-02T00:00:00Z' });
  const b = board({ flywheel: { enabled: true, continuous: true, backlogThreshold: 2, maxOpenTickets: 10, maxEpics: 1, maxTicketsPerPass: 3, cooldownMs: 900000 } });
  store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Already proposed', parentId: idleMission.id, status: 'in_review', tracker: 'github:acme/caligo' });
  markMissionHashCurrent(store, idleMission);
  const spawnEngine = scriptedSpawnEngine([
    { lastMessage: ticketsMessage('epics', [{ title: 'Fresh epic', summary: 'S'.repeat(60) }]) },
  ]);

  const result = await runFlywheelPass({ config: { baseDir }, board: b, store, services: { spawnEngine, worktrees: fakeWorktrees() } });

  assert.equal(result.status, 'ok');
  assert.equal(result.created, 1);
  assert.equal(result.missionId, actionableMission.id);
  const epics = store.ticketsByKind('caligo', 'epic').filter((epic) => epic.parentId === actionableMission.id);
  assert.equal(epics.length, 1);
  assert.equal(epics[0].title, 'Fresh epic');
});

test('epic phase proposes epics under the mission when none exist yet', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  const spawnEngine = scriptedSpawnEngine([
    { lastMessage: ticketsMessage('epics', [{ title: 'Onboarding flow', summary: 'S'.repeat(60) }]) },
  ]);
  const wt = fakeWorktrees();
  const result = await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine, worktrees: wt } });
  assert.equal(result.status, 'ok');
  assert.equal(result.created, 1);
  const epics = store.ticketsByKind('caligo', 'epic');
  assert.equal(epics.length, 1);
  assert.equal(epics[0].status, 'in_review');
  assert.equal(epics[0].parentId, mission.id);
  assert.match(epics[0].body, /Onboarding flow|Parent/);
  assert.equal(wt.calls.create.length, 1);
  assert.equal(wt.calls.remove.length, 1);
});

test('epic phase and ticket phase use their own planner policies', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  const cfg = { baseDir, fallbackPolicies: {
    epicPlanner: [{ provider: 'claude', model: 'claude-opus-4-8' }],
    ticketPlanner: [{ provider: 'codex', model: '' }],
  } };

  // Epic phase (no epics yet) should spawn the epicPlanner engine.
  const epicSpawn = scriptedSpawnEngine([{ lastMessage: ticketsMessage('epics', [{ title: 'E', summary: 'S'.repeat(60) }]) }]);
  await runFlywheelPass({ config: cfg, board: board(), store, services: { spawnEngine: epicSpawn, worktrees: fakeWorktrees() } });
  assert.equal(epicSpawn.calls[0].cli, 'claude');
  assert.equal(epicSpawn.calls[0].model, 'claude-opus-4-8');

  // Approve the epic, then the ticket phase should spawn the ticketPlanner engine.
  const epic = store.ticketsByKind('caligo', 'epic')[0];
  store.transition(epic.id, 'queued');
  const ticketSpawn = scriptedSpawnEngine([{ lastMessage: ticketsMessage('tickets', [{ title: 'T', body: 'x'.repeat(60) }]) }]);
  await runFlywheelPass({ config: cfg, board: board(), store, services: { spawnEngine: ticketSpawn, worktrees: fakeWorktrees() } });
  assert.equal(ticketSpawn.calls[0].cli, 'codex');
});

test('epic phase does not propose when the in-review pool is already full', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  const b = board({ flywheel: { enabled: true, continuous: true, backlogThreshold: 2, maxOpenTickets: 10, maxEpics: 2, maxTicketsPerPass: 3, cooldownMs: 900000 } });
  // maxEpics (2) proposals already awaiting review: the semaphore is saturated.
  store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Pending epic 1', parentId: mission.id, status: 'in_review', tracker: 'github:acme/caligo' });
  store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Pending epic 2', parentId: mission.id, status: 'in_review', tracker: 'github:acme/caligo' });
  markMissionHashCurrent(store, mission);
  const spawnEngine = scriptedSpawnEngine([]);
  const result = await runFlywheelPass({ config: { baseDir }, board: b, store, services: { spawnEngine } });
  assert.equal(result.status, 'awaiting_epic_approval');
  assert.equal(spawnEngine.calls.length, 0);
});

test('epic phase tops the in-review pool back up to maxEpics (semaphore, not latch)', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  const b = board({ flywheel: { enabled: true, continuous: true, backlogThreshold: 2, maxOpenTickets: 10, maxEpics: 3, maxTicketsPerPass: 3, cooldownMs: 900000 } });
  // Pool has drained to one proposal (the others were picked/rejected). The
  // semaphore must refill the remaining slots even though a proposal is still in
  // review and the mission itself is unchanged.
  store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Still pending', parentId: mission.id, status: 'in_review', tracker: 'github:acme/caligo' });
  markMissionHashCurrent(store, mission);
  const spawnEngine = scriptedSpawnEngine([
    { lastMessage: ticketsMessage('epics', [
      { title: 'Refill A', summary: 'S'.repeat(60) },
      { title: 'Refill B', summary: 'S'.repeat(60) },
    ]) },
  ]);
  const result = await runFlywheelPass({ config: { baseDir }, board: b, store, services: { spawnEngine, worktrees: fakeWorktrees() } });
  assert.equal(result.status, 'ok');
  assert.equal(result.created, 2); // refilled 2 slots: pool goes 1 -> 3
  const inReview = store.ticketsByKind('caligo', 'epic').filter((e) => e.status === 'in_review');
  assert.equal(inReview.length, 3);
});

test('ticket phase generates tickets under an approved epic and wires dependsOn', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  const epic = store.createLocalTicket({
    projectKey: 'caligo', kind: 'epic', title: 'Epic one', body: 'scope', parentId: mission.id,
    status: 'in_review', tracker: 'github:acme/caligo', trackerMeta: { url: 'https://github.com/acme/caligo/issues/2' },
  });
  store.transition(epic.id, 'queued'); // human approval (board move -> requeue)
  markMissionHashCurrent(store, mission);

  const spawnEngine = scriptedSpawnEngine([
    { lastMessage: ticketsMessage('tickets', [
      { title: 'Build API', body: 'A'.repeat(60) },
      { title: 'Build UI', body: 'B'.repeat(60), dependsOn: [0] },
    ]) },
  ]);
  const wt = fakeWorktrees();
  const result = await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine, worktrees: wt } });
  assert.equal(result.status, 'ok');
  assert.equal(result.created, 2);
  const features = store.ticketsByKind('caligo', 'feature');
  assert.equal(features.length, 2);
  assert.ok(features.every((f) => f.status === 'queued' && f.parentId === epic.id));
  const uiTicket = features.find((f) => f.title === 'Build UI');
  const apiTicket = features.find((f) => f.title === 'Build API');
  const deps = store.dependencies(uiTicket.id);
  assert.equal(deps.length, 1);
  assert.equal(deps[0].dependsOnId, apiTicket.id);
});

test('ticket phase respects backlogThreshold and maxOpenTickets budgets without invoking the planner', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  const epic = store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Epic one', parentId: mission.id, status: 'queued', tracker: 'github:acme/caligo' });
  store.createLocalTicket({ projectKey: 'caligo', kind: 'feature', title: 'Existing queued 1', parentId: epic.id, status: 'queued', tracker: 'github:acme/caligo' });
  store.createLocalTicket({ projectKey: 'caligo', kind: 'feature', title: 'Existing queued 2', parentId: epic.id, status: 'queued', tracker: 'github:acme/caligo' });
  markMissionHashCurrent(store, mission);

  const spawnEngine = scriptedSpawnEngine([]);
  const result = await runFlywheelPass({ config: { baseDir }, board: board({ flywheel: { enabled: true, backlogThreshold: 2, maxOpenTickets: 10, maxEpics: 7, maxTicketsPerPass: 3, cooldownMs: 900000 } }), store, services: { spawnEngine } });
  assert.equal(result.status, 'backlog_full');
  assert.equal(spawnEngine.calls.length, 0);
});

test('proposals that all dedupe against existing tickets create nothing and set a cooldown', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  const epic = store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Epic one', parentId: mission.id, status: 'queued', tracker: 'github:acme/caligo' });
  store.createLocalTicket({ projectKey: 'caligo', kind: 'feature', title: 'Build API', parentId: epic.id, status: 'in_progress', tracker: 'github:acme/caligo' });
  markMissionHashCurrent(store, mission);

  const spawnEngine = scriptedSpawnEngine([
    { lastMessage: ticketsMessage('tickets', [{ title: 'Build API', body: 'A'.repeat(60) }]) },
  ]);
  const cfg = { baseDir };
  const result = await runFlywheelPass({ config: cfg, board: board(), store, services: { spawnEngine, worktrees: fakeWorktrees() } });
  assert.equal(result.status, 'ok');
  assert.equal(result.created, 0);
  assert.equal(store.ticketsByKind('caligo', 'feature').length, 1);
  assert.ok(store.getKv(missionCooldownKey(mission), null));
});

test('cooldown blocks a pass from invoking the planner again', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  store.setKv(missionCooldownKey(mission), new Date(Date.now() + 60000).toISOString());
  const spawnEngine = scriptedSpawnEngine([]);
  const result = await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine } });
  assert.equal(result.status, 'cooldown');
  assert.equal(spawnEngine.calls.length, 0);
});

test('needs_info from the planner comments and sets a cooldown without throwing', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  const spawnEngine = scriptedSpawnEngine([{ lastMessage: 'NEEDS_INFO: what kind of app is this?' }]);
  const result = await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine, worktrees: fakeWorktrees() } });
  assert.equal(result.status, 'needs_info');
  assert.ok(store.getKv(missionCooldownKey(mission), null));
  const comments = store.pendingOutbox(mission.id).filter((op) => op.op === 'comment');
  assert.ok(comments.some((op) => op.payload.text.includes('NEEDS_INFO')));
});

test('exhausted planning candidates are caught, back off exponentially, and never crash the pass', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  const spawnEngine = scriptedSpawnEngine([{ code: 1, lastMessage: '' }]);
  const result1 = await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine, worktrees: fakeWorktrees() } });
  assert.equal(result1.status, 'error');
  const cooldown1 = store.getKv(missionCooldownKey(mission), null);
  assert.ok(cooldown1);
  assert.equal(store.getKv(missionFailuresKey(mission), 0), 1);
  const comments = store.pendingOutbox(mission.id).filter((op) => op.op === 'comment');
  assert.ok(comments.length >= 1);

  // second failure without clearing the cooldown key manually should back off further
  store.setKv(missionCooldownKey(mission), new Date(0).toISOString()); // simulate cooldown elapsed
  const spawnEngine2 = scriptedSpawnEngine([{ code: 1, lastMessage: '' }]);
  await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine: spawnEngine2, worktrees: fakeWorktrees() } });
  assert.equal(store.getKv(missionFailuresKey(mission), 0), 2);
  const cooldown2 = store.getKv(missionCooldownKey(mission), null);
  assert.ok(Date.parse(cooldown2) > Date.parse(cooldown1));
});

test('mission edits re-trigger the epic phase even when non-cancelled epics already exist', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store, { title: 'Original mission' });
  store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Old epic', parentId: mission.id, status: 'done', tracker: 'github:acme/caligo' });

  const spawnEngine = scriptedSpawnEngine([
    { lastMessage: ticketsMessage('epics', [{ title: 'New epic after edit', summary: 'S'.repeat(60) }]) },
  ]);
  const wt = fakeWorktrees();
  // first pass with the same mission body: hash unset -> counts as "changed" once, then stored.
  await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine, worktrees: wt } });
  assert.equal(spawnEngine.calls.length, 1);

  // second pass: the mission hash is now stored (missionChanged=false) and this
  // is a one-shot mission (not continuous), so the semaphore does not refill —
  // the single in-review proposal is left as-is. With no epic approved yet, the
  // pass has nothing to do.
  const spawnEngine2 = scriptedSpawnEngine([]);
  const result2 = await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine: spawnEngine2, worktrees: fakeWorktrees() } });
  assert.equal(spawnEngine2.calls.length, 0);
  assert.equal(result2.status, 'awaiting_epic_approval');
});

// ---- continuous mode + epic completion signal ----

test('continuous mode auto-regenerates epics once every epic has settled', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  const oldEpic = store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Shipped epic', parentId: mission.id, status: 'done', tracker: 'github:acme/caligo' });
  assert.ok(oldEpic);
  markMissionHashCurrent(store, mission); // mission itself unchanged - regeneration must come from the settled state

  const spawnEngine = scriptedSpawnEngine([
    { lastMessage: ticketsMessage('epics', [{ title: 'Next improvement', summary: 'S'.repeat(60) }]) },
  ]);
  const board2 = board({ flywheel: { enabled: true, continuous: true, backlogThreshold: 2, maxOpenTickets: 10, maxEpics: 7, maxTicketsPerPass: 3, cooldownMs: 900000 } });
  const result = await runFlywheelPass({ config: { baseDir }, board: board2, store, services: { spawnEngine, worktrees: fakeWorktrees() } });
  assert.equal(result.status, 'ok');
  assert.equal(result.created, 1);
  assert.equal(spawnEngine.calls.length, 1);
  const openEpics = store.ticketsByKind('caligo', 'epic').filter((e) => e.status === 'in_review');
  assert.equal(openEpics.length, 1);
  assert.equal(openEpics[0].title, 'Next improvement');
});

test('one-shot (non-continuous) mode idles instead of regenerating when all epics settle', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Shipped epic', parentId: mission.id, status: 'done', tracker: 'github:acme/caligo' });
  markMissionHashCurrent(store, mission);

  const spawnEngine = scriptedSpawnEngine([]);
  const result = await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine, worktrees: fakeWorktrees() } });
  assert.equal(result.status, 'mission_idle');
  assert.equal(spawnEngine.calls.length, 0);
  // reconcileEpics should have posted the one-shot idle nudge on the mission.
  const missionComments = store.pendingOutbox(mission.id).filter((op) => op.op === 'comment');
  assert.ok(missionComments.some((op) => /Update the mission body/.test(op.payload.text)));
});

test('Perpetual mission tag regenerates epics even when project continuous mode is off', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store, { trackerMeta: { tags: ['Perpetual'] } });
  store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Shipped epic', parentId: mission.id, status: 'done', tracker: 'github:acme/caligo' });
  markMissionHashCurrent(store, mission);

  const spawnEngine = scriptedSpawnEngine([
    { lastMessage: ticketsMessage('epics', [{ title: 'Next perpetual improvement', summary: 'S'.repeat(60) }]) },
  ]);
  const result = await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine, worktrees: fakeWorktrees() } });
  assert.equal(result.status, 'ok');
  assert.equal(result.created, 1);
  assert.equal(spawnEngine.calls.length, 1);
  assert.equal(store.pendingOutbox(mission.id).filter((op) => /Update the mission body/.test(op.payload.text)).length, 0);
});

test('reconcileEpics does not post one-shot idle notices for Perpetual missions', (t) => {
  const { store } = fixture(t);
  const mission = seedMission(store, { trackerMeta: { tags: ['perpetual'] } });
  const epic = store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Only epic', parentId: mission.id, status: 'in_review', tracker: 'github:acme/caligo' });
  store.transition(epic.id, 'cancelled');

  reconcileEpics({ store, board: board() });
  const missionComments = store.pendingOutbox(mission.id).filter((op) => op.op === 'comment');
  assert.equal(missionComments.length, 0);
});

test('EPIC_COMPLETE with no open children closes the epic and rotates', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  const epic = store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Covered epic', parentId: mission.id, status: 'queued', tracker: 'github:acme/caligo' });
  markMissionHashCurrent(store, mission);
  store.setKv(missionCooldownKey(mission), new Date(0).toISOString()); // already elapsed; progress should clear it

  const spawnEngine = scriptedSpawnEngine([{ lastMessage: 'EPIC_COMPLETE: existing code already delivers this scope' }]);
  const result = await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine, worktrees: fakeWorktrees() } });
  assert.equal(result.status, 'epic_complete');
  assert.equal(store.getById(epic.id).status, 'done');
  assert.equal(store.getKv(missionCooldownKey(mission), null), null); // progress clears the cooldown so the next epic starts promptly
  const epicComments = store.pendingOutbox(epic.id).filter((op) => op.op === 'comment');
  assert.ok(epicComments.some((op) => /marked this epic complete/.test(op.payload.text)));
});

test('EPIC_COMPLETE with tickets still in flight freezes the epic in Testing and stops re-asking', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  const epic = store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Draining epic', parentId: mission.id, status: 'queued', tracker: 'github:acme/caligo' });
  const child = store.createLocalTicket({ projectKey: 'caligo', kind: 'feature', title: 'Last ticket in testing', parentId: epic.id, status: 'queued', tracker: 'github:acme/caligo' });
  store.transition(child.id, 'in_progress');
  store.transition(child.id, 'testing');
  markMissionHashCurrent(store, mission);
  store.setKv(missionCooldownKey(mission), new Date(0).toISOString()); // already elapsed

  const spawnEngine = scriptedSpawnEngine([{ lastMessage: 'EPIC_COMPLETE: nothing more to add' }]);
  const result = await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine, worktrees: fakeWorktrees() } });
  assert.equal(result.status, 'epic_testing');
  assert.equal(store.getById(epic.id).status, 'testing'); // frozen for human sign-off
  // Freezing is forward progress: the cooldown is cleared so the next epic starts.
  assert.equal(store.getKv(missionCooldownKey(mission), null), null);
  const epicComments = store.pendingOutbox(epic.id).filter((op) => op.op === 'comment');
  assert.ok(epicComments.some((op) => /no more tickets to add/.test(op.payload.text)));

  // A follow-up pass must NOT invoke the planner again while the epic sits in Testing.
  const spawnEngine2 = scriptedSpawnEngine([]);
  const result2 = await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine: spawnEngine2, worktrees: fakeWorktrees() } });
  assert.equal(spawnEngine2.calls.length, 0);
  assert.notEqual(result2.status, 'epic_testing');
});

test('EPIC_COMPLETE with a child still queued keeps the epic In progress until the child lands', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  const epic = store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Draining epic', parentId: mission.id, status: 'queued', tracker: 'github:acme/caligo' });
  store.transition(epic.id, 'in_progress');
  const done = store.createLocalTicket({ projectKey: 'caligo', kind: 'feature', title: 'Already in testing', parentId: epic.id, status: 'queued', tracker: 'github:acme/caligo' });
  store.transition(done.id, 'in_progress');
  store.transition(done.id, 'testing');
  // A sibling that was planned but has not had its turn on the runner yet.
  const pending = store.createLocalTicket({ projectKey: 'caligo', kind: 'feature', title: 'Still queued', parentId: epic.id, status: 'queued', tracker: 'github:acme/caligo' });
  markMissionHashCurrent(store, mission);
  store.deleteKv(missionCooldownKey(mission));

  const spawnEngine = scriptedSpawnEngine([{ lastMessage: 'EPIC_COMPLETE: nothing more to add' }]);
  const result = await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine, worktrees: fakeWorktrees() } });
  assert.equal(result.status, 'epic_waiting');
  assert.equal(store.getById(epic.id).status, 'in_progress'); // not parked while a ticket is still queued
  assert.ok(store.getKv(missionCooldownKey(mission), null)); // idle back-off so the planner isn't re-asked every tick
  const epicComments = store.pendingOutbox(epic.id).filter((op) => op.op === 'comment');
  assert.ok(epicComments.some((op) => /still being worked/.test(op.payload.text)));

  // Once the last ticket reaches the testing branch, reconcileEpics parks the epic
  // in Testing on the next pass — without re-invoking the planner.
  store.transition(pending.id, 'in_progress');
  store.transition(pending.id, 'testing');
  store.deleteKv(missionCooldownKey(mission));
  const spawnEngine2 = scriptedSpawnEngine([]);
  await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine: spawnEngine2, worktrees: fakeWorktrees() } });
  assert.equal(spawnEngine2.calls.length, 0);
  assert.equal(store.getById(epic.id).status, 'testing');
});

test('an approved epic is promoted from Not started to In progress when the flywheel starts it', async (t) => {
  const { store, baseDir } = fixture(t);
  const mission = seedMission(store);
  const epic = store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Approved epic', parentId: mission.id, status: 'in_review', tracker: 'github:acme/caligo' });
  store.transition(epic.id, 'queued'); // human approval: In review -> Not started
  markMissionHashCurrent(store, mission);

  const spawnEngine = scriptedSpawnEngine([{ lastMessage: ticketsMessage('tickets', [{ title: 'First ticket', body: 'x'.repeat(60) }]) }]);
  await runFlywheelPass({ config: { baseDir }, board: board(), store, services: { spawnEngine, worktrees: fakeWorktrees() } });
  assert.equal(store.getById(epic.id).status, 'in_progress');
  assert.equal(store.getById(mission.id).status, 'in_progress'); // an actively-worked mission moves to In progress too
});

test('reconcileEpics parks an in-progress epic in Testing once every ticket reaches the testing branch', (t) => {
  const { store } = fixture(t);
  const mission = seedMission(store);
  const epic = store.createLocalTicket({ projectKey: 'caligo', kind: 'epic', title: 'Ready epic', parentId: mission.id, status: 'in_review', tracker: 'github:acme/caligo' });
  store.transition(epic.id, 'in_progress');
  const child1 = store.createLocalTicket({ projectKey: 'caligo', kind: 'feature', title: 'A', parentId: epic.id, status: 'queued', tracker: 'github:acme/caligo' });
  const child2 = store.createLocalTicket({ projectKey: 'caligo', kind: 'feature', title: 'B', parentId: epic.id, status: 'queued', tracker: 'github:acme/caligo' });
  store.transition(child1.id, 'in_progress');
  store.transition(child1.id, 'testing');
  store.transition(child2.id, 'cancelled');

  reconcileEpics({ store, board: board() });
  assert.equal(store.getById(epic.id).status, 'testing'); // not done: awaits human sign-off to cascade-merge
  const epicComments = store.pendingOutbox(epic.id).filter((op) => op.op === 'comment');
  assert.ok(epicComments.some((op) => /in the testing branch/.test(op.payload.text)));
});
