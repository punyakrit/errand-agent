// A backstop. The system prompt tells the model never to claim an outcome, and
// real outcomes are reported by code after verification. If model text claims
// one anyway, finish() must not pass it on.
const CLAIMS = [
  /\bi(['’]ve| have)?\s+(just\s+|now\s+|already\s+)?(booked|cancelled|canceled|rescheduled|moved|confirmed)\b/i,
  /\byour\b[^.!?\n]{0,60}\b(is|has been|was)\s+(now\s+|successfully\s+)?(booked|confirmed|cancelled|canceled|rescheduled|moved)\b/i,
  /\bsuccessfully\s+(booked|cancelled|canceled|rescheduled|moved)\b/i,
  /\bbooking (is )?confirmed\b/i,
  /\byou(['’]re| are) (all )?(booked|set)\b/i,
];

export function claimsOutcome(text: string): boolean {
  return CLAIMS.some((pattern) => pattern.test(text));
}

export const CLAIM_BLOCKED_REPLY =
  "I can't confirm that anything has been booked or changed yet. Bookings only count once I have approval from you and have checked the result.";
