import { RECOVERY } from "../config.ts";
import type { BookResult, StatusResult } from "../mock/types.ts";
import { formatPrice, formatSlot } from "./format.ts";
import { offerAlternatives, reholdAndAsk } from "./offers.ts";
import type { Op } from "./ops.ts";
import type { Outcome, Run } from "./run.ts";
import type { Task } from "./tasks.ts";

export const UNCONFIRMED_MESSAGE =
  "I can't confirm whether this went through. I have not retried it, so it can't be done twice. Treat it as unconfirmed for now: I will check again and tell you the result.";

type KnownStatus = Extract<StatusResult, { ok: true }>;
type BookingStatusResult = Extract<KnownStatus, { booking_id: string }>;

// Asks the source of truth, with bounded backoff. Returns undefined if it never
// gives an answer. On a fake clock the waits are instant.
export async function checkStatus(run: Run, op: Op, options: { immediate: boolean }): Promise<KnownStatus | undefined> {
  const delays = options.immediate ? [0, ...RECOVERY.statusPollDelaysMs] : RECOVERY.statusPollDelaysMs;
  for (const delay of delays) {
    if (delay > 0) await run.deps.clock.sleep(delay);
    try {
      const status = await run.callMock("get_booking_status", { idempotency_key: op.idempotency_key, hold_id: op.args.hold_id });
      if (status.ok) return status;
    } catch {
      // No answer this time. Keep going until the delays run out.
    }
  }
  return undefined;
}

function holdStillValid(run: Run, op: Op): boolean {
  return run.deps.clock.now() < Date.parse(op.args.hold_expires_at!);
}

function closeFailed(run: Run, op: Op, outcome: Outcome): Outcome {
  run.deps.ops.close(op.op_id, "failed", outcome.text ?? "");
  return outcome;
}

function unconfirmed(run: Run, task: Task): Outcome {
  // The op stays 'started' on purpose. Reconcile picks it up later.
  run.setState(task, "NEEDS_USER", { because: "outcome_unconfirmed" });
  return { reason: "action_result", text: UNCONFIRMED_MESSAGE };
}

function complete(run: Run, task: Task, op: Op, status: BookingStatusResult, text: string): Outcome {
  run.trace.emit("gate_decision", { decision: "verified", action: op.action, status: status.status, booking_id: status.booking_id });
  task.details.result = {
    booking_id: status.booking_id, provider_name: task.details.hold?.provider_name ?? task.details.target_booking?.provider_name ?? status.provider_id,
    slot: status.slot, price: status.price, verified_status: status.status,
  };
  run.deps.tasks.save(task);
  run.deps.ops.close(op.op_id, "completed", text);
  run.setState(task, "DONE");
  return { reason: "action_result", text };
}

export function finishBooked(run: Run, task: Task, op: Op, status: BookingStatusResult): Outcome {
  const name = task.details.hold?.provider_name ?? status.provider_id;
  return complete(run, task, op, status, `Booked and verified: ${name}, ${formatSlot(status.slot)}, ${formatPrice(status.price)}. Booking ID ${status.booking_id}.`);
}

async function afterHoldExpired(run: Run, task: Task, op: Op): Promise<Outcome> {
  const outcome = await reholdAndAsk(run, task, "The hold expired before the booking went through.");
  return closeFailed(run, op, outcome);
}

async function afterSlotTaken(run: Run, task: Task, op: Op): Promise<Outcome> {
  const outcome = await offerAlternatives(run, task, "That slot was taken just before I could book it, so nothing was booked.");
  return closeFailed(run, op, outcome);
}

async function verifyBooked(run: Run, task: Task, op: Op): Promise<Outcome> {
  run.setState(task, "VERIFYING");
  const status = await checkStatus(run, op, { immediate: true });
  if (status?.status === "booked") return finishBooked(run, task, op, status);
  return unconfirmed(run, task);
}

async function callBook(run: Run, op: Op): Promise<BookResult> {
  try {
    return await run.callMock("book", { hold_id: op.args.hold_id!, idempotency_key: op.idempotency_key });
  } catch {
    // An unexpected failure tells us nothing about whether it booked, so it
    // is handled exactly like a timeout.
    return { ok: false, error: "timeout" };
  }
}

