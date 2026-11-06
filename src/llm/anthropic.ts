import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { EFFORT, MAX_OUTPUT_TOKENS, MODEL } from "../config.ts";
import type { LLM, LlmRequest } from "./types.ts";

function keyFromDotEnv(): string {
  const key = parseEnv(readFileSync(".env", "utf8")).ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is missing from .env");
  return key;
}

export class AnthropicLLM implements LLM {
  private client: Anthropic;
  private model: string;

  // The default is the model this project uses. Only smoke tests pass another.
  constructor(model: string = MODEL) {
    // Tests and evals must never reach the network.
    if (process.env.LIVE !== "1") throw new Error("AnthropicLLM needs LIVE=1");
    this.model = model;
    this.client = new Anthropic({
      apiKey: keyFromDotEnv(),
      authToken: null, // ignore any token in the shell
      baseURL: "https://api.anthropic.com", // the shell may point somewhere else
      maxRetries: 0, // our own limits decide what happens on failure
    });
  }

  complete(request: LlmRequest): Promise<Anthropic.Message> {
    // tool_choice stays at its default of auto. Forced tools are a 400 on this
    // model, and thinking stays on its adaptive default.
    return this.client.messages.create(
      {
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        output_config: { effort: EFFORT },
      },
      { timeout: request.timeoutMs },
    );
  }
}
