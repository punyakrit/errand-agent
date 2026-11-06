import type { BookingView } from "../mock/types.ts";

export type ProactiveDecision = "rebook" | "log_only";

// Code decides what a cancellation means for the user. The model is not asked.
export function decide(booking: BookingView, now: number): ProactiveDecision {
  if (booking.status !== "cancelled_by_provider") return "log_only";
  return Date.parse(booking.slot) > now ? "rebook" : "log_only";
}
