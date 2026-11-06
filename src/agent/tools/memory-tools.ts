import { z } from "zod";
import { forgetEverywhere } from "../forget.ts";
import type { Run } from "../run.ts";
import { defineTool } from "./define.ts";

const MIN_EVIDENCE_CHARS = 8;

const Evidence = z.string().describe("The user's exact words from this session that support this, copied character for character");
const Scope = z.string().describe('"global", or a service: plumber, electrician, ac_service');

// The capability check. Every memory write must quote the user. A review or
// other tool output is not a user message, so it can never pass this.
function evidenceProblem(run: Run, evidence: string, action: string): object | undefined {
  const quoted = evidence.trim();
  const found = quoted.length >= MIN_EVIDENCE_CHARS
    && run.deps.chat.userMessagesInSession(run.sessionId).some((message) => message.includes(quoted));
  if (found) return undefined;
  run.trace.emit("gate_decision", { decision: "memory_write_blocked", action, evidence });
  return { error: "evidence_not_found", next: "Memory changes must quote the user's own words from this session." };
}

export const rememberPreference = defineTool({
  name: "remember_preference",
  description:
    "Save a stable preference the user stated, for future sessions. Common keys: preferred_area, earliest_time (HH:MM), preferred_provider, max_budget. Do not save one-off details of a single request.",
  input: z.object({ key: z.string(), value: z.string(), scope: Scope, evidence: Evidence }).strict(),
  run: async (run, input) => {
    const problem = evidenceProblem(run, input.evidence, "remember_preference");
    if (problem) return problem;
    const id = run.deps.memory.remember(run.userId, input.key, input.value, input.scope, input.evidence.trim());
    return { ok: true, id };
  },
});

export const memoryList = defineTool({
  name: "memory_list",
  description: "Show the user everything stored about them. The list goes straight to the user, not to you.",
  input: z.object({}).strict(),
  run: async (run) => {
    const memories = run.deps.memory.active(run.userId);
    const lines = memories.map((memory) => {
      const label = memory.kind === "explicit" ? "you told me" : memory.confirmed ? "inferred, confirmed" : `inferred, not confirmed (reply "confirm ${memory.id}" if this is right)`;
      return `- ${memory.key} (${memory.scope}): ${memory.value} [${label}]`;
    });
    const text = lines.length > 0 ? `Here is what I have stored:\n${lines.join("\n")}` : "I have nothing stored about you.";
    // Unconfirmed facts must not reach the model, so this reply is shown to the
    // user but only a placeholder goes into chat history.
    run.end = { reason: "reply", text, historyText: "[Showed the user their stored memories]" };
    return { shown_to_user: true };
  },
});

export const memoryCorrect = defineTool({
  name: "memory_correct",
  description: "Correct a stored fact when the user says it is wrong. The old value is kept as superseded.",
  input: z.object({ key: z.string(), value: z.string(), scope: Scope, evidence: Evidence }).strict(),
  run: async (run, input) => {
    const problem = evidenceProblem(run, input.evidence, "memory_correct");
    if (problem) return problem;
    const exists = run.deps.memory.active(run.userId).some((memory) => memory.key === input.key && memory.scope === input.scope);
    if (!exists) return { error: "not_found", keys: run.deps.memory.active(run.userId).map((memory) => memory.key) };
    const id = run.deps.memory.remember(run.userId, input.key, input.value, input.scope, input.evidence.trim());
    return { ok: true, id };
  },
});

export const memoryForget = defineTool({
  name: "memory_forget",
  description: "Forget a stored fact completely, when the user asks. Omit scope to forget it everywhere.",
  input: z.object({ key: z.string(), scope: Scope.optional(), evidence: Evidence }).strict(),
  run: async (run, input) => {
    const problem = evidenceProblem(run, input.evidence, "memory_forget");
    if (problem) return problem;
    if (!forgetEverywhere(run, input.key, input.scope)) {
      return { error: "not_found", keys: run.deps.memory.active(run.userId).map((memory) => memory.key) };
    }
    // Stop here. The model's own last message may quote the value, so it must
    // not be called again in this run.
    run.end = { reason: "memory_forgotten", text: `Done. I have forgotten ${input.key.replaceAll("_", " ")}.` };
    return { ok: true };
  },
});
