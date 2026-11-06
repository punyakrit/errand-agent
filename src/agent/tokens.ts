import type Anthropic from "@anthropic-ai/sdk";

// A deliberately high local estimate, so tests stay offline and we stay under
// budget. Real English text is closer to 4 characters per token. Live runs log
// the real usage.input_tokens next to this figure.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
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
