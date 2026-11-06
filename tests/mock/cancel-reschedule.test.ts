import { describe, expect, it } from "vitest";
import { UPCOMING_AC_BOOKING } from "../../src/mock/seed.ts";
import { makeMock } from "./helpers.ts";

describe("cancel", () => {
  it("fails with a 503 on the first call and succeeds on the retry", async () => {
    const { mock } = makeMock();
    const args = { booking_id: UPCOMING_AC_BOOKING, idempotency_key: "c1" };
    expect(await mock.cancel(args)).toEqual({ ok: false, error: "service_unavailable", status: 503 });
    expect(await mock.cancel(args)).toEqual({ ok: true, status: "cancelled", booking_id: UPCOMING_AC_BOOKING });
    expect(mock.calls("cancel").map((c) => c.outcome)).toEqual(["service_unavailable", "ok"]);
  });

  it("does not cancel anything on the failed first call", async () => {
    const { mock } = makeMock();
    await mock.cancel({ booking_id: UPCOMING_AC_BOOKING, idempotency_key: "c1" });
    expect(mock.allBookings().find((b) => b.booking_id === UPCOMING_AC_BOOKING)?.status).toBe("booked");
  });

  it("replays the same result for the same key", async () => {
    const { mock } = makeMock();
    const args = { booking_id: UPCOMING_AC_BOOKING, idempotency_key: "c1" };
    await mock.cancel(args);
    const done = await mock.cancel(args);
    expect(await mock.cancel(args)).toEqual(done);
  });

  it("the source of truth reflects a cancellation", async () => {
    const { mock } = makeMock();
    const args = { booking_id: UPCOMING_AC_BOOKING, idempotency_key: "c1" };
    await mock.cancel(args);
    await mock.cancel(args);
    expect(await mock.get_booking_status({ idempotency_key: "c1" })).toMatchObject({ ok: true, status: "cancelled" });
  });

  it("refuses unknown and inactive bookings", async () => {
    const { mock } = makeMock();
    expect(await mock.cancel({ booking_id: "B-9999", idempotency_key: "x" })).toEqual({ ok: false, error: "unknown_booking" });
    await mock.cancel({ booking_id: UPCOMING_AC_BOOKING, idempotency_key: "c1" });
    await mock.cancel({ booking_id: UPCOMING_AC_BOOKING, idempotency_key: "c1" });
    expect(await mock.cancel({ booking_id: UPCOMING_AC_BOOKING, idempotency_key: "c2" })).toEqual({ ok: false, error: "booking_not_active" });
  });
});

describe("reschedule", () => {
  const SATURDAY = "2026-11-14T10:00:00+05:30";

  it("moves the booking and keeps the price", async () => {
    const { mock } = makeMock();
    expect(await mock.reschedule({ booking_id: UPCOMING_AC_BOOKING, slot: SATURDAY, idempotency_key: "r1" }))
      .toMatchObject({ ok: true, status: "booked", slot: SATURDAY, price: 1200 });
    expect(await mock.get_booking_status({ idempotency_key: "r1" })).toMatchObject({ slot: SATURDAY });
  });

  it("returns slot_conflict on configured slots and does not move the booking", async () => {
    const { mock } = makeMock();
    const before = mock.allBookings().find((b) => b.booking_id === UPCOMING_AC_BOOKING)?.slot;
    mock.configure({ conflictSlots: [SATURDAY] });
    expect(await mock.reschedule({ booking_id: UPCOMING_AC_BOOKING, slot: SATURDAY, idempotency_key: "r1" })).toEqual({ ok: false, error: "slot_conflict" });
    expect(mock.allBookings().find((b) => b.booking_id === UPCOMING_AC_BOOKING)?.slot).toBe(before);
  });

  it("returns slot_conflict for a slot the provider does not offer", async () => {
    const { mock } = makeMock();
    expect(await mock.reschedule({ booking_id: UPCOMING_AC_BOOKING, slot: "2026-11-14T03:00:00+05:30", idempotency_key: "r1" })).toEqual({ ok: false, error: "slot_conflict" });
  });

  it("is idempotent on its key", async () => {
    const { mock } = makeMock();
    const args = { booking_id: UPCOMING_AC_BOOKING, slot: SATURDAY, idempotency_key: "r1" };
    const first = await mock.reschedule(args);
    expect(await mock.reschedule(args)).toEqual(first);
  });
});

describe("provider cancellation event", () => {
  it("shows up in list_bookings and in the source of truth", async () => {
    const { mock } = makeMock();
    mock.configure({ providerCancels: [UPCOMING_AC_BOOKING] });
    const result = await mock.list_bookings({ user_id: "u1" });
    if (!result.ok) throw new Error(result.error);
    expect(result.bookings.find((b) => b.booking_id === UPCOMING_AC_BOOKING)?.status).toBe("cancelled_by_provider");
  });

  it("frees the slot for other customers", async () => {
    const { mock } = makeMock();
    const slot = mock.allBookings().find((b) => b.booking_id === UPCOMING_AC_BOOKING)!.slot;
    expect(await mock.hold_slot({ provider_id: "ac_1", slot })).toEqual({ ok: false, error: "slot_unavailable" });
    mock.providerCancels(UPCOMING_AC_BOOKING);
    expect((await mock.hold_slot({ provider_id: "ac_1", slot })).ok).toBe(true);
  });
});
