import type { Outcome, Run } from "./run.ts";

export type FinishReason =
  | "reply" | "asked_user" | "awaiting_approval" | "action_result" | "memory_forgotten"
  | "turn_limit" | "tool_limit" | "time_limit" | "context_budget"
  | "api_error" | "model_timeout" | "refusal" | "max_tokens" | "malformed_output"
  | "bad_tool_input" | "tool_error" | "internal_error";

const LIMIT_REASONS: FinishReason[] = ["turn_limit", "tool_limit", "time_limit", "context_budget"];

const NOT_BOOKED = "Nothing was booked or changed in this step.";
const CARRY_ON = "Your details are saved, so you can send another message to carry on.";

// Code-written messages, so every failure gives the user a clear answer
// even when the model produced nothing usable.
const FIXED_MESSAGES: Partial<Record<FinishReason, string>> = {
  turn_limit: `I stopped because this needed more steps than I allow for one message. ${NOT_BOOKED} ${CARRY_ON}`,
  tool_limit: `I stopped because this needed more lookups than I allow for one message. ${NOT_BOOKED} ${CARRY_ON}`,
  time_limit: `I stopped because this took longer than I allow for one message. ${NOT_BOOKED} ${CARRY_ON}`,
  context_budget: `I stopped because this conversation step grew too large to handle safely. ${NOT_BOOKED} ${CARRY_ON}`,
  api_error: `I could not reach the assistant service just now. ${NOT_BOOKED} ${CARRY_ON}`,
  model_timeout: `The assistant service took too long to answer. ${NOT_BOOKED} ${CARRY_ON}`,
  refusal: `I can't help with that request. ${NOT_BOOKED}`,
  max_tokens: `My reply was cut off before it finished. ${NOT_BOOKED} ${CARRY_ON}`,
  malformed_output: `I got a reply I could not use. ${NOT_BOOKED} ${CARRY_ON}`,
  bad_tool_input: `I could not form a valid request for that step. ${NOT_BOOKED} ${CARRY_ON}`,
  tool_error: `A service I rely on failed unexpectedly. ${NOT_BOOKED} ${CARRY_ON}`,
  internal_error: `Something went wrong on my side. ${NOT_BOOKED} ${CARRY_ON}`,
};

export interface AgentReply {
  reason: FinishReason;
  reply: string;
  taskId?: string;
  taskState?: string;
  approval?: Outcome["approval"];
  notices: string[]; // messages queued while the user was away
}

// Every exit from a run passes through here. It saves the reply, closes the
// trace and returns one message for the user.
export function finish(run: Run, outcome: Outcome, options: { queue?: boolean } = {}): AgentReply {
  const reply = outcome.text ?? FIXED_MESSAGES[outcome.reason] ?? FIXED_MESSAGES.internal_error!;
  if (LIMIT_REASONS.includes(outcome.reason)) {
    run.trace.emit("limit_hit", { limit: outcome.reason, turns: run.turns, tool_calls: run.toolCalls });
  }
  run.deps.chat.add(run.sessionId, run.userId, "assistant", outcome.historyText ?? reply);
  if (options.queue) run.deps.outbox.add(run.userId, reply);
  const task = run.activeTask();
  run.trace.emit("run_end", {
    reason: outcome.reason, reply, turns: run.turns, tool_calls: run.toolCalls,
    task_id: task?.task_id, task_state: task?.state,
  });
  const notices = options.queue ? [] : run.deps.outbox.drain(run.userId);
  return { reason: outcome.reason, reply, taskId: task?.task_id, taskState: task?.state, approval: outcome.approval, notices };
}
