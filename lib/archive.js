'use strict';

// Per-project clean-up pass. Closed tickets pile up in the Done/Cancelled columns
// of the board; once they have sat there long enough, archive their board card so
// the columns stay readable. Archiving removes the card from the project board but
// leaves the underlying issue (closed) intact. See lib/trackers/github.js
// archiveItem + the 'archive' outbox op in lib/sync.js.

const ARCHIVE_DEFAULTS = {
  enabled: true,
  // How long a ticket must have been closed before its card is archived.
  closedForMs: 24 * 60 * 60 * 1000,
};

// Only these terminal statuses are archived. `failed` is intentionally left on
// the board so failures stay visible for triage.
const ARCHIVABLE_STATUSES = ['done', 'cancelled'];

function archiveSettings(config, board) {
  return { ...ARCHIVE_DEFAULTS, ...(config.archive || {}), ...(board.archive || {}) };
}

// Flags qualifying tickets archived (idempotent via the local meta.archived flag)
// and enqueues a durable archive op for each. The tick loop's trailing
// flushOutbox delivers those to the tracker in the same pass.
async function runArchivePass({ config, board, store, log = () => {}, now = () => Date.now() } = {}) {
  const settings = archiveSettings(config, board);
  if (!settings.enabled) return { status: 'disabled' };
  // Archiving currently only means anything for GitHub Projects boards.
  if (board.tracker?.type !== 'github') return { status: 'unsupported_tracker' };

  const before = new Date(now() - settings.closedForMs).toISOString();
  const due = store.listArchivable({
    projectKey: board.key || board.app,
    statuses: ARCHIVABLE_STATUSES,
    before,
  });
  for (const ticket of due) store.archiveTicket(ticket.id);
  if (due.length) log(`archived ${due.length} closed ticket(s) off the board for ${board.key || board.app}`);
  return { status: 'ok', archived: due.length };
}

module.exports = { ARCHIVE_DEFAULTS, ARCHIVABLE_STATUSES, archiveSettings, runArchivePass };
