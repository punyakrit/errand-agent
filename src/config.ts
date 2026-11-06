// Every limit and price in one place, so they are easy to find and explain.

export const MODEL = "claude-sonnet-5-5";
export const EFFORT = "medium";
export const MAX_OUTPUT_TOKENS = 8192; // includes thinking

export interface Limits {
  maxModelTurns: number;
  maxToolCalls: number;
  wallClockMs: number;
  modelCallTimeoutMs: number;
  maxToolRetries: number;
  maxBadToolInputs: number;
}

// Hard limits for one user message.
export const LIMITS: Limits = {
  maxModelTurns: 8,
  maxToolCalls: 20,
  wallClockMs: 60_000,
  modelCallTimeoutMs: 30_000,
  maxToolRetries: 3,
  maxBadToolInputs: 2,
};

// Waits between attempts during recovery. The lists bound the attempts too.
export const RECOVERY = {
  statusPollDelaysMs: [500, 1_000, 2_000, 4_000],
  cancelRetryDelaysMs: [500, 1_000, 2_000],
};

export const CONTEXT = {
  budgetTokens: 3_000, // everything sent except the tool schemas
  loopReserveTokens: 1_200, // kept free for tool results inside one tool loop
  recentMessages: 8,
};

export const UNTRUSTED = {
  maxTextChars: 240,
  maxReviews: 3,
};

export const OPTIONS = {
  maxProviders: 5,
  maxSlotsShown: 4,
};

// Dollars per million tokens.
export const PRICING = {
  input: 2,
  output: 10,
  cacheRead: 0.2,
};
