// Code alone decides what counts as yes. This function only ever receives the
// user's raw message, never tool output, so nothing a provider writes can reach it.
const YES = new Set([
  "yes", "y", "yep", "yeah", "yup", "ok", "okay", "sure", "confirm", "confirmed", "approve", "approved",
  "go ahead", "do it", "book it", "yes please", "yes go ahead", "yes book it", "yes do it", "ok go ahead",
  "okay go ahead", "please do", "go for it", "yes confirm", "yes approve",
]);

const NO = new Set(["no", "n", "nope", "no thanks", "dont", "do not", "stop", "cancel", "cancel it", "not now"]);

function normalise(text: string): string {
  return text.toLowerCase().replace(/[.,!'"]/g, "").replace(/\s+/g, " ").trim();
}

// Only a short, unconditional yes counts. "Yes but Tuesday" is a change, not approval.
export function isPlainYes(text: string): boolean {
  return YES.has(normalise(text));
}

export function isPlainNo(text: string): boolean {
  return NO.has(normalise(text));
}