export async function runBook(run: Run, task: Task, op: Op): Promise<Outcome> {
  run.setState(task, "EXECUTING");
  await run.deps.checkpoint("op_started");

  for (let attempt = 0; attempt <= run.deps.limits.maxToolRetries; attempt++) {
    const result = await callBook(run, op);
    await run.deps.checkpoint("book_returned");

    if (result.ok) return verifyBooked(run, task, op);
    if (result.error === "slot_taken") return afterSlotTaken(run, task, op);
    if (result.error === "hold_expired") return afterHoldExpired(run, task, op);
    if (result.error !== "timeout") {
      run.setState(task, "NEEDS_USER", { because: result.error });
      return closeFailed(run, op, { reason: "action_result", text: `The booking failed (${result.error}). Nothing was booked.` });
    }

    // Timeout: never guess. Ask the source of truth first.
    run.setState(task, "VERIFYING", { because: "book_timeout" });
    const status = await checkStatus(run, op, { immediate: false });
    if (!status) return unconfirmed(run, task);
    if (status.status === "booked") return finishBooked(run, task, op, status);
    if (status.status !== "not_booked") return unconfirmed(run, task);
    if (!holdStillValid(run, op)) return afterHoldExpired(run, task, op);
    run.setState(task, "EXECUTING", { because: "retry_same_key" });
  }

  run.setState(task, "NEEDS_USER", { because: "book_retries_exhausted" });
  return closeFailed(run, op, {
    reason: "action_result",
    text: "The provider kept timing out, and I confirmed nothing was booked. Would you like me to try again?",
  });
}

export async function runCancel(run: Run, task: Task, op: Op): Promise<Outcome> {
  run.setState(task, "EXECUTING");
  await run.deps.checkpoint("op_started");

  const bookingId = op.args.booking_id!;
  const delays = [0, ...RECOVERY.cancelRetryDelaysMs];
  for (const delay of delays) {
    if (delay > 0) await run.deps.clock.sleep(delay);
    let result;
    try {
      result = await run.callMock("cancel", { booking_id: bookingId, idempotency_key: op.idempotency_key });
    } catch {
      continue;
    }
    await run.deps.checkpoint("book_returned");
    if (result.ok) {
      run.setState(task, "VERIFYING");
      const status = await checkStatus(run, op, { immediate: true });
      if (status?.status === "cancelled") {
        const name = task.details.target_booking?.provider_name ?? status.provider_id;
        return complete(run, task, op, status, `Cancelled and verified: ${name}, ${formatSlot(status.slot)}. Booking ID ${status.booking_id}.`);
      }
      return unconfirmed(run, task);
    }
    if (result.status !== 503) {
      run.setState(task, "FAILED", { because: result.error });
      return closeFailed(run, op, { reason: "action_result", text: `I could not cancel that booking (${result.error}).` });
    }
  }

  run.setState(task, "FAILED", { because: "cancel_retries_exhausted" });
  return closeFailed(run, op, {
    reason: "action_result",
    text: `I could not cancel booking ${bookingId}: the provider's service kept failing after ${delays.length} tries. As far as I can tell it is still active. Please try again later.`,
  });
}

async function afterConflict(run: Run, task: Task, op: Op): Promise<Outcome> {
  task.details.conflict_slots = [...(task.details.conflict_slots ?? []), op.args.slot!];
  const outcome = await offerAlternatives(run, task, "That slot conflicts with the provider's schedule, so the booking did not move.");
  return closeFailed(run, op, outcome);
}

export async function runReschedule(run: Run, task: Task, op: Op): Promise<Outcome> {
  run.setState(task, "EXECUTING");
  await run.deps.checkpoint("op_started");

  let result;
  try {
    result = await run.callMock("reschedule", { booking_id: op.args.booking_id!, slot: op.args.slot!, idempotency_key: op.idempotency_key });
  } catch {
    return unconfirmed(run, task);
  }
  await run.deps.checkpoint("book_returned");

  if (result.ok) return verifyMoved(run, task, op);
  if (result.error === "slot_conflict") return afterConflict(run, task, op);
  run.setState(task, "FAILED", { because: result.error });
  return closeFailed(run, op, { reason: "action_result", text: `I could not move that booking (${result.error}).` });
}

export async function verifyMoved(run: Run, task: Task, op: Op): Promise<Outcome> {
  run.setState(task, "VERIFYING");
  const status = await checkStatus(run, op, { immediate: true });
  if (status?.status === "booked" && status.slot === op.args.slot) {
    const name = task.details.target_booking?.provider_name ?? status.provider_id;
    return complete(run, task, op, status, `Moved and verified: ${name}, now ${formatSlot(status.slot)}. Booking ID ${status.booking_id}.`);
  }
  return unconfirmed(run, task);
}

export function runOp(run: Run, task: Task, op: Op): Promise<Outcome> {
  if (op.action === "book") return runBook(run, task, op);
  return op.action === "cancel" ? runCancel(run, task, op) : runReschedule(run, task, op);
}

export { afterConflict, afterHoldExpired, afterSlotTaken, complete, unconfirmed };
