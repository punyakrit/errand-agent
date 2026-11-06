import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../clock.ts";
import type { BookingView } from "../mock/types.ts";
import type { Option } from "./options.ts";
import type { RequestFields } from "./request.ts";
import type { State } from "./state.ts";
import { TERMINAL_STATES } from "./state.ts";

export type TaskKind = "book" | "reschedule" | "cancel" | "rebook_after_provider_cancel";

export interface HoldRecord {
  hold_id: string;
  provider_id: string;
  provider_name: string;
  slot: string;
  price: number;
  search_price: number;
  expires_at: string;
}

// Everything code has learned while working on a task.
export interface TaskDetails {
  options?: Option[];
  options_message_id?: number; // the user message the options were found in
  hold?: HoldRecord;
  target_booking?: BookingView;
  matching_bookings?: BookingView[];
  new_slot?: string;
  cancelled_booking_id?: string; // for rebook: the booking the provider cancelled
  result?: { booking_id: string; provider_name: string; slot: string; price: number; verified_status: string };
}

export interface Task {
  task_id: string;
  session_id: string;
  user_id: string;
  kind: TaskKind;
  state: State;
  request: RequestFields;
  details: TaskDetails;
}

interface TaskRow {
  task_id: string; session_id: string; user_id: string; kind: TaskKind; state: State; request: string; details: string;
}

function fromRow(row: TaskRow): Task {
  return { ...row, request: JSON.parse(row.request), details: JSON.parse(row.details) };
}

export class TaskStore {
  private db: DatabaseSync;
  private clock: Clock;

  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  create(sessionId: string, userId: string, kind: TaskKind, request: RequestFields = {}): Task {
    const task: Task = { task_id: `task_${randomUUID().slice(0, 8)}`, session_id: sessionId, user_id: userId, kind, state: "COLLECTING", request, details: {} };
    const now = this.clock.now();
    this.db.prepare(
      `INSERT INTO tasks (task_id, session_id, user_id, kind, state, request, details, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(task.task_id, sessionId, userId, kind, task.state, JSON.stringify(request), "{}", now, now);
    return task;
  }

  save(task: Task): void {
    this.db.prepare("UPDATE tasks SET state = ?, request = ?, details = ?, updated_at = ? WHERE task_id = ?")
      .run(task.state, JSON.stringify(task.request), JSON.stringify(task.details), this.clock.now(), task.task_id);
  }

  get(taskId: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as TaskRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  // The user's newest unfinished task. Tasks belong to the user, not the
  // session, so a task keeps going in a later session.
  active(userId: string): Task | undefined {
    const terminal = TERMINAL_STATES.map((state) => `'${state}'`).join(", ");
    const row = this.db.prepare(
      `SELECT * FROM tasks WHERE user_id = ? AND state NOT IN (${terminal}) ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(userId) as TaskRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  all(userId: string): Task[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at, rowid").all(userId) as unknown as TaskRow[];
    return rows.map(fromRow);
  }
}
