import { afterConflict, afterHoldExpired, afterSlotTaken, checkStatus, complete, finishBooked, runBook, runCancel, runReschedule, verifyMoved } from "./executor.ts";
import { formatSlot } from "./format.ts";
import type { Op } from "./ops.ts";
import type { Outcome, Run } from "./run.ts";

// Finishes one op left open by a crash or an unknown result. Every path is
// decided by the source of truth, never by what the agent remembers.
// Returns undefined if the source of truth still gives no answer.
export async function reconcileOp(run: Run, op: Op): Promise<Outcome | undefined> {
  const task = run.deps.tasks.get(op.task_id);
  if (!task) return undefined;

  const status = await checkStatus(run, op, { immediate: true });
  if (!status) return undefined;
  if (task.state === "EXECUTING" || task.state === "NEEDS_USER") run.setState(task, "VERIFYING", { because: "reconcile" });

  if (op.action === "book") {
    if (status.status === "booked") return finishBooked(run, task, op, status);
    if (status.status !== "not_booked") return undefined;
    if (status.reason === "slot_taken") return afterSlotTaken(run, task, op);
    if (run.deps.clock.now() >= Date.parse(op.args.hold_expires_at!)) return afterHoldExpired(run, task, op);
    run.setState(task, "EXECUTING", { because: "reconcile_retry_same_key" });
    return runBook(run, task, op);
  }

  if (op.action === "cancel") {
    if (status.status === "cancelled") {
      const name = task.details.target_booking?.provider_name ?? status.provider_id;
      return complete(run, task, op, status, `Cancelled and verified: ${name}, ${formatSlot(status.slot)}. Booking ID ${status.booking_id}.`);
    }
    run.setState(task, "EXECUTING", { because: "reconcile_retry_same_key" });
    return runCancel(run, task, op);
  }

  if (status.status === "booked") return verifyMoved(run, task, op);
  if (status.status === "not_booked" && status.reason === "slot_conflict") return afterConflict(run, task, op);
  run.setState(task, "EXECUTING", { because: "reconcile_retry_same_key" });
  return runReschedule(run, task, op);
}
