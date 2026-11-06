import type { DatabaseSync } from "node:sqlite";

// The agent's own database, separate from the mock provider's.
export function createAgentSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      request TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      approval_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      card TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL, -- pending, granted, consumed, void
      void_reason TEXT,
      created_at INTEGER NOT NULL
    );
    -- Written before a side effect runs, so a crash can always be recovered.
    CREATE TABLE IF NOT EXISTS pending_ops (
      op_id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      args TEXT NOT NULL,
      state TEXT NOT NULL, -- started, completed, failed
      result TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      scope TEXT NOT NULL, -- global, or a service such as plumber
      kind TEXT NOT NULL, -- explicit, inferred
      confirmed INTEGER NOT NULL,
      status TEXT NOT NULL, -- active, superseded, forgotten
      source TEXT NOT NULL, -- the user's words, or booking:<id>
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- Messages for a user who is not connected right now.
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      at INTEGER NOT NULL
    );
  `);
}
