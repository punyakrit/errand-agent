import type { Outcome, Run } from "./run.ts";

const CONFIRM = /^confirm\s+(\d+)$/i;

// "confirm 12" confirms an inferred fact. Plain code handles it, because the
// model is not allowed to see the fact until it is confirmed.
export function handleMemoryCommand(run: Run, text: string): Outcome | undefined {
  const match = CONFIRM.exec(text.trim());
  if (!match) return undefined;
  const id = Number(match[1]);
  const memory = run.deps.memory.get(id);
  if (!memory || memory.user_id !== run.userId || memory.kind !== "inferred" || memory.status !== "active") {
    return { reason: "reply", text: `I have no unconfirmed fact with ID ${id}.` };
  }
  run.deps.memory.confirm(run.userId, id);
  run.trace.emit("gate_decision", { decision: "memory_confirmed_by_user", id });
  return { reason: "reply", text: `Thanks, I have confirmed that (ID ${id}).` };
}
