import type { World } from "./world.ts";

export type Facts = Record<string, unknown>;

function count(values: unknown[], match: (value: never) => boolean): number {
  return values.filter(match as (value: unknown) => boolean).length;
}

// What really happened, worked out from mock_calls and the trace. The eval
// table's "actual" column comes from here and is never typed by hand.
export function factsOf(world: World): Facts {
  const calls = world.mock.calls();
  const events = world.sink.events;
  const ofTool = (tool: string) => calls.filter((call) => call.tool === tool);
  const keys = (tool: string) => new Set(ofTool(tool).map((call) => String(call.args.idempotency_key))).size;
  const gate = (decision: string) => count(events, (event: { type: string; decision?: string }) => event.type === "gate_decision" && event.decision === decision);
  const ofType = (type: string) => events.filter((event) => event.type === type);
  const transitions = ofType("state_transition").filter((event) => !event.illegal);
  const newBookings = world.mock.allBookings().filter((booking) => booking.hold_id !== null);
  const asked = ofType("tool_call").filter((event) => event.name === "ask_user" && (event.result as { ok?: boolean } | undefined)?.ok);
  const reasons = ofType("run_end").map((event) => event.reason);

  return {
    book_calls: ofTool("book").length,
    book_outcomes: ofTool("book").map((call) => call.outcome),
    book_keys: keys("book"),
    new_bookings: newBookings.length,
    booked_price: newBookings.at(-1)?.price,
    booked_provider: newBookings.at(-1)?.provider_id,
    cancel_calls: ofTool("cancel").length,
    cancel_outcomes: ofTool("cancel").map((call) => call.outcome),
    cancel_keys: keys("cancel"),
    reschedule_calls: ofTool("reschedule").length,
    reschedule_outcomes: ofTool("reschedule").map((call) => call.outcome),
    reschedule_keys: keys("reschedule"),
    hold_calls: ofTool("hold_slot").length,
    status_checks: ofTool("get_booking_status").length,
    approvals_created: ofType("approval_created").length,
    approvals_granted: ofType("approval_granted").length,
    approvals_consumed: ofType("approval_consumed").length,
    approvals_voided: ofType("approval_voided").length,
    void_reasons: ofType("approval_voided").map((event) => event.reason),
    blocked_actions: gate("blocked"),
    blocked_holds: gate("hold_blocked"),
    reask_blocked: gate("reask_blocked"),
    memory_writes_blocked: gate("memory_write_blocked"),
    claims_blocked: gate("unverified_claim_blocked"),
    verified: gate("verified"),
    asked_fields: asked.map((event) => (event.args as { field: string }).field),
    questions: asked.length,
    limit_hits: ofType("limit_hit").map((event) => event.limit),
    finish_reasons: reasons,
    last_finish: reasons.at(-1),
    last_state: transitions.at(-1)?.to,
    open_ops: world.agent.deps.ops.open().length,
    model_calls: ofType("model_call").length,
    proactive_events: ofType("proactive_event").length,
  };
}
