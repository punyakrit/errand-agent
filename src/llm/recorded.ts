import { readFileSync, writeFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import type { LLM, LlmRequest } from "./types.ts";

export interface Recording {
  note: string;
  responses: Anthropic.Message[];
}

// Replays real model responses in order. It proves the code handles real
// response shapes. It does not prove the model would answer the same way today.
export class RecordedLLM implements LLM {
  readonly requests: LlmRequest[] = [];
  private responses: Anthropic.Message[];

  constructor(path: string) {
    this.responses = (JSON.parse(readFileSync(path, "utf8")) as Recording).responses;
  }

  remaining(): number {
    return this.responses.length;
  }

  async complete(request: LlmRequest): Promise<Anthropic.Message> {
    this.requests.push(structuredClone(request));
    const next = this.responses.shift();
    if (!next) throw new Error("RecordedLLM ran out of responses");
    return next;
  }
}

// Wraps a real model and saves each response, to make a recording.
export class RecordingLLM implements LLM {
  private inner: LLM;
  private path: string;
  private note: string;
  private responses: Anthropic.Message[] = [];

  constructor(inner: LLM, path: string, note: string) {
    this.inner = inner;
    this.path = path;
    this.note = note;
  }

  async complete(request: LlmRequest): Promise<Anthropic.Message> {
    const response = await this.inner.complete(request);
    this.responses.push(response);
    const recording: Recording = { note: this.note, responses: this.responses };
    writeFileSync(this.path, JSON.stringify(recording, null, 2));
    return response;
  }
}
