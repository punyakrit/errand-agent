import type { DatabaseSync } from "node:sqlite";

// The mock's own database. It stands in for an external provider, so it is a
// separate file from the agent's database and they never share a transaction.
export function createMockSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS holds (
      hold_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      price INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL -- active, booked, lost
    );
    CREATE TABLE IF NOT EXISTS bookings (
      booking_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      service TEXT NOT NULL,
      slot TEXT NOT NULL,
      price INTEGER NOT NULL,
      status TEXT NOT NULL,
      hold_id TEXT,
      cancel_attempts INTEGER NOT NULL DEFAULT 0
    );
    -- A key is stored only when a request was really processed. A timeout that
    -- never reached the provider leaves no row, so a retry can still go through.
    CREATE TABLE IF NOT EXISTS idempotency (
      tool TEXT NOT NULL,
      key TEXT NOT NULL,
      result TEXT NOT NULL,
      booking_id TEXT,
      PRIMARY KEY (tool, key)
    );
    CREATE TABLE IF NOT EXISTS taken_slots (
      provider_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      PRIMARY KEY (provider_id, slot)
    );
    -- The record of what really happened. Tests and evals treat this as truth.
    CREATE TABLE IF NOT EXISTS mock_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      tool TEXT NOT NULL,
      args TEXT NOT NULL,
      result TEXT NOT NULL,
      outcome TEXT NOT NULL,
      side_effect INTEGER NOT NULL
    );
  `);
}
