import type { DatabaseSync } from "node:sqlite";
import { addDays, istDate, type Clock } from "../clock.ts";
import { tx } from "../db.ts";
import { nextRandom } from "../rng.ts";
import { findProvider, PROVIDERS, type Provider } from "./catalog.ts";
import { createMockSchema } from "./schema.ts";
import { insertBooking, seedBookings, SEED_USER } from "./seed.ts";
import { generateSlots } from "./slots.ts";
import type {
  BookOutcome, BookResult, BookingStatus, BookingView, CancelResult, Failure, HoldResult, ListResult,
  MockTools, ProviderResult, ProviderSummary, RescheduleResult, ScenarioConfig, SearchResult, StatusResult,
} from "./types.ts";
import { AREAS, SERVICES } from "./types.ts";

export const HOLD_MINUTES = 10;
const SIDE_EFFECT_TOOLS = ["hold_slot", "book", "cancel", "reschedule"];
const EMPTY_CONFIG: ScenarioConfig = { forceBook: [], holdPriceDeltas: [], conflictSlots: [], providerSlots: {} };

interface BookingRow {
  booking_id: string; user_id: string; provider_id: string; service: string; slot: string;
  price: number; status: BookingStatus; hold_id: string | null; cancel_attempts: number;
}
interface HoldRow {
  hold_id: string; user_id: string; provider_id: string; slot: string;
  price: number; expires_at: number; state: string;
}
export interface MockCall {
  id: number; at: number; tool: string; args: Record<string, unknown>;
  result: Record<string, unknown>; outcome: string; side_effect: boolean;
}

function fail(error: string, status?: number): Failure {
  return status === undefined ? { ok: false, error } : { ok: false, error, status };
}

// The whole mock provider system. Each public snake_case method is one PDF tool.
// userId plays the part of an API login: the PDF's book() has no user argument,
// so the mock takes the user from the caller, as a real service would.
export class MockEnv implements MockTools {
  private db: DatabaseSync;
  private clock: Clock;
  private userId: string;

  constructor(options: { db: DatabaseSync; clock: Clock; seed?: number; userId?: string }) {
    this.db = options.db;
    this.clock = options.clock;
    this.userId = options.userId ?? SEED_USER;
    createMockSchema(this.db);
    // First open only. Reopening an existing file keeps its state.
    if (this.readMeta("rng_state") === undefined) {
      tx(this.db, () => {
        this.writeMeta("rng_state", String(options.seed ?? 1));
        this.writeMeta("config", JSON.stringify(EMPTY_CONFIG));
        seedBookings(this.db, this.clock);
      });
    }
  }

  // ---- The 8 tools ----

  async search_providers(args: { service: string; area: string; date_range: { from: string; to: string } }): Promise<SearchResult> {
    return this.logged("search_providers", args, () => {
      if (!(SERVICES as readonly string[]).includes(args.service)) return fail("unknown_service");
      if (!(AREAS as readonly string[]).includes(args.area)) return fail("unknown_area");
      if (args.date_range.from > args.date_range.to) return fail("bad_date_range");
      const providers = PROVIDERS
        .filter((p) => p.service === args.service && (p.areas as string[]).includes(args.area))
        .map((p) => this.summarise(p, args.date_range.from, args.date_range.to));
      return { ok: true, providers };
    });
  }

  async get_provider(args: { provider_id: string }): Promise<ProviderResult> {
    return this.logged("get_provider", args, () => {
      const provider = findProvider(args.provider_id);
      if (!provider) return fail("unknown_provider");
      const today = istDate(this.clock.now());
      const summary = this.summarise(provider, today, addDays(today, 14));
      return { ok: true, provider: { ...summary, about: provider.about, reviews: provider.reviews } };
    });
  }

