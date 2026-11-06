import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../clock.ts";
import { LIMITS, type Limits } from "../config.ts";
import type { LLM } from "../llm/types.ts";
import type { MockTools } from "../mock/types.ts";
import type { TraceSink } from "../trace/tracer.ts";
import { ChatStore } from "./chat.ts";
import { finish, type AgentReply } from "./finish.ts";
import { runModelLoop } from "./loop.ts";
import { Run, type AgentDeps } from "./run.ts";
import { createAgentSchema } from "./schema.ts";
import { TaskStore } from "./tasks.ts";

export class Agent {
  readonly deps: AgentDeps;
  private sink: TraceSink;

  constructor(options: { db: DatabaseSync; mock: MockTools; llm: LLM; clock: Clock; sink: TraceSink; limits?: Partial<Limits> }) {
    createAgentSchema(options.db);
    this.sink = options.sink;
    this.deps = {
      db: options.db,
      mock: options.mock,
      llm: options.llm,
      clock: options.clock,
      limits: { ...LIMITS, ...options.limits },
      tasks: new TaskStore(options.db, options.clock),
      chat: new ChatStore(options.db, options.clock),
    };
  }

  async handleMessage(sessionId: string, userId: string, text: string): Promise<AgentReply> {
    const messageId = this.deps.chat.add(sessionId, userId, "user", text);
    const run = new Run(this.deps, sessionId, userId, messageId, this.sink.startRun(sessionId, "user_message"));
    try {
      return finish(run, await runModelLoop(run));
    } catch (error) {
      run.trace.emit("tool_call", { name: "agent", error: String(error) });
      return finish(run, { reason: "internal_error" });
    }
  }
}
