import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { CONTEXT, MODEL } from "../config.ts";
import { estimateCostUsd } from "../llm/cost.ts";
import { buildContext, type BuiltContext } from "./context.ts";
import { CLAIM_BLOCKED_REPLY, claimsOutcome } from "./reply-guard.ts";
import type { Outcome, Run } from "./run.ts";
import { estimatePayloadTokens } from "./tokens.ts";
import { dispatch, toolDefinitions } from "./tools/index.ts";

class ModelTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ModelTimeout()), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function replyText(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

// Logs exactly what is about to be sent, so tests can prove what the model saw.
function writeManifest(run: Run, context: BuiltContext, messages: Anthropic.MessageParam[], estimated: number): void {
  const payload = JSON.stringify({ system: context.system, messages });
  run.trace.emit("context_manifest", {
    turn: run.turns + 1,
    memory_included: context.memoryIncluded,
    memory_excluded: context.memoryExcluded,
    tokens: { ...context.tokens, estimated_total: estimated, budget: CONTEXT.budgetTokens },
    payload_sha256: createHash("sha256").update(payload).digest("hex"),
  });
}

// The hand-written tool loop. The model proposes, this loop enforces the limits
// and runs the tools. Every return value goes through finish().
export async function runModelLoop(run: Run): Promise<Outcome> {
  const { limits, llm } = run.deps;
  const context = buildContext(run);
  const tools = toolDefinitions();
  const messages: Anthropic.MessageParam[] = context.messages;

  for (;;) {
    if (run.turns >= limits.maxModelTurns) return { reason: "turn_limit" };
    if (run.outOfTime()) return { reason: "time_limit" };
    const estimated = estimatePayloadTokens(context.system, messages);
    if (estimated > CONTEXT.budgetTokens) return { reason: "context_budget" };
    writeManifest(run, context, messages, estimated);

    const started = performance.now();
    let response: Anthropic.Message;
    run.turns += 1;
    try {
      response = await withTimeout(
        llm.complete({ system: context.system, messages, tools, timeoutMs: limits.modelCallTimeoutMs }),
        limits.modelCallTimeoutMs,
      );
    } catch (error) {
      const timedOut = error instanceof ModelTimeout;
      run.trace.emit("model_call", {
        model: MODEL, latency_ms: Math.round(performance.now() - started),
        error: timedOut ? "timeout" : (error as Error).name, status: (error as { status?: number }).status,
      });
      return { reason: timedOut ? "model_timeout" : "api_error" };
    }

    run.trace.emit("model_call", {
      model: response.model,
      latency_ms: Math.round(performance.now() - started),
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
      estimated_input_tokens: estimated,
      estimated_cost_usd: estimateCostUsd(response.usage),
      stop_reason: response.stop_reason,
    });

    // Check why the model stopped before reading what it said.
    switch (response.stop_reason) {
      case "refusal":
        return { reason: "refusal" };
      case "max_tokens":
        return { reason: "max_tokens" };
      case "end_turn": {
        const text = replyText(response);
        if (!text) return { reason: "malformed_output" };
        if (claimsOutcome(text)) {
          run.trace.emit("gate_decision", { decision: "unverified_claim_blocked", text });
          return { reason: "reply", text: CLAIM_BLOCKED_REPLY };
        }
        return { reason: "reply", text };
      }
      case "tool_use":
        break;
      default:
        return { reason: "malformed_output" };
    }

    const toolUses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
    if (toolUses.length === 0) return { reason: "malformed_output" };

    // Appended unchanged, thinking blocks included.
    messages.push({ role: "assistant", content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUses) {
      if (run.outOfToolCalls()) return { reason: "tool_limit" };
      if (run.outOfTime()) return { reason: "time_limit" };
      results.push(await dispatch(run, block));
    }
    messages.push({ role: "user", content: results });

    if (run.end) {
      const questions = run.questions.join("\n");
      return run.end.reason === "asked_user" ? { reason: "asked_user", text: questions } : run.end;
    }
  }
}
