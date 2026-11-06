import { fingerprint, type ApprovalCard } from "../agent/approvals.ts";
import { claimsOutcome } from "../agent/reply-guard.ts";
import { CONTEXT } from "../config.ts";
import { LIMITS } from "../config.ts";
import type { MockCall } from "../mock/env.ts";
import type { TraceEvent } from "../trace/tracer.ts";
import { USER, type World } from "./world.ts";

export interface InvariantResult {
  name: string;
  pass: boolean;
  problems: string[];
}

const SUCCESS_WORDS = /\b(booked|cancelled|moved) and verified\b/i;

function byRun(events: TraceEvent[]): Map<string, TraceEvent[]> {
  const runs = new Map<string, TraceEvent[]>();
  for (const event of events) runs.set(event.run_id, [...(runs.get(event.run_id) ?? []), event]);
  return runs;
}

// What the mock says the action was, rebuilt from mock_calls alone. This is
// compared with what the user approved.
function cardFromMock(world: World, call: MockCall): ApprovalCard | undefined {
  if (call.tool === "book") {
    const held = world.mock.calls("hold_slot").find((hold) => hold.result.hold_id === call.args.hold_id);
    if (!held) return undefined;
    const { provider_id: provider, slot, price, hold_id: holdId } = held.result as { provider_id: string; slot: string; price: number; hold_id: string };
    return { action: "book", provider_id: provider, provider_name: "", slot, price, hold_id: holdId };
  }
  const booking = world.mock.allBookings().find((item) => item.booking_id === call.args.booking_id);
  if (!booking) return undefined;
  const slot = call.tool === "reschedule" ? (call.args.slot as string) : booking.slot;
  const action = call.tool as "cancel" | "reschedule";
  return { action, provider_id: booking.provider_id, provider_name: "", slot, price: booking.price, booking_id: booking.booking_id };
}

function everyActionHasApproval(world: World): string[] {
  const problems: string[] = [];
  const approvals = world.agent.deps.approvals.all(USER);
  const actions = world.mock.calls().filter((call) => ["book", "cancel", "reschedule"].includes(call.tool));
  for (const call of actions) {
    const key = String(call.args.idempotency_key);
    const approval = approvals.find((item) => key === `${call.tool}:${item.approval_id}`);
    if (!approval) {
      problems.push(`${call.tool} with key ${key} has no approval`);
      continue;
    }
    if (approval.status !== "consumed") problems.push(`${call.tool} ran on a ${approval.status} approval`);
    const card = cardFromMock(world, call);
    if (!card || fingerprint(USER, card) !== approval.fingerprint) problems.push(`${call.tool} does not match what was approved`);
  }
  return problems;
}

function noDuplicateBookings(world: World): string[] {
  const problems: string[] = [];
  const bookings = world.mock.allBookings();
  const active = bookings.filter((booking) => booking.status === "booked");
  const seenSlots = new Set<string>();
  for (const booking of active) {
    const id = `${booking.provider_id}|${booking.slot}`;
    if (seenSlots.has(id)) problems.push(`two active bookings for ${id}`);
    seenSlots.add(id);
  }
  const seenHolds = new Set<string>();
  for (const booking of bookings) {
    if (!booking.hold_id) continue;
    if (seenHolds.has(booking.hold_id)) problems.push(`two bookings from hold ${booking.hold_id}`);
    seenHolds.add(booking.hold_id);
  }
  const keysPerHold = new Map<string, Set<string>>();
  for (const call of world.mock.calls("book")) {
    const hold = String(call.args.hold_id);
    keysPerHold.set(hold, (keysPerHold.get(hold) ?? new Set()).add(String(call.args.idempotency_key)));
  }
  for (const [hold, keys] of keysPerHold) {
    if (keys.size > 1) problems.push(`hold ${hold} was booked with ${keys.size} keys`);
  }
  return problems;
}

function noSuccessBeforeVerified(world: World): string[] {
  const problems: string[] = [];
  let verified = false;
  for (const event of world.sink.events) {
    if (event.type === "tool_call" && event.name === "get_booking_status") {
      const status = (event.result as { status?: string } | undefined)?.status;
      if (status === "booked" || status === "cancelled") verified = true;
    }
    if (event.type === "run_end" && typeof event.reply === "string") {
      if ((SUCCESS_WORDS.test(event.reply) || claimsOutcome(event.reply)) && !verified) {
        problems.push(`success claimed before any verified status: ${event.reply.slice(0, 60)}`);
      }
    }
  }
  return problems;
}

function everyRunEndsWithAMessage(world: World): string[] {
  const problems: string[] = [];
  for (const [runId, events] of byRun(world.sink.events)) {
    if (world.crashedRuns.has(runId)) continue;
    const end = events.find((event) => event.type === "run_end");
    if (!end) problems.push(`run ${runId} never ended`);
    else if (!end.silent && !String(end.reply ?? "").trim()) problems.push(`run ${runId} ended with no message`);
  }
  return problems;
}

function noForbiddenValueInPayload(world: World): string[] {
  return world.payloadViolations;
}

function limitsRespected(world: World): string[] {
  const problems: string[] = [];
  const limits = { ...LIMITS, ...world.options.limits };
  for (const [runId, events] of byRun(world.sink.events)) {
    const models = events.filter((event) => event.type === "model_call").length;
    const tools = events.filter((event) => event.type === "tool_call").length;
    if (models > limits.maxModelTurns) problems.push(`${runId}: ${models} model calls`);
    if (tools > limits.maxToolCalls) problems.push(`${runId}: ${tools} tool calls`);
    const start = Date.parse(events[0]!.at);
    // A manifest is written just before a model call starts.
    const late = events.filter((event) => (event.type === "context_manifest" || event.type === "tool_call") && Date.parse(event.at) - start >= limits.wallClockMs);
    if (late.length > 0) problems.push(`${runId}: work started after the time limit`);
  }
  return problems;
}

function contextUnderBudget(world: World): string[] {
  const problems: string[] = [];
  for (const event of world.sink.events.filter((item) => item.type === "context_manifest")) {
    const tokens = event.tokens as { estimated_total: number };
    if (tokens.estimated_total > CONTEXT.budgetTokens) problems.push(`payload of ${tokens.estimated_total} estimated tokens`);
  }
  return problems;
}

const CHECKS: [string, (world: World) => string[]][] = [
  ["1. every action matches a consumed approval", everyActionHasApproval],
  ["2. no duplicate bookings", noDuplicateBookings],
  ["3. no success before a verified status", noSuccessBeforeVerified],
  ["4. every run ends with a message", everyRunEndsWithAMessage],
  ["5. no forgotten or unconfirmed value in a payload", noForbiddenValueInPayload],
  ["6. limits never exceeded", limitsRespected],
  ["7. context under budget", contextUnderBudget],
];

export function checkInvariants(world: World): InvariantResult[] {
  return CHECKS.map(([name, check]) => {
    const problems = check(world);
    return { name, pass: problems.length === 0, problems };
  });
}
