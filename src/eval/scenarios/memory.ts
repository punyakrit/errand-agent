import type { DatabaseSync } from "node:sqlite";
import { say, tool } from "../../llm/scripted.ts";
import type { Scenario } from "../scenario.ts";
import { estimatePayloadTokens } from "../../agent/tokens.ts";
import { CONTEXT } from "../../config.ts";
import { MARKERS, seedLongChat, seedMemories } from "../seed-history.ts";
import { PLUMBER_REQUEST } from "../steps.ts";
import { USER, type World } from "../world.ts";

function lastPayload(w: World): string {
  const request = w.llm.requests.at(-1);
  return request ? JSON.stringify({ system: request.system, messages: request.messages }) : "";
}

export const memoryScenarios: Scenario[] = [
  {
    id: "25", name: "Preference persists across sessions",
    note: "A new session fills the area from memory and blocks asking for it again.",
    expect: { area_from_memory: "Koramangala", reask_blocked: 1, preference_in_payload: true },
    run: async (w) => {
      w.script(tool("remember_preference", { key: "preferred_area", value: "Koramangala", scope: "global", evidence: "always use Koramangala" }), say("Saved."));
      await w.user("I always use Koramangala for home jobs.", "session-1");
      w.script(tool("update_request", { service: "plumber" }), tool("ask_user", { field: "area", question: "Which area?" }), say("Which dates suit you?"));
      await w.user("I need a plumber.", "session-2");
    },
    extra: (w) => ({
      area_from_memory: w.agent.deps.tasks.active(USER)?.request.area,
      preference_in_payload: lastPayload(w).includes("preferred_area = Koramangala"),
    }),
  },
  {
    id: "26", name: "Memory correction",
    note: "The old row is superseded and only the new value reaches the model.",
    expect: { rows: [["Koramangala", "superseded"], ["Whitefield", "active"]], new_value_sent: true, old_value_sent: false },
    run: async (w) => {
      w.script(tool("remember_preference", { key: "preferred_area", value: "Koramangala", scope: "global", evidence: "my usual area is Koramangala" }), say("Saved."));
      await w.user("Note this: my usual area is Koramangala.", "session-1");
      w.script(tool("memory_correct", { key: "preferred_area", value: "Whitefield", scope: "global", evidence: "I moved to Whitefield" }), say("Updated."));
      await w.user("I moved to Whitefield.", "session-2");
      w.script(say("Hello."));
      await w.user("Hi.", "session-3");
    },
    extra: (w) => ({
      rows: w.agent.deps.memory.all(USER).map((row) => [row.value, row.status]),
      new_value_sent: w.llm.requests.at(-1)!.system.includes("preferred_area = Whitefield"),
      old_value_sent: w.llm.requests.at(-1)!.system.includes("preferred_area = Koramangala"),
    }),
  },
  {
    id: "27", name: "Memory forget, including old chat",
    note: "The value goes from the table, chat history, summary and every later payload.",
    expect: { row_status: "forgotten", row_value: "", in_chat_history: false, in_later_payload: false, last_finish: "reply" },
    run: async (w) => {
      w.script(tool("remember_preference", { key: "gate_code", value: "ZEBRA-4471", scope: "global", evidence: "my gate code is ZEBRA-4471" }), say("Saved ZEBRA-4471."));
      await w.user("Remember my gate code is ZEBRA-4471 for all visits.");
      w.script(tool("memory_forget", { key: "gate_code", evidence: "forget my gate code" }));
      await w.user("Please forget my gate code.");
      w.script(say("Hello."));
      await w.user("Hello again.");
    },
    extra: (w) => {
      const row = w.agent.deps.memory.all(USER)[0];
      return {
        row_status: row?.status,
        row_value: row?.value,
        in_chat_history: JSON.stringify(w.agent.deps.chat.history(USER)).includes("ZEBRA-4471"),
        in_later_payload: lastPayload(w).includes("ZEBRA-4471"),
      };
    },
  },
  {
    id: "28", name: "Inferred fact excluded until confirmed",
    note: "Code infers it from history. The model only sees it after the user confirms.",
    expect: { before_confirm: false, after_confirm: true, kind: "inferred", confirmed: true },
    run: async (w) => {
      await w.tick();
      w.script(say("Hello."));
      await w.user("Hi there.");
      const id = w.agent.deps.memory.active(USER)[0]!.id;
      await w.user(`confirm ${id}`);
      w.script(tool("update_request", { service: "electrician" }), say("Hello again."));
      await w.user("I need an electrician.");
      w.script(say("Sure."));
      await w.user("Which one do I use?");
    },
    extra: (w) => {
      const memory = w.agent.deps.memory.active(USER)[0];
      return {
        before_confirm: w.llm.requests[0]!.system.includes("Voltline"),
        after_confirm: w.llm.requests.at(-1)!.system.includes("Voltline"),
        kind: memory?.kind,
        confirmed: memory?.confirmed,
      };
    },
  },
  {
    id: "29", name: "Context budget with 50+ memories and long history",
    note: "The real payload stays under budget, with only relevant, current facts in it.",
    expect: {
      memories_seeded_50: true, chat_seeded_200_turns: true, under_budget: true,
      relevant_present: true, forgotten_absent: true, unconfirmed_absent: true, superseded_absent: true, other_service_absent: true,
    },
    run: async (w) => {
      seedMemories(w.agent, USER);
      seedLongChat(w.db as DatabaseSync, USER);
      w.script(tool("update_request", PLUMBER_REQUEST), say("Looking."));
      await w.user("I need a plumber.");
      w.script(say("Sure."));
      await w.user("What happens next?");
    },
    extra: (w) => {
      const request = w.llm.requests.at(-1)!;
      const text = lastPayload(w);
      return {
        memories_seeded_50: w.agent.deps.memory.all(USER).length >= 50,
        chat_seeded_200_turns: w.agent.deps.chat.history(USER).length >= 400,
        under_budget: estimatePayloadTokens(request.system, request.messages) <= CONTEXT.budgetTokens,
        relevant_present: text.includes(MARKERS.relevantProvider) && text.includes("earliest_time"),
        forgotten_absent: !text.includes(MARKERS.forgotten),
        unconfirmed_absent: !text.includes(MARKERS.unconfirmed),
        superseded_absent: !text.includes(MARKERS.superseded),
        other_service_absent: !text.includes(MARKERS.otherService),
      };
    },
  },
];
