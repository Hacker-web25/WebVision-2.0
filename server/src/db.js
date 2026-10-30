import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS trips (
      id          TEXT PRIMARY KEY,
      edit_hash   TEXT NOT NULL,
      plan_json   TEXT NOT NULL,
      people_json TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trips_expiry ON trips(expires_at);
    CREATE TABLE IF NOT EXISTS batches (
      id           TEXT PRIMARY KEY,
      email_enc    TEXT,
      email_hash   TEXT NOT NULL,
      confirm_hash TEXT NOT NULL,
      unsub_hash   TEXT NOT NULL,
      confirmed_at INTEGER,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS batches_email ON batches(email_hash);
    CREATE TABLE IF NOT EXISTS reminders (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id   TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      due_at     INTEGER NOT NULL,
      payload    TEXT NOT NULL,
      sent_at    INTEGER,
      attempts   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS reminders_due ON reminders(due_at) WHERE sent_at IS NULL;
    CREATE TABLE IF NOT EXISTS outbox (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      to_addr    TEXT NOT NULL,
      subject    TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}
