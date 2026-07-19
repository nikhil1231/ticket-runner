'use strict';

const path = require('path');
const { assertCommandArray } = require('./commands');

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

function normalizeTracker(raw, key) {
  if (!raw || typeof raw !== 'object') throw new Error(`${key}: tracker config is required`);
  const type = raw.type || 'github';
  if (type !== 'github') throw new Error(`${key}: unsupported tracker type: ${type}`);
  if (!raw.owner || !raw.repo) throw new Error(`${key}: github tracker requires owner and repo`);
  return { ...raw, type };
}

function normalizeProject(config, raw) {
  const key = String(raw.key || raw.app || '').trim().toLowerCase();
  if (!key) throw new Error('project key is required');
  const tracker = normalizeTracker(raw.tracker, key);
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
    tracker,
    flywheel: raw.flywheel || {},
    archive: raw.archive || {},
  };
}

async function resolveProjects(config) {
  if (!Array.isArray(config.projects) || !config.projects.length) {
    throw new Error('config.projects must contain at least one project');
  }
  const projects = config.projects.map((project) => normalizeProject(config, project));
  config.projects = projects;
  config.projectsByKey = Object.fromEntries(projects.map((project) => [project.key, project]));
  return projects;
}

function findProject(config, key) {
  const value = String(key || '').toLowerCase();
  return (config.projects || []).find((project) => project.key === value || project.app === value);
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
  parseJsonField,
  normalizeProject,
  resolveProjects,
  findProject,
  matchesAnyPattern,
  expoStackBlockPatterns,
};
