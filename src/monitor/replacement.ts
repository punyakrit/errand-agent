import { addDays } from "../clock.ts";
import type { BookingView } from "../mock/types.ts";
import { applyMemoryDefaults } from "../memory/defaults.ts";
import { formatSlot, optionsText } from "../agent/format.ts";
import type { RequestFields } from "../agent/request.ts";
import type { Outcome, Run } from "../agent/run.ts";
import { searchForTask } from "../agent/search.ts";
import type { Task } from "../agent/tasks.ts";

const SEARCH_DAYS = 3;

// The replacement request: same service and day, within what we know the user
// wants, and never the provider that just cancelled.
async function replacementRequest(run: Run, booking: BookingView): Promise<RequestFields> {
  const date = booking.slot.slice(0, 10);
  const provider = await run.callMock("get_provider", { provider_id: booking.provider_id });
  const known: RequestFields = {
    service: booking.service,
    date_from: date,
    date_to: addDays(date, SEARCH_DAYS),
    exclude_provider_ids: [booking.provider_id],
  };
  const { request } = applyMemoryDefaults(known, run.deps.memory.usable(run.userId));
  request.area ??= provider.ok ? provider.provider.areas[0] : undefined;
  if (!request.time_from) request.any_time = true;
  if (request.budget_inr === undefined) request.any_budget = true;
  return request;
}

export function createRebookTask(run: Run, booking: BookingView): Task {
  const task = run.deps.tasks.create(run.sessionId, run.userId, "rebook_after_provider_cancel");
  task.details.cancelled_booking_id = booking.booking_id;
  run.deps.tasks.save(task);
  return task;
}

// Tells the user and offers options. It stops there: booking still needs the
// user to pick, a new hold and a fresh approval, like any other booking.
export async function offerReplacement(run: Run, task: Task, booking: BookingView): Promise<Outcome> {
  task.request = await replacementRequest(run, booking);
  run.deps.tasks.save(task);

  const lead = `${booking.provider_name} cancelled your ${booking.service.replace("_", " ")} booking on ${formatSlot(booking.slot)}.`;
  const found = await searchForTask(run, task);
  if (found.kind === "options") {
    return {
      reason: "action_result",
      text: `${lead} Here are replacements that fit your preferences:\n${optionsText(found.options)}\nTell me which you would like, and I will ask you to approve it first. Nothing has been booked.`,
    };
  }
  return {
    reason: "action_result",
    text: `${lead} I could not find a replacement that fits your preferences in the next few days. Nothing has been booked. Tell me if you would like to change your limits or dates.`,
  };
}
