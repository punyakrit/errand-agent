import { z } from "zod";
import type { BookingView } from "../../mock/types.ts";
import { applyMemoryDefaults } from "../../memory/defaults.ts";
import { voidOpenApprovals } from "../offers.ts";
import { ASK_FIELDS, fieldValue, findInvalidField, mergeRequest, missingFields, RequestUpdate } from "../request.ts";
import type { Run } from "../run.ts";
import type { Task, TaskKind } from "../tasks.ts";
import { defineTool } from "./define.ts";

const UpdateInput = RequestUpdate.extend({
  kind: z.enum(["book", "reschedule", "cancel"]).optional().describe("Omit to keep the current task"),
  target_booking_id: z.string().optional().describe("The booking to move or cancel"),
  new_slot: z.string().optional().describe("For a move: the slot the user chose"),
}).strict();

// Fields that change what was searched for, so old options no longer apply.
const BUDGET_FIELDS = ["budget_inr", "any_budget"];

function withinBudget(task: Task): boolean {
  const hold = task.details.hold;
  return hold !== undefined && (task.request.budget_inr === undefined || hold.price <= task.request.budget_inr);
}

// Old options, holds and approvals were for the old request, so they are dropped.
function resetSearch(run: Run, task: Task, changed: string[]): void {
  voidOpenApprovals(run, task, "request_changed");
  delete task.details.options;
  delete task.details.options_message_id;
  delete task.details.hold;
  delete task.details.new_slot;
  run.setState(task, "COLLECTING", { because: "request_changed", changed });
}

async function upcomingBookings(run: Run, service: string | undefined): Promise<BookingView[]> {
  const result = await run.callMock("list_bookings", { user_id: run.userId });
  if (!result.ok) return [];
  return result.bookings.filter((b) => b.status === "booked" && (!service || b.service === service));
}

// Works out which booking a move or cancellation means, or that it is unclear.
async function resolveTarget(run: Run, task: Task, targetId: string | undefined): Promise<object | undefined> {
  const upcoming = await upcomingBookings(run, targetId ? undefined : task.request.service);
  const matches = targetId ? upcoming.filter((b) => b.booking_id === targetId) : upcoming;
  if (matches.length === 0) return { error: "no_matching_booking" };
  if (matches.length > 1) {
    task.details.matching_bookings = matches;
    run.deps.tasks.save(task);
    run.setState(task, "NEEDS_USER", { because: "ambiguous_booking" });
    return { error: "ambiguous_booking", matching_bookings: matches, next: "Ask the user which one." };
  }

  const target = matches[0]!;
  task.details.target_booking = target;
  delete task.details.matching_bookings;
  task.request.service = target.service;
  const provider = await run.callMock("get_provider", { provider_id: target.provider_id });
  if (provider.ok) task.request.area = provider.provider.areas[0];
  task.request.provider_id = target.provider_id;
  run.deps.tasks.save(task);
  return undefined;
}

export const updateRequest = defineTool({
  name: "update_request",
  description:
    "Record what the user wants. Send only fields the user gave or corrected. Returns the merged request and what is still missing.",
  input: UpdateInput,
  run: async (run, input) => {
    const { kind, target_booking_id: targetId, new_slot: newSlot, ...update } = input;
    const invalid = findInvalidField(update);
    if (invalid) return { error: "invalid_field", field: invalid };

    let task = run.activeTask();
    const sameKind = task?.kind === kind || (task?.kind === "rebook_after_provider_cancel" && kind === "book");
    if (task && kind && !sameKind) {
      voidOpenApprovals(run, task, "task_replaced");
      run.setState(task, "FAILED", { because: "replaced_by_new_request" });
      task = undefined;
    }
    task ??= run.deps.tasks.create(run.sessionId, run.userId, (kind ?? "book") as TaskKind);

    const { merged, changed } = mergeRequest(task.request, update);
    const { request, filled } = applyMemoryDefaults(merged, run.deps.memory.usable(run.userId));
    task.request = request;
    run.deps.tasks.save(task);

    const hadSearch = task.details.options !== undefined || task.details.hold !== undefined;
    const onlyBudget = changed.every((field) => BUDGET_FIELDS.includes(field));
    const keepHold = onlyBudget && withinBudget(task);
    if (hadSearch && changed.length > 0 && changed.some((f) => f !== "notes") && !keepHold) {
      resetSearch(run, task, changed);
    }

    if ((kind === "reschedule" || kind === "cancel" || task.kind === "reschedule" || task.kind === "cancel")
      && (targetId || !task.details.target_booking)) {
      const problem = await resolveTarget(run, task, targetId);
      if (problem) return problem;
    }

    if (newSlot) {
      if (task.kind !== "reschedule") return { error: "new_slot_is_for_reschedule_only" };
      const offered = task.details.options?.some((option) => option.slots.includes(newSlot));
      if (!offered) return { error: "not_an_offered_option" };
      if (task.details.options_message_id === run.messageId) return { error: "user_must_pick" };
      if (task.details.new_slot !== newSlot) voidOpenApprovals(run, task, "new_slot_changed");
      task.details.new_slot = newSlot;
      run.deps.tasks.save(task);
      if (task.state === "AWAITING_APPROVAL") run.setState(task, "COMPARING", { because: "new_slot_changed" });
    }

    return {
      task_id: task.task_id,
      kind: task.kind,
      state: task.state,
      request: task.request,
      filled_from_memory: filled,
      target_booking: task.details.target_booking,
      new_slot: task.details.new_slot,
      missing: missingFields(task.kind, task.request, task.details.target_booking !== undefined),
    };
  },
});

export const askUser = defineTool({
  name: "ask_user",
  description: "Ask the user for one missing detail. Code refuses a question about something already known.",
  input: z.object({
    field: z.enum(ASK_FIELDS),
    question: z.string().describe("The question, in plain words"),
  }).strict(),
  run: async (run, input) => {
    const task = run.activeTask();
    const known = task ? fieldValue(input.field, task.request) : undefined;
    if (known !== undefined) {
      run.trace.emit("gate_decision", { decision: "reask_blocked", field: input.field, question: input.question });
      return { error: "already_known", field: input.field, value: known };
    }
    run.questions.push(input.question);
    run.end = { reason: "asked_user" };
    return { ok: true, asked: input.field };
  },
});
