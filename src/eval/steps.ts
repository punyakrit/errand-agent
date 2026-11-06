import { say, tool } from "../llm/scripted.ts";
import type { AgentReply } from "../agent/finish.ts";
import type { World } from "./world.ts";

export const PLUMBER_REQUEST = {
  service: "plumber", area: "Indiranagar", date_from: "2026-11-09", date_to: "2026-11-15",
  time_from: "08:00", time_to: "12:00", budget_inr: 1500,
};
export const PLUMBER_SEARCH = { service: "plumber", area: "Indiranagar", date_range: { from: "2026-11-09", to: "2026-11-15" } };
export const SHARMA = { provider_id: "pl_1", slot: "2026-11-10T09:00:00+05:30" };
export const FIRST_MESSAGE = "Find a plumber for my kitchen tap this week, mornings only, under ₹1,500, in Indiranagar.";
export const ELEVEN_MINUTES = 11 * 60 * 1000;
export const SATURDAY = { from: "2026-11-14", to: "2026-11-14" };

// The conversation up to the options.
export async function reachOptions(world: World): Promise<void> {
  world.script(tool("update_request", PLUMBER_REQUEST), tool("search_providers", PLUMBER_SEARCH), say("Here are the options."));
  await world.user(FIRST_MESSAGE);
}

// The conversation up to the approval card.
export async function reachApproval(world: World): Promise<AgentReply> {
  await reachOptions(world);
  world.script(tool("hold_slot", SHARMA), tool("request_approval"));
  return world.user("Sharma at 9 on Tuesday, please.");
}

// A cancel, up to its approval card.
export async function reachCancelApproval(world: World): Promise<AgentReply> {
  world.script(tool("update_request", { kind: "cancel", service: "ac_service" }), tool("request_approval"));
  return world.user("Cancel my AC servicing.");
}

// A move to Saturday, up to its approval card.
export async function reachMoveApproval(world: World, slot: string): Promise<AgentReply> {
  world.script(
    tool("update_request", { kind: "reschedule", service: "ac_service", date_from: SATURDAY.from, date_to: SATURDAY.to, any_time: true }),
    tool("search_providers", { service: "ac_service", area: "Indiranagar", date_range: SATURDAY }),
    say("Which time on Saturday?"),
  );
  await world.user("Move my AC servicing to Saturday.");
  world.script(tool("update_request", { new_slot: slot }), tool("request_approval"));
  return world.user("That time works.");
}

export function lastReply(world: World): string {
  return world.replies.at(-1) ?? "";
}
