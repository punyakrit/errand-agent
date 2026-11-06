import type Anthropic from "@anthropic-ai/sdk";
import { CONTEXT } from "../config.ts";
import { istDate } from "../clock.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { missingFields } from "./request.ts";
import type { Run } from "./run.ts";

export interface BuiltContext {
  system: string;
  messages: Anthropic.MessageParam[];
  memoryIncluded: string[];
  memoryExcluded: { id: string; reason: string }[];
}

function taskBlock(run: Run): string {
  const task = run.activeTask();
  if (!task) return "No active task.";
  const hasTarget = task.details.target_booking !== undefined;
  return JSON.stringify({
    kind: task.kind,
    state: task.state,
    request: task.request,
    missing: missingFields(task.kind, task.request, hasTarget),
  });
}

// Runs once per user message. Inside one tool loop the payload only grows by
// appending, because earlier messages must not change once a thinking block
// has been produced after them.
export function buildContext(run: Run): BuiltContext {
  const history = run.deps.chat.history(run.userId);
  const recent = history.slice(-CONTEXT.recentMessages);
  while (recent.length > 1 && recent[0]?.role !== "user") recent.shift();
  const messages = recent.map((message) => ({ role: message.role, content: message.text }));
  const today = istDate(run.deps.clock.now());
  const system = `${SYSTEM_PROMPT}\n\nToday is ${today} (IST).\n\n<task_state>${taskBlock(run)}</task_state>`;
  return { system, messages, memoryIncluded: [], memoryExcluded: [] };
}
