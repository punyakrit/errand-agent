import type { ChatMessage } from "./chat.ts";
import { estimateTokens } from "./tokens.ts";

const MAX_LINE_CHARS = 90;

// A summary of older chat written by code. No model call, so it is free,
// deterministic, and it can only contain text that is still in chat history.
export function summariseOlderChat(messages: ChatMessage[], maxTokens: number): string {
  if (messages.length === 0) return "";
  const header = `Older chat: ${messages.length} earlier messages. Most recent things the user asked for:`;
  const lines: string[] = [];
  let used = estimateTokens(header);
  const userMessages = messages.filter((message) => message.role === "user");
  for (let index = userMessages.length - 1; index >= 0; index--) {
    const text = userMessages[index]!.text.replace(/\s+/g, " ").slice(0, MAX_LINE_CHARS);
    const line = `- ${text}`;
    const cost = estimateTokens(line) + 1;
    if (used + cost > maxTokens) break;
    lines.unshift(line);
    used += cost;
  }
  return [header, ...lines].join("\n");
}
