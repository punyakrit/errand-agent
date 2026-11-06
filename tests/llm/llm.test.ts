import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnthropicLLM } from "../../src/llm/anthropic.ts";
import { estimateCostUsd } from "../../src/llm/cost.ts";
import { RecordedLLM, RecordingLLM } from "../../src/llm/recorded.ts";
import { say, ScriptedLLM, tool } from "../../src/llm/scripted.ts";

const REQUEST = { system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [], timeoutMs: 1000 };

describe("AnthropicLLM", () => {
  it("cannot be constructed without LIVE=1", () => {
    const before = process.env.LIVE;
    delete process.env.LIVE;
    expect(() => new AnthropicLLM()).toThrow("LIVE=1");
    process.env.LIVE = "0";
    expect(() => new AnthropicLLM()).toThrow("LIVE=1");
    if (before === undefined) delete process.env.LIVE;
    else process.env.LIVE = before;
  });
});

describe("ScriptedLLM", () => {
  it("plays steps in order and keeps each request", async () => {
    const llm = new ScriptedLLM([tool("list_bookings"), say("done")]);
    expect((await llm.complete(REQUEST)).stop_reason).toBe("tool_use");
    expect((await llm.complete(REQUEST)).stop_reason).toBe("end_turn");
    expect(llm.requests).toHaveLength(2);
  });

  it("can build a response from the request", async () => {
    const llm = new ScriptedLLM([(request) => say(`system was ${request.system}`)]);
    const response = await llm.complete(REQUEST);
    expect(response.content[0]).toMatchObject({ text: "system was s" });
  });

  it("fails loudly when the script runs out", async () => {
    await expect(new ScriptedLLM([]).complete(REQUEST)).rejects.toThrow("ran out of steps");
  });
});

describe("RecordedLLM and RecordingLLM", () => {
  it("saves real responses, then replays them in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recording-"));
    const path = join(dir, "run.json");
    const recording = new RecordingLLM(new ScriptedLLM([tool("list_bookings"), say("hello")]), path, "a test");
    await recording.complete(REQUEST);
    await recording.complete(REQUEST);
    expect(JSON.parse(readFileSync(path, "utf8")).note).toBe("a test");

    const replay = new RecordedLLM(path);
    expect((await replay.complete(REQUEST)).stop_reason).toBe("tool_use");
    expect((await replay.complete(REQUEST)).content[0]).toMatchObject({ text: "hello" });
    await expect(replay.complete(REQUEST)).rejects.toThrow("ran out of responses");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a recording file with thinking blocks unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recording-"));
    const path = join(dir, "run.json");
    const block = { type: "thinking", thinking: "", signature: "abc" };
    writeFileSync(path, JSON.stringify({ note: "n", responses: [{ content: [block], stop_reason: "end_turn" }] }));
    expect((await new RecordedLLM(path).complete(REQUEST)).content[0]).toEqual(block);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("cost estimate", () => {
  it("uses the brief's prices", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
    expect(estimateCostUsd(usage as never)).toBeCloseTo(12.2, 6);
    expect(estimateCostUsd({ input_tokens: 1000, output_tokens: 100 } as never)).toBeCloseTo(0.003, 6);
  });
});
