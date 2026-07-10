'use strict';

const crypto = require('crypto');
const { canonical } = require('./store');

// Fields the runner owns and mirrors outward. Human-owned intent (title, body,
// engine/model pins) is never written back — it flows inbound only, at claim time.
function buildMirrorPayload(ticket) {
  return {
    status: ticket.status,
    attempts: ticket.attempts,
    reviewRounds: ticket.reviewRounds,
    reviewFeedback: ticket.reviewFeedback,
    lastAgent: ticket.lastAgent,
    branch: ticket.branch || '',
  };
}

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}

function backoffMs(attempts) {
  return Math.min(30000 * (2 ** attempts), 60 * 60 * 1000);
}

// Drain the outbox to the trackers. The local store is the source of truth; the
// mirror is eventually consistent. Per-ticket ordering is preserved: if any op
// for a ticket fails this pass, its remaining ops are held so a comment never
// lands before the status it belongs to.
async function flushOutbox({ store, trackerFor, log = () => {}, now = () => new Date().toISOString(), limit = 100 } = {}) {
  const due = store.outboxDue(now(), limit);
  const blocked = new Set();
  const result = { done: 0, failed: 0, parked: 0, skipped: 0 };

  for (const op of due) {
    if (blocked.has(op.ticketId)) { result.skipped += 1; continue; }
    const ticket = store.getById(op.ticketId);
    if (!ticket) { store.outboxDone(op.id); continue; }
    let tracker;
    try {
      tracker = trackerFor(ticket);
    } catch (error) {
      const outcome = store.outboxFail(op.id, error, backoffMs(op.attempts));
      result[outcome.parked ? 'parked' : 'failed'] += 1;
      blocked.add(op.ticketId);
      continue;
    }
    try {
      await applyOp({ store, tracker, ticket, op });
      store.outboxDone(op.id);
      result.done += 1;
    } catch (error) {
      const outcome = store.outboxFail(op.id, error, backoffMs(op.attempts));
      if (outcome.parked) { result.parked += 1; log(`mirror op ${op.op} for ${ticket.shortId} parked: ${error.message}`); }
      else result.failed += 1;
      blocked.add(op.ticketId);
    }
  }
  return result;
}

async function applyOp({ store, tracker, ticket, op }) {
  if (op.op === 'mirror') {
    const payload = buildMirrorPayload(ticket);
    const hash = hashPayload(payload);
    if (hash === ticket.mirrorHash) return; // nothing changed since last mirror
    const res = (await tracker.upsertMirror(ticket, payload)) || {};
    store.setMirrorState(ticket.id, {
      mirrorHash: hash,
      mirroredStatus: tracker.statusToBoard(payload.status),
      ...(res.trackerId ? { trackerId: res.trackerId } : {}),
      ...(res.trackerMeta ? { trackerMeta: res.trackerMeta } : {}),
    });
    return;
  }
  if (op.op === 'comment') {
    await tracker.comment(ticket, op.payload.text);
    return;
  }
  if (op.op === 'append_section') {
    await tracker.appendSection(ticket, { markdown: op.payload.markdown, existing: op.payload.existing });
    return;
  }
  if (op.op === 'promote_incubator') {
    await tracker.promoteIncubator(ticket, op.payload.targetDatabaseId || op.payload.targetTrackerId);
    return;
  }
  throw new Error(`unknown outbox op: ${op.op}`);
}

// Re-assert local truth onto a tracker whose visible status has drifted and does
// not parse as an inbound command. Enqueues a fresh mirror (hash cleared) so the
// next flush pushes the canonical status back.
function reassert(store, ticket, log = () => {}) {
  store.setMirrorState(ticket.id, { mirrorHash: null });
  store.transition(ticket.id, ticket.status); // self-transition re-enqueues a mirror op
  log(`re-asserting ${ticket.status} for ${ticket.shortId}`);
}

module.exports = { buildMirrorPayload, hashPayload, backoffMs, flushOutbox, applyOp, reassert };
