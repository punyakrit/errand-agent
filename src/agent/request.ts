import { z } from "zod";
import { AREAS, SERVICES } from "../mock/types.ts";

// What the user wants. The model sends partial updates, code merges them.
export const RequestUpdate = z.object({
  service: z.enum(SERVICES).optional(),
  area: z.enum(AREAS).optional(),
  date_from: z.string().optional().describe("YYYY-MM-DD"),
  date_to: z.string().optional().describe("YYYY-MM-DD"),
  time_from: z.string().optional().describe("24-hour HH:MM, earliest start"),
  time_to: z.string().optional().describe("24-hour HH:MM, latest start"),
  any_time: z.boolean().optional().describe("The user said any time is fine"),
  budget_inr: z.number().optional().describe("Most the user will pay, in rupees"),
  any_budget: z.boolean().optional().describe("The user said there is no budget limit"),
  provider_id: z.string().optional().describe("A specific provider the user asked for"),
  clear_provider: z.boolean().optional().describe("The user no longer wants that specific provider"),
  exclude_provider_ids: z.array(z.string()).optional(),
  notes: z.string().optional().describe("Other preferences, in the user's words"),
});
export type RequestUpdate = z.infer<typeof RequestUpdate>;

export type RequestFields = Omit<RequestUpdate, "clear_provider">;

export const ASK_FIELDS = [
  "service", "area", "date_window", "time_window", "budget", "preferences", "which_booking", "new_slot", "other",
] as const;
export type AskField = (typeof ASK_FIELDS)[number];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

// Returns the name of the first badly formatted field, if any.
export function findInvalidField(update: RequestUpdate): string | undefined {
  if (update.date_from && !DATE.test(update.date_from)) return "date_from";
  if (update.date_to && !DATE.test(update.date_to)) return "date_to";
  if (update.time_from && !TIME.test(update.time_from)) return "time_from";
  if (update.time_to && !TIME.test(update.time_to)) return "time_to";
  if (update.budget_inr !== undefined && update.budget_inr <= 0) return "budget_inr";
  return undefined;
}

// Only fields present in the update change. Everything else stays as it was,
// which is what makes "a correction changes only that field" true.
export function mergeRequest(current: RequestFields, update: RequestUpdate): { merged: RequestFields; changed: string[] } {
  const { clear_provider: clearProvider, ...fields } = update;
  const merged: Record<string, unknown> = { ...current };
  const changed: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === "") continue;
    if (JSON.stringify(merged[key]) !== JSON.stringify(value)) changed.push(key);
    merged[key] = value;
  }
  // A concrete value and "any" cannot both stand. The newest one wins.
  if (changed.includes("budget_inr")) delete merged.any_budget;
  if (changed.includes("any_budget") && merged.any_budget) delete merged.budget_inr;
  if ((changed.includes("time_from") || changed.includes("time_to"))) delete merged.any_time;
  if (changed.includes("any_time") && merged.any_time) {
    delete merged.time_from;
    delete merged.time_to;
  }
  if (clearProvider && merged.provider_id !== undefined) {
    delete merged.provider_id;
    changed.push("provider_id");
  }
  return { merged: merged as RequestFields, changed };
}

export function fieldValue(field: AskField, request: RequestFields): unknown {
  switch (field) {
    case "service": return request.service;
    case "area": return request.area;
    case "date_window": return request.date_from && request.date_to ? `${request.date_from} to ${request.date_to}` : undefined;
    case "time_window":
      if (request.any_time) return "any time";
      return request.time_from || request.time_to ? `${request.time_from ?? "any"} to ${request.time_to ?? "any"}` : undefined;
    case "budget": return request.any_budget ? "no limit" : request.budget_inr;
    case "preferences": return request.notes;
    default: return undefined; // which_booking, new_slot and other are never "known" here
  }
}

// Code, not the model, decides what is still missing.
export function missingFields(kind: string, request: RequestFields, hasTarget: boolean): AskField[] {
  const known = (field: AskField) => fieldValue(field, request) !== undefined;
  if (kind === "cancel") return hasTarget ? [] : ["which_booking"];
  if (kind === "reschedule") {
    const missing: AskField[] = hasTarget ? [] : ["which_booking"];
    return known("date_window") ? missing : [...missing, "date_window"];
  }
  const required: AskField[] = ["service", "area", "date_window", "time_window", "budget"];
  return required.filter((field) => !known(field));
}
