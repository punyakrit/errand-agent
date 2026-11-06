import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../clock.ts";
import type { Task } from "./tasks.ts";

export type ApprovalAction = "book" | "cancel" | "reschedule";
export type ApprovalStatus = "pending" | "granted" | "consumed" | "void";

export interface ApprovalCard {
  action: ApprovalAction;
  provider_id: string;
  provider_name: string;
  slot: string;
  price: number;
  hold_id?: string;
  booking_id?: string;
  old_slot?: string;
  hold_expires_at?: string;
}

export interface Approval {
  approval_id: string;
  task_id: string;
  user_id: string;
  action: ApprovalAction;
  card: ApprovalCard;
  fingerprint: string;
  status: ApprovalStatus;
  void_reason: string | null;
}

// Object keys sorted at every level, so equal values always hash the same.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// The exact thing being approved. Any change to these details changes the hash.
export function fingerprint(userId: string, card: ApprovalCard): string {
  const material = {
    user: userId,
    action: card.action,
    provider: card.provider_id,
    slot: card.slot,
    price: card.price,
    ref: card.hold_id ?? card.booking_id,
  };
  return createHash("sha256").update(canonicalJson(material)).digest("hex");
}

// Builds the card from stored task records, or explains why it cannot.
export function buildCard(task: Task, now: number): ApprovalCard | { error: string } {
  const { hold, target_booking: target, new_slot: newSlot } = task.details;

  if (task.kind === "book" || task.kind === "rebook_after_provider_cancel") {
    if (!hold) return { error: "no_hold" };
    if (now >= Date.parse(hold.expires_at)) return { error: "hold_expired" };
    if (task.request.budget_inr !== undefined && hold.price > task.request.budget_inr) return { error: "over_budget" };
    return {
      action: "book", provider_id: hold.provider_id, provider_name: hold.provider_name,
      slot: hold.slot, price: hold.price, hold_id: hold.hold_id, hold_expires_at: hold.expires_at,
    };
  }

  if (!target) return { error: "no_target_booking" };
  const base = { provider_id: target.provider_id, provider_name: target.provider_name, price: target.price, booking_id: target.booking_id };
  if (task.kind === "cancel") return { ...base, action: "cancel", slot: target.slot };
  if (!newSlot) return { error: "no_new_slot" };
  return { ...base, action: "reschedule", slot: newSlot, old_slot: target.slot };
}

interface ApprovalRow extends Omit<Approval, "card"> {
  card: string;
}

function fromRow(row: ApprovalRow): Approval {
  return { ...row, card: JSON.parse(row.card) };
}

export class ApprovalStore {
  private db: DatabaseSync;
  private clock: Clock;

  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  create(task: Task, card: ApprovalCard): Approval {
    const approval: Approval = {
      approval_id: `appr_${randomUUID().slice(0, 8)}`, task_id: task.task_id, user_id: task.user_id,
      action: card.action, card, fingerprint: fingerprint(task.user_id, card), status: "pending", void_reason: null,
    };
    this.db.prepare(
      `INSERT INTO approvals (approval_id, task_id, user_id, action, card, fingerprint, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(approval.approval_id, approval.task_id, approval.user_id, approval.action, JSON.stringify(card), approval.fingerprint, this.clock.now());
    return approval;
  }

  get(approvalId: string): Approval | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId) as ApprovalRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  // The approval still waiting on the user for this task, if there is one.
  open(taskId: string): Approval | undefined {
    const row = this.db.prepare(
      "SELECT * FROM approvals WHERE task_id = ? AND status IN ('pending', 'granted') ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(taskId) as ApprovalRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  latestConsumed(userId: string): Approval | undefined {
    const row = this.db.prepare(
      "SELECT * FROM approvals WHERE user_id = ? AND status = 'consumed' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(userId) as ApprovalRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  all(userId: string): Approval[] {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE user_id = ? ORDER BY created_at, rowid").all(userId) as unknown as ApprovalRow[];
    return rows.map(fromRow);
  }

  grant(approvalId: string): void {
    this.db.prepare("UPDATE approvals SET status = 'granted' WHERE approval_id = ? AND status = 'pending'").run(approvalId);
  }

  void(approvalId: string, reason: string): void {
    this.db.prepare("UPDATE approvals SET status = 'void', void_reason = ? WHERE approval_id = ? AND status IN ('pending', 'granted')").run(reason, approvalId);
  }

  // Returns false if it was not granted, which is what makes approvals single use.
  consume(approvalId: string): boolean {
    const result = this.db.prepare("UPDATE approvals SET status = 'consumed' WHERE approval_id = ? AND status = 'granted'").run(approvalId);
    return result.changes === 1;
  }
}
