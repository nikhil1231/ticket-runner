'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// All schema lives here as an ordered list of migration steps applied under
// PRAGMA user_version. To evolve the schema, append a new SQL string; never edit
// an existing one. The store is the source of truth for ticket state, so this
// file is the only place that touches the raw database.
const MIGRATIONS = [
  // 1: initial schema
  `
  CREATE TABLE tickets (
    id                     INTEGER PRIMARY KEY,
    short_id               TEXT NOT NULL UNIQUE,
    project_key            TEXT NOT NULL,
    kind                   TEXT NOT NULL DEFAULT 'feature',
    parent_id              INTEGER REFERENCES tickets(id),
    title                  TEXT NOT NULL,
    body                   TEXT NOT NULL DEFAULT '',
    status                 TEXT NOT NULL,
    attempts               INTEGER NOT NULL DEFAULT 0,
    review_rounds          INTEGER NOT NULL DEFAULT 0,
    review_feedback        TEXT NOT NULL DEFAULT '',
    engine_pin             TEXT NOT NULL DEFAULT '',
    model_pin              TEXT NOT NULL DEFAULT '',
    last_agent             TEXT NOT NULL DEFAULT '',
    repo_path              TEXT,
    branch                 TEXT,
    worktree_dir           TEXT,
    base_sha               TEXT,
    head_sha               TEXT,
    changed_files          TEXT NOT NULL DEFAULT '[]',
    native_sensitive_files TEXT NOT NULL DEFAULT '[]',
    implemented_at         TEXT,
    tracker                TEXT NOT NULL,
    tracker_id             TEXT,
    tracker_meta           TEXT NOT NULL DEFAULT '{}',
    mirror_hash            TEXT,
    mirror_synced_at       TEXT,
    mirrored_status        TEXT,
    processed_comment_ids  TEXT NOT NULL DEFAULT '[]',
    pending_comment_ids    TEXT NOT NULL DEFAULT '[]',
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    closed_at              TEXT,
    meta                   TEXT NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX tickets_tracker ON tickets(tracker, tracker_id);
  CREATE INDEX tickets_claim   ON tickets(status, created_at);
  CREATE INDEX tickets_project ON tickets(project_key, status);
  CREATE INDEX tickets_parent  ON tickets(parent_id);

  CREATE TABLE ticket_dependencies (
    ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    depends_on_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    dep_type      TEXT NOT NULL DEFAULT 'blocks',
    created_at    TEXT NOT NULL,
    PRIMARY KEY (ticket_id, depends_on_id),
    CHECK (ticket_id <> depends_on_id)
  );

  CREATE TABLE ticket_events (
    id          INTEGER PRIMARY KEY,
    ticket_id   INTEGER REFERENCES tickets(id),
    type        TEXT NOT NULL,
    from_status TEXT,
    to_status   TEXT,
    payload     TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL
  );
  CREATE INDEX events_ticket ON ticket_events(ticket_id, id);

  CREATE TABLE outbox (
    id              INTEGER PRIMARY KEY,
    ticket_id       INTEGER REFERENCES tickets(id),
    op              TEXT NOT NULL,
    payload         TEXT NOT NULL DEFAULT '{}',
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error      TEXT,
    created_at      TEXT NOT NULL,
    done_at         TEXT
  );
  CREATE UNIQUE INDEX outbox_mirror_coalesce ON outbox(ticket_id, op) WHERE op = 'mirror' AND done_at IS NULL;
  CREATE INDEX outbox_due ON outbox(next_attempt_at) WHERE done_at IS NULL;

  CREATE TABLE stacks (
    project_key   TEXT PRIMARY KEY,
    status        TEXT NOT NULL,
    base_sha      TEXT,
    composite_sha TEXT,
    branch        TEXT,
    fingerprint   TEXT,
    tickets       TEXT NOT NULL DEFAULT '[]',
    publisher     TEXT,
    deployed_at   TEXT
  );

  CREATE TABLE repairs (
    fingerprint TEXT PRIMARY KEY,
    count       INTEGER NOT NULL DEFAULT 0,
    last_status TEXT,
    last_at     TEXT,
    meta        TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE kv (
    name       TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // 2: durable review history + a requeue-cycle counter. Rounds within one
  // implementation attempt already lived in review_rounds/review_feedback, but
  // both got wiped exactly when a ticket parked for a human (max rounds reached,
  // or evicted from the cumulative testing stack by a merge conflict) - so a
  // ticket that bounced back to implementation had no memory of what reviewers
  // had already found, and could cycle through the same handful of defects
  // indefinitely. review_history accumulates every distinct finding for the
  // life of the ticket; requeue_count counts real do-overs (queued again after
  // having already been implemented at least once) so the loop is visible.
  `
  ALTER TABLE tickets ADD COLUMN review_history TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE tickets ADD COLUMN requeue_count   INTEGER NOT NULL DEFAULT 0;
  `,
];

function dbPath(baseDir) {
  return path.join(baseDir, 'state', 'runner.db');
}

// Opens (creating if needed) the runner database and applies any pending
// migrations. WAL mode allows read-only subcommands (stack, db status) to run
// while the loop holds the write connection; cross-process write exclusion is
// still handled by the operation lock. Pass ':memory:' for tests.
function openDb(baseDir, { file } = {}) {
  const target = file || (baseDir === ':memory:' ? ':memory:' : dbPath(baseDir));
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function closeDb(db) {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
  try { db.close(); } catch {}
}

module.exports = { openDb, closeDb, dbPath, MIGRATIONS };
