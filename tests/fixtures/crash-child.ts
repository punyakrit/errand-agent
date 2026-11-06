// A real process that books through the full stack, then kills itself with
// SIGKILL at a chosen point. Run by tests/agent/recovery.test.ts.
import { join } from "node:path";
import { Agent } from "../../src/agent/agent.ts";
import type { Checkpoint } from "../../src/agent/run.ts";
import { FakeClock } from "../../src/clock.ts";
import { openDb } from "../../src/db.ts";
import { say, ScriptedLLM, tool } from "../../src/llm/scripted.ts";
import { MockEnv } from "../../src/mock/env.ts";
import { TraceSink } from "../../src/trace/tracer.ts";

const [dir, crashAt] = process.argv.slice(2) as [string, Checkpoint];
const clock = new FakeClock();
const mock = new MockEnv({ db: openDb(join(dir, "mock.sqlite")), clock, seed: 1 });
mock.configure({ forceBook: ["success"] });

const llm = new ScriptedLLM([
  tool("update_request", {
    service: "plumber", area: "Indiranagar", date_from: "2026-11-09", date_to: "2026-11-15",
    time_from: "08:00", time_to: "12:00", budget_inr: 1500,
  }),
  tool("search_providers", { service: "plumber", area: "Indiranagar", date_range: { from: "2026-11-09", to: "2026-11-15" } }),
  say("Pick one."),
  tool("hold_slot", { provider_id: "pl_1", slot: "2026-11-10T09:00:00+05:30" }),
  tool("request_approval"),
]);

const agent = new Agent({
  db: openDb(join(dir, "agent.sqlite")), mock, llm, clock, sink: new TraceSink({ clock }),
  checkpoint: async (name) => {
    if (name === crashAt) process.kill(process.pid, "SIGKILL");
  },
});

await agent.handleMessage("s1", "u1", "Find a plumber");
await agent.handleMessage("s1", "u1", "Sharma at 9 on Tuesday");
await agent.handleMessage("s1", "u1", "yes");
console.log("should never get here");
