import { tool } from "../../llm/scripted.ts";
import { UPCOMING_AC_BOOKING } from "../../mock/seed.ts";
import type { Scenario } from "../scenario.ts";
import { USER } from "../world.ts";

export const proactiveScenarios: Scenario[] = [
  {
    id: "34", name: "Provider cancels, replacement found, fresh approval",
    note: "Detected with no user message. Rebooking still needs a pick, a hold and a new yes.",
    expect: {
      proactive_events: 1, model_calls_before_user: 0, approvals_consumed: 1, book_calls: 1, new_bookings: 1,
      replaced_provider_avoided: true, last_state: "DONE",
    },
    run: async (w) => {
      w.mock.configure({ forceBook: ["success"] });
      await w.tick();
      w.mock.providerCancels(UPCOMING_AC_BOOKING);
      await w.tick();
      const option = w.agent.deps.tasks.active(USER)!.details.options![0]!;
      w.script(tool("hold_slot", { provider_id: option.provider_id, slot: option.slots[0]! }), tool("request_approval"));
      await w.user("The first one, please.");
      await w.user("yes");
    },
    extra: (w) => {
      const firstUserRun = w.sink.events.findIndex((event) => event.type === "run_start" && event.kind === "user_message");
      return {
        model_calls_before_user: w.sink.events.slice(0, firstUserRun).filter((event) => event.type === "model_call").length,
        replaced_provider_avoided: w.mock.allBookings().at(-1)?.provider_id !== "ac_1",
      };
    },
  },
  {
    id: "35", name: "Provider cancels, no replacement fits",
    note: "Tells the user, holds nothing, and waits.",
    expect: { proactive_events: 1, hold_calls: 0, book_calls: 0, last_state: "NEEDS_USER", user_told: true },
    run: async (w) => {
      w.agent.deps.memory.remember(USER, "max_budget", "100", "global", "stated in an earlier session");
      w.mock.providerCancels(UPCOMING_AC_BOOKING);
      await w.tick();
    },
    extra: (w) => ({ user_told: w.replies.some((reply) => reply.includes("could not find a replacement")) }),
  },
  {
    id: "36", name: "Same cancellation event across a restart",
    note: "Handled once: one event, one task, one message.",
    expect: { proactive_events: 1, tasks: 1, notices: 1 },
    run: async (w) => {
      w.mock.providerCancels(UPCOMING_AC_BOOKING);
      await w.tick();
      await w.restart();
      await w.tick();
      await w.tick();
    },
    extra: (w) => ({
      tasks: w.agent.deps.tasks.all(USER).length,
      notices: w.replies.filter((reply) => reply.includes("CoolAir Care cancelled")).length,
    }),
  },
];
