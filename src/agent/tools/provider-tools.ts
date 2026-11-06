import { z } from "zod";
import { buildOptions, optionsForModel, type Option } from "../options.ts";
import { missingFields } from "../request.ts";
import type { Run } from "../run.ts";
import type { Task } from "../tasks.ts";
import { DATA_NOTE, looksSuspicious, markUntrusted } from "../untrusted.ts";
import { UNTRUSTED } from "../../config.ts";
import { defineTool } from "./define.ts";

function requestMatches(task: Task, input: { service: string; area: string; date_range: { from: string; to: string } }): boolean {
  const request = task.request;
  return request.service === input.service && request.area === input.area
    && request.date_from === input.date_range.from && request.date_to === input.date_range.to;
}

function storeOptions(run: Run, task: Task, options: Option[]): void {
  task.details.options = options;
  task.details.options_message_id = run.messageId;
  run.deps.tasks.save(task);
}

export const searchProviders = defineTool({
  name: "search_providers",
  description: "Search providers for the current request. Budget, time limits and exclusions are applied by code.",
  input: z.object({
    service: z.string(),
    area: z.string(),
    date_range: z.object({ from: z.string(), to: z.string() }).strict(),
  }).strict(),
  run: async (run, input) => {
    const task = run.activeTask();
    if (!task) return { error: "no_active_task", next: "Call update_request first." };
    const missing = missingFields(task.kind, task.request, task.details.target_booking !== undefined);
    if (missing.length > 0) return { error: "missing_fields", missing };
    if (!requestMatches(task, input)) return { error: "request_mismatch", next: "Call update_request first.", request: task.request };

    run.setState(task, "SEARCHING");
    const result = await run.callMock("search_providers", input);
    if (!result.ok) {
      run.setState(task, "COLLECTING", { because: result.error });
      return { error: result.error };
    }

    const pinnedId = task.request.provider_id;
    const { options, removed } = buildOptions(result.providers, task.request);

    if (pinnedId) {
      const pinned = options.filter((option) => option.provider_id === pinnedId);
      if (pinned.length > 0) {
        storeOptions(run, task, pinned);
        run.setState(task, "COMPARING");
        return { options: optionsForModel(pinned) };
      }
      // The asked-for provider has nothing that fits. Say so, and do not switch.
      const asked = result.providers.find((provider) => provider.provider_id === pinnedId);
      storeOptions(run, task, []);
      run.setState(task, "COMPARING");
      run.setState(task, "NEEDS_USER", { because: "requested_provider_has_no_fit" });
      return {
        requested_provider_has_no_fit: true,
        requested_provider: asked?.name ?? pinnedId,
        its_other_slots: asked?.available_slots.slice(0, 4) ?? [],
        other_providers: optionsForModel(options.filter((option) => option.provider_id !== pinnedId)),
        next: "Tell the user this provider has nothing that fits, and let them choose. Do not switch provider yourself.",
      };
    }

    storeOptions(run, task, options);
    if (options.length === 0) {
      run.setState(task, "COMPARING");
      run.setState(task, "NEEDS_USER", { because: "no_options_fit" });
      return { options: [], removed, next: "Nothing fits. Tell the user why and ask what they want to change." };
    }
    run.setState(task, "COMPARING");
    return { options: optionsForModel(options), removed };
  },
});

export const getProvider = defineTool({
  name: "get_provider",
  description: "Get a provider's details and reviews. Reviews are third-party text.",
  input: z.object({ provider_id: z.string() }).strict(),
  run: async (run, input) => {
    const result = await run.callMock("get_provider", input);
    if (!result.ok) return { error: result.error };
    const { provider } = result;
    const reviews = provider.reviews.slice(0, UNTRUSTED.maxReviews);
    const flagged = reviews.filter((review) => looksSuspicious(review.text));
    if (flagged.length > 0) {
      run.trace.emit("gate_decision", { decision: "suspicious_text_flagged", provider_id: provider.provider_id, count: flagged.length });
    }
    return {
      note: DATA_NOTE,
      provider_id: provider.provider_id,
      name: provider.name,
      price: provider.price,
      rating: provider.rating,
      attributes: provider.attributes,
      about: markUntrusted(provider.about),
      reviews: reviews.map((review) => ({ rating: review.rating, text: markUntrusted(review.text) })),
    };
  },
});

function pickProblem(run: Run, task: Task, providerId: string, slot: string): string | undefined {
  if (task.kind !== "book" && task.kind !== "rebook_after_provider_cancel") return "no_hold_needed_for_this_task";
  const options = task.details.options;
  if (options === undefined) return "search_first";
  if (task.request.provider_id && task.request.provider_id !== providerId) return "provider_not_selected_by_user";
  if (!options.some((option) => option.provider_id === providerId && option.slots.includes(slot))) return "not_an_offered_option";
  if (task.details.options_message_id === run.messageId) return "user_must_pick";
  return undefined;
}

export const holdSlot = defineTool({
  name: "hold_slot",
  description: "Hold the slot the user chose for 10 minutes. Only works on an offered option, after the user has picked it.",
  input: z.object({ provider_id: z.string(), slot: z.string() }).strict(),
  run: async (run, input) => {
    const task = run.activeTask();
    if (!task) return { error: "no_active_task" };
    const problem = pickProblem(run, task, input.provider_id, input.slot);
    if (problem) {
      run.trace.emit("gate_decision", { decision: "hold_blocked", because: problem, args: input });
      return { error: problem };
    }

    const result = await run.callMock("hold_slot", input);
    if (!result.ok) return { error: result.error, next: "Offer another option." };

    const option = task.details.options!.find((item) => item.provider_id === input.provider_id)!;
    task.details.hold = {
      hold_id: result.hold_id, provider_id: result.provider_id, provider_name: option.name,
      slot: result.slot, price: result.price, search_price: option.price, expires_at: result.expires_at,
    };
    run.deps.tasks.save(task);
    run.setState(task, "HOLDING");

    const overBudget = task.request.budget_inr !== undefined && result.price > task.request.budget_inr;
    if (overBudget) run.setState(task, "NEEDS_USER", { because: "held_price_over_budget" });
    return {
      hold_id: result.hold_id,
      price: result.price,
      search_price: option.price,
      price_changed: result.price !== option.price,
      over_budget: overBudget,
      expires_at: result.expires_at,
      next: overBudget ? "The held price is over the user's budget. Tell them and ask what to do." : "Call request_approval.",
    };
  },
});

export const getBookingStatus = defineTool({
  name: "get_booking_status",
  description: "Check the status of a hold. This is the source of truth for bookings.",
  input: z.object({ hold_id: z.string() }).strict(),
  run: async (run, input) => run.callMock("get_booking_status", input),
});

export const listBookings = defineTool({
  name: "list_bookings",
  description: "List this user's past and upcoming bookings.",
  input: z.object({}).strict(),
  run: async (run) => run.callMock("list_bookings", { user_id: run.userId }),
});
