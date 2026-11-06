import { OPTIONS } from "../config.ts";
import type { ProviderSummary } from "../mock/types.ts";
import type { RequestFields } from "./request.ts";

export interface Option {
  provider_id: string;
  name: string;
  price: number;
  rating: number;
  slots: string[]; // every slot that fits, not just the ones shown to the model
  offered_in_message?: number; // the user message this option was first found in
}

function slotFitsTime(slot: string, request: RequestFields): boolean {
  const time = slot.slice(11, 16);
  if (request.time_from && time < request.time_from) return false;
  if (request.time_to && time >= request.time_to) return false;
  return true;
}

// The user's limits are applied here, in code. The model only ever sees
// options that already respect them.
export function buildOptions(providers: ProviderSummary[], request: RequestFields): { options: Option[]; removed: Record<string, number> } {
  const removed = { over_budget: 0, no_slot_in_time_window: 0, excluded: 0 };
  const options: Option[] = [];
  for (const provider of providers) {
    if (request.exclude_provider_ids?.includes(provider.provider_id)) {
      removed.excluded += 1;
      continue;
    }
    if (request.budget_inr !== undefined && provider.price > request.budget_inr) {
      removed.over_budget += 1;
      continue;
    }
    const slots = provider.available_slots.filter((slot) => slotFitsTime(slot, request));
    if (slots.length === 0) {
      removed.no_slot_in_time_window += 1;
      continue;
    }
    options.push({ provider_id: provider.provider_id, name: provider.name, price: provider.price, rating: provider.rating, slots });
  }
  options.sort((a, b) => b.rating - a.rating || a.price - b.price);
  return { options: options.slice(0, OPTIONS.maxProviders), removed };
}

// A short view for the model: a few slots, spread across different days.
export function optionsForModel(options: Option[]): (Omit<Option, "slots" | "offered_in_message"> & { slots: string[]; more_slots: number })[] {
  return options.map(({ offered_in_message: _bookkeeping, ...option }) => {
    const seenDays = new Set<string>();
    const spread = option.slots.filter((slot) => {
      const day = slot.slice(0, 10);
      if (seenDays.has(day)) return false;
      seenDays.add(day);
      return true;
    });
    const shown = (spread.length >= OPTIONS.maxSlotsShown ? spread : option.slots).slice(0, OPTIONS.maxSlotsShown);
    return { ...option, slots: shown, more_slots: option.slots.length - shown.length };
  });
}
