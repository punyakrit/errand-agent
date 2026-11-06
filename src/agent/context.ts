import type Anthropic from "@anthropic-ai/sdk";
import { istDate } from "../clock.ts";
import { CONTEXT } from "../config.ts";
import { memoryLine, selectMemories } from "../memory/select.ts";
import type { ChatMessage } from "./chat.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { missingFields } from "./request.ts";
import type { Run } from "./run.ts";
import { summariseOlderChat } from "./summary.ts";
import { estimateTokens } from "./tokens.ts";
import type { Task } from "./tasks.ts";

export interface BuiltContext {
  system: string;
  messages: Anthropic.MessageParam[];
  memoryIncluded: number[];
  memoryExcluded: { id: number; reason: string }[];
  tokens: { system: number; memories: number; summary: number; recent: number };
}

function taskBlock(task: Task | undefined): string {
  if (!task) return "No active task.";
  return JSON.stringify({
    kind: task.kind,
    state: task.state,
    request: task.request,
    missing: missingFields(task.kind, task.request, task.details.target_booking !== undefined),
  });
}

function clip(text: string): string {
  return text.length > CONTEXT.maxMessageChars ? `${text.slice(0, CONTEXT.maxMessageChars)}...` : text;
}

// Newest messages that fit, always including the current one. The first
// message sent must be from the user.
function pickRecent(history: ChatMessage[], budgetTokens: number): ChatMessage[] {
  const recent: ChatMessage[] = [];
  let used = 0;
  for (let index = history.length - 1; index >= 0 && recent.length < CONTEXT.recentMessages; index--) {
    const message = history[index]!;
    const cost = estimateTokens(clip(message.text));
    if (recent.length > 0 && used + cost > budgetTokens) break;
    recent.unshift(message);
    used += cost;
  }
  while (recent.length > 1 && recent[0]?.role !== "user") recent.shift();
  return recent;
}

// Builds what the model sees for one user message. It is a pure function of
// stored records and the clock, and it stays under a fixed budget. Inside one
// tool loop the payload then only grows by appending, because earlier messages
// must not change once a thinking block follows them.
export function buildContext(run: Run): BuiltContext {
  const task = run.activeTask();
  const { included, excluded } = selectMemories(
    run.deps.memory.all(run.userId), task?.request.service, task?.request.area, CONTEXT.memoryTokens,
  );
  const memoryText = included.map(memoryLine).join("\n");

  const fixedSystem = [
    SYSTEM_PROMPT,
    `Today is ${istDate(run.deps.clock.now())} (IST).`,
    `<task_state>${taskBlock(task)}</task_state>`,
    memoryText ? `<user_preferences>\n${memoryText}\n</user_preferences>` : "",
  ].filter(Boolean).join("\n\n");

  const baseBudget = CONTEXT.budgetTokens - CONTEXT.loopReserveTokens;
  const room = baseBudget - estimateTokens(fixedSystem) - CONTEXT.summaryTokens;

  const history = run.deps.chat.history(run.userId);
  const recent = pickRecent(history, room);
  const older = history.slice(0, history.length - recent.length);
  const summary = summariseOlderChat(older, CONTEXT.summaryTokens);
  const system = summary ? `${fixedSystem}\n\n<older_chat>\n${summary}\n</older_chat>` : fixedSystem;
  const messages = recent.map((message) => ({ role: message.role, content: clip(message.text) }));

  return {
    system,
    messages,
    memoryIncluded: included.map((memory) => memory.id),
    memoryExcluded: excluded,
    tokens: {
      system: estimateTokens(fixedSystem),
      memories: estimateTokens(memoryText),
      summary: estimateTokens(summary),
      recent: messages.reduce((total, message) => total + estimateTokens(message.content), 0),
    },
  };
}
