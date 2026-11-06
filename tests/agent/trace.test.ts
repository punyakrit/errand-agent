import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.ts";
import { message, say, tool } from "../../src/llm/scripted.ts";
import { sanitize, TraceSink } from "../../src/trace/tracer.ts";
import { makeAgent } from "./helpers.ts";

describe("trace", () => {
  it("writes one JSONL file per run", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-"));
    const sink = new TraceSink({ clock: new FakeClock(), dir });
    const first = sink.startRun("s1", "user_message");
    first.emit("run_end", { reason: "reply" });
    const second = sink.startRun("s1", "user_message");
    second.emit("run_end", { reason: "reply" });
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["s1-001.jsonl", "s1-002.jsonl"]);
    const lines = readFileSync(join(dir, files[0]!), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual(["run_start", "run_end"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("records model calls with tokens, cost, latency and stop reason", async () => {
    const { send, events } = makeAgent([message([{ type: "text", text: "hi" } as never], "end_turn", { input: 1000, output: 100 })]);
    await send("hi");
    const event = events("model_call")[0]!;
    expect(event).toMatchObject({ input_tokens: 1000, output_tokens: 100, stop_reason: "end_turn" });
    expect(event.estimated_cost_usd).toBeCloseTo(0.003, 6);
    expect(typeof event.latency_ms).toBe("number");
  });

  it("records tool calls with arguments, result, latency and attempt", async () => {
    const { send, events } = makeAgent([tool("get_provider", { provider_id: "pl_1" }), say("ok")]);
    await send("hi");
    const event = events("tool_call")[0]!;
    expect(event).toMatchObject({ name: "get_provider", args: { provider_id: "pl_1" }, attempt: 1 });
    expect(event.result).toBeTruthy();
    expect(typeof event.latency_ms).toBe("number");
  });

  it("writes a context manifest before each model call", async () => {
    const { send, events } = makeAgent([tool("list_bookings"), say("ok")]);
    await send("hi");
    const manifests = events("context_manifest");
    expect(manifests).toHaveLength(2);
    expect(manifests[0]).toMatchObject({ turn: 1, memory_included: [], tokens: { budget: 3000 } });
    expect(manifests[0]!.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifests[1]!.payload_sha256).not.toBe(manifests[0]!.payload_sha256);
  });

  it("opens and closes each run", async () => {
    const { send, sink } = makeAgent([say("ok")]);
    await send("hi");
    expect(sink.events[0]?.type).toBe("run_start");
    expect(sink.events.at(-1)?.type).toBe("run_end");
  });
});

describe("sanitize", () => {
  it("removes keys and anything that looks like an API key", () => {
    const key = `sk-ant-${"a".repeat(30)}`;
    const clean = JSON.stringify(sanitize({ api_key: key, nested: { note: `used ${key} here`, authorization: "Bearer x" } }));
    expect(clean).not.toContain(key);
    expect(clean).not.toContain("Bearer x");
    expect(clean).toContain("[redacted]");
  });

  it("cuts very long text", () => {
    expect((sanitize("x".repeat(5000)) as string).length).toBeLessThan(700);
  });

  it("leaves numbers and token counts alone", () => {
    expect(sanitize({ input_tokens: 5, ok: true })).toEqual({ input_tokens: 5, ok: true });
  });
});
