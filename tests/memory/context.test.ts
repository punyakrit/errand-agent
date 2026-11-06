import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildContext } from "../../src/agent/context.ts";
import { Run } from "../../src/agent/run.ts";
import { estimatePayloadTokens } from "../../src/agent/tokens.ts";
import { CONTEXT } from "../../src/config.ts";
import { MARKERS, seedLongChat, seedMemories } from "../../src/eval/seed-history.ts";
import { say, tool } from "../../src/llm/scripted.ts";
import { makeAgent, PLUMBER_REQUEST, SESSION, USER } from "../agent/helpers.ts";

function seeded() {
  const made = makeAgent([tool("update_request", PLUMBER_REQUEST), say("Looking.")]);
  seedMemories(made.agent, USER);
  seedLongChat(made.agent.deps.db as DatabaseSync, USER);
  return made;
}

async function payloadAfterTask() {
  const made = seeded();
  await made.send("I need a plumber");
  made.llm.add(say("Sure."));
  await made.send("what next?");
  const request = made.llm.requests.at(-1)!;
  return { ...made, request, text: JSON.stringify({ system: request.system, messages: request.messages }) };
}

describe("context budget with 50+ memories and a 200+ turn chat", () => {
  it("really has that much data", () => {
    const { agent } = seeded();
    expect(agent.deps.memory.all(USER).length).toBeGreaterThanOrEqual(50);
    expect(agent.deps.chat.history(USER).length).toBeGreaterThanOrEqual(400);
  });

  it("keeps the actual payload under budget", async () => {
    const { request } = await payloadAfterTask();
    expect(estimatePayloadTokens(request.system, request.messages)).toBeLessThanOrEqual(CONTEXT.budgetTokens);
  });

  it("leaves room for tool results inside the loop", async () => {
    const { request } = await payloadAfterTask();
    expect(estimatePayloadTokens(request.system, request.messages)).toBeLessThanOrEqual(CONTEXT.budgetTokens - CONTEXT.loopReserveTokens);
  });

  it("includes relevant preferences", async () => {
    const { text } = await payloadAfterTask();
    expect(text).toContain(MARKERS.relevantProvider);
    expect(text).toContain("preferred_area = Indiranagar");
  });

  it("excludes forgotten, unconfirmed and superseded values", async () => {
    const { text } = await payloadAfterTask();
    expect(text).not.toContain(MARKERS.forgotten);
    expect(text).not.toContain(MARKERS.unconfirmed);
    expect(text).not.toContain(MARKERS.superseded);
  });

  it("excludes other services and other areas", async () => {
    const { text } = await payloadAfterTask();
    expect(text).not.toContain(MARKERS.otherService);
    expect(text).not.toContain("Koramangala only detail");
  });

  it("includes recent turns and a summary of older ones", async () => {
    const { request } = await payloadAfterTask();
    expect(request.messages.at(-1)).toEqual({ role: "user", content: "what next?" });
    expect(request.system).toMatch(/Older chat: \d+ earlier messages/);
    expect(request.messages.length).toBeGreaterThan(2);
    expect(request.messages.length).toBeLessThanOrEqual(CONTEXT.recentMessages);
  });

  it("does not send the old chat in full", async () => {
    const { text } = await payloadAfterTask();
    expect(text).not.toContain("Old question number 3 ");
    expect(text).not.toContain("Old answer number 100 ");
  });
});

describe("context_manifest", () => {
  it("lists what was included and why the rest was left out", async () => {
    const { events, agent } = await payloadAfterTask();
    const manifest = events("context_manifest").at(-1)!;
    const included = manifest.memory_included as number[];
    const excluded = manifest.memory_excluded as { id: number; reason: string }[];

    expect(included.length).toBeGreaterThan(0);
    expect(included.length + excluded.length).toBe(agent.deps.memory.all(USER).length);

    const reasons = new Set(excluded.map((item) => item.reason));
    for (const reason of ["forgotten", "superseded", "unconfirmed", "other_service", "other_area", "over_memory_budget"]) {
      expect(reasons, reason).toContain(reason);
    }
    for (const id of included) expect(excluded.map((item) => item.id)).not.toContain(id);
  });

  it("agrees with what was really sent", async () => {
    const { events, agent, request } = await payloadAfterTask();
    const manifest = events("context_manifest").at(-1)!;
    for (const id of manifest.memory_included as number[]) {
      expect(request.system).toContain(agent.deps.memory.get(id)!.value);
    }
    for (const item of (manifest.memory_excluded as { id: number; reason: string }[]).filter((entry) => entry.reason === "unconfirmed")) {
      expect(request.system).not.toContain(agent.deps.memory.get(item.id)!.value);
    }
  });

  it("records token counts per part", async () => {
    const { events } = await payloadAfterTask();
    const tokens = events("context_manifest").at(-1)!.tokens as Record<string, number>;
    expect(tokens.budget).toBe(CONTEXT.budgetTokens);
    expect(tokens.memories).toBeGreaterThan(0);
    expect(tokens.summary).toBeGreaterThan(0);
    expect(tokens.recent).toBeGreaterThan(0);
    expect(tokens.estimated_total).toBeLessThanOrEqual(CONTEXT.budgetTokens);
  });
});

