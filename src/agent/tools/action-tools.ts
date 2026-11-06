import { z } from "zod";
import { askForApproval } from "../offers.ts";
import type { Run } from "../run.ts";
import { defineTool } from "./define.ts";

// These three exist so a model that tries to act early, for example after a
// prompt injection, is stopped and traced. They never reach the provider.
// After a real approval, code runs the action through the executor instead.
function blocked(run: Run, action: string, args: object): object {
  run.trace.emit("gate_decision", { decision: "blocked", action, args, because: "approval_required" });
  return { error: "approval_required", next: "Call request_approval. Only the user can approve, on the approval card." };
}

export const book = defineTool({
  name: "book",
  description: "Always returns approval_required. Real bookings happen only after the user approves the card.",
  input: z.object({ hold_id: z.string() }).strict(),
  run: async (run, input) => blocked(run, "book", input),
});

export const cancel = defineTool({
  name: "cancel",
  description: "Always returns approval_required. Real cancellations happen only after the user approves the card.",
  input: z.object({ booking_id: z.string() }).strict(),
  run: async (run, input) => blocked(run, "cancel", input),
});

export const reschedule = defineTool({
  name: "reschedule",
  description: "Always returns approval_required. Real moves happen only after the user approves the card.",
  input: z.object({ booking_id: z.string(), slot: z.string() }).strict(),
  run: async (run, input) => blocked(run, "reschedule", input),
});

export const requestApproval = defineTool({
  name: "request_approval",
  description: "Show the user the approval card for the current task. The card is built by code from stored records.",
  input: z.object({}).strict(),
  run: async (run) => {
    const task = run.activeTask();
    if (!task) return { error: "no_active_task" };
    const outcome = askForApproval(run, task);
    if ("error" in outcome) {
      run.trace.emit("gate_decision", { decision: "approval_refused", because: outcome.error });
      return { error: outcome.error };
    }
    run.end = outcome;
    return { ok: true, shown_to_user: true };
  },
});
