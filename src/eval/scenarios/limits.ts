import type Anthropic from "@anthropic-ai/sdk";
import { call, message, say, tool, type Step } from "../../llm/scripted.ts";
import type { Scenario } from "../scenario.ts";

const SMALL_RESULT = { name: "get_booking_status", input: { hold_id: "H-9999" } };

export const limitScenarios: Scenario[] = [
  {
    id: "30", name: "Model loops on tools until the limit",
    note: "Stops at 8 model turns with a clear message.",
    expect: { model_calls: 8, limit_hits: ["turn_limit"], last_finish: "turn_limit", book_calls: 0 },
    run: async (w) => {
      const steps: Step[] = Array.from({ length: 12 }, () => tool("get_booking_status", { hold_id: "H-9999" }));
      w.script(...steps);
      await w.user("Keep checking.");
    },
  },
  {
    id: "30b", name: "Too many tool calls in one message",
    note: "Stops at 20 calls, even in the middle of a batch.",
    expect: { tool_events: 20, limit_hits: ["tool_limit"], last_finish: "tool_limit" },
    run: async (w) => {
      const batch = Array.from({ length: 12 }, () => SMALL_RESULT);
      w.script(call(...batch), call(...batch), call(...batch));
      await w.user("Check everything.");
    },
    extra: (w) => ({ tool_events: w.sink.events.filter((event) => event.type === "tool_call").length }),
  },
  {
    id: "31", name: "Wall-clock limit on the fake clock",
    note: "The clock passes 60 seconds during a model call, so no further work starts.",
    expect: { model_calls: 1, limit_hits: ["time_limit"], last_finish: "time_limit" },
    run: async (w) => {
      w.script(() => {
        w.clock.advance(61_000);
        return tool("list_bookings");
      }, say("Too late."));
      await w.user("Are you there?");
    },
  },
  {
    id: "32", name: "Tool throws an unexpected error",
    note: "Reads are retried up to 3 times, then the run ends with a clear message.",
    world: { faults: { throwOn: { list_bookings: 10 } } },
    expect: { list_attempts: 4, last_finish: "tool_error" },
    run: async (w) => {
      w.script(tool("list_bookings"));
      await w.user("What do I have booked?");
    },
    extra: (w) => ({ list_attempts: w.sink.events.filter((event) => event.type === "tool_call" && event.name === "list_bookings").length }),
  },
  {
    id: "33", name: "Malformed model output",
    note: "Tool use with no tool block gets a code-written message, not a crash.",
    expect: { last_finish: "malformed_output", book_calls: 0 },
    run: async (w) => {
      w.script(message([], "tool_use"));
      await w.user("Hello.");
    },
  },
  {
    id: "33b", name: "Bad tool input from the model",
    note: "Zod rejects it. The model gets one chance, then the run ends.",
    expect: { last_finish: "bad_tool_input" },
    run: async (w) => {
      w.script(tool("get_provider", { wrong: 1 }), tool("get_provider", { wrong: 2 }), say("Never reached."));
      await w.user("Hello.");
    },
  },
  {
    id: "33c", name: "Refusal",
    note: "Checked before reading content, with a code-written message.",
    expect: { last_finish: "refusal" },
    run: async (w) => {
      w.script(message([], "refusal"));
      await w.user("Hello.");
    },
  },
  {
    id: "33d", name: "Output cut off at max_tokens",
    note: "Partial text is not shown to the user.",
    expect: { last_finish: "max_tokens", partial_text_shown: false },
    run: async (w) => {
      w.script(message([{ type: "text", text: "PARTIAL" } as Anthropic.TextBlock], "max_tokens"));
      await w.user("Hello.");
    },
    extra: (w) => ({ partial_text_shown: w.replies.some((reply) => reply.includes("PARTIAL")) }),
  },
  {
    id: "33e", name: "API error",
    note: "Ends with a clear message, and state is kept.",
    expect: { last_finish: "api_error" },
    run: async (w) => {
      w.script(() => Promise.reject(Object.assign(new Error("overloaded"), { status: 529 })));
      await w.user("Hello.");
    },
  },
];
