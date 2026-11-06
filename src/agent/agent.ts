import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../clock.ts";
import { LIMITS, type Limits } from "../config.ts";
import type { LLM } from "../llm/types.ts";
import type { MockTools } from "../mock/types.ts";
import type { TraceSink } from "../trace/tracer.ts";
import { ApprovalStore } from "./approvals.ts";
import { ChatStore } from "./chat.ts";
import { UNCONFIRMED_MESSAGE } from "./executor.ts";
import { finish, type AgentReply } from "./finish.ts";
import { handleApprovalReply, handleApproveClick } from "./gate.ts";
import { runModelLoop } from "./loop.ts";
import { OpStore } from "./ops.ts";
import { Outbox } from "./outbox.ts";
import { reconcileOp } from "./recovery.ts";
import { Run, type AgentDeps, type Checkpoint } from "./run.ts";
import { createAgentSchema } from "./schema.ts";
import { TaskStore } from "./tasks.ts";

export class Agent {
  readonly deps: AgentDeps;
  private sink: TraceSink;

  constructor(options: {
    db: DatabaseSync; mock: MockTools; llm: LLM; clock: Clock; sink: TraceSink; limits?: Partial<Limits>;
    checkpoint?: (name: Checkpoint) => Promise<void>;
  }) {
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
      approvals: new ApprovalStore(options.db, options.clock),
      ops: new OpStore(options.db, options.clock),
      outbox: new Outbox(options.db, options.clock),
      checkpoint: options.checkpoint ?? (async () => {}),
    };
  }

  async handleMessage(sessionId: string, userId: string, text: string): Promise<AgentReply> {
    const messageId = this.deps.chat.add(sessionId, userId, "user", text);
    const run = new Run(this.deps, sessionId, userId, messageId, this.sink.startRun(sessionId, "user_message"));
    try {
      await this.settleOpenOps(run);
      const outcome = (await handleApprovalReply(run, text)) ?? (await runModelLoop(run));
      return finish(run, outcome);
    } catch (error) {
      run.trace.emit("tool_call", { name: "agent", error: String(error) });
      return finish(run, { reason: "internal_error" });
    }
  }

  // The Approve button on the approval card.
  async approve(sessionId: string, userId: string, approvalId: string): Promise<AgentReply> {
    const messageId = this.deps.chat.add(sessionId, userId, "user", "[Approve button]");
    const run = new Run(this.deps, sessionId, userId, messageId, this.sink.startRun(sessionId, "approve_click"));
    try {
      return finish(run, await handleApproveClick(run, approvalId));
    } catch (error) {
      run.trace.emit("tool_call", { name: "agent", error: String(error) });
      return finish(run, { reason: "internal_error" });
    }
  }

  // Runs at startup. Finishes every op a crash left open, using the source of
  // truth. The result is queued, because the user may not be connected.
  async reconcile(): Promise<void> {
    for (const op of this.deps.ops.open()) {
      const run = new Run(this.deps, op.session_id, op.user_id, 0, this.sink.startRun(op.session_id, "reconcile"));
      try {
        const outcome = await reconcileOp(run, op);
        finish(run, outcome ?? { reason: "action_result", text: UNCONFIRMED_MESSAGE }, { queue: true });
      } catch (error) {
        run.trace.emit("tool_call", { name: "reconcile", error: String(error) });
        finish(run, { reason: "action_result", text: UNCONFIRMED_MESSAGE }, { queue: true });
      }
    }
  }

  // An outcome left unconfirmed earlier may be known by now. If it is, the user
  // hears about it with their next reply.
  private async settleOpenOps(run: Run): Promise<void> {
    for (const op of this.deps.ops.openForUser(run.userId)) {
      const outcome = await reconcileOp(run, op);
      if (outcome?.text) {
        this.deps.chat.add(run.sessionId, run.userId, "assistant", outcome.text);
        this.deps.outbox.add(run.userId, outcome.text);
      }
    }
  }
}
