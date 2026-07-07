'use strict';

const fs = require('fs');
const path = require('path');

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function lockError(message) {
  const error = new Error(message);
  error.code = 'OPERATION_LOCKED';
  return error;
}

function acquire(baseDir) {
  const stateDir = path.join(baseDir, 'state');
  const lockDir = path.join(stateDir, 'operations.lock');
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')); } catch {}
    const ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
    if (owner?.host === require('os').hostname() && processExists(owner.pid)) {
      throw lockError(`runner operation lock is held by pid ${owner.pid}`);
    }
    if ((!owner && ageMs < 60_000) || (owner?.host !== require('os').hostname() && ageMs < 2 * 60 * 60 * 1000)) {
      throw lockError('runner operation lock exists and is not stale');
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir);
  }
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
    pid: process.pid,
    host: require('os').hostname(),
    acquiredAt: new Date().toISOString(),
  }));
  return () => fs.rmSync(lockDir, { recursive: true, force: true });
}

async function withOperationLock(baseDir, fn) {
  const release = acquire(baseDir);
  try {
    return await fn();
  } finally {
    release();
  }
}

module.exports = { acquire, withOperationLock, processExists, lockError };
