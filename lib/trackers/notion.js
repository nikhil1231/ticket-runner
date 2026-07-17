'use strict';

const notionDefault = require('./../notion');
const { extractTicket, blocksToMarkdown, richTextToPlain } = require('./../ticket');

// Canonical status <-> Notion board vocabulary. The runner speaks canonical
// statuses everywhere; only this adapter knows the Notion names.
const TO_BOARD = {
  queued: 'Not started',
  in_progress: 'In progress',
  needs_info: 'Needs info',
  in_review: 'In review',
  testing: 'Testing',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const FROM_BOARD = {
  'Not started': 'queued',
  Backlog: 'queued',
  'In progress': 'in_progress',
  'Needs info': 'needs_info',
  'In review': 'in_review',
  Testing: 'testing',
  Done: 'done',
  Failed: 'failed',
  Cancelled: 'cancelled',
};

const QUEUE_FILTER = {
  and: [
    { property: 'For AI', checkbox: { equals: true } },
    {
      or: [
        { property: 'Status', status: { equals: 'Backlog' } },
        { property: 'Status', status: { equals: 'Not started' } },
      ],
    },
  ],
};

const STALE_FILTER = {
  and: [
    { property: 'For AI', checkbox: { equals: true } },
    { property: 'Status', status: { equals: 'In progress' } },
  ],
};

const DONE_FILTER = {
  and: [
    { property: 'For AI', checkbox: { equals: true } },
    { property: 'Status', status: { equals: 'Done' } },
  ],
};

const FORCE_DEPLOY_FILTER = {
  and: [
    { property: 'Status', status: { equals: 'In review' } },
    { property: 'Force deploy', checkbox: { equals: true } },
  ],
};

const statusFilter = (name) => ({ property: 'Status', status: { equals: name } });

// Translate a canonical mirror payload into Notion page properties. Every field
// is optional; undefined fields are left untouched, empty strings clear the
// corresponding rich_text/select.
function buildProperties(payload = {}) {
  const props = {};
  if (payload.status !== undefined) {
    const name = TO_BOARD[payload.status];
    if (!name) throw new Error(`no Notion status for canonical "${payload.status}"`);
    props.Status = { status: { name } };
  }
  if (payload.attempts !== undefined) props.Attempts = { number: payload.attempts };
  if (payload.reviewRounds !== undefined) props['Review rounds'] = { number: payload.reviewRounds };
  if (payload.reviewFeedback !== undefined) {
    props['Review feedback'] = payload.reviewFeedback
      ? { rich_text: [{ text: { content: String(payload.reviewFeedback).slice(0, 1900) } }] }
      : { rich_text: [] };
  }
  if (payload.lastAgent !== undefined) {
    props['Last agent'] = payload.lastAgent
      ? { rich_text: [{ text: { content: String(payload.lastAgent).slice(0, 200) } }] }
      : { rich_text: [] };
  }
  if (payload.branch !== undefined) {
    props.Branch = payload.branch ? { rich_text: [{ text: { content: payload.branch } }] } : { rich_text: [] };
  }
  if (payload.cli !== undefined) props.CLI = payload.cli ? { select: { name: payload.cli } } : { select: null };
  if (payload.model !== undefined) {
    props.Model = payload.model ? { rich_text: [{ text: { content: payload.model } }] } : { rich_text: [] };
  }
  if (payload.forAI !== undefined) props['For AI'] = { checkbox: !!payload.forAI };
  if (payload.forceDeploy !== undefined) props['Force deploy'] = { checkbox: !!payload.forceDeploy };
  return props;
}

// The Notion page id for a ticket, tolerating both store tickets (trackerId)
// and Notion-native tickets (pageId).
function pageOf(ticket) {
  return ticket.trackerId || ticket.pageId;
}

function snapshotFromTicket(ticket, projectKey, kind = 'feature') {
  return {
    tracker: 'notion',
    trackerId: ticket.pageId || ticket.trackerId,
    projectKey,
    kind,
    title: ticket.title,
    shortId: ticket.shortId,
    createdAt: ticket.createdTime || ticket.createdAt,
    enginePin: ticket.cli || ticket.enginePin || '',
    modelPin: ticket.model || ticket.modelPin || '',
    trackerMeta: { url: ticket.url || '', databaseId: ticket.databaseId || '' },
    mirroredStatus: ticket.status,
    status: boardStatusToCanonical(ticket.status) || 'queued',
  };
}

function boardStatusToCanonical(status) {
  return FROM_BOARD[status] || null;
}

// A Notion tracker bound to one database (a project board or the incubator DB).
function createNotionTracker({ transport = notionDefault, databaseId, log = console.log } = {}) {
  const statusToBoard = (canonical) => TO_BOARD[canonical] || null;
  const boardToStatus = (name) => FROM_BOARD[name] || null;

  // ---- reads ----
  const listRaw = (filter) => transport.queryDatabase(databaseId, filter);
  const listQueue = async () => (await listRaw(QUEUE_FILTER)).map(extractTicket);
  const listStale = async () => (await listRaw(STALE_FILTER)).map(extractTicket);
  const listDone = async () => (await listRaw(DONE_FILTER)).map(extractTicket);
  const listForceDeploy = async () => (await listRaw(FORCE_DEPLOY_FILTER)).map(extractTicket);
  const listByStatus = async (name) => (await listRaw(statusFilter(name))).map(extractTicket);
  // Raw pages for callers that need a non-standard parse (incubator tickets).
  const pagesByStatus = (name) => listRaw(statusFilter(name));

  async function pollCommands({ store, projectKey, kind = 'feature', extract = extractTicket } = {}) {
    if (!store) throw new Error('pollCommands requires a store');
    const commands = [];
    const queuedPages = await listRaw(QUEUE_FILTER);
    for (const page of queuedPages) {
      const ticket = extract(page);
      const existing = store.getByTrackerId('notion', ticket.pageId);
      const snapshot = snapshotFromTicket({ ...ticket, databaseId }, projectKey, ticket.kind || kind);
      if (!existing) {
        commands.push({ type: 'create', trackerId: ticket.pageId, snapshot });
      } else if (existing.status !== 'queued') {
        commands.push({ type: 'requeue', trackerId: ticket.pageId, ticket: existing, snapshot });
      }
    }

    const donePages = await listRaw(DONE_FILTER);
    for (const page of donePages) {
      const ticket = extract(page);
      const existing = store.getByTrackerId('notion', ticket.pageId);
      const snapshot = snapshotFromTicket({ ...ticket, databaseId }, projectKey, ticket.kind || kind);
      if (!existing) commands.push({ type: 'create', trackerId: ticket.pageId, snapshot });
      // Moving an epic to Done cascades a merge of every ticket under it; a
      // feature authorizes just its own merge.
      else if (existing.status === 'testing') commands.push({ type: existing.kind === 'epic' ? 'authorize_epic_merge' : 'authorize_merge', trackerId: ticket.pageId, ticket: existing, snapshot });
      else if (kind === 'incubator') commands.push({ type: 'incubator_approve', trackerId: ticket.pageId, ticket: existing, snapshot });
    }

    const forcePages = await listRaw(FORCE_DEPLOY_FILTER);
    for (const page of forcePages) {
      const ticket = extract(page);
      const existing = store.getByTrackerId('notion', ticket.pageId);
      if (!existing) continue;
      await mirror(ticket, { forceDeploy: false });
      commands.push({ type: 'force_deploy', trackerId: ticket.pageId, ticket: existing, snapshot: snapshotFromTicket({ ...ticket, databaseId }, projectKey, kind) });
    }

    const reviewPages = await listRaw({ property: 'Status', status: { equals: 'In review' } });
    for (const page of reviewPages) {
      const ticket = extract(page);
      const existing = store.getByTrackerId('notion', ticket.pageId);
      if (existing && existing.status === 'testing') {
        commands.push({ type: 'withdraw', trackerId: ticket.pageId, ticket: existing, snapshot: snapshotFromTicket({ ...ticket, databaseId }, projectKey, kind) });
      }
    }

    // A human reopening an epic parked in Testing (moving it back to In progress)
    // to have the flywheel add more tickets to it.
    const inProgressPages = await listRaw(statusFilter('In progress'));
    for (const page of inProgressPages) {
      const ticket = extract(page);
      const existing = store.getByTrackerId('notion', ticket.pageId);
      if (existing && existing.kind === 'epic' && existing.status === 'testing') {
        commands.push({ type: 'resume_epic', trackerId: ticket.pageId, ticket: existing, snapshot: snapshotFromTicket({ ...ticket, databaseId }, projectKey, ticket.kind || kind) });
      }
    }

    const cancelledPages = await listRaw(statusFilter('Cancelled'));
    for (const page of cancelledPages) {
      const ticket = extract(page);
      const existing = store.getByTrackerId('notion', ticket.pageId);
      if (existing && !['done', 'failed', 'cancelled'].includes(existing.status)) {
        commands.push({ type: 'cancel', trackerId: ticket.pageId, ticket: existing, snapshot: snapshotFromTicket({ ...ticket, databaseId }, projectKey, ticket.kind || kind) });
      }
    }
    return commands;
  }

  async function fetchBody(ticket) {
    const blocks = await transport.getBlockChildren(pageOf(ticket));
    return blocksToMarkdown(blocks);
  }

  async function fetchComments(ticket) {
    const [comments, bot] = await Promise.all([transport.getComments(pageOf(ticket)), transport.getCurrentBot()]);
    return comments.map((comment) => ({
      id: comment.id,
      text: richTextToPlain(comment.rich_text).trim(),
      isBot: comment.created_by?.id === bot.id,
    }));
  }

  async function fetchPlanMarkdown(ticket) {
    const page = await transport.getPageMarkdown(pageOf(ticket));
    return { markdown: page.markdown || '', truncated: !!page.truncated, unknownBlockIds: page.unknown_block_ids || [] };
  }

  // ---- writes ----
  const mirror = (ticket, payload) => transport.updatePage(pageOf(ticket), buildProperties(payload));
  const comment = (ticket, text) => transport.safeComment(pageOf(ticket), text, log);

  // Async mirror used by the sync engine. Most tickets are Notion-native (a
  // human created the page), so this updates in place. Planner-created
  // tickets are local-first and have no page yet — create one on first mirror
  // and report the new page id back so the store can adopt it.
  async function upsertMirror(ticket, payload) {
    const id = pageOf(ticket);
    if (id) {
      await transport.updatePage(id, buildProperties(payload));
      return { trackerId: id };
    }
    const targetDatabaseId = ticket.trackerMeta?.databaseId || databaseId;
    if (!targetDatabaseId) throw new Error('cannot create a Notion page with no target database');
    const status = payload.status || ticket.status || 'queued';
    const properties = {
      Name: { title: [{ text: { content: ticket.title || '(untitled)' } }] },
      ...buildProperties({ forAI: true, ...payload, status }),
    };
    if (ticket.kind) properties.Kind = { select: { name: ticket.kind } };
    const page = await transport.createPage(targetDatabaseId, properties);
    if (ticket.body) {
      await transport.updatePageMarkdown(page.id, {
        type: 'insert_content',
        insert_content: { content: ticket.body, position: { type: 'end' } },
      });
    }
    return { trackerId: page.id, trackerMeta: { ...(ticket.trackerMeta || {}), url: page.url || '', databaseId: targetDatabaseId } };
  }

  // Insert a managed section at the page end, or replace an existing one.
  function appendSection(ticket, { markdown, existing }) {
    if (existing) {
      return transport.updatePageMarkdown(pageOf(ticket), {
        type: 'update_content',
        update_content: { content_updates: [{ old_str: existing, new_str: markdown }] },
      });
    }
    return transport.updatePageMarkdown(pageOf(ticket), {
      type: 'insert_content',
      insert_content: { content: `\n\n${markdown}`, position: { type: 'end' } },
    });
  }

  // Move an incubator page to a target board's data source, then reset its
  // implementation fields so the target board treats it as a fresh queued ticket.
  async function promoteIncubator(ticket, targetDatabaseId) {
    const dataSourceId = await transport.getDataSourceId(targetDatabaseId);
    await transport.movePage(pageOf(ticket), dataSourceId);
    await mirror(ticket, {
      status: 'queued', forAI: true, attempts: 0, branch: '', cli: '', model: '', reviewRounds: 0, reviewFeedback: '',
    });
  }

  return {
    type: 'notion',
    databaseId,
    statusToBoard,
    boardToStatus,
    listRaw,
    listQueue,
    listStale,
    listDone,
    listForceDeploy,
    listByStatus,
    pagesByStatus,
    pollCommands,
    fetchBody,
    fetchComments,
    fetchPlanMarkdown,
    mirror,
    upsertMirror,
    comment,
    appendSection,
    promoteIncubator,
  };
}

module.exports = { createNotionTracker, buildProperties, TO_BOARD, FROM_BOARD };
