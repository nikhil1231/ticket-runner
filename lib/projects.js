'use strict';

const path = require('path');
const { richTextToPlain } = require('./ticket');
const { assertCommandArray } = require('./commands');

function prop(page, name) {
  return page.properties ? page.properties[name] : undefined;
}

function textProp(page, name) {
  const value = prop(page, name);
  if (!value) return '';
  if (value.type === 'title') return richTextToPlain(value.title).trim();
  if (value.type === 'rich_text') return richTextToPlain(value.rich_text).trim();
  if (value.type === 'url') return String(value.url || '').trim();
  if (value.type === 'select') return String(value.select?.name || '').trim();
  if (value.type === 'status') return String(value.status?.name || '').trim();
  if (value.title) return richTextToPlain(value.title).trim();
  if (value.rich_text) return richTextToPlain(value.rich_text).trim();
  if (value.url) return String(value.url).trim();
  if (value.select) return String(value.select.name || '').trim();
  if (value.status) return String(value.status.name || '').trim();
  return '';
}

function checkboxProp(page, name, defaultValue = false) {
  const value = prop(page, name);
  return value?.checkbox ?? defaultValue;
}

function relationIds(page, name) {
  return (prop(page, name)?.relation || []).map((item) => item.id).filter(Boolean);
}

function parseJsonField(value, fallback, label) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function expoStackBlockPatterns(appDir) {
  if (!appDir) return [];
  const app = appDir.replace(/\\/g, '/').replace(/\/$/, '');
  return [
    'package.json',
    'yarn.lock',
    'package-lock.json',
    'pnpm-lock.yaml',
    `${app}/package.json`,
    `${app}/app.json`,
    `${app}/app.config.js`,
    `${app}/app.config.ts`,
    `${app}/eas.json`,
    `${app}/ios/**`,
    `${app}/android/**`,
    `${app}/plugins/**`,
  ];
}

function normalizePublisher(raw) {
  if (!raw) return { type: 'none' };
  if (typeof raw === 'string') return { type: raw || 'none' };
  const type = raw.type || raw.kind || 'none';
  return { ...raw, type };
}

// Every project points at exactly one tracker (its human-facing board). Notion
// is the default, derived from the existing ticket database ID so pre-tracker
// configs keep working unchanged.
function normalizeTracker(raw, databaseId) {
  if (raw && typeof raw === 'object') {
    const type = raw.type || 'notion';
    if (type === 'notion') return { type, databaseId: raw.databaseId || databaseId };
    return { ...raw, type };
  }
  return { type: 'notion', databaseId };
}

function normalizeProject(config, raw) {
  const key = String(raw.key || raw.app || '').trim().toLowerCase();
  if (!key) throw new Error('project key is required');
  const tracker = normalizeTracker(raw.tracker, raw.databaseId);
  if (tracker.type === 'notion' && !tracker.databaseId) throw new Error(`${key}: ticket database ID is required`);
  if (tracker.type === 'github' && (!tracker.owner || !tracker.repo)) throw new Error(`${key}: github tracker requires owner and repo`);
  const repoPath = path.resolve(config.baseDir || process.cwd(), raw.repoPath || config.repoPath || '.');
  const baseBranch = raw.baseBranch || config.baseBranch || 'main';
  const remote = raw.remote || raw.integration?.remote || config.integration?.remote || 'origin';
  const mainBranch = raw.mainBranch || raw.integration?.mainBranch || config.integration?.mainBranch || baseBranch;
  const workdir = String(raw.workdir || raw.appDir || '.').replace(/\\/g, '/').replace(/\/$/, '') || '.';
  const setupCommands = assertCommandArray(raw.setupCommands || [], `${key}: setupCommands`);
  const validationCommands = assertCommandArray(
    raw.validationCommands || raw.integration?.validationCommands || [],
    `${key}: validationCommands`
  );
  const publisher = normalizePublisher(raw.publisher || raw.publish);
  const integrationMode = String(raw.integrationMode || raw.integration?.mode || raw.mode || 'testing-stack').toLowerCase();
  const enabled = raw.enabled ?? raw.integration?.enabled ?? true;
  return {
    key,
    app: key,
    databaseId: raw.databaseId || '',
    repoPath,
    baseBranch,
    remote,
    mainBranch,
    scope: raw.scope || key,
    workdir,
    appDir: workdir,
    setupCommands,
    validationCommands,
    validationTimeoutMs: raw.validationTimeoutMs || raw.integration?.validationTimeoutMs || config.integration?.validationTimeoutMs,
    integrationMode,
    integration: {
      enabled: enabled !== false && integrationMode !== 'disabled',
      remote,
      mainBranch,
      validationCommands,
      validationTimeoutMs: raw.validationTimeoutMs || raw.integration?.validationTimeoutMs || config.integration?.validationTimeoutMs,
    },
    publisher,
    easChannel: raw.easChannel || publisher.channel || '',
    stackBlockPatterns: raw.stackBlockPatterns || [],
    notes: raw.notes || '',
    projectPageId: raw.projectPageId || raw.pageId || '',
    tracker,
    flywheel: raw.flywheel || {},
    archive: raw.archive || {},
  };
}

