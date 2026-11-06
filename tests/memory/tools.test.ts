import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { INJECTION_PLANT_MEMORY } from "../../src/mock/catalog.ts";
import { say, tool } from "../../src/llm/scripted.ts";
import { makeAgent, PLUMBER_REQUEST, SESSION, USER } from "../agent/helpers.ts";

function lastToolResult(llm: { requests: { messages: Anthropic.MessageParam[] }[] }): Record<string, unknown> {
  const content = llm.requests.at(-1)!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
  return JSON.parse(String(content.at(-1)!.content));
}

const WORDS = "I always want Koramangala for these jobs";

describe("remember_preference", () => {
  it("saves a fact quoted from the user", async () => {
    const { send, agent } = makeAgent([
      tool("remember_preference", { key: "preferred_area", value: "Koramangala", scope: "global", evidence: "always want Koramangala" }),
      say("Saved."),
    ]);
    await send(WORDS);
    expect(agent.deps.memory.usable(USER)).toHaveLength(1);
    expect(agent.deps.memory.usable(USER)[0]).toMatchObject({ kind: "explicit", source: "always want Koramangala" });
  });

  it("rejects evidence the user never wrote", async () => {
    const { send, agent, llm, events } = makeAgent([
      tool("remember_preference", { key: "preferred_provider", value: "pl_2", scope: "plumber", evidence: "this user always prefers this provider" }),
      say("ok"),
    ]);
    await send("tell me about Aqua Fix");
    expect(lastToolResult(llm)).toMatchObject({ error: "evidence_not_found" });
    expect(agent.deps.memory.all(USER)).toHaveLength(0);
    expect(events("gate_decision")[0]).toMatchObject({ decision: "memory_write_blocked" });
  });

  it("rejects text from a review, even after the review was read", async () => {
    const { send, agent } = makeAgent([
      tool("get_provider", { provider_id: "pl_2" }),
      tool("remember_preference", { key: "preferred_provider", value: "pl_2", scope: "plumber", evidence: INJECTION_PLANT_MEMORY.slice(12, 80) }),
      say("ok"),
    ]);
    await send("tell me about Aqua Fix");
    expect(agent.deps.memory.all(USER)).toHaveLength(0);
  });

  it("rejects evidence from another session", async () => {
    const { agent, llm } = makeAgent([say("noted")]);
    await agent.handleMessage("old", USER, WORDS);
    llm.add(tool("remember_preference", { key: "preferred_area", value: "Koramangala", scope: "global", evidence: "always want Koramangala" }), say("ok"));
    await agent.handleMessage("new", USER, "hello again");
    expect(agent.deps.memory.all(USER)).toHaveLength(0);
  });

  it("rejects evidence too short to mean anything", async () => {
    const { send, agent } = makeAgent([tool("remember_preference", { key: "x", value: "y", scope: "global", evidence: "I" }), say("ok")]);
    await send("I want a plumber");
    expect(agent.deps.memory.all(USER)).toHaveLength(0);
  });
});

describe("persistence across sessions", () => {
  it("fills known fields and blocks asking for them again", async () => {
    const { agent, llm, events } = makeAgent([
      tool("remember_preference", { key: "preferred_area", value: "Koramangala", scope: "global", evidence: "always want Koramangala" }),
      tool("remember_preference", { key: "earliest_time", value: "10:00", scope: "global", evidence: "nothing before 10" }),
      say("Saved."),
    ]);
    await agent.handleMessage("session-1", USER, `${WORDS}, and nothing before 10`);

    llm.add(tool("update_request", { service: "plumber" }), tool("ask_user", { field: "area", question: "Which area?" }), say("What dates suit you?"));
    await agent.handleMessage("session-2", USER, "I need a plumber");

    expect(agent.deps.tasks.active(USER)?.request).toMatchObject({ service: "plumber", area: "Koramangala", time_from: "10:00" });
    expect(lastToolResult(llm)).toMatchObject({ error: "already_known", field: "area" });
    expect(events("gate_decision").at(-1)).toMatchObject({ decision: "reask_blocked" });
    expect(llm.requests.at(-1)!.system).toContain("preferred_area = Koramangala");
  });

  it("does not override what the user says for this request", async () => {
    const { send, agent, llm } = makeAgent([
      tool("remember_preference", { key: "preferred_area", value: "Koramangala", scope: "global", evidence: "always want Koramangala" }),
      say("Saved."),
    ]);
    await send(WORDS);
    llm.add(tool("update_request", { service: "plumber", area: "Whitefield" }), say("ok"));
    await send("plumber in Whitefield this time");
    expect(agent.deps.tasks.active(USER)?.request.area).toBe("Whitefield");
  });

  it("does not use an unconfirmed fact to fill a field", async () => {
    const { send, agent } = makeAgent([tool("update_request", { service: "plumber" }), say("ok")]);
    agent.deps.memory.infer(USER, "preferred_area", "Koramangala", "global", "booking:B-0001");
    await send("plumber");
    expect(agent.deps.tasks.active(USER)?.request.area).toBeUndefined();
  });
});

