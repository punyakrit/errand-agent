import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../clock.ts";

export interface ChatMessage {
  id: number;
  session_id: string;
  user_id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
}

export class ChatStore {
  private db: DatabaseSync;
  private clock: Clock;

  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  add(sessionId: string, userId: string, role: ChatMessage["role"], text: string): number {
    const result = this.db.prepare("INSERT INTO messages (session_id, user_id, role, text, at) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, userId, role, text, this.clock.now());
    return Number(result.lastInsertRowid);
  }

  // All of a user's messages across sessions, oldest first.
  history(userId: string): ChatMessage[] {
    return this.db.prepare("SELECT * FROM messages WHERE user_id = ? ORDER BY id").all(userId) as unknown as ChatMessage[];
  }

  lastAssistantText(userId: string): string | undefined {
    const row = this.db.prepare("SELECT text FROM messages WHERE user_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1").get(userId) as { text: string } | undefined;
    return row?.text;
  }

  userMessagesInSession(sessionId: string): string[] {
    const rows = this.db.prepare("SELECT text FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id").all(sessionId) as { text: string }[];
    return rows.map((row) => row.text);
  }
}
