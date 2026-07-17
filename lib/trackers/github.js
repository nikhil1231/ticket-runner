'use strict';

const githubDefault = require('../github');

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

const FROM_BOARD = Object.fromEntries(Object.entries(TO_BOARD).map(([key, value]) => [value, key]));
FROM_BOARD.Backlog = 'queued';
FROM_BOARD['In Progress'] = 'in_progress';

const MANAGED_PLAN_HEADING = '## AI implementation plan';
const QUERY_HEADING = '## AI query answer';

function issueNumber(value) {
  const text = String(value || '');
  const match = text.match(/\d+$/);
  return match ? Number(match[0]) : Number(text);
}

function labels(issue) {
  return (issue.labels || []).map((label) => (typeof label === 'string' ? label : label.name)).filter(Boolean);
}

function hasLabel(issue, name) {
  return labels(issue).includes(name);
}

function kindOf(issue) {
  if (hasLabel(issue, 'incubator')) return 'incubator';
  if (hasLabel(issue, 'mission')) return 'mission';
  if (hasLabel(issue, 'epic')) return 'epic';
  return 'feature';
}

function parentTrackerId(issue) {
  const body = String(issue.body || '');
  const patterns = [
    /\bparent\s*[:#]?\s*#(\d+)\b/i,
    /\bparent\s*:\s*https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)\b/i,
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) return String(match[1]);
  }
  return '';
}

function snapshot(issue, projectKey, status, trackerType = 'github') {
  return {
    tracker: trackerType,
    trackerId: String(issue.number),
    projectKey,
    kind: kindOf(issue),
    title: issue.title || '(untitled)',
    shortId: (projectKey || 'gh').slice(0, 4).padEnd(4, '0').toLowerCase() + String(issue.number).slice(-8).padStart(8, '0'),
    createdAt: issue.created_at || new Date().toISOString(),
    trackerMeta: {
      nodeId: issue.node_id || '',
      url: issue.html_url || '',
      issueNumber: issue.number,
      projectItemId: issue.projectItemId || '',
    },
    parentTrackerId: parentTrackerId(issue),
    mirroredStatus: TO_BOARD[status] || status,
    status,
  };
}

function markdownAppend(body, heading, markdown) {
  const current = String(body || '').trimEnd();
  const section = String(markdown || '').trim();
  if (!current) return section;
  const index = current.indexOf(heading);
  if (index < 0) return `${current}\n\n${section}`;
  return `${current.slice(0, index).trimEnd()}\n\n${section}`;
}

function projectStatusName(issue, fallback = 'queued') {
  const status = issue.projectStatus || issue.status || issue.trackerStatus;
  return FROM_BOARD[status] || fallback;
}

function isMissingProjectError(error) {
  const message = String(error?.message || '');
  return message.includes('"type":"NOT_FOUND"')
    && message.includes('"path":["node"]')
    && message.includes('Could not resolve to a node');
}

function isTransientGithubError(error) {
  const status = Number(error?.status || error?.statusCode);
  if (status === 429 || status >= 500) return true;
  const message = String(error?.message || '');
  if (message.includes('GitHub GraphQL errors:')
    && message.includes('Something went wrong while executing your query')) {
    return true;
  }
  const match = message.match(/GitHub \S+ .+ -> (\d{3}):/);
  if (!match) return false;
  const parsed = Number(match[1]);
  return parsed === 429 || parsed >= 500;
}

function recentlyMirrored(ticket, now = Date.now(), windowMs = 2 * 60 * 1000) {
  if (!ticket?.mirrorSyncedAt) return false;
  const at = Date.parse(ticket.mirrorSyncedAt);
  return Number.isFinite(at) && now - at >= 0 && now - at < windowMs;
}