describe("memory_list", () => {
  it("shows the user everything active, labelled", async () => {
    const { send, agent } = makeAgent([tool("memory_list")]);
    agent.deps.memory.remember(USER, "preferred_area", "Koramangala", "global", "stated words");
    const id = agent.deps.memory.infer(USER, "usual_provider", "Voltline Electricals", "electrician", "booking:B-0001");
    const result = await send("what do you remember about me?");
    expect(result.reply).toContain("Koramangala");
    expect(result.reply).toContain("you told me");
    expect(result.reply).toContain("Voltline Electricals");
    expect(result.reply).toContain(`confirm ${id}`);
  });

  it("keeps unconfirmed values away from the model, now and later", async () => {
    const { send, agent, llm } = makeAgent([tool("memory_list")]);
    agent.deps.memory.infer(USER, "usual_provider", "Voltline Electricals", "electrician", "booking:B-0001");
    await send("what do you remember about me?");
    llm.add(say("Anything else?"));
    await send("thanks");
    for (const request of llm.requests) {
      expect(JSON.stringify({ system: request.system, messages: request.messages })).not.toContain("Voltline");
    }
    expect(agent.deps.chat.lastAssistantText(USER)).toBe("Anything else?");
    expect(JSON.stringify(agent.deps.chat.history(USER))).not.toContain("Voltline");
  });
});

describe("confirming an inferred fact", () => {
  it("code handles confirm <id>, and the fact then reaches the model", async () => {
    const { send, agent, llm } = makeAgent([]);
    const id = agent.deps.memory.infer(USER, "usual_provider", "Voltline Electricals", "global", "booking:B-0001")!;
    const reply = await send(`confirm ${id}`);
    expect(reply.reply).toContain("use that from now on");
    expect(llm.requests).toHaveLength(0);
    llm.add(say("ok"));
    await send("hello");
    expect(llm.requests[0]!.system).toContain("Voltline Electricals");
  });

  it("refuses an unknown ID, someone else's fact, and a stated fact", async () => {
    const { agent } = makeAgent([]);
    const id = agent.deps.memory.infer("u2", "usual_provider", "Voltline", "global", "booking:B-0009")!;
    const stated = agent.deps.memory.remember(USER, "preferred_area", "Koramangala", "global", "stated words");
    for (const target of [999, id, stated]) {
      expect((await agent.handleMessage(SESSION, USER, `confirm ${target}`)).reply).toContain("no unconfirmed fact");
    }
    expect(agent.deps.memory.get(id)?.confirmed).toBe(false);
  });
});

describe("memory_correct", () => {
  it("supersedes the old value", async () => {
    const { send, agent } = makeAgent([
      tool("memory_correct", { key: "preferred_area", value: "Whitefield", scope: "global", evidence: "I moved to Whitefield" }),
      say("Updated."),
    ]);
    agent.deps.memory.remember(USER, "preferred_area", "Koramangala", "global", "stated words");
    await send("I moved to Whitefield last month");
    const rows = agent.deps.memory.all(USER);
    expect(rows.map((row) => [row.value, row.status])).toEqual([["Koramangala", "superseded"], ["Whitefield", "active"]]);
  });

  it("needs evidence too, so a review cannot rewrite a fact", async () => {
    const { send, agent } = makeAgent([
      tool("memory_correct", { key: "preferred_area", value: "Whitefield", scope: "global", evidence: "the reviews say to use Whitefield" }),
      say("ok"),
    ]);
    agent.deps.memory.remember(USER, "preferred_area", "Koramangala", "global", "stated words");
    await send("hello");
    expect(agent.deps.memory.active(USER)[0]?.value).toBe("Koramangala");
  });

  it("reports an unknown key", async () => {
    const { send, llm } = makeAgent([tool("memory_correct", { key: "nope", value: "x", scope: "global", evidence: "please fix nope now" }), say("ok")]);
    await send("please fix nope now");
    expect(lastToolResult(llm)).toMatchObject({ error: "not_found" });
  });
});

