import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../clock.ts";

// Holds messages for a user who is not connected, until their next session.
export class Outbox {
  private db: DatabaseSync;
  private clock: Clock;

  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  add(userId: string, text: string): void {
    this.db.prepare("INSERT INTO outbox (user_id, text, at) VALUES (?, ?, ?)").run(userId, text, this.clock.now());
  }

  rewrite(userId: string, change: (text: string) => string): void {
    const rows = this.db.prepare("SELECT id, text FROM outbox WHERE user_id = ? AND delivered = 0").all(userId) as { id: number; text: string }[];
    for (const row of rows) this.db.prepare("UPDATE outbox SET text = ? WHERE id = ?").run(change(row.text), row.id);
  }

  // Returns undelivered messages and marks them delivered.
  drain(userId: string): string[] {
    const rows = this.db.prepare("SELECT id, text FROM outbox WHERE user_id = ? AND delivered = 0 ORDER BY id").all(userId) as { id: number; text: string }[];
    this.db.prepare("UPDATE outbox SET delivered = 1 WHERE user_id = ? AND delivered = 0").run(userId);
    return rows.map((row) => row.text);
  }
}
