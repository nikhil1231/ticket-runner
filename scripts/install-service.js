'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform === 'win32') {
  console.error('The bundled service installer targets the Linux systemd host.');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'ticket-runner.service');
const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
const target = path.join(unitDir, 'ticket-runner.service');
fs.mkdirSync(unitDir, { recursive: true });
fs.copyFileSync(source, target);
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', 'ticket-runner.service'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'restart', 'ticket-runner.service'], { stdio: 'inherit' });
console.log(`Installed ${target} with the guarded supervisor entrypoint.`);