  async hold_slot(args: { provider_id: string; slot: string }): Promise<HoldResult> {
    return this.logged("hold_slot", args, () => {
      const provider = findProvider(args.provider_id);
      if (!provider) return fail("unknown_provider");
      if (!this.isSlotFree(provider, args.slot)) return fail("slot_unavailable");

      const config = this.readConfig();
      const delta = config.holdPriceDeltas.shift() ?? 0;
      this.writeConfig(config);

      const holdId = `H-${String(this.count("holds") + 1).padStart(4, "0")}`;
      const price = provider.price + delta;
      const expiresAt = this.clock.now() + HOLD_MINUTES * 60 * 1000;
      this.db.prepare(
        `INSERT INTO holds (hold_id, user_id, provider_id, slot, price, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      ).run(holdId, this.userId, provider.provider_id, args.slot, price, expiresAt);
      return { ok: true, hold_id: holdId, provider_id: provider.provider_id, slot: args.slot, price, expires_at: new Date(expiresAt).toISOString() };
    });
  }

  async book(args: { hold_id: string; idempotency_key: string }): Promise<BookResult> {
    return this.logged("book", args, () => {
      // The key comes first: a retry after a timeout that really booked must
      // find that booking, even if the hold has expired since.
      const replay = this.findProcessed<BookResult>("book", args.idempotency_key);
      if (replay) return replay;

      const hold = this.getHold(args.hold_id);
      if (!hold) return fail("unknown_hold");
      if (this.clock.now() >= hold.expires_at) return fail("hold_expired");
      if (hold.state !== "active") return fail("slot_taken");

      const outcome = this.nextBookOutcome();
      if (outcome === "timeout_not_booked") return fail("timeout");
      if (outcome === "slot_taken") {
        const lost = fail("slot_taken");
        this.db.prepare("UPDATE holds SET state = 'lost' WHERE hold_id = ?").run(hold.hold_id);
        this.db.prepare("INSERT OR IGNORE INTO taken_slots (provider_id, slot) VALUES (?, ?)").run(hold.provider_id, hold.slot);
        this.saveProcessed("book", args.idempotency_key, lost, null);
        return lost;
      }

      const booked = this.createBooking(hold);
      this.saveProcessed("book", args.idempotency_key, booked, booked.booking_id);
      // timeout_booked: the booking exists, but the caller never hears about it.
      return outcome === "timeout_booked" ? fail("timeout") : booked;
    });
  }

  async get_booking_status(args: { hold_id?: string; idempotency_key?: string }): Promise<StatusResult> {
    return this.logged("get_booking_status", args, () => {
      if (!args.hold_id && !args.idempotency_key) return fail("missing_lookup");

      if (args.idempotency_key) {
        const row = this.db.prepare("SELECT result, booking_id FROM idempotency WHERE key = ?").get(args.idempotency_key) as
          | { result: string; booking_id: string | null } | undefined;
        if (row?.booking_id) return this.statusOf(this.getBooking(row.booking_id)!);
        if (row) return { ok: true, status: "not_booked", reason: (JSON.parse(row.result) as Failure).error };
      }
      if (args.hold_id) {
        if (!this.getHold(args.hold_id)) return fail("unknown_hold");
        const booking = this.db.prepare("SELECT * FROM bookings WHERE hold_id = ?").get(args.hold_id) as BookingRow | undefined;
        if (booking) return this.statusOf(booking);
      }
      return { ok: true, status: "not_booked" };
    });
  }

  async cancel(args: { booking_id: string; idempotency_key: string }): Promise<CancelResult> {
    return this.logged("cancel", args, () => {
      const replay = this.findProcessed<CancelResult>("cancel", args.idempotency_key);
      if (replay) return replay;

      const booking = this.getBooking(args.booking_id);
      if (!booking) return fail("unknown_booking");
      if (this.currentStatus(booking) !== "booked") return fail("booking_not_active");

      // PDF: the first call fails with a transient 503, the retry succeeds.
      if (booking.cancel_attempts === 0) {
        this.db.prepare("UPDATE bookings SET cancel_attempts = 1 WHERE booking_id = ?").run(booking.booking_id);
        return fail("service_unavailable", 503);
      }
      this.db.prepare("UPDATE bookings SET status = 'cancelled' WHERE booking_id = ?").run(booking.booking_id);
      const cancelled: CancelResult = { ok: true, status: "cancelled", booking_id: booking.booking_id };
      this.saveProcessed("cancel", args.idempotency_key, cancelled, booking.booking_id);
      return cancelled;
    });
  }

  async reschedule(args: { booking_id: string; slot: string; idempotency_key: string }): Promise<RescheduleResult> {
    return this.logged("reschedule", args, () => {
      const replay = this.findProcessed<RescheduleResult>("reschedule", args.idempotency_key);
      if (replay) return replay;

      const booking = this.getBooking(args.booking_id);
      if (!booking) return fail("unknown_booking");
      if (this.currentStatus(booking) !== "booked") return fail("booking_not_active");

      const provider = findProvider(booking.provider_id)!;
      if (this.readConfig().conflictSlots.includes(args.slot) || !this.isSlotFree(provider, args.slot)) {
        const conflict = fail("slot_conflict");
        this.saveProcessed("reschedule", args.idempotency_key, conflict, null);
        return conflict;
      }
      this.db.prepare("UPDATE bookings SET slot = ? WHERE booking_id = ?").run(args.slot, booking.booking_id);
      const moved: RescheduleResult = {
        ok: true, status: "booked", booking_id: booking.booking_id,
        provider_id: booking.provider_id, slot: args.slot, price: booking.price,
      };
      this.saveProcessed("reschedule", args.idempotency_key, moved, booking.booking_id);
      return moved;
    });
  }

  async list_bookings(args: { user_id: string }): Promise<ListResult> {
    return this.logged("list_bookings", args, () => {
      const rows = this.db.prepare("SELECT * FROM bookings WHERE user_id = ? ORDER BY slot").all(args.user_id) as unknown as BookingRow[];
      const bookings: BookingView[] = rows.map((row) => ({
        booking_id: row.booking_id,
        provider_id: row.provider_id,
        provider_name: findProvider(row.provider_id)?.name ?? row.provider_id,
        service: row.service as BookingView["service"],
        slot: row.slot,
        status: this.currentStatus(row),
        price: row.price,
      }));
      return { ok: true, bookings };
    });
  }

  // ---- Scenario controls. Not part of the PDF contract, never offered to the model. ----

  configure(changes: Partial<ScenarioConfig> & { providerCancels?: string[] }): void {
    const { providerCancels = [], ...rest } = changes;
    this.writeConfig({ ...this.readConfig(), ...rest });
    for (const bookingId of providerCancels) this.providerCancels(bookingId);
  }

  // The simulated event: a provider cancels a booking on their side.
  providerCancels(bookingId: string): void {
    tx(this.db, () => {
      this.db.prepare("UPDATE bookings SET status = 'cancelled_by_provider' WHERE booking_id = ?").run(bookingId);
      this.writeCall("provider_cancel_event", { booking_id: bookingId }, { ok: true }, true);
    });
  }

  addBooking(booking: { provider_id: string; service: string; slot: string; price: number }): string {
    const bookingId = this.nextBookingId();
    insertBooking(this.db, { ...booking, booking_id: bookingId, user_id: this.userId });
    return bookingId;
  }

  calls(tool?: string): MockCall[] {
    const rows = (tool
      ? this.db.prepare("SELECT * FROM mock_calls WHERE tool = ? ORDER BY id").all(tool)
      : this.db.prepare("SELECT * FROM mock_calls ORDER BY id").all()) as unknown as (Omit<MockCall, "args" | "result" | "side_effect"> & { args: string; result: string; side_effect: number })[];
    return rows.map((row) => ({ ...row, args: JSON.parse(row.args), result: JSON.parse(row.result), side_effect: row.side_effect === 1 }));
  }

  allBookings(): BookingRow[] {
    return this.db.prepare("SELECT * FROM bookings ORDER BY booking_id").all() as unknown as BookingRow[];
  }

  // Used by the fault wrapper so a simulated failure still shows up in mock_calls.
  logFaultedCall(tool: string, args: object, result: object): void {
    this.writeCall(tool, args, result, SIDE_EFFECT_TOOLS.includes(tool));
  }

  // ---- Internals ----

  // Runs one tool call in a transaction and logs it in that same transaction,
  // so the log can never disagree with what the call did.
  private logged<T extends object>(tool: string, args: object, run: () => T): Promise<T> {
    const result = tx(this.db, () => {
      const output = run();
      this.writeCall(tool, args, output, SIDE_EFFECT_TOOLS.includes(tool));
      return output;
    });
    return Promise.resolve(result);
  }

  private writeCall(tool: string, args: object, result: object, sideEffect: boolean): void {
    const outcome = (result as { ok?: boolean; error?: string }).ok === false ? String((result as Failure).error) : "ok";
    this.db.prepare(
      `INSERT INTO mock_calls (at, tool, args, result, outcome, side_effect) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(this.clock.now(), tool, JSON.stringify(args), JSON.stringify(result), outcome, sideEffect ? 1 : 0);
  }

  private nextBookOutcome(): BookOutcome {
    const config = this.readConfig();
    const forced = config.forceBook.shift();
    if (forced) {
      this.writeConfig(config);
      return forced;
    }
    const { value, state } = nextRandom(Number(this.readMeta("rng_state")));
    this.writeMeta("rng_state", String(state));
    if (value < 0.7) return "success";
    if (value < 0.85) return "slot_taken";
    return value < 0.925 ? "timeout_booked" : "timeout_not_booked";
  }

  private createBooking(hold: HoldRow): Extract<BookResult, { ok: true }> {
    const bookingId = this.nextBookingId();
    const provider = findProvider(hold.provider_id)!;
    insertBooking(this.db, {
      booking_id: bookingId, user_id: hold.user_id, provider_id: hold.provider_id,
      service: provider.service, slot: hold.slot, price: hold.price, hold_id: hold.hold_id,
    });
    this.db.prepare("UPDATE holds SET state = 'booked' WHERE hold_id = ?").run(hold.hold_id);
    return { ok: true, status: "booked", booking_id: bookingId, provider_id: hold.provider_id, slot: hold.slot, price: hold.price };
  }

  private summarise(provider: Provider, from: string, to: string): ProviderSummary {
    return {
      provider_id: provider.provider_id,
      name: provider.name,
      service: provider.service,
      areas: provider.areas,
      price: provider.price,
      rating: provider.rating,
      attributes: {
        years_experience: provider.years_experience,
        warranty_days: provider.warranty_days,
        verified: provider.verified,
      },
      available_slots: this.offeredSlots(provider, from, to).filter((slot) => this.isSlotFree(provider, slot)),
    };
  }

  private offeredSlots(provider: Provider, from: string, to: string): string[] {
    const override = this.readConfig().providerSlots[provider.provider_id];
    if (override) return override.filter((slot) => slot.slice(0, 10) >= from && slot.slice(0, 10) <= to);
    return generateSlots(provider, from, to);
  }

  private isSlotFree(provider: Provider, slot: string): boolean {
    const date = slot.slice(0, 10);
    if (!this.offeredSlots(provider, date, date).includes(slot)) return false;
    if (Date.parse(slot) <= this.clock.now()) return false;
    const id = provider.provider_id;
    const taken = this.db.prepare("SELECT 1 FROM taken_slots WHERE provider_id = ? AND slot = ?").get(id, slot);
    const held = this.db.prepare(
      "SELECT 1 FROM holds WHERE provider_id = ? AND slot = ? AND state = 'active' AND expires_at > ?",
    ).get(id, slot, this.clock.now());
    const booked = this.db.prepare(
      "SELECT 1 FROM bookings WHERE provider_id = ? AND slot = ? AND status = 'booked'",
    ).get(id, slot);
    return !taken && !held && !booked;
  }

  // A booking whose slot has passed reads as completed.
  private currentStatus(booking: BookingRow): BookingStatus {
    return booking.status === "booked" && Date.parse(booking.slot) < this.clock.now() ? "completed" : booking.status;
  }

  private statusOf(booking: BookingRow): StatusResult {
    return {
      ok: true, status: this.currentStatus(booking), booking_id: booking.booking_id,
      provider_id: booking.provider_id, slot: booking.slot, price: booking.price,
    };
  }

  private findProcessed<T>(tool: string, key: string): T | undefined {
    const row = this.db.prepare("SELECT result FROM idempotency WHERE tool = ? AND key = ?").get(tool, key) as { result: string } | undefined;
    return row ? (JSON.parse(row.result) as T) : undefined;
  }

  private saveProcessed(tool: string, key: string, result: object, bookingId: string | null): void {
    this.db.prepare("INSERT INTO idempotency (tool, key, result, booking_id) VALUES (?, ?, ?, ?)").run(tool, key, JSON.stringify(result), bookingId);
  }

  private getHold(holdId: string): HoldRow | undefined {
    return this.db.prepare("SELECT * FROM holds WHERE hold_id = ?").get(holdId) as HoldRow | undefined;
  }

  private getBooking(bookingId: string): BookingRow | undefined {
    return this.db.prepare("SELECT * FROM bookings WHERE booking_id = ?").get(bookingId) as BookingRow | undefined;
  }

  private nextBookingId(): string {
    return `B-${String(this.count("bookings") + 1).padStart(4, "0")}`;
  }

  private count(table: "holds" | "bookings"): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  private readMeta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  private writeMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private readConfig(): ScenarioConfig {
    return JSON.parse(this.readMeta("config")!) as ScenarioConfig;
  }

  private writeConfig(config: ScenarioConfig): void {
    this.writeMeta("config", JSON.stringify(config));
  }
}
