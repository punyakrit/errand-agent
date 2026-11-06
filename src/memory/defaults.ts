import type { RequestFields } from "../agent/request.ts";
import { AREAS } from "../mock/types.ts";
import type { Memory } from "./store.ts";

const TIME = /^\d{2}:\d{2}$/;

function find(memories: Memory[], key: string, service: string | undefined): Memory | undefined {
  return memories.find((memory) => memory.key === key && memory.scope === service)
    ?? memories.find((memory) => memory.key === key && memory.scope === "global");
}

// Fills gaps in a request from stored preferences, so we do not ask for
// something the user already told us. Only usable facts are passed in, and a
// value the user gave for this request always wins.
export function applyMemoryDefaults(request: RequestFields, memories: Memory[]): { request: RequestFields; filled: string[] } {
  const merged = { ...request };
  const filled: string[] = [];

  const area = find(memories, "preferred_area", request.service)?.value;
  if (!merged.area && area && (AREAS as readonly string[]).includes(area)) {
    merged.area = area as RequestFields["area"];
    filled.push("area");
  }

  const earliest = find(memories, "earliest_time", request.service)?.value;
  if (!merged.time_from && !merged.any_time && earliest && TIME.test(earliest)) {
    merged.time_from = earliest;
    filled.push("time_from");
  }

  const budget = Number(find(memories, "max_budget", request.service)?.value);
  if (merged.budget_inr === undefined && !merged.any_budget && budget > 0) {
    merged.budget_inr = budget;
    filled.push("budget_inr");
  }
  return { request: merged, filled };
}
