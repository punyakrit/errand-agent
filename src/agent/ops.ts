import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../clock.ts";
import { tx } from "../db.ts";
import type { Approval, ApprovalAction, ApprovalStore } from "./approvals.ts";

export type OpState = "started" | "completed" | "failed";

export interface OpArgs {
  hold_id?: string;
  hold_expires_at?: string;
  booking_id?: string;
  slot?: string;
}

export interface Op {
  op_id: string;
  approval_id: string;
  task_id: string;
  session_id: string;
  user_id: string;
  action: ApprovalAction;
  idempotency_key: string;
  args: OpArgs;
  state: OpState;
  result: string | null; // the message the user was given
}

interface OpRow extends Omit<Op, "args"> {
  args: string;
}

function fromRow(row: OpRow): Op {
  return { ...row, args: JSON.parse(row.args) };
}

// Built from the approval ID and action. The model never sees it.
export function idempotencyKey(approvalId: string, action: ApprovalAction): string {
  return `${action}:${approvalId}`;
}

export class OpStore {
  private db: DatabaseSync;
  private clock: Clock;

  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  // One transaction: the approval is used up and the intent is on disk before
  // any tool runs. Returns undefined if the approval was already used.
  consumeAndStart(approvals: ApprovalStore, approval: Approval, sessionId: string, args: OpArgs): Op | undefined {
    return tx(this.db, () => {
      if (!approvals.consume(approval.approval_id)) return undefined;
      const op: Op = {
        op_id: `op_${randomUUID().slice(0, 8)}`, approval_id: approval.approval_id, task_id: approval.task_id,
        session_id: sessionId, user_id: approval.user_id, action: approval.action,
        idempotency_key: idempotencyKey(approval.approval_id, approval.action), args, state: "started", result: null,
      };
      this.db.prepare(
        `INSERT INTO pending_ops (op_id, approval_id, task_id, session_id, user_id, action, idempotency_key, args, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'started', ?)`,
      ).run(op.op_id, op.approval_id, op.task_id, sessionId, op.user_id, op.action, op.idempotency_key, JSON.stringify(args), this.clock.now());
      return op;
    });
  }

  close(opId: string, state: "completed" | "failed", message: string): void {
    this.db.prepare("UPDATE pending_ops SET state = ?, result = ? WHERE op_id = ?").run(state, message, opId);
  }

  byApproval(approvalId: string): Op | undefined {
    const row = this.db.prepare("SELECT * FROM pending_ops WHERE approval_id = ?").get(approvalId) as OpRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  open(): Op[] {
    const rows = this.db.prepare("SELECT * FROM pending_ops WHERE state = 'started' ORDER BY created_at, rowid").all() as unknown as OpRow[];
    return rows.map(fromRow);
  }

  openForUser(userId: string): Op[] {
    return this.open().filter((op) => op.user_id === userId);
  }

  all(): Op[] {
    const rows = this.db.prepare("SELECT * FROM pending_ops ORDER BY created_at, rowid").all() as unknown as OpRow[];
    return rows.map(fromRow);
  }
}
