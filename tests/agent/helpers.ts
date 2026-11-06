import { DatabaseSync } from "node:sqlite";
import { Agent } from "../../src/agent/agent.ts";
import type { Checkpoint } from "../../src/agent/run.ts";
import { FakeClock } from "../../src/clock.ts";
import type { Limits } from "../../src/config.ts";
import { say, ScriptedLLM, tool, type Step } from "../../src/llm/scripted.ts";
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

export interface AgentOptions {
  limits?: Partial<Limits>;
  faults?: Faults;
  seed?: number;
  checkpoint?: (name: Checkpoint) => Promise<void>;
}

export function makeAgent(steps: Step[] = [], options: AgentOptions = {}) {
  const clock = new FakeClock();
  const mock = new MockEnv({ db: new DatabaseSync(":memory:"), clock, seed: options.seed ?? 1 });
  const tools = options.faults ? new FaultyTools(mock, options.faults) : mock;
  const llm = new ScriptedLLM(steps);
  const sink = new TraceSink({ clock });
  const db = new DatabaseSync(":memory:");
  const agent = new Agent({ db, mock: tools, llm, clock, sink, limits: options.limits, checkpoint: options.checkpoint });
  const task = () => agent.deps.tasks.active(USER);
  const events = (type: string) => sink.events.filter((event) => event.type === type);
  const send = (text: string) => agent.handleMessage(SESSION, USER, text);
  // A new process on the same databases.
  const restart = () => new Agent({ db, mock: tools, llm, clock, sink, limits: options.limits });
  return { agent, clock, mock, llm, sink, task, events, send, restart };
}

export const SHARMA_SLOT = "2026-11-10T09:00:00+05:30";

// Runs a conversation up to the approval card for a plumber booking.
export async function atApproval(options: AgentOptions = {}, configure?: (made: ReturnType<typeof makeAgent>) => void) {
  const made = makeAgent([tool("update_request", PLUMBER_REQUEST), tool("search_providers", PLUMBER_SEARCH), say("Pick one.")], options);
  configure?.(made);
  await made.send("Find a plumber in Indiranagar this week, mornings only, under 1500");
  made.llm.add(tool("hold_slot", { provider_id: "pl_1", slot: SHARMA_SLOT }), tool("request_approval"));
  const card = await made.send("Sharma at 9 on Tuesday");
  return { ...made, card };
}
