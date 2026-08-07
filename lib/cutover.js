'use strict';

function upsertSnapshot(store, snapshot) {
  const ticket = store.upsertFromTracker({
    tracker: snapshot.tracker,
    trackerId: snapshot.trackerId,
    projectKey: snapshot.projectKey,
    kind: snapshot.kind || 'feature',
    title: snapshot.title,
    body: snapshot.body || '',
    priority: snapshot.priority || 'Medium',
    shortId: snapshot.shortId,
    createdAt: snapshot.createdAt,
    enginePin: snapshot.enginePin || '',
    modelPin: snapshot.modelPin || '',
    trackerMeta: snapshot.trackerMeta || {},
    mirroredStatus: snapshot.mirroredStatus || null,
    status: snapshot.status || 'queued',
  });
  return applySnapshotParent(store, ticket, snapshot);
}

function applySnapshotParent(store, ticket, snapshot = {}) {
  const parentTrackerId = snapshot.parentTrackerId || snapshot.trackerMeta?.parentTrackerId || '';
  if (!ticket || !parentTrackerId) return ticket;
  const parent = store.getByTrackerId(snapshot.tracker || ticket.tracker, String(parentTrackerId));
  if (!parent || parent.id === ticket.id || parent.projectKey !== ticket.projectKey) return ticket;
  if (ticket.parentId === parent.id) return ticket;
  return store.setParent(ticket.id, parent.id);
}

// Kinds a human can move a ticket between purely by relabelling it. Adding the
// `incubator` label a moment after opening an issue is the normal way into the
// planning flow, and intake has usually already filed the ticket as a plain
// feature by then - so the label has to keep deciding after intake.
//
// Only while the ticket is still waiting to be claimed, though. Once it has
// been planned (parked in Needs info) or implemented, a relabel would strand
// work: in particular, a plan parked in Needs info whose label was pulled by
// hand would read as a human-resolved ticket and get accepted straight to Done,
// silently throwing the plan away. Moving the card to Done is the one supported
// way to approve a plan, and that path flips the kind itself.
const RELABELABLE_KINDS = new Set(['feature', 'incubator']);

function nextKind(ticket, snapshot = {}) {
  const kind = snapshot.kind;
  if (!kind || !ticket || kind === ticket.kind) return undefined;
  if (ticket.status !== 'queued') return undefined;
  if (!RELABELABLE_KINDS.has(kind) || !RELABELABLE_KINDS.has(ticket.kind)) return undefined;
  return kind;
}

function requeue(store, ticket, snapshot) {
  const current = ticket || store.getByTrackerId(snapshot.tracker, snapshot.trackerId) || upsertSnapshot(store, snapshot);
  applySnapshotParent(store, current, snapshot);
  if (current.status === 'queued') return current;
  return store.transition(current.id, 'queued');
}

function applyTrackerCommands({ store, commands = [], log = () => {} } = {}) {
  const actions = { promotions: [], forceDeploys: [], incubatorApprovals: [], epicMerges: [] };
  for (const command of commands) {
    if (command.type === 'create') {
      const ticket = upsertSnapshot(store, command.snapshot);
      log(`tracked "${ticket.title}" (${ticket.shortId}) from ${ticket.tracker}`);
      continue;
    }
    if (command.type === 'refresh_intent') {
      const ticket = command.ticket || store.getByTrackerId(command.snapshot.tracker, command.snapshot.trackerId);
      if (ticket) store.refreshIntent(ticket.id, {
        title: command.snapshot.title,
        body: command.snapshot.body,
        kind: nextKind(ticket, command.snapshot),
        priority: command.snapshot.priority,
        trackerMeta: command.snapshot.trackerMeta,
      });
      continue;
    }
    if (command.type === 'link_parent') {
      const ticket = command.ticket || store.getByTrackerId(command.snapshot.tracker, command.snapshot.trackerId);
      if (ticket) applySnapshotParent(store, ticket, command.snapshot);
      continue;
    }
    if (command.type === 'requeue') {
      const ticket = requeue(store, command.ticket, command.snapshot);
      log(`requeued "${ticket.title}" (${ticket.shortId}) from tracker command`);
      continue;
    }
    if (command.type === 'authorize_merge') {
      const ticket = command.ticket || store.getByTrackerId(command.snapshot.tracker, command.snapshot.trackerId);
      if (ticket) actions.promotions.push(ticket);
      continue;
    }
    if (command.type === 'force_deploy') {
      const ticket = command.ticket || store.getByTrackerId(command.snapshot.tracker, command.snapshot.trackerId);
      if (ticket) actions.forceDeploys.push(ticket);
      continue;
    }
    if (command.type === 'authorize_epic_merge') {
      const ticket = command.ticket || store.getByTrackerId(command.snapshot.tracker, command.snapshot.trackerId);
      if (ticket) actions.epicMerges.push(ticket);
      continue;
    }
    if (command.type === 'resume_epic') {
      const ticket = command.ticket || store.getByTrackerId(command.snapshot.tracker, command.snapshot.trackerId);
      if (ticket && ticket.status === 'testing') {
        store.transition(ticket.id, 'in_progress');
        log(`resumed epic "${ticket.title}" (${ticket.shortId}) from Testing to In progress`);
      }
      continue;
    }
    if (command.type === 'incubator_approve') {
      const ticket = command.ticket || store.getByTrackerId(command.snapshot.tracker, command.snapshot.trackerId);
      if (ticket) actions.incubatorApprovals.push(ticket);
      continue;
    }
    if (command.type === 'feedback') {
      const ticket = command.ticket || store.getByTrackerId(command.snapshot.tracker, command.snapshot.trackerId);
      if (ticket && Array.isArray(command.commentIds)) store.setPendingComments(ticket.id, command.commentIds);
      continue;
    }
    if (command.type === 'withdraw') {
      const ticket = command.ticket || store.getByTrackerId(command.snapshot.tracker, command.snapshot.trackerId);
      if (ticket && ticket.status === 'testing') { store.transition(ticket.id, 'in_review'); log(`withdrew "${ticket.title}" (${ticket.shortId}) from Testing to In review`); }
      continue;
    }
    if (command.type === 'accept_done') {
      const ticket = command.ticket || store.getByTrackerId(command.snapshot.tracker, command.snapshot.trackerId);
      if (ticket && ticket.status === 'needs_info') {
        store.transition(ticket.id, 'done');
        log(`accepted manual resolution of "${ticket.title}" (${ticket.shortId}); Needs info -> Done`);
      }
      continue;
    }
    if (command.type === 'cancel') {
      const ticket = command.ticket || store.getByTrackerId(command.snapshot.tracker, command.snapshot.trackerId);
      if (ticket) store.transition(ticket.id, 'cancelled');
      continue;
    }
    if (command.type === 'remote_missing') {
      const ticket = command.ticket || store.getByTrackerId(command.snapshot?.tracker, command.snapshot?.trackerId);
      if (ticket && !['done', 'failed', 'cancelled'].includes(ticket.status)) {
        store.markRemoteMissing(ticket.id, { trackerId: command.trackerId });
        log(`hid "${ticket.title}" (${ticket.shortId}) because its tracker issue is gone`);
      } else if (ticket) {
        store.markRemoteMissing(ticket.id, { trackerId: command.trackerId });
        log(`hid "${ticket.title}" (${ticket.shortId}) because its tracker issue is gone`);
      }
      continue;
    }
    throw new Error(`unknown tracker command: ${command.type}`);
  }
  return actions;
}

module.exports = { applyTrackerCommands, upsertSnapshot, nextKind };
