import type Anthropic from "@anthropic-ai/sdk";
import type { LLM, LlmRequest } from "./types.ts";

export type ToolCall = { name: string; input: Record<string, unknown> };
// A step is a canned response, or a function that builds one from the request.
export type Step = Anthropic.Message | ((request: LlmRequest) => Anthropic.Message | Promise<Anthropic.Message>);

let nextId = 1;

export function message(
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.Message["stop_reason"],
  usage: { input?: number; output?: number } = {},
): Anthropic.Message {
  return {
    id: `msg_scripted_${nextId++}`,
    type: "message",
    role: "assistant",
    model: "scripted",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: usage.input ?? 100, output_tokens: usage.output ?? 20 },
  } as unknown as Anthropic.Message;
}

export function say(text: string): Anthropic.Message {
  return message([{ type: "text", text } as Anthropic.TextBlock], "end_turn");
}

export function call(...calls: ToolCall[]): Anthropic.Message {
  const blocks = calls.map((c) => ({ type: "tool_use", id: `toolu_${nextId++}`, name: c.name, input: c.input }));
  return message(blocks as unknown as Anthropic.ContentBlock[], "tool_use");
}

export function tool(name: string, input: Record<string, unknown> = {}): Anthropic.Message {
  return call({ name, input });
}

// Plays back a fixed list of steps, and keeps every request it was given so
// tests can inspect the exact payload the model would have seen.
export class ScriptedLLM implements LLM {
  readonly requests: LlmRequest[] = [];
  private steps: Step[];

  constructor(steps: Step[] = []) {
    this.steps = [...steps];
  }

  add(...steps: Step[]): void {
    this.steps.push(...steps);
  }

  remaining(): number {
    return this.steps.length;
  }

  async complete(request: LlmRequest): Promise<Anthropic.Message> {
    this.requests.push(structuredClone(request));
    const step = this.steps.shift();
    if (!step) throw new Error("ScriptedLLM ran out of steps");
    return typeof step === "function" ? step(request) : step;
  }
}