describe("task state in the context", () => {
  it("gives the next message the exact options, so it need not search again", async () => {
    const made = makeAgent([
      tool("update_request", PLUMBER_REQUEST),
      tool("search_providers", { service: "plumber", area: "Indiranagar", date_range: { from: "2026-11-09", to: "2026-11-15" } }),
      say("Pick one."),
    ]);
    await made.send("plumber");
    made.llm.add(say("ok"));
    await made.send("the first one");
    const system = made.llm.requests.at(-1)!.system;
    expect(system).toContain('"provider_id":"pl_3"');
    expect(system).toContain("2026-11-10T09:00:00+05:30");
    expect(system).not.toContain("offered_in_message");
  });

  it("shows the booking being changed", async () => {
    const made = makeAgent([tool("update_request", { kind: "cancel", service: "ac_service" }), say("Shall I?")]);
    await made.send("cancel my AC service");
    made.llm.add(say("ok"));
    await made.send("hmm");
    expect(made.llm.requests.at(-1)!.system).toContain("B-0002");
  });
});

describe("buildContext", () => {
  it("is deterministic", async () => {
    const made = seeded();
    await made.send("I need a plumber");
    const run = new Run(made.agent.deps, SESSION, USER, 1, made.sink.startRun(SESSION, "test"));
    expect(buildContext(run)).toEqual(buildContext(run));
  });

  it("keeps a forgotten value out of the older-chat summary", async () => {
    const made = makeAgent([]);
    const db = made.agent.deps.db as DatabaseSync;
    seedLongChat(db, USER, 40);
    db.prepare("INSERT INTO messages (session_id, user_id, role, text, at) VALUES ('old', ?, 'user', ?, 0)").run(USER, "Please always send Ramesh-the-plumber to me");
    // Pushes that message out of the recent turns. Assistant messages only, so it
    // stays the newest line in the summary and has to be scrubbed, not scrolled away.
    for (let index = 0; index < 20; index++) {
      db.prepare("INSERT INTO messages (session_id, user_id, role, text, at) VALUES ('old', ?, 'assistant', ?, 0)").run(USER, `Older reply number ${index} with some detail in it`);
    }
    made.agent.deps.memory.remember(USER, "preferred_technician", "Ramesh-the-plumber", "plumber", "always send Ramesh-the-plumber");

    made.llm.add(say("ok"));
    await made.send("hello");
    const before = made.llm.requests[0]!;
    expect(before.system).toContain("<older_chat>");
    expect(before.system).toContain("Ramesh-the-plumber"); // it really was in the summary
    expect(JSON.stringify(before.messages)).not.toContain("Ramesh-the-plumber");

    made.llm.add(tool("memory_forget", { key: "preferred_technician", evidence: "forget my technician" }));
    await made.send("forget my technician");
    made.llm.add(say("ok"));
    await made.send("hello");
    const after = made.llm.requests.at(-1)!;
    expect(after.system).not.toContain("Ramesh-the-plumber");
    expect(JSON.stringify(after.messages)).not.toContain("Ramesh-the-plumber");
    expect(after.system).toContain("[forgotten]");
  });

  it("shows a user message that is too long in part, and stays under budget", async () => {
    const { send, llm } = makeAgent([say("ok")]);
    await send("please help ".repeat(2000));
    const request = llm.requests[0]!;
    expect(estimatePayloadTokens(request.system, request.messages)).toBeLessThanOrEqual(CONTEXT.budgetTokens);
  });

  it("drops older turns when recent messages are long, and stays under budget", async () => {
    const made = makeAgent([say("ok")]);
    const db = made.agent.deps.db as DatabaseSync;
    for (let turn = 0; turn < 12; turn++) {
      const role = turn % 2 === 0 ? "user" : "assistant";
      db.prepare("INSERT INTO messages (session_id, user_id, role, text, at) VALUES ('old', ?, ?, ?, 0)").run(USER, role, `long message ${turn} `.repeat(70));
    }
    await made.send("hello");
    const request = made.llm.requests[0]!;
    expect(estimatePayloadTokens(request.system, request.messages)).toBeLessThanOrEqual(CONTEXT.budgetTokens - CONTEXT.loopReserveTokens);
    expect(request.messages.at(-1)).toEqual({ role: "user", content: "hello" });
    expect(request.messages.length).toBeLessThan(12);
  });

  it("sends the same context for the same stored records", async () => {
    const first = makeAgent([say("ok")]);
    const second = makeAgent([say("ok")]);
    await first.send("hello");
    await second.send("hello");
    expect(first.llm.requests[0]!.system).toBe(second.llm.requests[0]!.system);
    expect(first.llm.requests[0]!.messages).toEqual(second.llm.requests[0]!.messages);
  });
});
