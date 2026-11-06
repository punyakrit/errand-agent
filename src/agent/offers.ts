import { buildCard } from "./approvals.ts";
import { cardText, formatPrice, formatSlot, optionsText } from "./format.ts";
import type { Outcome, Run } from "./run.ts";
import { searchForTask } from "./search.ts";
import type { Task } from "./tasks.ts";

export function voidOpenApprovals(run: Run, task: Task, reason: string): void {
  const open = run.deps.approvals.open(task.task_id);
  if (!open) return;
  run.deps.approvals.void(open.approval_id, reason);
  run.trace.emit("approval_voided", { approval_id: open.approval_id, reason });
}

// Creates an approval from stored records and shows the card. The model has
// no say in what the card contains.
export function askForApproval(run: Run, task: Task, preface = ""): Outcome | { error: string } {
  const card = buildCard(task, run.deps.clock.now());
  if ("error" in card) return card;
  voidOpenApprovals(run, task, "replaced_by_new_approval");
  const approval = run.deps.approvals.create(task, card);
  run.trace.emit("approval_created", { approval_id: approval.approval_id, fingerprint: approval.fingerprint, card });
  run.setState(task, "AWAITING_APPROVAL");
  const text = preface ? `${preface}\n\n${cardText(card)}` : cardText(card);
  return { reason: "awaiting_approval", text, approval: { approval_id: approval.approval_id, card } };
}

// Code offers fresh options itself, so recovery never waits on the model.
export async function offerAlternatives(run: Run, task: Task, why: string): Promise<Outcome> {
  delete task.details.hold;
  delete task.details.new_slot;
  run.deps.tasks.save(task);
  const found = await searchForTask(run, task);
  switch (found.kind) {
    case "options":
      return { reason: "action_result", text: `${why} Here are other options:\n${optionsText(found.options)}\nTell me which you would like.` };
    case "requested_provider_no_fit": {
      const others = found.others.length > 0 ? ` Other providers:\n${optionsText(found.others)}` : "";
      return { reason: "action_result", text: `${why} ${found.name} has nothing else that fits.${others}\nWhat would you like to do?` };
    }
    default:
      return { reason: "action_result", text: `${why} I found nothing else that fits your limits. Would you like to change them?` };
  }
}

// A hold ran out. Hold the same slot again, then ask again, even if nothing else
// changed: the old approval was for the old hold.
export async function reholdAndAsk(run: Run, task: Task, why: string): Promise<Outcome> {
  const old = task.details.hold!;
  run.setState(task, "HOLDING", { because: "rehold" });

  const held = await run.callMock("hold_slot", { provider_id: old.provider_id, slot: old.slot });
  if (!held.ok) return offerAlternatives(run, task, `${why} That slot is no longer available.`);

  task.details.hold = { ...old, hold_id: held.hold_id, price: held.price, expires_at: held.expires_at };
  run.deps.tasks.save(task);

  const budget = task.request.budget_inr;
  if (budget !== undefined && held.price > budget) {
    run.setState(task, "NEEDS_USER", { because: "held_price_over_budget" });
    return {
      reason: "action_result",
      text: `${why} The price for ${formatSlot(old.slot)} is now ${formatPrice(held.price)}, which is over your budget of ${formatPrice(budget)}. Nothing was booked. Would you like to raise the budget or choose something else?`,
    };
  }
  const change = held.price === old.price ? `The price is still ${formatPrice(held.price)}.` : `The price changed from ${formatPrice(old.price)} to ${formatPrice(held.price)}.`;
  const outcome = askForApproval(run, task, `${why} ${change}`);
  return "error" in outcome ? { reason: "internal_error" } : outcome;
}
