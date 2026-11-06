import { estimateTokens } from "../agent/tokens.ts";
import { AREAS } from "../mock/types.ts";
import type { Memory } from "./store.ts";

export const CORE_KEYS = ["preferred_area", "earliest_time", "preferred_provider", "max_budget"];

export interface Selection {
  included: Memory[];
  excluded: { id: number; reason: string }[];
}

function mentionedArea(memory: Memory): string | undefined {
  const text = `${memory.key} ${memory.value}`.toLowerCase();
  return AREAS.find((area) => text.includes(area.toLowerCase()) || text.includes(area.toLowerCase().replaceAll(" ", "_")));
}

function exclusionReason(memory: Memory, service: string | undefined, area: string | undefined): string | undefined {
  if (memory.status === "forgotten") return "forgotten";
  if (memory.status === "superseded") return "superseded";
  if (memory.kind === "inferred" && !memory.confirmed) return "unconfirmed";
  if (memory.scope !== "global" && memory.scope !== service) return "other_service";
  const mentioned = mentionedArea(memory);
  if (mentioned && area && mentioned !== area) return "other_area";
  return undefined;
}

function score(memory: Memory, service: string | undefined, area: string | undefined): number {
  let total = 0;
  if (memory.scope === service) total += 3;
  if (CORE_KEYS.includes(memory.key)) total += 2;
  if (area && mentionedArea(memory) === area) total += 2;
  if (memory.kind === "explicit") total += 1;
  return total;
}

export function memoryLine(memory: Memory): string {
  return `[${memory.id}] ${memory.key} = ${memory.value} (${memory.scope}, ${memory.kind})`;
}

// Decides which facts reach the model. Rules first, then rank, then trim to
// budget. Every fact left out is reported with the reason, for the manifest.
export function selectMemories(memories: Memory[], service: string | undefined, area: string | undefined, budgetTokens: number): Selection {
  const excluded: Selection["excluded"] = [];
  const eligible: Memory[] = [];
  for (const memory of memories) {
    const reason = exclusionReason(memory, service, area);
    if (reason) excluded.push({ id: memory.id, reason });
    else eligible.push(memory);
  }

  eligible.sort((a, b) => score(b, service, area) - score(a, service, area) || b.updated_at - a.updated_at || a.id - b.id);

  const included: Memory[] = [];
  let used = 0;
  for (const memory of eligible) {
    const cost = estimateTokens(memoryLine(memory)) + 1;
    if (used + cost > budgetTokens) {
      excluded.push({ id: memory.id, reason: "over_memory_budget" });
      continue;
    }
    included.push(memory);
    used += cost;
  }
  return { included, excluded };
}