function createGithubTracker({
  transport = githubDefault,
  owner,
  repo,
  projectNumber,
  projectId,
  statusFieldId,
  statusOptions = {},
  engineFieldId,
  modelFieldId,
  assignee = 'ticket-runner-bot',
  log = console.log,
} = {}) {
  if (!owner || !repo) throw new Error('github tracker requires owner and repo');

  const repoPath = `/repos/${owner}/${repo}`;
  const statusToBoard = (canonical) => TO_BOARD[canonical] || null;
  const boardToStatus = (name) => FROM_BOARD[name] || null;

  async function rest(method, path, body, opts) {
    const res = await transport.rest(method, path, body, opts);
    return res?.data === undefined ? res : res.data;
  }

  async function issue(number) {
    return rest('GET', `${repoPath}/issues/${issueNumber(number)}`);
  }

  async function comments(number) {
    return rest('GET', `${repoPath}/issues/${issueNumber(number)}/comments?per_page=100`);
  }

  async function currentViewer() {
    if (!transport.graphql) return null;
    const data = await transport.graphql('query ViewerLogin { viewer { login } }', {});
    return data?.viewer?.login || null;
  }

  async function fetchContent(trackerId) {
    const [item, thread, viewer] = await Promise.all([
      issue(trackerId),
      comments(trackerId).catch(() => []),
      currentViewer().catch(() => null),
    ]);
    return {
      title: item.title || '(untitled)',
      bodyMarkdown: item.body || '',
      comments: (thread || []).map((comment) => ({
        id: String(comment.id),
        text: comment.body || '',
        isBot: viewer ? comment.user?.login === viewer : comment.user?.type === 'Bot',
        createdAt: comment.created_at || '',
      })),
    };
  }

  const fetchBody = async (ticket) => (await fetchContent(ticket.trackerId || ticket.pageId)).bodyMarkdown;
  const fetchComments = async (ticket) => (await fetchContent(ticket.trackerId || ticket.pageId)).comments;
  const fetchPlanMarkdown = async (ticket) => {
    const content = await fetchContent(ticket.trackerId || ticket.pageId);
    return { markdown: content.bodyMarkdown, truncated: false, unknownBlockIds: [] };
  };

  async function addToProject(nodeId) {
    if (!projectId || !nodeId || !transport.graphql) return null;
    const data = await transport.graphql(`
      mutation AddProjectItem($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item { id }
        }
      }`, { projectId, contentId: nodeId });
    return data?.addProjectV2ItemById?.item?.id || null;
  }

  async function updateProjectStatus(itemId, status) {
    if (!projectId || !statusFieldId || !itemId || !transport.graphql) return;
    const optionId = statusOptions[status] || statusOptions[TO_BOARD[status]] || '';
    if (!optionId) return;
    await transport.graphql(`
      mutation UpdateProjectStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: { singleSelectOptionId: $optionId }
        }) { projectV2Item { id } }
      }`, { projectId, itemId, fieldId: statusFieldId, optionId });
  }

  async function updateProjectText(itemId, fieldId, text) {
    if (!projectId || !fieldId || !itemId || !transport.graphql || text === undefined) return;
    await transport.graphql(`
      mutation UpdateProjectText($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: { text: $text }
        }) { projectV2Item { id } }
      }`, { projectId, itemId, fieldId, text: String(text || '').slice(0, 255) });
  }

  async function upsertMirror(ticket, payload) {
    const status = payload.status || ticket.status || 'queued';
    let id = ticket.trackerId || ticket.pageId;
    let item = null;
    if (!id) {
      const kindLabel = { incubator: 'incubator', epic: 'epic', mission: 'mission' }[ticket.kind] || null;
      item = await rest('POST', `${repoPath}/issues`, {
        title: ticket.title || '(untitled)',
        body: ticket.body || '',
        labels: [kindLabel].filter(Boolean),
        assignees: assignee ? [assignee] : [],
      });
      id = String(item.number);
    } else {
      item = await rest('PATCH', `${repoPath}/issues/${issueNumber(id)}`, {
        state: status === 'done' || status === 'cancelled' ? 'closed' : 'open',
      });
    }
    let projectItemId = ticket.trackerMeta?.projectItemId || item?.projectItemId || '';
    if (!projectItemId) projectItemId = await addToProject(item?.node_id || ticket.trackerMeta?.nodeId);
    await updateProjectStatus(projectItemId, status);
    let lastCli = '';
    let lastModel = '';
    if (payload.cli !== undefined) {
      lastCli = payload.cli;
    } else if (payload.lastAgent) {
      lastCli = payload.lastAgent.split(' / ')[0] || '';
    }
    if (payload.model !== undefined) {
      lastModel = payload.model;
    } else if (payload.lastAgent) {
      lastModel = payload.lastAgent.split(' / ')[1] || '';
    }
    await updateProjectText(projectItemId, engineFieldId, lastCli);
    await updateProjectText(projectItemId, modelFieldId, lastModel);
    return {
      trackerId: id,
      trackerMeta: {
        ...(ticket.trackerMeta || {}),
        nodeId: item?.node_id || ticket.trackerMeta?.nodeId || '',
        url: item?.html_url || ticket.url || '',
        issueNumber: issueNumber(id),
        projectItemId: projectItemId || '',
      },
    };
  }

  async function comment(ticket, text) {
    await rest('POST', `${repoPath}/issues/${issueNumber(ticket.trackerId || ticket.pageId)}/comments`, { body: text || '(empty)' });
  }

  async function appendSection(ticket, { heading, markdown }) {
    const number = issueNumber(ticket.trackerId || ticket.pageId);
    const item = await issue(number);
    const sectionHeading = heading || (String(markdown || '').includes(QUERY_HEADING) ? QUERY_HEADING : MANAGED_PLAN_HEADING);
    await rest('PATCH', `${repoPath}/issues/${number}`, { body: markdownAppend(item.body || '', sectionHeading, markdown) });
  }

  async function promoteIncubator(ticket) {
    const number = issueNumber(ticket.trackerId || ticket.pageId);
    const item = await issue(number);
    const nextLabels = labels(item).filter((label) => label !== 'incubator');
    await rest('PUT', `${repoPath}/issues/${number}/labels`, { labels: nextLabels });
    if (assignee) await rest('PATCH', `${repoPath}/issues/${number}`, { assignees: [assignee] });
  }

  async function removeLabel(number, label) {
    try {
      await transport.rest('DELETE', `${repoPath}/issues/${issueNumber(number)}/labels/${encodeURIComponent(label)}`);
    } catch (error) {
      log(`github label removal failed (non-fatal): ${error.message}`);
    }
  }

  async function projectItemsByIssue() {
    if (!projectId || !transport.graphql) return new Map();
    let data;
    try {
      data = await transport.graphql(`
        query ProjectItems($projectId: ID!) {
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: 100) {
                nodes {
                  id
                  content { ... on Issue { number repository { nameWithOwner } } }
                  fieldValueByName(name: "Status") {
                    ... on ProjectV2ItemFieldSingleSelectValue { name }
                  }
                }
              }
            }
          }
        }`, { projectId });
    } catch (error) {
      if (!isMissingProjectError(error)) throw error;
      log(`github project lookup failed; skipping project-filtered poll for ${owner}/${repo}: ${error.message}`);
      return new Map();
    }
    // A single Project v2 board can hold issues from several repos (e.g. a repo
    // rename leaves stale items pointing at the old name). Issue numbers are only
    // unique within a repo, so keying this map by number alone lets another repo's
    // #N clobber this repo's #N — the poll would then read the wrong item id and
    // board status for the ticket. This tracker is scoped to one repo, so drop
    // items belonging to any other. (A missing nameWithOwner — e.g. draft items —
    // is treated as matching so behaviour is unchanged on single-repo boards.)
    const map = new Map();
    const wantRepo = `${owner}/${repo}`;
    for (const node of data?.node?.items?.nodes || []) {
      if (!node.content?.number) continue;
      const nameWithOwner = node.content.repository?.nameWithOwner;
      if (nameWithOwner && nameWithOwner !== wantRepo) continue;
      map.set(node.content.number, {
        projectItemId: node.id,
        projectStatus: node.fieldValueByName?.name || '',
      });
    }
    return map;
  }

  async function pollCommands({ store, projectKey }) {
    const key = `github:${owner}/${repo}`;
    const etagKey = `cursor:github:${owner}/${repo}:issues:etag`;
    const sinceKey = `cursor:github:${owner}/${repo}:issues:since`;
    const params = new URLSearchParams({ state: 'open', assignee: assignee || '*', per_page: '100' });
    const since = store?.getKv?.(sinceKey, null);
    if (since) params.set('since', since);
    const etag = store?.getKv?.(etagKey, '');
    let response;
    try {
      response = await transport.rest('GET', `${repoPath}/issues?${params}`, undefined, etag ? { etag } : {});
    } catch (error) {
      if (!isTransientGithubError(error)) throw error;
      log(`github issue poll failed transiently for ${owner}/${repo}; skipping this poll: ${error.message}`);
      return [];
    }
    const notModified = response.status === 304;
    let projects;
    try {
      projects = await projectItemsByIssue();
    } catch (error) {
      if (!isTransientGithubError(error)) throw error;
      log(`github project lookup failed transiently for ${owner}/${repo}; skipping this poll: ${error.message}`);
      return [];
    }
    if (!notModified && store?.setKv && response.etag) store.setKv(etagKey, response.etag);
    const commands = [];
    const handled = new Set();

    // Intake + label-driven force-deploy: both coincide with an issue update, so
    // the since-cursored issue list is the right (and cheap) source for them.
    if (!notModified) {
      let maxUpdated = since;
      for (const raw of response.data || []) {
        if (raw.pull_request) continue;
        const project = projects.get(raw.number) || {};
        if (projectId && !project.projectItemId) continue;
        const item = { ...raw, ...project };
        const status = projectStatusName(item, 'queued');
        const existing = store.getByTrackerId(key, String(item.number));
        const snap = snapshot(item, projectKey, status, key);
        if (!existing) {
          commands.push({ type: 'create', trackerId: String(item.number), snapshot: snap });
          handled.add(raw.number);
        } else {
          const parent = snap.parentTrackerId ? store.getByTrackerId(key, snap.parentTrackerId) : null;
          if (parent && existing.parentId !== parent.id) {
            commands.push({ type: 'link_parent', trackerId: String(item.number), ticket: existing, snapshot: snap });
          }
        }
        if (existing && hasLabel(item, 'force-deploy')) {
          await removeLabel(item.number, 'force-deploy');
          commands.push({ type: 'force_deploy', trackerId: String(item.number), ticket: existing, snapshot: snap });
          handled.add(raw.number);
        }
        if (!maxUpdated || String(item.updated_at || '').localeCompare(maxUpdated) > 0) maxUpdated = item.updated_at;
      }
      if (store?.setKv && maxUpdated) store.setKv(sinceKey, maxUpdated);
    }

    // Board-status transitions on existing tickets. Changing a project's Status
    // field does NOT bump the issue's updatedAt, so the since-cursored list above
    // never re-fetches the issue and the change is invisible. Detect these from
    // the current project item statuses every poll instead.
    for (const [number, project] of projects) {
      if (handled.has(number) || !project.projectStatus) continue;
      const existing = store.getByTrackerId(key, String(number));
      if (!existing) continue; // brand-new issues are intake, handled above
      // The board is eventually-consistent: the runner's own status writes take a
      // moment to mirror. Only treat the board as a human command when it differs
      // from what we last mirrored — otherwise mirror lag (e.g. a just-claimed
      // ticket whose "In progress" hasn't propagated yet) reads as a human moving
      // the card back and we requeue our own in-progress work in a tight loop.
      if (project.projectStatus === existing.mirroredStatus) continue;
      if (recentlyMirrored(existing)) continue;
      const status = projectStatusName(project, existing.status);
      if (status === existing.status) continue;
      const snap = snapshot({ number, node_id: existing.trackerMeta?.nodeId, title: existing.title, ...project }, projectKey, status, key);
      if (status === 'done' && existing.status === 'testing') {
        // Moving an epic to Done cascades a merge of every ticket under it;
        // moving a feature to Done authorizes that single ticket's merge.
        const type = existing.kind === 'epic' ? 'authorize_epic_merge' : 'authorize_merge';
        commands.push({ type, trackerId: String(number), ticket: existing, snapshot: snap });
      } else if (status === 'in_progress' && existing.kind === 'epic' && existing.status === 'testing') {
        // A human reopening an epic parked in Testing to add more tickets to it.
        commands.push({ type: 'resume_epic', trackerId: String(number), ticket: existing, snapshot: snap });
      } else if (status === 'queued' && existing.status !== 'queued') {
        // A human moving a card back to "Not started" is the documented requeue
        // flow for In review (approve the withdraw) and Needs info (runner parks
        // there and asks the human to edit + move back). Every other state
        // (Testing, Failed, terminal) stays board-immune so a stale card left by
        // a failed mirror write can't silently restart work.
        if (!['in_review', 'needs_info'].includes(existing.status)) continue;
        if (existing.status === 'needs_info' && existing.nativeSensitiveFiles?.length) continue;
        commands.push({ type: 'requeue', trackerId: String(number), ticket: existing, snapshot: snap });
      } else if (status === 'in_review' && existing.status === 'testing') {
        commands.push({ type: 'withdraw', trackerId: String(number), ticket: existing, snapshot: snap });
      } else if (status === 'cancelled' && !['done', 'failed', 'cancelled'].includes(existing.status)) {
        commands.push({ type: 'cancel', trackerId: String(number), ticket: existing, snapshot: snap });
      }
    }
    return commands;
  }

  async function healthcheck() {
    await transport.rest('GET', `${repoPath}`);
    return true;
  }

  return {
    type: 'github',
    owner,
    repo,
    projectNumber,
    projectId,
    statusToBoard,
    boardToStatus,
    pollCommands,
    fetchContent,
    fetchBody,
    fetchComments,
    fetchPlanMarkdown,
    upsertMirror,
    comment,
    appendSection,
    promoteIncubator,
    healthcheck,
  };
}

module.exports = { createGithubTracker, TO_BOARD, FROM_BOARD, markdownAppend };
