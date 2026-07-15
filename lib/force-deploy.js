'use strict';

const fs = require('fs');
const path = require('path');
const integrationDefault = require('./integration');

function lastErrorLine(error) {
  return String(error || '').split(/\r?\n/).filter(Boolean).slice(-1)[0] || 'see runner logs';
}

// A checked force-deploy flag is a one-shot human approval. Clear it before
// touching EAS so a later tracker failure cannot publish the same update every poll.
async function forceDeploy({ baseDir, config, board, ticket, tracker, integration = integrationDefault, log = console.log }) {
  await tracker.mirror(ticket, { forceDeploy: false });

  const storeTicket = config?.store && ticket.id ? config.store.getById(ticket.id) : null;
  const metaPath = path.join(baseDir, 'worktrees', `${ticket.shortId}.json`);
  if (!storeTicket && !fs.existsSync(metaPath)) {
    const reason = `No worktree metadata found for ${ticket.shortId}; the branch may have been cleaned up.`;
    await tracker.comment(ticket, `⚠️ Force deploy could not start. ${reason}`);
    return { status: 'failed', reason };
  }

  const meta = storeTicket ? {
    pageId: storeTicket.pageId,
    projectKey: storeTicket.projectKey,
    app: storeTicket.projectKey,
    branch: storeTicket.branch,
  } : JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const key = board.key || board.app;
  if (meta.pageId !== ticket.pageId || (meta.projectKey || meta.app) !== key) {
    const reason = 'Worktree metadata does not match this ticket and app.';
    await tracker.comment(ticket, `⚠️ Force deploy refused. ${reason}`);
    return { status: 'failed', reason };
  }

  log(`force admitting "${ticket.title}" from ${meta.branch} to the cumulative testing stack`);
  const result = await integration.admitTicket({ config: config || { baseDir }, board, ticket, tracker, log, allowNativeSensitive: true });

  if (!['deployed', 'unchanged'].includes(result.status)) {
    const reason = lastErrorLine(result.error || result.status);
    await tracker.comment(ticket, `⚠️ Force deploy failed; ticket remains In review. Tick Force deploy to retry.\n\n${reason}`);
    return { status: 'failed', reason };
  }

  await tracker.mirror(ticket, { status: 'testing', reviewRounds: 0, reviewFeedback: '' });
  const publisher = result.publisher === 'eas-update' ? `\nEAS channel: ${board.easChannel || board.publisher?.channel}` : '\nPublisher: none';
  await tracker.comment(ticket, `🚀 Added by human override → cumulative Testing stack\nBranch: ${meta.branch}${publisher}\nStack: ${result.compositeSha || 'already current'}`);
  return { status: 'deployed', branch: meta.branch, channel: board.easChannel || board.publisher?.channel || '', compositeSha: result.compositeSha };
}

module.exports = { forceDeploy, lastErrorLine };
