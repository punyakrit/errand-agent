import type Anthropic from "@anthropic-ai/sdk";

// Measured with scripts/measure-tokens.ts: JSON tool results run at about 2.4
// characters per token, so 2.2 stays above the real count. English prose is
// nearer 4, which makes this estimate high for chat text, as intended.
const CHARS_PER_TOKEN = 2.2;

// A local estimate, so tests stay offline. Live runs log the real
// usage.input_tokens next to this figure.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function messageText(message: Anthropic.MessageParam): string {
  if (typeof message.content === "string") return message.content;
  // Thinking blocks carry a long signature but no visible text, so they are
  // left out here. The real token count is logged on live runs.
  const blocks = message.content.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking");
  return JSON.stringify(blocks);
}

export function estimatePayloadTokens(system: string, messages: Anthropic.MessageParam[]): number {
  return estimateTokens(system) + messages.reduce((total, message) => total + estimateTokens(messageText(message)), 0);
}
