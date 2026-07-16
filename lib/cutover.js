'use strict';

function upsertSnapshot(store, snapshot) {
  const ticket = store.upsertFromTracker({
    tracker: snapshot.tracker,
    trackerId: snapshot.trackerId,
    projectKey: snapshot.projectKey,
    kind: snapshot.kind || 'feature',
    title: snapshot.title,
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

function requeue(store, ticket, snapshot) {
  const current = ticket || store.getByTrackerId(snapshot.tracker, snapshot.trackerId) || upsertSnapshot(store, snapshot);
  applySnapshotParent(store, current, snapshot);
  if (current.status === 'queued') return current;
  return store.transition(current.id, 'queued');
}

function applyTrackerCommands({ store, commands = [], log = () => {} } = {}) {
  const actions = { promotions: [], forceDeploys: [], incubatorApprovals: [] };
  for (const command of commands) {
    if (command.type === 'create') {
      const ticket = upsertSnapshot(store, command.snapshot);
      log(`tracked "${ticket.title}" (${ticket.shortId}) from ${ticket.tracker}`);
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
    if (command.type === 'cancel') {
      const ticket = command.ticket || store.getByTrackerId(command.snapshot.tracker, command.snapshot.trackerId);
      if (ticket) store.transition(ticket.id, 'cancelled');
      continue;
    }
    throw new Error(`unknown tracker command: ${command.type}`);
  }
  return actions;
}

module.exports = { applyTrackerCommands, upsertSnapshot };
