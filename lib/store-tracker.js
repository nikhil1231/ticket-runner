'use strict';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function patchFromMirror(payload = {}) {
  const patch = {};
  if (payload.attempts !== undefined) patch.attempts = payload.attempts;
  if (payload.reviewRounds !== undefined) patch.reviewRounds = payload.reviewRounds;
  if (payload.reviewFeedback !== undefined) patch.reviewFeedback = payload.reviewFeedback;
  if (payload.lastAgent !== undefined) patch.lastAgent = payload.lastAgent;
  if (payload.branch !== undefined) patch.branch = payload.branch;
  if (payload.cli !== undefined) patch.enginePin = payload.cli;
  if (payload.model !== undefined) patch.modelPin = payload.model;
  return patch;
}

function ticketId(ticket) {
  if (!ticket?.id) throw new Error(`store-backed tracker requires a store ticket for ${ticket?.shortId || ticket?.title || 'unknown ticket'}`);
  return ticket.id;
}

function createStoreBackedTracker({ store, tracker, projectKey }) {
  if (!store) throw new Error('createStoreBackedTracker requires a store');
  if (!tracker) throw new Error('createStoreBackedTracker requires a tracker');

  function current(ticket) {
    return store.getById(ticketId(ticket));
  }

  function toCanonical(status) {
    if (!status) return status;
    return tracker.boardToStatus?.(status) || status;
  }

  return {
    ...tracker,

    async mirror(ticket, payload = {}) {
      const id = ticketId(ticket);
      const patch = patchFromMirror(payload);
      if (payload.status !== undefined) {
        return store.transition(id, payload.status, patch);
      }
      if (Object.keys(patch).length) {
        const before = current(ticket);
        return store.transition(id, before.status, patch);
      }
      return current(ticket);
    },

    async comment(ticket, text) {
      store.enqueueComment(ticketId(ticket), text);
    },

    async appendSection(ticket, section) {
      store.enqueueSection(ticketId(ticket), section);
    },

    async promoteIncubator(ticket, targetProjectKey) {
      store.enqueuePromotion(ticketId(ticket), targetProjectKey);
    },

    async listByStatus(status) {
      return store.listByStatus(projectKey, toCanonical(status));
    },

    async listDone() {
      return store.listByStatus(projectKey, 'done');
    },

    async listQueue() {
      return store.readyTickets({ projectKey });
    },

    async fetchBody(ticket) {
      const body = tracker.fetchBody ? await tracker.fetchBody(ticket) : ticket.body;
      store.refreshIntent(ticketId(ticket), { body });
      return body;
    },

    async fetchComments(ticket) {
      return tracker.fetchComments ? asArray(await tracker.fetchComments(ticket)) : [];
    },

    async fetchPlanMarkdown(ticket) {
      return tracker.fetchPlanMarkdown ? tracker.fetchPlanMarkdown(ticket) : { markdown: ticket.body || '', truncated: false, unknownBlockIds: [] };
    },
  };
}

module.exports = { createStoreBackedTracker, patchFromMirror };
