import { DatabaseSync } from "node:sqlite";
import type Anthropic from "@anthropic-ai/sdk";
import { Agent } from "../agent/agent.ts";
import type { AgentReply } from "../agent/finish.ts";
import type { Checkpoint } from "../agent/run.ts";
import { FakeClock } from "../clock.ts";
import type { Limits } from "../config.ts";
import { ScriptedLLM, type Step } from "../llm/scripted.ts";
import type { LLM, LlmRequest } from "../llm/types.ts";
import { MockEnv } from "../mock/env.ts";
import { FaultyTools, type Faults } from "../mock/faults.ts";
import { Monitor } from "../monitor/monitor.ts";
import { TraceSink } from "../trace/tracer.ts";

export const USER = "u1";
export const SESSION = "session-1";

export interface WorldOptions {
  seed?: number;
  limits?: Partial<Limits>;
  faults?: Faults;
  llm?: LLM; // defaults to a ScriptedLLM
  startAt?: string;
}

// Wraps the model so every request is checked at the moment it is sent, against
// what is forbidden at that moment. This is invariant 5.
class PayloadChecker implements LLM {
  readonly requests: LlmRequest[] = [];
  private inner: LLM;
  private world: World;

  constructor(inner: LLM, world: World) {
    this.inner = inner;
    this.world = world;
  }

  complete(request: LlmRequest): Promise<Anthropic.Message> {
    this.requests.push(structuredClone(request));
    this.world.checkPayload(request);
    return this.inner.complete(request);
  }
}

// One simulated environment for one scenario.
export class World {
  readonly clock: FakeClock;
  readonly mock: MockEnv;
  readonly tools: MockEnv | FaultyTools;
  readonly scripted: ScriptedLLM;
  readonly llm: PayloadChecker;
  readonly sink: TraceSink;
  readonly db = new DatabaseSync(":memory:");
  readonly replies: string[] = [];
  readonly payloadViolations: string[] = [];
  readonly crashedRuns = new Set<string>();
  readonly forgottenValues = new Set<string>();
  readonly options: WorldOptions;
  agent: Agent;
  monitor: Monitor;
  private checkpointHook: ((name: Checkpoint) => Promise<void>) | undefined;

  constructor(options: WorldOptions = {}) {
    this.options = options;
    this.clock = new FakeClock(options.startAt);
    this.mock = new MockEnv({ db: new DatabaseSync(":memory:"), clock: this.clock, seed: options.seed ?? 1 });
    this.tools = options.faults ? new FaultyTools(this.mock, options.faults) : this.mock;
    this.scripted = new ScriptedLLM();
    this.llm = new PayloadChecker(options.llm ?? this.scripted, this);
    this.sink = new TraceSink({ clock: this.clock });
    this.agent = this.newAgent();
    this.monitor = new Monitor(this.agent, [USER]);
  }

  private newAgent(): Agent {
    const agent = new Agent({
      db: this.db, mock: this.tools, llm: this.llm, clock: this.clock, sink: this.sink, limits: this.options.limits,
      checkpoint: (name) => this.checkpointHook?.(name) ?? Promise.resolve(),
    });
    // Remember every value forgotten, because the table no longer holds it.
    const store = agent.deps.memory;
    const original = store.forget.bind(store);
    store.forget = (userId, key, scope) => {
      const texts = original(userId, key, scope);
      for (const text of texts) this.forgottenValues.add(text);
      return texts;
    };
    return agent;
  }

  script(...steps: Step[]): void {
    this.scripted.add(...steps);
  }

  onCheckpoint(hook: (name: Checkpoint) => Promise<void>): void {
    this.checkpointHook = hook;
  }

  private note(reply: AgentReply): AgentReply {
    this.replies.push(reply.reply, ...reply.notices);
    return reply;
  }

  async user(text: string, session = SESSION): Promise<AgentReply> {
    return this.note(await this.agent.handleMessage(session, USER, text));
  }

  async click(approvalId: string): Promise<AgentReply> {
    return this.note(await this.agent.approve(SESSION, USER, approvalId));
  }

  // Sends a message and stops the process at a named point, leaving the run
  // unfinished, as a real crash would.
  async userThenCrash(text: string, point: Checkpoint): Promise<void> {
    let reached: () => void;
    const crashed = new Promise<void>((resolve) => { reached = resolve; });
    this.onCheckpoint(async (name) => {
      if (name !== point) return;
      reached();
      await new Promise(() => {});
    });
    void this.agent.handleMessage(SESSION, USER, text);
    await crashed;
    this.onCheckpoint(async () => {});
    const finished = new Set(this.sink.events.filter((event) => event.type === "run_end").map((event) => event.run_id));
    for (const event of this.sink.events) {
      if (event.type === "run_start" && !finished.has(event.run_id)) this.crashedRuns.add(event.run_id);
    }
  }

  // A new process on the same databases.
  async restart(): Promise<void> {
    this.agent = this.newAgent();
    this.monitor = new Monitor(this.agent, [USER]);
    await this.agent.reconcile();
    this.replies.push(...this.agent.deps.outbox.drain(USER));
  }

  async tick(): Promise<void> {
    await this.monitor.tick();
    this.replies.push(...this.agent.deps.outbox.drain(USER));
  }

  // Forgotten values must appear nowhere. Unconfirmed facts must not appear in
  // the prompt or chat text. They may appear in tool data about real bookings,
  // which is a fact from the provider, not a memory.
  checkPayload(request: LlmRequest): void {
    const everything = JSON.stringify({ system: request.system, messages: request.messages });
    const textOnly = [request.system, ...request.messages.filter((m) => typeof m.content === "string").map((m) => m.content as string)].join("\n");
    for (const value of this.forgottenValues) {
      if (everything.toLowerCase().includes(value.toLowerCase())) this.payloadViolations.push(`forgotten value in payload: ${value}`);
    }
    for (const memory of this.agent.deps.memory.active(USER)) {
      if (memory.kind === "inferred" && !memory.confirmed && textOnly.includes(memory.value)) {
        this.payloadViolations.push(`unconfirmed value in payload: ${memory.value}`);
      }
    }
  }
}
