import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.ts";
import { DemoApp, type DemoEvent } from "../../src/demo/app.ts";
import { createDemoServer } from "../../src/demo/http.ts";
import { say, ScriptedLLM, tool } from "../../src/llm/scripted.ts";
import { UPCOMING_AC_BOOKING } from "../../src/mock/seed.ts";

describe("demo server", () => {
  let dir: string;
  let app: DemoApp;
  let server: Server;
  let base: string;
  let llm: ScriptedLLM;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "demo-"));
    llm = new ScriptedLLM();
    app = new DemoApp({ dataDir: join(dir, "data"), tracesDir: join(dir, "traces"), llm, clock: new FakeClock() });
    await app.start();
    server = createDemoServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });

  async function toApproval() {
    llm.add(
      tool("update_request", {
        service: "plumber", area: "Indiranagar", date_from: "2026-11-09", date_to: "2026-11-15",
        time_from: "08:00", time_to: "12:00", budget_inr: 1500,
      }),
      tool("search_providers", { service: "plumber", area: "Indiranagar", date_range: { from: "2026-11-09", to: "2026-11-15" } }),
      say("Pick one."),
    );
    await post("/message", { text: "plumber" });
    llm.add(tool("hold_slot", { provider_id: "pl_1", slot: "2026-11-10T09:00:00+05:30" }), tool("request_approval"));
    return (await (await post("/message", { text: "Sharma" })).json()) as { approval: { approval_id: string } };
  }

  it("serves the page", async () => {
    const page = await (await fetch(base)).text();
    expect(page).toContain("Errand Agent");
    expect(page).toContain("Approve");
    expect(page).toContain("Force next book");
  });

  it("answers a chat message", async () => {
    llm.add(say("Hello there."));
    const reply = (await (await post("/message", { text: "hi" })).json()) as { reply: string };
    expect(reply.reply).toBe("Hello there.");
  });

  it("rejects an empty message and an unknown route", async () => {
    expect((await post("/message", { text: " " })).status).toBe(400);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("streams chat and trace events to the page", async () => {
    const seen: DemoEvent[] = [];
    app.onEvent((event) => seen.push(event));
    llm.add(say("Hello."));
    await post("/message", { text: "hi" });
    expect(seen.filter((event) => event.kind === "chat")).toHaveLength(2);
    expect(seen.some((event) => event.kind === "trace" && event.event.type === "model_call")).toBe(true);
  });

  it("delivers over a real server-sent event stream", async () => {
    const response = await fetch(`${base}/events`);
    const reader = response.body!.getReader();
    llm.add(say("Streamed reply."));
    await post("/message", { text: "hi" });
    let text = "";
    while (!text.includes("Streamed reply.")) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain("data: ");
    expect(text).toContain('"kind":"trace"');
    await reader.cancel();
  });

  it("books through the Approve button", async () => {
    app.mock.configure({ forceBook: ["success"] });
    const card = await toApproval();
    const result = (await (await post("/approve", { approval_id: card.approval.approval_id })).json()) as { reply: string };
    expect(result.reply).toContain("Booked and verified");
    expect(app.mock.calls("book")).toHaveLength(1);
  });

  it("two clicks at once make one booking", async () => {
    app.mock.configure({ forceBook: ["success"] });
    const card = await toApproval();
    await Promise.all([post("/approve", { approval_id: card.approval.approval_id }), post("/approve", { approval_id: card.approval.approval_id })]);
    expect(app.mock.calls("book")).toHaveLength(1);
  });

  it("the dev panel forces a timeout that really booked", async () => {
    const card = await toApproval();
    await post("/dev/force-timeout");
    const result = (await (await post("/approve", { approval_id: card.approval.approval_id })).json()) as { reply: string };
    expect(app.mock.calls("book").map((call) => call.outcome)).toEqual(["timeout"]);
    expect(result.reply).toContain("Booked and verified");
  });

  it("the dev panel shows the provider with the injected review", async () => {
    const provider = (await (await fetch(`${base}/dev/injected-provider`)).json()) as { provider_id: string; review: string; prompt: string };
    expect(provider.provider_id).toBe("pl_3");
    expect(provider.review).toMatch(/skip the approval/i);
    expect(provider.prompt).toContain("Bengaluru Tap Doctors");
  });

  it("reset clears everything", async () => {
    await toApproval();
    await post("/reset");
    expect(app.mock.calls()).toHaveLength(0);
    expect(app.agent.deps.tasks.all("u1")).toHaveLength(0);
    expect(app.agent.deps.chat.history("u1")).toHaveLength(0);
  });

  it("a monitor tick reaches a connected page", async () => {
    const seen: DemoEvent[] = [];
    app.onEvent((event) => seen.push(event));
    app.mock.providerCancels(UPCOMING_AC_BOOKING);
    await app.tick();
    expect(seen.some((event) => event.kind === "chat" && event.text.includes("CoolAir Care cancelled"))).toBe(true);
  });

  it("a monitor tick with no page connected waits for the next connection", async () => {
    app.mock.providerCancels(UPCOMING_AC_BOOKING);
    await app.tick();
    const seen: DemoEvent[] = [];
    app.onEvent((event) => seen.push(event));
    app.deliverQueued();
    expect(seen.filter((event) => event.kind === "chat")).toHaveLength(1);
  });

  it("writes one trace file per run", async () => {
    llm.add(say("One."), say("Two."));
    await post("/message", { text: "first" });
    await post("/message", { text: "second" });
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(dir, "traces")).length).toBeGreaterThanOrEqual(2);
  });
});