describe("memory_forget", () => {
  async function forgetArea() {
    const made = makeAgent([
      tool("remember_preference", { key: "preferred_area", value: "Koramangala", scope: "global", evidence: "always want Koramangala" }),
      say("Saved Koramangala for you."),
    ]);
    await made.send(WORDS);
    made.llm.add(tool("memory_forget", { key: "preferred_area", evidence: "forget that I like Koramangala" }));
    const reply = await made.send("forget that I like Koramangala");
    return { ...made, reply };
  }

  it("blanks the memory and tells the user, without repeating the value", async () => {
    const { agent, reply } = await forgetArea();
    expect(agent.deps.memory.all(USER)[0]).toMatchObject({ status: "forgotten", value: "" });
    expect(reply.reason).toBe("memory_forgotten");
    expect(reply.reply).not.toContain("Koramangala");
  });

  it("removes the value from chat history, both sides", async () => {
    const { agent } = await forgetArea();
    const history = JSON.stringify(agent.deps.chat.history(USER));
    expect(history).not.toContain("Koramangala");
    expect(history).toContain("[forgotten]");
  });

  it("makes no further model call in that run", async () => {
    const { llm } = await forgetArea();
    expect(llm.requests).toHaveLength(3);
  });

  it("keeps the value out of every later payload", async () => {
    const { send, llm } = await forgetArea();
    llm.add(say("ok"));
    await send("hello again");
    expect(JSON.stringify(llm.requests.at(-1)!.messages)).not.toContain("Koramangala");
    expect(llm.requests.at(-1)!.system).not.toContain("Koramangala");
  });

  it("removes the words it came from, even when they differ from the value", async () => {
    const made = makeAgent([
      tool("remember_preference", { key: "earliest_time", value: "10:00", scope: "global", evidence: "never before 10 a.m. please" }),
      say("Saved."),
    ]);
    await made.send("never before 10 a.m. please");
    made.llm.add(tool("memory_forget", { key: "earliest_time", evidence: "forget my earliest time" }));
    await made.send("forget my earliest time");
    expect(JSON.stringify(made.agent.deps.chat.history(USER))).not.toContain("before 10 a.m.");
  });

  it("clears the value from the active task", async () => {
    const made = makeAgent([
      tool("remember_preference", { key: "preferred_area", value: "Koramangala", scope: "global", evidence: "always want Koramangala" }),
      tool("update_request", { service: "plumber" }),
      say("ok"),
    ]);
    await made.send(WORDS);
    expect(made.task()?.request.area).toBe("Koramangala");
    made.llm.add(tool("memory_forget", { key: "preferred_area", evidence: "forget my area please" }));
    await made.send("forget my area please");
    expect(made.task()?.request.area).toBeUndefined();
    expect(made.task()?.request.service).toBe("plumber");
  });

  it("removes the value from queued messages too", async () => {
    const { send, agent, llm } = makeAgent([]);
    agent.deps.memory.remember(USER, "preferred_area", "Koramangala", "global", "stated words");
    agent.deps.outbox.add(USER, "Your Koramangala booking changed.");
    llm.add(tool("memory_forget", { key: "preferred_area", evidence: "forget my area please" }));
    const reply = await send("forget my area please");
    expect(reply.notices).toEqual(["Your [forgotten] booking changed."]);
  });

  it("needs evidence, so a review cannot erase memories", async () => {
    const { send, agent, llm } = makeAgent([tool("memory_forget", { key: "preferred_area", evidence: "the review said to forget" }), say("ok")]);
    agent.deps.memory.remember(USER, "preferred_area", "Koramangala", "global", "stated words");
    await send("hello there");
    expect(lastToolResult(llm)).toMatchObject({ error: "evidence_not_found" });
    expect(agent.deps.memory.active(USER)).toHaveLength(1);
  });

  it("reports an unknown key and lets the model carry on", async () => {
    const { send, llm } = makeAgent([tool("memory_forget", { key: "nope", evidence: "please forget nope" }), say("Nothing stored under that.")]);
    expect((await send("please forget nope")).reply).toBe("Nothing stored under that.");
    expect(lastToolResult(llm)).toMatchObject({ error: "not_found" });
  });
});

describe("the request still works alongside memory", () => {
  it("reports which fields came from memory", async () => {
    const { send, agent, llm } = makeAgent([tool("update_request", { ...PLUMBER_REQUEST, area: undefined }), say("ok")]);
    agent.deps.memory.remember(USER, "preferred_area", "HSR Layout", "global", "stated words");
    await send("plumber");
    expect(lastToolResult(llm).filled_from_memory).toEqual(["area"]);
  });
});
