import { describe, expect, it } from "vitest";
import { holdPlumber, makeMock, WEEK } from "./helpers.ts";

const TEN_MINUTES = 10 * 60 * 1000;
const SLOT = "2026-11-10T09:00:00+05:30";

describe("hold_slot", () => {
  it("holds for 10 minutes and returns a hold ID and expiry", async () => {
    const { mock, clock } = makeMock();
    const hold = await holdPlumber(mock);
    expect(hold.hold_id).toBeTruthy();
    expect(Date.parse(hold.expires_at)).toBe(clock.now() + TEN_MINUTES);
    expect(hold.price).toBe(800);
  });

  it("can quote a different price, one change at a time", async () => {
    const { mock } = makeMock();
    mock.configure({ holdPriceDeltas: [250] });
    expect((await holdPlumber(mock)).price).toBe(1050);
    const next = await mock.hold_slot({ provider_id: "pl_1", slot: "2026-11-11T09:00:00+05:30" });
    expect(next.ok && next.price).toBe(800);
  });

  it("refuses a slot that is already held, then frees it after expiry", async () => {
    const { mock, clock } = makeMock();
    await holdPlumber(mock);
    expect(await mock.hold_slot({ provider_id: "pl_1", slot: SLOT })).toEqual({ ok: false, error: "slot_unavailable" });
    clock.advance(TEN_MINUTES);
    expect((await mock.hold_slot({ provider_id: "pl_1", slot: SLOT })).ok).toBe(true);
  });

  it("refuses a slot the provider does not offer, and a slot in the past", async () => {
    const { mock } = makeMock();
    expect(await mock.hold_slot({ provider_id: "pl_1", slot: "2026-11-10T03:00:00+05:30" })).toEqual({ ok: false, error: "slot_unavailable" });
    expect(await mock.hold_slot({ provider_id: "pl_1", slot: "2026-11-02T09:00:00+05:30" })).toEqual({ ok: false, error: "slot_unavailable" });
  });

  it("hides a held slot from search", async () => {
    const { mock } = makeMock();
    await holdPlumber(mock);
    const result = await mock.search_providers({ service: "plumber", area: "Indiranagar", date_range: WEEK });
    if (!result.ok) throw new Error(result.error);
    expect(result.providers.find((p) => p.provider_id === "pl_1")?.available_slots).not.toContain(SLOT);
  });
});

