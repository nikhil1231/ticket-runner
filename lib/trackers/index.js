'use strict';

const { createNotionTracker } = require('./notion');
const { createGithubTracker } = require('./github');

const REGISTRY = {
  notion: createNotionTracker,
  github: createGithubTracker,
};

// Resolve a tracker adapter from a tracker config block ({ type, databaseId,
// ... }). Adapters are cached per (type + databaseId) so repeated calls within a
// tick reuse one instance (and its bot-identity cache). `transport` is injectable
// for tests; production uses each adapter's default transport.
function getTracker(trackerConfig, { log = console.log, transport, cache } = {}) {
  if (!trackerConfig || !trackerConfig.type) throw new Error('tracker config requires a type');
  const factory = REGISTRY[trackerConfig.type];
  if (!factory) throw new Error(`unknown tracker type: ${trackerConfig.type}`);
  const key = `${trackerConfig.type}:${trackerConfig.databaseId || `${trackerConfig.owner}/${trackerConfig.repo}/${trackerConfig.projectNumber || ''}`}`;
  if (cache && cache.has(key)) return cache.get(key);
  const tracker = factory({ ...trackerConfig, transport, log });
  if (cache) cache.set(key, tracker);
  return tracker;
}

function getProjectTracker(project, opts) {
  return getTracker(project.tracker, opts);
}

function getIncubatorTracker(config, opts) {
  if (!config.incubator?.databaseId && !config.incubator?.tracker) return null;
  const trackerConfig = config.incubator.tracker || { type: 'notion', databaseId: config.incubator.databaseId };
  return getTracker(trackerConfig, opts);
}

module.exports = { getTracker, getProjectTracker, getIncubatorTracker, REGISTRY };
