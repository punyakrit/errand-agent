import type Anthropic from "@anthropic-ai/sdk";

export interface LlmRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  timeoutMs: number;
}

// The one thing the agent needs from a model. Three classes implement it:
// AnthropicLLM (real), ScriptedLLM (tests), RecordedLLM (replays real responses).
export interface LLM {
  complete(request: LlmRequest): Promise<Anthropic.Message>;
}
