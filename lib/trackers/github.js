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

function snapshot(issue, projectKey, status) {
  return {
    tracker: 'github',
    trackerId: String(issue.number),
    projectKey,
    kind: kindOf(issue),
    title: issue.title || '(untitled)',
    shortId: `gh${String(issue.number).padStart(10, '0')}`.slice(0, 12),
    createdAt: issue.created_at || new Date().toISOString(),
    trackerMeta: {
      nodeId: issue.node_id || '',
      url: issue.html_url || '',
      issueNumber: issue.number,
      projectItemId: issue.projectItemId || '',
    },
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
      item = await rest('POST', `${repoPath}/issues`, {
        title: ticket.title || '(untitled)',
        body: ticket.body || '',
        labels: ['for-ai', ticket.kind === 'incubator' ? 'incubator' : null].filter(Boolean),
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
    await updateProjectText(projectItemId, engineFieldId, payload.lastAgent || '');
    await updateProjectText(projectItemId, modelFieldId, ticket.modelPin || ticket.model || '');
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
    const nextLabels = [...new Set(labels(item).filter((label) => label !== 'incubator').concat('for-ai'))];
    await rest('PUT', `${repoPath}/issues/${number}/labels`, { labels: nextLabels });
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
    const data = await transport.graphql(`
      query ProjectItems($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100) {
              nodes {
                id
                content { ... on Issue { number } }
                fieldValueByName(name: "Status") {
                  ... on ProjectV2ItemFieldSingleSelectValue { name }
                }
              }
            }
          }
        }
      }`, { projectId });
    const map = new Map();
    for (const node of data?.node?.items?.nodes || []) {
      if (node.content?.number) map.set(node.content.number, {
        projectItemId: node.id,
        projectStatus: node.fieldValueByName?.name || '',
      });
    }
    return map;
  }

  async function pollCommands({ store, projectKey }) {
    const etagKey = `cursor:github:${owner}/${repo}:issues:etag`;
    const sinceKey = `cursor:github:${owner}/${repo}:issues:since`;
    const params = new URLSearchParams({ state: 'open', labels: 'for-ai', per_page: '100' });
    const since = store?.getKv?.(sinceKey, null);
    if (since) params.set('since', since);
    const etag = store?.getKv?.(etagKey, '');
    const response = await transport.rest('GET', `${repoPath}/issues?${params}`, undefined, etag ? { etag } : {});
    if (response.status === 304) return [];
    if (store?.setKv && response.etag) store.setKv(etagKey, response.etag);
    const projects = await projectItemsByIssue();
    const commands = [];
    let maxUpdated = since;
    for (const raw of response.data || []) {
      if (raw.pull_request) continue;
      const project = projects.get(raw.number) || {};
      const item = { ...raw, ...project };
      const status = projectStatusName(item, 'queued');
      const existing = store.getByTrackerId('github', String(item.number));
      const snap = snapshot(item, projectKey, status);
      if (!existing) commands.push({ type: 'create', trackerId: String(item.number), snapshot: snap });
      else if (hasLabel(item, 'force-deploy')) {
        await removeLabel(item.number, 'force-deploy');
        commands.push({ type: 'force_deploy', trackerId: String(item.number), ticket: existing, snapshot: snap });
      } else if (status === 'done' && existing.status === 'testing') {
        commands.push({ type: 'authorize_merge', trackerId: String(item.number), ticket: existing, snapshot: snap });
      } else if (status === 'queued' && existing.status !== 'queued') {
        commands.push({ type: 'requeue', trackerId: String(item.number), ticket: existing, snapshot: snap });
      }
      if (!maxUpdated || String(item.updated_at || '').localeCompare(maxUpdated) > 0) maxUpdated = item.updated_at;
    }
    if (store?.setKv && maxUpdated) store.setKv(sinceKey, maxUpdated);
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
