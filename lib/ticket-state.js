'use strict';

const fs = require('fs');
const path = require('path');

function metaPath(baseDir, shortId) {
  return path.join(baseDir, 'worktrees', `${shortId}.json`);
}

function readMeta(baseDir, shortId) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(baseDir, shortId), 'utf8'));
  } catch {
    return null;
  }
}

function writeMeta(baseDir, shortId, value) {
  const dir = path.join(baseDir, 'worktrees');
  fs.mkdirSync(dir, { recursive: true });
  const target = metaPath(baseDir, shortId);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    if (process.platform !== 'win32' || !['EEXIST', 'EPERM'].includes(error.code)) throw error;
    fs.rmSync(target, { force: true });
    fs.renameSync(temp, target);
  }
  return target;
}

function removeMeta(baseDir, shortId) {
  fs.rmSync(metaPath(baseDir, shortId), { force: true });
}

module.exports = { metaPath, readMeta, writeMeta, removeMeta };
