import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { call, message, say, tool, type Step } from "../../src/llm/scripted.ts";
import { makeAgent, PLUMBER_REQUEST } from "./helpers.ts";

function expectCleanExit(result: { reason: string; reply: string }, reason: string) {
  expect(result.reason).toBe(reason);
  expect(result.reply.length).toBeGreaterThan(10);
}

describe("normal exits", () => {
  it("returns the model's reply on end_turn", async () => {
    const { send } = makeAgent([say("Hello there.")]);
    expect(await send("hi")).toMatchObject({ reason: "reply", reply: "Hello there." });
  });

  it("runs tools, then feeds the results back", async () => {
    const { send, llm } = makeAgent([tool("list_bookings"), say("You have two bookings.")]);
    await send("what do I have booked?");
    const last = llm.requests[1]!.messages.at(-1)!;
    const block = (last.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(block.type).toBe("tool_result");
    expect(String(block.content)).toContain("B-0002");
  });

  it("returns all results of a parallel call in one user message", async () => {
    const { send, llm } = makeAgent([
      call({ name: "list_bookings", input: {} }, { name: "get_provider", input: { provider_id: "pl_1" } }),
      say("ok"),
    ]);
    await send("hi");
    expect(llm.requests[1]!.messages.at(-1)!.content).toHaveLength(2);
  });

  it("stops and shows the question when the model asks", async () => {
    const { send, llm } = makeAgent([
      tool("update_request", { service: "plumber" }),
      tool("ask_user", { field: "area", question: "Which area are you in?" }),
    ]);
    expect(await send("I need a plumber")).toMatchObject({ reason: "asked_user", reply: "Which area are you in?" });
    expect(llm.remaining()).toBe(0);
  });
});

describe("re-ask guard", () => {
  it("blocks a question about a known field and traces it", async () => {
    const { send, events } = makeAgent([
      tool("update_request", { service: "plumber", area: "Koramangala" }),
      tool("ask_user", { field: "area", question: "Which area?" }),
      tool("ask_user", { field: "budget", question: "What is your budget?" }),
    ]);
    const result = await send("plumber in Koramangala");
    expect(result.reply).toBe("What is your budget?");
    expect(events("gate_decision")).toHaveLength(1);
    expect(events("gate_decision")[0]).toMatchObject({ decision: "reask_blocked", field: "area" });
  });
});

describe("stop reasons", () => {
  it("handles refusal", async () => {
    const { send } = makeAgent([message([], "refusal")]);
    expectCleanExit(await send("hi"), "refusal");
  });

  it("handles max_tokens", async () => {
    const { send } = makeAgent([message([{ type: "text", text: "PARTIAL-MODEL-TEXT" } as Anthropic.TextBlock], "max_tokens")]);
    const result = await send("hi");
    expectCleanExit(result, "max_tokens");
    expect(result.reply).not.toContain("PARTIAL-MODEL-TEXT");
  });

  it("handles an unknown stop reason", async () => {
    const { send } = makeAgent([message([], "pause_turn")]);
    expectCleanExit(await send("hi"), "malformed_output");
  });

  it("handles an empty end_turn", async () => {
    const { send } = makeAgent([message([], "end_turn")]);
    expectCleanExit(await send("hi"), "malformed_output");
  });

  it("handles tool_use with no tool block", async () => {
    const { send } = makeAgent([message([], "tool_use")]);
    expectCleanExit(await send("hi"), "malformed_output");
  });
});

describe("hard limits", () => {
  it("stops after 8 model turns", async () => {
    const steps: Step[] = Array.from({ length: 12 }, () => tool("list_bookings"));
    const { send, llm, events } = makeAgent(steps);
    expectCleanExit(await send("hi"), "turn_limit");
    expect(llm.requests).toHaveLength(8);
    expect(events("limit_hit")).toHaveLength(1);
  });

  it("stops at 20 tool calls, even inside one batch", async () => {
    // A tool with a tiny result, so this exercises the call limit, not the context budget.
    const batch = Array.from({ length: 12 }, () => ({ name: "get_booking_status", input: { hold_id: "H-9999" } }));
    const { send, events } = makeAgent([call(...batch), call(...batch), call(...batch)]);
    expectCleanExit(await send("hi"), "tool_limit");
    expect(events("tool_call")).toHaveLength(20);
  });

  it("stops cleanly when tool results outgrow the context budget", async () => {
    const batch = Array.from({ length: 12 }, () => ({ name: "list_bookings", input: {} }));
    const { send, llm, events } = makeAgent([call(...batch), say("never sent")]);
    expectCleanExit(await send("hi"), "context_budget");
    expect(llm.requests).toHaveLength(1); // the oversized payload never reached the model
    expect(events("limit_hit")[0]).toMatchObject({ limit: "context_budget" });
  });

  it("stops at 60 seconds on the injected clock", async () => {
    const made = makeAgent();
    made.llm.add(
      () => {
        made.clock.advance(61_000);
        return tool("list_bookings");
      },
      say("too late"),
    );
    expectCleanExit(await made.send("hi"), "time_limit");
    expect(made.llm.requests).toHaveLength(1);
    expect(made.events("limit_hit")[0]).toMatchObject({ limit: "time_limit" });
  });

  it("gives up on a model call that hangs", async () => {
    const { send } = makeAgent([() => new Promise(() => {})], { limits: { modelCallTimeoutMs: 20 } });
    expectCleanExit(await send("hi"), "model_timeout");
  });

  it("handles an API error", async () => {
    const { send, events } = makeAgent([() => Promise.reject(Object.assign(new Error("boom"), { status: 529 }))]);
    expectCleanExit(await send("hi"), "api_error");
    expect(events("model_call")[0]).toMatchObject({ status: 529 });
  });
});

describe("bad tool input", () => {
  it("tells the model about one bad input so it can fix it", async () => {
    const { send, llm } = makeAgent([tool("get_provider", { wrong: 1 }), say("fixed")]);
    expect((await send("hi")).reply).toBe("fixed");
    const block = (llm.requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(block.is_error).toBe(true);
  });

  it("ends the run after repeated bad input", async () => {
    const { send } = makeAgent([tool("get_provider", { wrong: 1 }), tool("get_provider", { wrong: 2 }), say("never")]);
    expectCleanExit(await send("hi"), "bad_tool_input");
  });

  it("treats an unknown tool as bad input", async () => {
    const { send, events } = makeAgent([tool("delete_everything"), tool("delete_everything")]);
    expectCleanExit(await send("hi"), "bad_tool_input");
    expect(events("tool_call")[0]).toMatchObject({ error: "bad_input" });
  });

  it("rejects extra fields the schema does not allow", async () => {
    const { send, events } = makeAgent([tool("list_bookings", { user_id: "someone_else" }), say("ok")]);
    await send("hi");
    expect(events("tool_call")[0]).toMatchObject({ error: "bad_input" });
  });
});

describe("tool failures", () => {
  it("retries a read that throws and carries on", async () => {
    const { send, events } = makeAgent([tool("list_bookings"), say("ok")], { faults: { throwOn: { list_bookings: 2 } } });
    expect((await send("hi")).reply).toBe("ok");
    expect(events("tool_call").map((event) => event.attempt)).toEqual([1, 2, 3]);
  });

  it("ends clearly when retries run out", async () => {
    const { send, events } = makeAgent([tool("list_bookings")], { faults: { throwOn: { list_bookings: 10 } } });
    expectCleanExit(await send("hi"), "tool_error");
    expect(events("tool_call")).toHaveLength(4); // first try plus 3 retries
  });

  it("counts each attempt of a failing tool exactly once", async () => {
    const { send, events } = makeAgent([tool("list_bookings")], { faults: { throwOn: { list_bookings: 10 } } });
    await send("hi");
    expect(events("run_end")[0]).toMatchObject({ reason: "tool_error", tool_calls: 4 });
  });

  it("traces and counts a tool call that code stopped before it reached the provider", async () => {
    const { send, events } = makeAgent([
      tool("hold_slot", { provider_id: "pl_1", slot: "2026-11-10T09:00:00+05:30" }),
      tool("search_providers", { service: "plumber", area: "Indiranagar", date_range: { from: "2026-11-09", to: "2026-11-15" } }),
      say("ok"),
    ]);
    await send("hi");
    expect(events("tool_call").map((event) => event.name)).toEqual(["hold_slot", "search_providers"]);
    expect(events("tool_call")[0]).toMatchObject({ args: { provider_id: "pl_1" }, result: { error: "no_active_task" } });
    expect(events("run_end")[0]).toMatchObject({ tool_calls: 2 });
  });

  it("does not retry a side effect that throws", async () => {
    const { send, events, llm } = makeAgent(
      [
        tool("update_request", PLUMBER_REQUEST),
        tool("search_providers", { service: "plumber", area: "Indiranagar", date_range: { from: "2026-11-09", to: "2026-11-15" } }),
        say("Pick one."),
      ],
      { faults: { throwOn: { hold_slot: 5 } } },
    );
    const options = await send("plumber");
    expect(options.reason).toBe("reply");
    llm.add(tool("hold_slot", { provider_id: "pl_1", slot: "2026-11-10T09:00:00+05:30" }));
    expectCleanExit(await send("Sharma at 9 on Tuesday"), "tool_error");
    expect(events("tool_call").filter((event) => event.name === "hold_slot")).toHaveLength(1);
  });
});

describe("thinking blocks", () => {
  const thinking = { type: "thinking", thinking: "", signature: "sig-1" };
  const useBlock = { type: "tool_use", id: "toolu_a", name: "list_bookings", input: {} };

  it("appends the response unchanged inside a tool loop", async () => {
    const content = [thinking, useBlock] as unknown as Anthropic.ContentBlock[];
    const { send, llm } = makeAgent([message(content, "tool_use"), say("done")]);
    await send("hi");
    const assistant = llm.requests[1]!.messages.at(-2)!;
    expect(assistant.content).toEqual([thinking, useBlock]);
  });

  it("rebuilds history as plain text on the next user message", async () => {
    const content = [thinking, useBlock] as unknown as Anthropic.ContentBlock[];
    const { send, llm } = makeAgent([message(content, "tool_use"), say("done"), say("again")]);
    await send("first");
    await send("second");
    const next = llm.requests[2]!;
    expect(JSON.stringify(next.messages)).not.toContain("sig-1");
    for (const item of next.messages) expect(typeof item.content).toBe("string");
    expect(next.messages.map((item) => item.content)).toEqual(["first", "done", "second"]);
  });

  it("sends the same system prompt and tools for every call in a loop", async () => {
    const { send, llm } = makeAgent([tool("update_request", { service: "plumber" }), say("ok")]);
    await send("I need a plumber");
    expect(llm.requests[1]!.system).toBe(llm.requests[0]!.system);
    expect(llm.requests[1]!.tools).toEqual(llm.requests[0]!.tools);
  });
});

describe("request shape", () => {
  it("marks every tool strict with no extra properties", async () => {
    const { send, llm } = makeAgent([say("ok")]);
    await send("hi");
    for (const definition of llm.requests[0]!.tools) {
      expect(definition.strict, definition.name).toBe(true);
      expect(definition.input_schema.additionalProperties, definition.name).toBe(false);
    }
  });

  it("sends only schema features strict tools support", async () => {
    const { send, llm } = makeAgent([say("ok")]);
    await send("hi");
    const tools = llm.requests[0]!.tools;
    expect(tools.length).toBeLessThanOrEqual(20);
    for (const definition of tools) {
      expect(definition.input_schema, definition.name).not.toHaveProperty("$schema");
      expect(Array.isArray(definition.input_schema.required), definition.name).toBe(true);
    }
    const text = JSON.stringify(tools);
    for (const unsupported of ["minLength", "maxLength", "minimum", "maximum", "pattern", "multipleOf"]) {
      expect(text, unsupported).not.toContain(`"${unsupported}"`);
    }
  });

  it("lists kind before the request fields, because strict output follows schema order", async () => {
    const { send, llm } = makeAgent([say("ok")]);
    await send("hi");
    const update = llm.requests[0]!.tools.find((definition) => definition.name === "update_request")!;
    const order = Object.keys(update.input_schema.properties as object);
    expect(order[0]).toBe("kind");
    expect(order.indexOf("target_booking_id")).toBeLessThan(order.indexOf("service"));
  });

  it("never offers the user ID or an idempotency key to the model", async () => {
    const { send, llm } = makeAgent([say("ok")]);
    await send("hi");
    const schemas = JSON.stringify(llm.requests[0]!.tools);
    expect(schemas).not.toContain("idempotency_key");
    expect(schemas).not.toContain("user_id");
  });

  it("every run ends with a saved reply and a run_end event", async () => {
    const { send, agent, events } = makeAgent([message([], "refusal")]);
    const result = await send("hi");
    expect(agent.deps.chat.history("u1").at(-1)).toMatchObject({ role: "assistant", text: result.reply });
    expect(events("run_end")[0]).toMatchObject({ reason: "refusal" });
  });
});