describe("book", () => {
  it("creates one booking on success", async () => {
    const { mock } = makeMock();
    const hold = await holdPlumber(mock);
    mock.configure({ forceBook: ["success"] });
    const result = await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" });
    expect(result).toMatchObject({ ok: true, status: "booked", provider_id: "pl_1", slot: SLOT, price: 800 });
    expect(mock.allBookings().filter((b) => b.hold_id === hold.hold_id)).toHaveLength(1);
  });

  it("books at the held price, not the search price", async () => {
    const { mock } = makeMock();
    mock.configure({ holdPriceDeltas: [300], forceBook: ["success"] });
    const hold = await holdPlumber(mock);
    expect(await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" })).toMatchObject({ ok: true, price: 1100 });
  });

  it("is idempotent: same key, same result, no second booking", async () => {
    const { mock } = makeMock();
    const hold = await holdPlumber(mock);
    mock.configure({ forceBook: ["success"] });
    const first = await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" });
    const second = await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" });
    const third = await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(mock.allBookings().filter((b) => b.hold_id === hold.hold_id)).toHaveLength(1);
    expect(mock.calls("book")).toHaveLength(3);
  });

  it("keeps slot_taken stable for the same key and removes the slot from search", async () => {
    const { mock, clock } = makeMock();
    const hold = await holdPlumber(mock);
    mock.configure({ forceBook: ["slot_taken", "success"] });
    expect(await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" })).toEqual({ ok: false, error: "slot_taken" });
    expect(await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" })).toEqual({ ok: false, error: "slot_taken" });
    clock.advance(TEN_MINUTES);
    expect(await mock.hold_slot({ provider_id: "pl_1", slot: SLOT })).toEqual({ ok: false, error: "slot_unavailable" });
  });

  it("returns hold_expired at and past expiry, and books nothing", async () => {
    const { mock, clock } = makeMock();
    const hold = await holdPlumber(mock);
    clock.advance(TEN_MINUTES);
    expect(await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" })).toEqual({ ok: false, error: "hold_expired" });
    expect(mock.allBookings().filter((b) => b.hold_id === hold.hold_id)).toHaveLength(0);
  });

  it("timeout that really booked: retrying the key returns that booking", async () => {
    const { mock } = makeMock();
    const hold = await holdPlumber(mock);
    mock.configure({ forceBook: ["timeout_booked"] });
    expect(await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" })).toEqual({ ok: false, error: "timeout" });
    expect(await mock.get_booking_status({ idempotency_key: "k1" })).toMatchObject({ ok: true, status: "booked" });
    expect(await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" })).toMatchObject({ ok: true, status: "booked" });
    expect(mock.allBookings().filter((b) => b.hold_id === hold.hold_id)).toHaveLength(1);
  });

  it("timeout that did not book: the same key can still go through, once", async () => {
    const { mock } = makeMock();
    const hold = await holdPlumber(mock);
    mock.configure({ forceBook: ["timeout_not_booked", "success"] });
    expect(await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" })).toEqual({ ok: false, error: "timeout" });
    expect(await mock.get_booking_status({ idempotency_key: "k1" })).toEqual({ ok: true, status: "not_booked" });
    expect(await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" })).toMatchObject({ ok: true, status: "booked" });
    expect(mock.allBookings().filter((b) => b.hold_id === hold.hold_id)).toHaveLength(1);
  });

  it("the key wins over expiry: a booked key still replays after the hold expires", async () => {
    const { mock, clock } = makeMock();
    const hold = await holdPlumber(mock);
    mock.configure({ forceBook: ["timeout_booked"] });
    await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" });
    clock.advance(TEN_MINUTES * 2);
    expect(await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" })).toMatchObject({ ok: true, status: "booked" });
  });

  it("a different key on a used hold cannot make a second booking", async () => {
    const { mock } = makeMock();
    const hold = await holdPlumber(mock);
    mock.configure({ forceBook: ["success", "success"] });
    await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" });
    expect(await mock.book({ hold_id: hold.hold_id, idempotency_key: "k2" })).toEqual({ ok: false, error: "slot_taken" });
    expect(mock.allBookings().filter((b) => b.hold_id === hold.hold_id)).toHaveLength(1);
  });
});

describe("get_booking_status", () => {
  it("answers by hold ID and by key", async () => {
    const { mock } = makeMock();
    const hold = await holdPlumber(mock);
    mock.configure({ forceBook: ["success"] });
    const booked = await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" });
    if (!booked.ok) throw new Error(booked.error);
    const expected = { ok: true, status: "booked", booking_id: booked.booking_id };
    expect(await mock.get_booking_status({ hold_id: hold.hold_id })).toMatchObject(expected);
    expect(await mock.get_booking_status({ idempotency_key: "k1" })).toMatchObject(expected);
  });

  it("reports not_booked for a hold with no booking, with the reason when known", async () => {
    const { mock } = makeMock();
    const hold = await holdPlumber(mock);
    expect(await mock.get_booking_status({ hold_id: hold.hold_id })).toEqual({ ok: true, status: "not_booked" });
    mock.configure({ forceBook: ["slot_taken"] });
    await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" });
    expect(await mock.get_booking_status({ idempotency_key: "k1" })).toEqual({ ok: true, status: "not_booked", reason: "slot_taken" });
  });

  it("needs a hold ID or a key", async () => {
    const { mock } = makeMock();
    expect(await mock.get_booking_status({})).toEqual({ ok: false, error: "missing_lookup" });
    expect(await mock.get_booking_status({ hold_id: "H-9999" })).toEqual({ ok: false, error: "unknown_hold" });
  });
});
