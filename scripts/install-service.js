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
const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
fs.mkdirSync(unitDir, { recursive: true });

// The runner loop (supervised, self-updating) and the read-only dashboard are
// two units grouped under one target so they start/stop/restart together.
const UNITS = ['ticket-runner.service', 'ticket-runner-dashboard.service', 'ticket-runner.target'];

function systemctl(args, { check = true } = {}) {
  try {
    execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
  } catch (error) {
    if (check) throw error;
  }
}

// Earlier versions enabled ticket-runner.service directly under default.target.
// Disable it first (best-effort) so re-enabling under the target doesn't leave a
// stale default.target.wants symlink pointing at the runner.
systemctl(['disable', 'ticket-runner.service'], { check: false });

for (const unit of UNITS) {
  fs.copyFileSync(path.join(root, unit), path.join(unitDir, unit));
}

systemctl(['daemon-reload']);
systemctl(['enable', ...UNITS]);
// Starting the target brings up both services; --now on enable would only cover
// the target itself, so restart it explicitly to (re)launch members too.
systemctl(['restart', 'ticket-runner.target']);

console.log('Installed ticket-runner.target (runner loop + dashboard).');
console.log('Control both:   systemctl --user {status,restart,stop} ticket-runner.target');
console.log('Dashboard logs: journalctl --user -u ticket-runner-dashboard.service -f');
console.log('Dashboard URL:  http://127.0.0.1:4600 (set DASHBOARD_HOST/DASHBOARD_PORT in the unit to change)');
