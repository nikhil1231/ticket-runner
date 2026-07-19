'use strict';

const { createGithubTracker } = require('./github');

const REGISTRY = {
  github: createGithubTracker,
};

// Resolve a tracker adapter from a tracker config block. Adapters are cached per
// tracker endpoint so repeated calls within a
// tick reuse one instance (and its bot-identity cache). `transport` is injectable
// for tests; production uses each adapter's default transport.
function getTracker(trackerConfig, { log = console.log, transport, cache } = {}) {
  if (!trackerConfig || !trackerConfig.type) throw new Error('tracker config requires a type');
  const factory = REGISTRY[trackerConfig.type];
  if (!factory) throw new Error(`unknown tracker type: ${trackerConfig.type}`);
  const key = `${trackerConfig.type}:${trackerConfig.owner}/${trackerConfig.repo}/${trackerConfig.projectNumber || ''}`;
  if (cache && cache.has(key)) return cache.get(key);
  const tracker = factory({ ...trackerConfig, transport, log });
  if (cache) cache.set(key, tracker);
  return tracker;
}

function getProjectTracker(project, opts) {
  return getTracker(project.tracker, opts);
}

function getIncubatorTracker(config, opts) {
  return config.incubator?.tracker ? getTracker(config.incubator.tracker, opts) : null;
}

module.exports = { getTracker, getProjectTracker, getIncubatorTracker, REGISTRY };
