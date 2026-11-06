import { FORGOTTEN_MARK, scrubText } from "../memory/store.ts";
import type { Run } from "./run.ts";

// Forgetting has to reach everywhere the value could get back to the model
// from: chat history, the summary built from it, queued messages and the
// active task. The memory table alone is not enough.
export function forgetEverywhere(run: Run, key: string, scope: string | undefined): boolean {
  const texts = run.deps.memory.forget(run.userId, key, scope);
  if (texts.length === 0) return false;

  run.deps.chat.rewrite(run.userId, (text) => scrubText(text, texts));
  run.deps.outbox.rewrite(run.userId, (text) => scrubText(text, texts));

  const task = run.activeTask();
  if (task) {
    const lowered = texts.map((text) => text.toLowerCase());
    const request = task.request as Record<string, unknown>;
    for (const [field, value] of Object.entries(request)) {
      if (typeof value !== "string") continue;
      if (lowered.includes(value.toLowerCase())) delete request[field];
      else if (scrubText(value, texts) !== value) request[field] = scrubText(value, texts);
    }
    run.deps.tasks.save(task);
  }
  run.trace.emit("gate_decision", { decision: "memory_forgotten", key, marker: FORGOTTEN_MARK });
  return true;
}
