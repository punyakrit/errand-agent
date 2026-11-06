// The tool contract from the assignment PDF, section 2.
// Inputs and failure codes here are the fixed interface the agent works with.

export const SERVICES = ["plumber", "electrician", "ac_service"] as const;
export type Service = (typeof SERVICES)[number];

export const AREAS = ["Indiranagar", "HSR Layout", "Koramangala", "Whitefield"] as const;
export type Area = (typeof AREAS)[number];

export type BookOutcome = "success" | "slot_taken" | "timeout_booked" | "timeout_not_booked";
export type BookingStatus = "booked" | "cancelled" | "cancelled_by_provider" | "completed";

export type Failure = { ok: false; error: string; status?: number };

export interface Review {
  author: string;
  rating: number;
  text: string;
}

export interface ProviderSummary {
  provider_id: string;
  name: string;
  service: Service;
  areas: Area[];
  price: number;
  rating: number;
  attributes: { years_experience: number; warranty_days: number; verified: boolean };
  available_slots: string[];
}

export interface BookingView {
  booking_id: string;
  provider_id: string;
  provider_name: string;
  service: Service;
  slot: string;
  status: BookingStatus;
  price: number;
}

export type SearchResult = { ok: true; providers: ProviderSummary[] } | Failure;
export type ProviderResult =
  | { ok: true; provider: ProviderSummary & { about: string; reviews: Review[] } }
  | Failure;
export type HoldResult =
  | { ok: true; hold_id: string; provider_id: string; slot: string; price: number; expires_at: string }
  | Failure;
export type BookResult =
  | { ok: true; status: "booked"; booking_id: string; provider_id: string; slot: string; price: number }
  | Failure;
export type StatusResult =
  | { ok: true; status: BookingStatus; booking_id: string; provider_id: string; slot: string; price: number }
  | { ok: true; status: "not_booked"; reason?: string }
  | Failure;
export type CancelResult = { ok: true; status: "cancelled"; booking_id: string } | Failure;
export type RescheduleResult =
  | { ok: true; status: "booked"; booking_id: string; provider_id: string; slot: string; price: number }
  | Failure;
export type ListResult = { ok: true; bookings: BookingView[] } | Failure;

// The 8 tools. Method names match the PDF exactly.
export interface MockTools {
  search_providers(args: {
    service: string;
    area: string;
    date_range: { from: string; to: string };
  }): Promise<SearchResult>;
  get_provider(args: { provider_id: string }): Promise<ProviderResult>;
  hold_slot(args: { provider_id: string; slot: string }): Promise<HoldResult>;
  book(args: { hold_id: string; idempotency_key: string }): Promise<BookResult>;
  get_booking_status(args: { hold_id?: string; idempotency_key?: string }): Promise<StatusResult>;
  cancel(args: { booking_id: string; idempotency_key: string }): Promise<CancelResult>;
  reschedule(args: { booking_id: string; slot: string; idempotency_key: string }): Promise<RescheduleResult>;
  list_bookings(args: { user_id: string }): Promise<ListResult>;
}

// What a scenario can force. Saved in SQLite so it survives a restart.
export interface ScenarioConfig {
  forceBook: BookOutcome[]; // used one per book() call, then back to the odds
  holdPriceDeltas: number[]; // used one per hold_slot(), then 0
  conflictSlots: string[]; // reschedule() returns slot_conflict on these
  providerSlots: Record<string, string[]>; // replaces a provider's generated slots
}
