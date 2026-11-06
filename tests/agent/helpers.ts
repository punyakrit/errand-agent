import { DatabaseSync } from "node:sqlite";
import { Agent } from "../../src/agent/agent.ts";
import { FakeClock } from "../../src/clock.ts";
import type { Limits } from "../../src/config.ts";
import { ScriptedLLM, type Step } from "../../src/llm/scripted.ts";
import { MockEnv } from "../../src/mock/env.ts";
import { FaultyTools, type Faults } from "../../src/mock/faults.ts";
import { TraceSink } from "../../src/trace/tracer.ts";

export const USER = "u1";
export const SESSION = "s1";

export const PLUMBER_REQUEST = {
  service: "plumber", area: "Indiranagar", date_from: "2026-11-09", date_to: "2026-11-15",
  time_from: "08:00", time_to: "12:00", budget_inr: 1500,
};
export const PLUMBER_SEARCH = {
  service: "plumber", area: "Indiranagar", date_range: { from: "2026-11-09", to: "2026-11-15" },
};

export function makeAgent(steps: Step[] = [], options: { limits?: Partial<Limits>; faults?: Faults; seed?: number } = {}) {
  const clock = new FakeClock();
  const mock = new MockEnv({ db: new DatabaseSync(":memory:"), clock, seed: options.seed ?? 1 });
  const tools = options.faults ? new FaultyTools(mock, options.faults) : mock;
  const llm = new ScriptedLLM(steps);
  const sink = new TraceSink({ clock });
  const agent = new Agent({ db: new DatabaseSync(":memory:"), mock: tools, llm, clock, sink, limits: options.limits });
  const task = () => agent.deps.tasks.active(USER);
  const events = (type: string) => sink.events.filter((event) => event.type === type);
  const send = (text: string) => agent.handleMessage(SESSION, USER, text);
  return { agent, clock, mock, llm, sink, task, events, send };
}
