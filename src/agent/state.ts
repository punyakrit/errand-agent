export const STATES = [
  "COLLECTING", "SEARCHING", "COMPARING", "HOLDING", "AWAITING_APPROVAL",
  "EXECUTING", "VERIFYING", "NEEDS_USER", "DONE", "FAILED",
] as const;
export type State = (typeof STATES)[number];

// The workflow as data. A move that is not listed here is illegal.
export const TRANSITIONS: Record<State, State[]> = {
  COLLECTING: ["SEARCHING", "AWAITING_APPROVAL", "NEEDS_USER", "FAILED"],
  SEARCHING: ["COMPARING", "COLLECTING", "NEEDS_USER", "FAILED"],
  COMPARING: ["SEARCHING", "HOLDING", "AWAITING_APPROVAL", "COLLECTING", "NEEDS_USER", "FAILED"],
  HOLDING: ["AWAITING_APPROVAL", "COMPARING", "COLLECTING", "NEEDS_USER", "FAILED"],
  AWAITING_APPROVAL: ["EXECUTING", "HOLDING", "COMPARING", "COLLECTING", "NEEDS_USER", "FAILED"],
  EXECUTING: ["VERIFYING", "HOLDING", "COMPARING", "NEEDS_USER", "DONE", "FAILED"],
  VERIFYING: ["DONE", "EXECUTING", "HOLDING", "COMPARING", "NEEDS_USER", "FAILED"],
  NEEDS_USER: ["COLLECTING", "SEARCHING", "COMPARING", "HOLDING", "AWAITING_APPROVAL", "VERIFYING", "DONE", "FAILED"],
  DONE: [],
  FAILED: [],
};

export const TERMINAL_STATES: State[] = ["DONE", "FAILED"];

export class IllegalTransition extends Error {
  constructor(from: State, to: State) {
    super(`Illegal transition ${from} -> ${to}`);
    this.name = "IllegalTransition";
  }
}

export function canMove(from: State, to: State): boolean {
  return TRANSITIONS[from].includes(to);
}
