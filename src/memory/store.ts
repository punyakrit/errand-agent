import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../clock.ts";
import { tx } from "../db.ts";

export type MemoryKind = "explicit" | "inferred";
export type MemoryStatus = "active" | "superseded" | "forgotten";

export interface Memory {
  id: number;
  user_id: string;
  key: string;
  value: string;
  scope: string;
  kind: MemoryKind;
  confirmed: boolean;
  status: MemoryStatus;
  source: string;
  created_at: number;
  updated_at: number;
}

type MemoryRow = Omit<Memory, "confirmed"> & { confirmed: number };

function fromRow(row: MemoryRow): Memory {
  return { ...row, confirmed: row.confirmed === 1 };
}

export const FORGOTTEN_MARK = "[forgotten]";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Matches the text as a whole word, ignoring case, so forgetting "AC" does not
// damage "ACME".
function wholeWord(text: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(text)}(?![\\p{L}\\p{N}])`, "giu");
}

export function scrubText(text: string, values: string[]): string {
  return values.reduce((result, value) => result.replace(wholeWord(value), FORGOTTEN_MARK), text);
}

export class MemoryStore {
  private db: DatabaseSync;
  private clock: Clock;

  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  all(userId: string): Memory[] {
    const rows = this.db.prepare("SELECT * FROM memories WHERE user_id = ? ORDER BY id").all(userId) as unknown as MemoryRow[];
    return rows.map(fromRow);
  }

  get(id: number): Memory | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  active(userId: string): Memory[] {
    return this.all(userId).filter((memory) => memory.status === "active");
  }

  // Facts that may be used: active, and either stated or confirmed by the user.
  usable(userId: string): Memory[] {
    return this.active(userId).filter((memory) => memory.kind === "explicit" || memory.confirmed);
  }

  private insert(memory: Pick<Memory, "user_id" | "key" | "value" | "scope" | "kind" | "confirmed" | "source">): number {
    const now = this.clock.now();
    const result = this.db.prepare(
      `INSERT INTO memories (user_id, key, value, scope, kind, confirmed, status, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(memory.user_id, memory.key, memory.value, memory.scope, memory.kind, memory.confirmed ? 1 : 0, memory.source, now, now);
    return Number(result.lastInsertRowid);
  }

  private findActive(userId: string, key: string, scope: string): Memory | undefined {
    const row = this.db.prepare(
      "SELECT * FROM memories WHERE user_id = ? AND key = ? AND scope = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
    ).get(userId, key, scope) as MemoryRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  // A fact the user stated. An old value is kept as superseded, not overwritten.
  remember(userId: string, key: string, value: string, scope: string, evidence: string): number {
    return tx(this.db, () => {
      const existing = this.findActive(userId, key, scope);
      if (existing && existing.value.toLowerCase() === value.toLowerCase()) {
        // The user just confirmed something we inferred or already knew.
        this.db.prepare("UPDATE memories SET confirmed = 1, updated_at = ? WHERE id = ?").run(this.clock.now(), existing.id);
        return existing.id;
      }
      if (existing) this.setStatus(existing.id, "superseded");
      return this.insert({ user_id: userId, key, value, scope, kind: "explicit", confirmed: true, source: evidence });
    });
  }

  private setStatus(id: number, status: MemoryStatus): void {
    this.db.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?").run(status, this.clock.now(), id);
  }

  // A fact code worked out. It stays unconfirmed, and it is not created again
  // if the user already forgot it or a stated fact covers it.
  infer(userId: string, key: string, value: string, scope: string, source: string): number | undefined {
    const rows = this.all(userId).filter((memory) => memory.key === key && memory.scope === scope);
    const forgotten = rows.some((memory) => memory.status === "forgotten");
    const covered = rows.some((memory) => memory.status === "active" && (memory.kind === "explicit" || memory.value === value));
    if (forgotten || covered) return undefined;
    for (const memory of rows.filter((item) => item.status === "active")) this.setStatus(memory.id, "superseded");
    return this.insert({ user_id: userId, key, value, scope, kind: "inferred", confirmed: false, source });
  }

  confirm(userId: string, id: number): boolean {
    const result = this.db.prepare(
      "UPDATE memories SET confirmed = 1, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'active'",
    ).run(this.clock.now(), id, userId);
    return result.changes === 1;
  }

  // Blanks every row for this key and leaves a tombstone. Returns the texts that
  // must also go from chat history: the values, and the words they came from.
  forget(userId: string, key: string, scope?: string): string[] {
    return tx(this.db, () => {
      const rows = this.all(userId).filter((memory) => memory.key === key && (!scope || memory.scope === scope) && memory.status !== "forgotten");
      const texts = new Set<string>();
      for (const memory of rows) {
        texts.add(memory.value);
        if (memory.kind === "explicit") texts.add(memory.source);
        this.db.prepare("UPDATE memories SET value = '', source = 'forgotten', status = 'forgotten', updated_at = ? WHERE id = ?")
          .run(this.clock.now(), memory.id);
      }
      return [...texts].filter((text) => text.length > 0).sort((a, b) => b.length - a.length);
    });
  }
}
