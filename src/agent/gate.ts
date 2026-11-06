import { buildCard, fingerprint, type Approval, type ApprovalCard } from "./approvals.ts";
import { runOp } from "./executor.ts";
import { askForApproval, reholdAndAsk, voidOpenApprovals } from "./offers.ts";
import type { OpArgs } from "./ops.ts";
import type { Outcome, Run } from "./run.ts";
import type { Task } from "./tasks.ts";
import { isPlainNo, isPlainYes } from "./yes-no.ts";

// Reads the current state of the booking being changed, so the fingerprint
// check compares against the source of truth, not an old copy.
async function refreshTarget(run: Run, task: Task): Promise<void> {
  const target = task.details.target_booking;
  if (!target) return;
  const listed = await run.callMock("list_bookings", { user_id: task.user_id });
  const current = listed.ok ? listed.bookings.find((booking) => booking.booking_id === target.booking_id) : undefined;
  if (current) {
    task.details.target_booking = current;
    run.deps.tasks.save(task);
  }
}

function opArgs(card: ApprovalCard): OpArgs {
  if (card.action === "book") return { hold_id: card.hold_id, hold_expires_at: card.hold_expires_at };
  return card.action === "cancel" ? { booking_id: card.booking_id } : { booking_id: card.booking_id, slot: card.slot };
}

const CHANGED_TEXT = "The details changed after that approval, so it no longer applies. Nothing was booked or changed.";

async function voidAndRecover(run: Run, task: Task, approval: Approval, reason: string): Promise<Outcome> {
  run.deps.approvals.void(approval.approval_id, reason);
  run.trace.emit("approval_voided", { approval_id: approval.approval_id, reason });
  run.trace.emit("gate_decision", { decision: "void", action: approval.action, because: reason });

  if (reason === "hold_expired") return reholdAndAsk(run, task, "The hold expired before you approved, so that approval no longer applies.");
  if (reason === "over_budget") {
    run.setState(task, "NEEDS_USER", { because: reason });
    return { reason: "action_result", text: "That price is now over your budget, so the approval no longer applies. Nothing was booked." };
  }
  if (reason === "booking_not_active") {
    run.setState(task, "FAILED", { because: reason });
    return { reason: "action_result", text: "That booking is no longer active, so I did nothing." };
  }
  // Something material changed. If there are new details, ask about those.
  const asked = askForApproval(run, task, CHANGED_TEXT);
  return "error" in asked ? { reason: "action_result", text: `${CHANGED_TEXT} Tell me how you would like to carry on.` } : asked;
}

// The last check before acting. Runs after approval is granted, and rebuilds
// the fingerprint from current records, so any change voids the approval.
export async function checkAndExecute(run: Run, approval: Approval): Promise<Outcome> {
  await run.deps.checkpoint("approval_granted");
  const task = run.deps.tasks.get(approval.task_id)!; // re-read: it may have changed
  await refreshTarget(run, task);

  if (task.details.target_booking && task.details.target_booking.status !== "booked") {
    return voidAndRecover(run, task, approval, "booking_not_active");
  }
  const card = buildCard(task, run.deps.clock.now());
  if ("error" in card) return voidAndRecover(run, task, approval, card.error);
  if (fingerprint(task.user_id, card) !== approval.fingerprint) return voidAndRecover(run, task, approval, "details_changed");

  const op = run.deps.ops.consumeAndStart(run.deps.approvals, approval, run.sessionId, opArgs(card));
  if (!op) return repeatedResult(run, approval);
  run.trace.emit("approval_consumed", { approval_id: approval.approval_id, fingerprint: approval.fingerprint, op_id: op.op_id });
  run.trace.emit("gate_decision", { decision: "allowed", action: approval.action, fingerprint: approval.fingerprint });
  return runOp(run, task, op);
}

// A yes after the approval was used. Returns what happened, with no tool call.
function repeatedResult(run: Run, approval: Approval): Outcome {
  run.trace.emit("gate_decision", { decision: "repeat_ignored", approval_id: approval.approval_id });
  const op = run.deps.ops.byApproval(approval.approval_id);
  const text = op?.result ?? "That is already being handled. I can't confirm the outcome yet, and I have not repeated it.";
  return { reason: "action_result", text };
}

function grant(run: Run, approval: Approval, via: string): void {
  run.deps.approvals.grant(approval.approval_id);
  run.trace.emit("approval_granted", { approval_id: approval.approval_id, via, fingerprint: approval.fingerprint });
}

function decline(run: Run, task: Task): Outcome {
  voidOpenApprovals(run, task, "user_declined");
  if (task.kind === "book" || task.kind === "rebook_after_provider_cancel") {
    delete task.details.hold;
    run.deps.tasks.save(task);
    run.setState(task, task.details.options?.length ? "COMPARING" : "COLLECTING", { because: "user_declined" });
  } else {
    run.setState(task, "FAILED", { because: "user_declined" });
  }
  return { reason: "action_result", text: "OK, I have dropped that. Nothing was booked or changed. Tell me what you would like instead." };
}

// The only place a chat message can become an approval. It reads the user's raw
// text, and only while a task is waiting. Returns undefined to let the model
// handle the message.
export async function handleApprovalReply(run: Run, text: string): Promise<Outcome | undefined> {
  const task = run.activeTask();
  const open = task?.state === "AWAITING_APPROVAL" ? run.deps.approvals.open(task.task_id) : undefined;

  if (task && open) {
    if (isPlainYes(text)) {
      grant(run, open, "chat");
      return checkAndExecute(run, open);
    }
    if (isPlainNo(text)) return decline(run, task);
    run.trace.emit("gate_decision", { decision: "not_a_plain_yes", approval_id: open.approval_id });
    return undefined;
  }

  return isPlainYes(text) ? repeatOfLastAction(run) : undefined;
}

// A yes counts as a repeat only if the action is still unresolved, or the last
// thing we said was its result. Otherwise it answers something else, so it
// goes to the model.
function repeatOfLastAction(run: Run): Outcome | undefined {
  const last = run.deps.approvals.latestConsumed(run.userId);
  if (!last) return undefined;
  const op = run.deps.ops.byApproval(last.approval_id);
  if (!op || op.state === "failed") return undefined;
  const stillOpen = op.state === "started";
  const justReported = run.deps.chat.lastAssistantText(run.userId) === op.result;
  return stillOpen || justReported ? repeatedResult(run, last) : undefined;
}

// The Approve button. Same rules as a chat yes, tied to one specific approval.
export async function handleApproveClick(run: Run, approvalId: string): Promise<Outcome> {
  const approval = run.deps.approvals.get(approvalId);
  if (!approval || approval.user_id !== run.userId) {
    run.trace.emit("gate_decision", { decision: "stale_approval_rejected", approval_id: approvalId, because: "unknown" });
    return { reason: "action_result", text: "I could not find that approval. Nothing was booked or changed." };
  }
  if (approval.status === "consumed") return repeatedResult(run, approval);
  if (approval.status === "void") {
    run.trace.emit("gate_decision", { decision: "stale_approval_rejected", approval_id: approvalId, because: approval.void_reason });
    return { reason: "action_result", text: "That approval is no longer valid because the details changed. Nothing was booked or changed." };
  }
  grant(run, approval, "button");
  return checkAndExecute(run, approval);
}
