'use strict';

const fs = require('fs');
const path = require('path');
const github = require('../lib/github');

const baseDir = path.resolve(__dirname, '..');
const LABELS = {
  'for-ai': 'Tickets the runner may pick up',
  incubator: 'Planning tickets awaiting implementation handoff',
  epic: 'Epic-level parent issue',
  mission: 'Mission-level parent issue',
  'force-deploy': 'One-shot human override for the testing stack',
};
const STATUS_OPTIONS = ['Not started', 'In progress', 'Needs info', 'In review', 'Testing', 'Done', 'Failed', 'Cancelled'];

function loadEnv() {
  const envPath = path.join(baseDir, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

async function ensureLabel(owner, repo, name, description) {
  const body = { name, color: name === 'force-deploy' ? 'd73a4a' : '5319e7', description };
  try {
    await github.rest('GET', `/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`);
    await github.rest('PATCH', `/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`, body);
  } catch (error) {
    if (!/-> 404:/.test(error.message)) throw error;
    await github.rest('POST', `/repos/${owner}/${repo}/labels`, body);
  }
}

async function repoNodeId(owner, repo) {
  const data = await github.graphql(`
    query RepoNode($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) { id }
    }`, { owner, repo });
  return data.repository.id;
}

async function viewerProjects() {
  const data = await github.graphql(`
    query ViewerProjects {
      viewer {
        projectsV2(first: 100) {
          nodes { id number title }
        }
      }
    }`, {});
  return data.viewer.projectsV2.nodes || [];
}

async function createProject(title) {
  const viewer = await github.graphql('query ViewerId { viewer { id } }', {});
  const data = await github.graphql(`
    mutation CreateProject($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 { id number title }
      }
    }`, { ownerId: viewer.viewer.id, title });
  return data.createProjectV2.projectV2;
}

async function ensureProject(title) {
  return (await viewerProjects()).find((project) => project.title === title) || createProject(title);
}

async function linkRepo(projectId, repositoryId) {
  try {
    await github.graphql(`
      mutation LinkRepo($projectId: ID!, $repositoryId: ID!) {
        linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
          repository { id }
        }
      }`, { projectId, repositoryId });
  } catch (error) {
    if (!/already/i.test(error.message)) throw error;
  }
}

async function projectFields(projectId) {
  const data = await github.graphql(`
    query ProjectFields($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 100) {
            nodes {
              ... on ProjectV2FieldCommon { id name dataType }
              ... on ProjectV2SingleSelectField { id name dataType options { id name } }
            }
          }
        }
      }
    }`, { projectId });
  return data.node.fields.nodes || [];
}

async function createTextField(projectId, name) {
  const data = await github.graphql(`
    mutation CreateTextField($projectId: ID!, $name: String!) {
      createProjectV2Field(input: { projectId: $projectId, name: $name, dataType: TEXT }) {
        projectV2Field { ... on ProjectV2FieldCommon { id name } }
      }
    }`, { projectId, name });
  return data.createProjectV2Field.projectV2Field;
}

function statusField(fields) {
  const candidates = fields.filter((field) => field.name === 'AI Status' || field.name === 'Status');
  return candidates.find((field) => {
    const names = new Set((field.options || []).map((option) => option.name));
    return STATUS_OPTIONS.every((name) => names.has(name));
  }) || candidates[0];
}

async function setup({ owner, repo, title }) {
  for (const [name, description] of Object.entries(LABELS)) {
    await ensureLabel(owner, repo, name, description);
  }
  const project = await ensureProject(title || `${repo} AI Tickets`);
  await linkRepo(project.id, await repoNodeId(owner, repo));
  let fields = await projectFields(project.id);
  const status = statusField(fields);
  if (!status) {
    throw new Error(`Create a Projects v2 single-select field named "AI Status" with options: ${STATUS_OPTIONS.join(', ')}`);
  }
  let engine = fields.find((field) => field.name === 'Engine');
  if (!engine) {
    engine = await createTextField(project.id, 'Engine');
    fields = await projectFields(project.id);
  }
  let model = fields.find((field) => field.name === 'Model');
  if (!model) model = await createTextField(project.id, 'Model');
  const statusOptions = Object.fromEntries((status.options || []).map((option) => [option.name, option.id]));
  return {
    type: 'github',
    owner,
    repo,
    projectNumber: project.number,
    projectId: project.id,
    statusFieldId: status.id,
    statusOptions,
    engineFieldId: engine.id,
    modelFieldId: model.id,
  };
}

async function main() {
  loadEnv();
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not set');
  github.setToken(process.env.GITHUB_TOKEN);
  const owner = process.argv[2];
  const repo = process.argv[3];
  const title = process.argv.slice(4).join(' ');
  if (!owner || !repo) throw new Error('usage: node scripts/setup-github.js <owner> <repo> [project title]');
  const tracker = await setup({ owner, repo, title });
  console.log(JSON.stringify({ tracker }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { setup, STATUS_OPTIONS, LABELS };
