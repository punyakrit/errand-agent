import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../clock.ts";

export type TraceType =
  | "run_start" | "state_transition" | "context_manifest" | "model_call" | "tool_call"
  | "gate_decision" | "approval_created" | "approval_granted" | "approval_voided"
  | "approval_consumed" | "limit_hit" | "proactive_event" | "run_end";

export interface TraceEvent {
  type: TraceType;
  at: string;
  run_id: string;
  session_id: string;
  [key: string]: unknown;
}

const MAX_STRING = 600;
const SECRET_KEY = /api[_-]?key|authorization|secret|password/i;
const SECRET_VALUE = /sk-ant-[A-Za-z0-9_-]+/g;

// Makes a value safe to log: long text is cut, secrets are removed.
export function sanitize(value: unknown): unknown {
  if (typeof value === "string") {
    const clean = value.replace(SECRET_VALUE, "[redacted]");
    return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}...[cut]` : clean;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[redacted]" : sanitize(item)]),
    );
  }
  return value;
}

// Collects trace events for a process. With a directory set, each run is also
// written to its own JSONL file. Evals skip the file and read `events` directly.
export class TraceSink {
  readonly events: TraceEvent[] = [];
  private dir: string | undefined;
  private clock: Clock;
  private listeners: ((event: TraceEvent) => void)[] = [];
  private runCount = 0;

  constructor(options: { clock: Clock; dir?: string }) {
    this.clock = options.clock;
    this.dir = options.dir;
    if (this.dir) mkdirSync(this.dir, { recursive: true });
  }

  onEvent(listener: (event: TraceEvent) => void): void {
    this.listeners.push(listener);
  }

  startRun(sessionId: string, kind: string): RunTrace {
    this.runCount += 1;
    const runId = `${sessionId}-${String(this.runCount).padStart(3, "0")}`;
    const trace = new RunTrace(this, runId, sessionId);
    trace.emit("run_start", { kind });
    return trace;
  }

  write(event: Omit<TraceEvent, "at">): void {
    const full = { ...event, at: new Date(this.clock.now()).toISOString() } as TraceEvent;
    this.events.push(full);
    if (this.dir) appendFileSync(join(this.dir, `${event.run_id}.jsonl`), `${JSON.stringify(full)}\n`);
    for (const listener of this.listeners) listener(full);
  }
}

// The trace of one run. A run is one bounded piece of work: a user message,
// an approval click, a monitor tick or a startup reconcile.
export class RunTrace {
  private sink: TraceSink;
  readonly runId: string;
  private sessionId: string;

  constructor(sink: TraceSink, runId: string, sessionId: string) {
    this.sink = sink;
    this.runId = runId;
    this.sessionId = sessionId;
  }

  emit(type: TraceType, data: Record<string, unknown> = {}): void {
    this.sink.write({
      ...(sanitize(data) as Record<string, unknown>),
      type,
      run_id: this.runId,
      session_id: this.sessionId,
    });
  }
}
