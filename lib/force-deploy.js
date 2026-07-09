'use strict';

const fs = require('fs');
const path = require('path');
const integrationDefault = require('./integration');

function lastErrorLine(error) {
  return String(error || '').split(/\r?\n/).filter(Boolean).slice(-1)[0] || 'see runner logs';
}

// A checked Notion box is a one-shot human approval. Clear it before touching
// EAS so a later Notion failure cannot publish the same update every poll.
async function forceDeploy({ baseDir, config, board, ticket, notion, integration = integrationDefault, log = console.log }) {
  await notion.updatePage(ticket.pageId, { 'Force deploy': { checkbox: false } });

  const metaPath = path.join(baseDir, 'worktrees', `${ticket.shortId}.json`);
  if (!fs.existsSync(metaPath)) {
    const reason = `No worktree metadata found for ${ticket.shortId}; the branch may have been cleaned up.`;
    await notion.safeComment(ticket.pageId, `⚠️ Force deploy could not start. ${reason}`, log);
    return { status: 'failed', reason };
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const key = board.key || board.app;
  if (meta.pageId !== ticket.pageId || (meta.projectKey || meta.app) !== key) {
    const reason = 'Worktree metadata does not match this ticket and app.';
    await notion.safeComment(ticket.pageId, `⚠️ Force deploy refused. ${reason}`, log);
    return { status: 'failed', reason };
  }

  log(`force admitting "${ticket.title}" from ${meta.branch} to the cumulative testing stack`);
  const result = await integration.admitTicket({ config: config || { baseDir }, board, ticket, notion, log });

  if (!['deployed', 'unchanged'].includes(result.status)) {
    const reason = lastErrorLine(result.error || result.status);
    await notion.safeComment(ticket.pageId, `⚠️ Force deploy failed; ticket remains In review. Tick Force deploy to retry.\n\n${reason}`, log);
    return { status: 'failed', reason };
  }

  await notion.updatePage(ticket.pageId, {
    Status: { status: { name: 'Testing' } },
    'Review rounds': { number: 0 },
    'Review feedback': { rich_text: [] },
  });
  const publisher = result.publisher === 'eas-update' ? `\nEAS channel: ${board.easChannel || board.publisher?.channel}` : '\nPublisher: none';
  await notion.safeComment(ticket.pageId, `🚀 Added by human override → cumulative Testing stack\nBranch: ${meta.branch}${publisher}\nStack: ${result.compositeSha || 'already current'}`, log);
  return { status: 'deployed', branch: meta.branch, channel: board.easChannel || board.publisher?.channel || '', compositeSha: result.compositeSha };
}

module.exports = { forceDeploy, lastErrorLine };
