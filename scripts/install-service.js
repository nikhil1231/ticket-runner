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

// Install each unit as a symlink into the user unit dir so `git pull` refreshes
// the running definitions in place. Idempotent: replace any existing entry.
for (const unit of UNITS) {
  const dest = path.join(unitDir, unit);
  fs.rmSync(dest, { force: true });
  fs.symlinkSync(path.join(root, unit), dest);
}

// Older installs enabled ticket-runner.service directly under default.target.
// Remove that stale want by hand rather than via `systemctl disable`, which on a
// symlink-installed unit would also delete the unit file symlink itself.
fs.rmSync(path.join(unitDir, 'default.target.wants', 'ticket-runner.service'), { force: true });

systemctl(['daemon-reload']);
// Enable the target for boot, then group both services under it.
systemctl(['enable', 'ticket-runner.target']);
systemctl(['add-wants', 'ticket-runner.target', 'ticket-runner.service', 'ticket-runner-dashboard.service']);
// Starting the target brings up both members; restart to pick up unit changes.
systemctl(['restart', 'ticket-runner.target']);

console.log('Installed ticket-runner.target (runner loop + dashboard).');
console.log('Control both:   systemctl --user {status,restart,stop} ticket-runner.target');
console.log('Dashboard logs: journalctl --user -u ticket-runner-dashboard.service -f');
console.log('Dashboard URL:  http://127.0.0.1:4600 (set DASHBOARD_HOST/DASHBOARD_PORT in the unit to change)');
