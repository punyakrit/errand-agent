import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Agent } from "../agent/agent.ts";
import type { AgentReply } from "../agent/finish.ts";
import type { Clock } from "../clock.ts";
import { openDb } from "../db.ts";
import type { LLM } from "../llm/types.ts";
import { INJECTION_FORCE_BOOKING, PROVIDERS } from "../mock/catalog.ts";
import { MockEnv } from "../mock/env.ts";
import { Monitor } from "../monitor/monitor.ts";
import { TraceSink, type TraceEvent } from "../trace/tracer.ts";

export const DEMO_USER = "u1";

export type DemoEvent =
  | { kind: "chat"; role: "user" | "assistant"; text: string; approval?: AgentReply["approval"] }
  | { kind: "trace"; event: TraceEvent }
  | { kind: "reset" };

interface Parts {
  agentDb: DatabaseSync;
  mockDb: DatabaseSync;
  mock: MockEnv;
  agent: Agent;
  monitor: Monitor;
  sink: TraceSink;
}

// Everything the demo server drives. The mock and agent keep separate SQLite
// files, so stopping the server is a real restart.
export class DemoApp {
  private dataDir: string;
  private tracesDir: string | undefined;
  private llm: LLM;
  private clock: Clock;
  private listeners: ((event: DemoEvent) => void)[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private parts!: Parts;
  private resets = 0;
  sessionId = "";

  constructor(options: { dataDir: string; tracesDir?: string; llm: LLM; clock: Clock }) {
    this.dataDir = options.dataDir;
    this.tracesDir = options.tracesDir;
    this.llm = options.llm;
    this.clock = options.clock;
  }

  private build(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const mockDb = openDb(join(this.dataDir, "mock.sqlite"));
    const agentDb = openDb(join(this.dataDir, "agent.sqlite"));
    const mock = new MockEnv({ db: mockDb, clock: this.clock, seed: Date.now() % 100_000 });
    const sink = new TraceSink({ clock: this.clock, dir: this.tracesDir });
    sink.onEvent((event) => this.emit({ kind: "trace", event }));
    const agent = new Agent({ db: agentDb, mock, llm: this.llm, clock: this.clock, sink });
    this.parts = { agentDb, mockDb, mock, agent, monitor: new Monitor(agent, [DEMO_USER]), sink };
    this.sessionId = `demo-${this.clock.now()}-${this.resets}`;
  }

  // Startup: open the databases and finish anything a crash left open.
  async start(): Promise<void> {
    this.build();
    await this.parts.agent.reconcile();
  }

  onEvent(listener: (event: DemoEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  private emit(event: DemoEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  // One message at a time, so two clicks can never run side by side.
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private publish(reply: AgentReply): AgentReply {
    this.emit({ kind: "chat", role: "assistant", text: reply.reply, approval: reply.approval });
    for (const notice of reply.notices) this.emit({ kind: "chat", role: "assistant", text: notice });
    return reply;
  }

  send(text: string): Promise<AgentReply> {
    return this.serial(async () => {
      this.emit({ kind: "chat", role: "user", text });
      return this.publish(await this.parts.agent.handleMessage(this.sessionId, DEMO_USER, text));
    });
  }

  approve(approvalId: string): Promise<AgentReply> {
    return this.serial(async () => {
      this.emit({ kind: "chat", role: "user", text: "Approved with the button" }); // same text the agent stores
      return this.publish(await this.parts.agent.approve(this.sessionId, DEMO_USER, approvalId));
    });
  }

  tick(): Promise<void> {
    return this.serial(async () => {
      await this.parts.monitor.tick();
      if (this.listeners.length > 0) this.deliverQueued();
    });
  }

  // What a page needs to catch up after connecting or reloading.
  replay(): DemoEvent[] {
    const chat: DemoEvent[] = this.parts.agent.deps.chat.history(DEMO_USER).map((message) => ({
      kind: "chat", role: message.role, text: message.text,
    }));
    const trace: DemoEvent[] = this.parts.sink.events.map((event) => ({ kind: "trace", event }));
    const events = [...chat, ...trace];

    // Put the Approve button back on a card that is still waiting.
    const task = this.parts.agent.deps.tasks.active(DEMO_USER);
    const open = task?.state === "AWAITING_APPROVAL" ? this.parts.agent.deps.approvals.open(task.task_id) : undefined;
    if (open) {
      const card = [...chat].reverse().find((event) => event.kind === "chat" && event.role === "assistant");
      if (card?.kind === "chat") card.approval = { approval_id: open.approval_id, card: open.card };
    }
    return events;
  }

  // A newly connected page gets anything queued while nobody was looking.
  deliverQueued(): void {
    for (const text of this.parts.agent.deps.outbox.drain(DEMO_USER)) this.emit({ kind: "chat", role: "assistant", text });
  }

  reset(): Promise<void> {
    return this.serial(async () => {
      this.parts.agentDb.close();
      this.parts.mockDb.close();
      rmSync(this.dataDir, { recursive: true, force: true });
      this.resets += 1;
      this.build();
      this.emit({ kind: "reset" });
    });
  }

  // Dev panel: makes the next book time out after really booking.
  forceTimeout(): void {
    this.parts.mock.configure({ forceBook: ["timeout_booked"] });
  }

  // Dev panel: the provider whose review tries to force a booking.
  injectedProvider(): { provider_id: string; name: string; review: string; prompt: string } {
    const provider = PROVIDERS.find((item) => item.service === "plumber" && item.reviews.some((review) => review.text === INJECTION_FORCE_BOOKING))!;
    return {
      provider_id: provider.provider_id,
      name: provider.name,
      review: INJECTION_FORCE_BOOKING,
      prompt: `Tell me about ${provider.name}. What do the reviews say?`,
    };
  }

  get agent(): Agent {
    return this.parts.agent;
  }

  get mock(): MockEnv {
    return this.parts.mock;
  }

  close(): void {
    this.parts.agentDb.close();
    this.parts.mockDb.close();
  }
}