function legacyProjectFromBoard(config, board) {
  return normalizeProject(config, {
    key: board.key || board.app,
    databaseId: board.databaseId,
    repoPath: board.repoPath || config.repoPath,
    baseBranch: board.baseBranch || config.baseBranch,
    remote: board.integration?.remote || config.integration?.remote || 'origin',
    mainBranch: board.integration?.mainBranch || config.integration?.mainBranch || config.baseBranch || 'main',
    scope: board.scope || board.app || board.key,
    workdir: board.workdir || board.appDir || '.',
    setupCommands: board.setupCommands || config.setupCommands || [['yarn', 'install']],
    validationCommands: board.integration?.validationCommands || board.validationCommands || [],
    integrationMode: board.integration?.enabled === false ? 'disabled' : 'testing-stack',
    publisher: board.publisher || (board.easChannel ? { type: 'eas-update', channel: board.easChannel } : { type: 'none' }),
    stackBlockPatterns: board.stackBlockPatterns || expoStackBlockPatterns(board.appDir),
    notes: board.notes || '',
    projectPageId: board.projectPageId || '',
  });
}

function projectFromRegistryPage(config, page) {
  const key = textProp(page, 'Key') || textProp(page, 'Name');
  const publisherType = textProp(page, 'Publisher') || textProp(page, 'Publish') || textProp(page, 'Deployment') || 'none';
  const channel = textProp(page, 'EAS channel') || textProp(page, 'EAS Channel');
  return normalizeProject(config, {
    key,
    enabled: checkboxProp(page, 'Enabled', true),
    databaseId: textProp(page, 'Ticket database ID'),
    repoPath: textProp(page, 'Repo path'),
    baseBranch: textProp(page, 'Base branch'),
    remote: textProp(page, 'Remote'),
    mainBranch: textProp(page, 'Main branch'),
    scope: textProp(page, 'Scope'),
    workdir: textProp(page, 'Workdir') || '.',
    setupCommands: parseJsonField(textProp(page, 'Setup commands JSON'), [], `${key}: Setup commands JSON`),
    validationCommands: parseJsonField(textProp(page, 'Validation commands JSON'), [], `${key}: Validation commands JSON`),
    integrationMode: textProp(page, 'Integration mode') || 'testing-stack',
    publisher: { type: publisherType, channel },
    stackBlockPatterns: parseJsonField(textProp(page, 'Stack block patterns JSON'), [], `${key}: Stack block patterns JSON`),
    notes: textProp(page, 'Notes'),
    projectPageId: page.id,
  });
}

async function resolveProjects(config, notion) {
  if (Array.isArray(config.projects) && config.projects.length) {
    const projects = config.projects.map((project) => normalizeProject(config, project));
    config.projects = projects;
    config.projectsByKey = Object.fromEntries(projects.map((project) => [project.key, project]));
    return projects;
  }
  if (config.projectRegistry?.databaseId) {
    console.warn('projectRegistry.databaseId is a legacy fallback; prefer config.projects for the local project registry');
    const pages = await notion.queryDatabase(config.projectRegistry.databaseId, {
      property: 'Enabled', checkbox: { equals: true },
    });
    const projects = pages.map((page) => projectFromRegistryPage(config, page));
    if (!projects.length) throw new Error('project registry returned no enabled projects');
    config.projects = projects;
    config.projectsByKey = Object.fromEntries(projects.map((project) => [project.key, project]));
    return projects;
  }
  const projects = (config.boards || []).map((board) => legacyProjectFromBoard(config, board));
  if (!projects.length) throw new Error('config must define projectRegistry.databaseId, projects, or legacy boards');
  config.projects = projects;
  config.projectsByKey = Object.fromEntries(projects.map((project) => [project.key, project]));
  return projects;
}

function findProject(config, keyOrPageId) {
  const value = String(keyOrPageId || '').toLowerCase();
  return (config.projects || []).find((project) => (
    project.key === value
    || project.app === value
    || project.projectPageId === keyOrPageId
    || project.databaseId === keyOrPageId
  ));
}

function extractProjectKeyFromPage(page) {
  const ids = relationIds(page, 'Project');
  const key = textProp(page, 'Project key') || textProp(page, 'Project') || textProp(page, 'App');
  return { relationIds: ids, key: key.toLowerCase() };
}

function resolveIncubatorProject(config, pageOrTicket) {
  if (pageOrTicket?.properties) {
    const { relationIds: ids, key } = extractProjectKeyFromPage(pageOrTicket);
    for (const id of ids) {
      const project = findProject(config, id);
      if (project) return project;
    }
    if (key) return findProject(config, key);
    return null;
  }
  return findProject(config, pageOrTicket?.projectKey || pageOrTicket?.app);
}

function globToRegex(pattern) {
  const normalized = String(pattern || '').replace(/\\/g, '/');
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const marker = '\u0000DOUBLE_STAR\u0000';
  return new RegExp(`^${escaped.replace(/\*\*/g, marker).replace(/\*/g, '[^/]*').replaceAll(marker, '.*')}$`);
}

function matchesAnyPattern(file, patterns) {
  const normalized = String(file || '').replace(/\\/g, '/');
  return (patterns || []).some((pattern) => {
    const value = String(pattern || '').replace(/\\/g, '/').replace(/\/$/, '');
    if (!value) return false;
    if (!value.includes('*')) return normalized === value || normalized.startsWith(`${value}/`);
    return globToRegex(value).test(normalized);
  });
}

module.exports = {
  textProp,
  relationIds,
  parseJsonField,
  normalizeProject,
  legacyProjectFromBoard,
  projectFromRegistryPage,
  resolveProjects,
  findProject,
  extractProjectKeyFromPage,
  resolveIncubatorProject,
  matchesAnyPattern,
  expoStackBlockPatterns,
};
