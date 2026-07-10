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

  async function fetchBody(ticket) {
    const blocks = await transport.getBlockChildren(ticket.pageId);
    return blocksToMarkdown(blocks);
  }

  async function fetchComments(ticket) {
    const [comments, bot] = await Promise.all([transport.getComments(ticket.pageId), transport.getCurrentBot()]);
    return comments.map((comment) => ({
      id: comment.id,
      text: richTextToPlain(comment.rich_text).trim(),
      isBot: comment.created_by?.id === bot.id,
    }));
  }

  async function fetchPlanMarkdown(ticket) {
    const page = await transport.getPageMarkdown(ticket.pageId);
    return { markdown: page.markdown || '', truncated: !!page.truncated, unknownBlockIds: page.unknown_block_ids || [] };
  }

  // ---- writes ----
  const mirror = (ticket, payload) => transport.updatePage(ticket.pageId, buildProperties(payload));
  const comment = (ticket, text) => transport.safeComment(ticket.pageId, text, log);

  // Insert a managed section at the page end, or replace an existing one.
  function appendSection(ticket, { markdown, existing }) {
    if (existing) {
      return transport.updatePageMarkdown(ticket.pageId, {
        type: 'update_content',
        update_content: { content_updates: [{ old_str: existing, new_str: markdown }] },
      });
    }
    return transport.updatePageMarkdown(ticket.pageId, {
      type: 'insert_content',
      insert_content: { content: `\n\n${markdown}`, position: { type: 'end' } },
    });
  }

  // Move an incubator page to a target board's data source, then reset its
  // implementation fields so the target board treats it as a fresh queued ticket.
  async function promoteIncubator(ticket, targetDatabaseId) {
    const dataSourceId = await transport.getDataSourceId(targetDatabaseId);
    await transport.movePage(ticket.pageId, dataSourceId);
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
    fetchBody,
    fetchComments,
    fetchPlanMarkdown,
    mirror,
    comment,
    appendSection,
    promoteIncubator,
  };
}

module.exports = { createNotionTracker, buildProperties, TO_BOARD, FROM_BOARD };
