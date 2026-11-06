import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../clock.ts";
import type { Limits } from "../config.ts";
import type { LLM } from "../llm/types.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { MockTools } from "../mock/types.ts";
import type { RunTrace } from "../trace/tracer.ts";
import type { ApprovalCard, ApprovalStore } from "./approvals.ts";
import type { ChatStore } from "./chat.ts";
import type { FinishReason } from "./finish.ts";
import type { OpStore } from "./ops.ts";
import type { Outbox } from "./outbox.ts";
import { canMove, IllegalTransition, type State } from "./state.ts";
import type { Task, TaskStore } from "./tasks.ts";

export interface AgentDeps {
  db: DatabaseSync;
  tasks: TaskStore;
  chat: ChatStore;
  approvals: ApprovalStore;
  ops: OpStore;
  outbox: Outbox;
  memory: MemoryStore;
  checkpoint: (name: Checkpoint) => Promise<void>;
  mock: MockTools;
  llm: LLM;
  clock: Clock;
  limits: Limits;
}

// Named points in an action. Production ignores them. Tests use them to crash
// the process, or to change something at an exact moment.
export type Checkpoint = "approval_granted" | "op_started" | "book_returned" | "rebook_task_created";

export interface Outcome {
  reason: FinishReason;
  text?: string; // omitted when finish() should use its fixed message
  historyText?: string; // saved to chat instead of text, when text must not reach the model
  approval?: { approval_id: string; card: ApprovalCard };
}

const READ_ONLY = new Set<keyof MockTools>(["search_providers", "get_provider", "get_booking_status", "list_bookings"]);

// Everything about one bounded piece of work: counters, the trace, and helpers
// that keep state changes and tool calls honest.
export class Run {
  readonly deps: AgentDeps;
  readonly sessionId: string;
  readonly userId: string;
  readonly messageId: number;
  readonly trace: RunTrace;
  readonly startedAt: number;
  turns = 0;
  toolCalls = 0;
  badInputs = 0;
  questions: string[] = [];
  end: Outcome | undefined; // set by a tool to stop the loop after this batch

  constructor(deps: AgentDeps, sessionId: string, userId: string, messageId: number, trace: RunTrace) {
    this.deps = deps;
    this.sessionId = sessionId;
    this.userId = userId;
    this.messageId = messageId;
    this.trace = trace;
    this.startedAt = deps.clock.now();
  }

  outOfTime(): boolean {
    return this.deps.clock.now() - this.startedAt >= this.deps.limits.wallClockMs;
  }

  outOfToolCalls(): boolean {
    return this.toolCalls >= this.deps.limits.maxToolCalls;
  }

  activeTask(): Task | undefined {
    return this.deps.tasks.active(this.userId);
  }

  // The only way a task changes state. Illegal moves are traced, then thrown.
  setState(task: Task, to: State, info: Record<string, unknown> = {}): void {
    if (task.state === to) return;
    const from = task.state;
    if (!canMove(from, to)) {
      this.trace.emit("state_transition", { task_id: task.task_id, from, to, illegal: true, ...info });
      throw new IllegalTransition(from, to);
    }
    task.state = to;
    this.deps.tasks.save(task);
    this.trace.emit("state_transition", { task_id: task.task_id, from, to, ...info });
  }

  // Calls a mock tool and traces each attempt. Only read-only tools are retried
  // here, because retrying a side effect needs an idempotency key and a decision.
  async callMock<K extends keyof MockTools>(
    tool: K,
    args: Parameters<MockTools[K]>[0],
  ): Promise<Awaited<ReturnType<MockTools[K]>>> {
    const maxAttempts = READ_ONLY.has(tool) ? 1 + this.deps.limits.maxToolRetries : 1;
    const call = this.deps.mock[tool] as (input: typeof args) => Promise<Awaited<ReturnType<MockTools[K]>>>;
    for (let attempt = 1; ; attempt++) {
      this.toolCalls += 1;
      const started = performance.now();
      try {
        const result = await call.call(this.deps.mock, args);
        const latency_ms = Math.round(performance.now() - started);
        this.trace.emit("tool_call", { name: tool, args, result, latency_ms, attempt });
        return result;
      } catch (error) {
        const latency_ms = Math.round(performance.now() - started);
        this.trace.emit("tool_call", { name: tool, args, error: String(error), latency_ms, attempt });
        if (attempt >= maxAttempts || this.outOfToolCalls()) throw error;
      }
    }
  }
}
