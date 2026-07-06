'use strict';

const fs = require('fs');
const path = require('path');

function stateDir(baseDir) {
  return path.join(baseDir, 'state');
}

function statePath(baseDir, name) {
  return path.join(stateDir(baseDir), `${name}.json`);
}

function readState(baseDir, name, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(statePath(baseDir, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeState(baseDir, name, value) {
  const dir = stateDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = statePath(baseDir, name);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    // Windows does not consistently replace an existing file with rename.
    if (process.platform !== 'win32' || !['EEXIST', 'EPERM'].includes(error.code)) throw error;
    fs.rmSync(target, { force: true });
    fs.renameSync(temp, target);
  }
  return target;
}

function removeState(baseDir, name) {
  try { fs.rmSync(statePath(baseDir, name), { force: true }); } catch {}
}

module.exports = { stateDir, statePath, readState, writeState, removeState };
