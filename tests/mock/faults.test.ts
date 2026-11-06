import { describe, expect, it } from "vitest";
import { FaultyTools } from "../../src/mock/faults.ts";
import { UPCOMING_AC_BOOKING } from "../../src/mock/seed.ts";
import { makeMock } from "./helpers.ts";

describe("fault wrapper", () => {
  it("throws a set number of times, then passes through", async () => {
    const { mock } = makeMock();
    const tools = new FaultyTools(mock, { throwOn: { list_bookings: 1 } });
    await expect(tools.list_bookings({ user_id: "u1" })).rejects.toThrow("simulated unexpected failure");
    expect((await tools.list_bookings({ user_id: "u1" })).ok).toBe(true);
  });

  it("can make status unavailable, and logs the attempt", async () => {
    const { mock } = makeMock();
    const tools = new FaultyTools(mock, { statusUnavailable: true });
    expect(await tools.get_booking_status({ idempotency_key: "k" })).toMatchObject({ ok: false, error: "status_unavailable" });
    expect(mock.calls("get_booking_status")).toHaveLength(1);
  });

  it("can keep cancel failing so retries run out, and still logs each call", async () => {
    const { mock } = makeMock();
    const tools = new FaultyTools(mock, { cancelAlways503: true });
    const args = { booking_id: UPCOMING_AC_BOOKING, idempotency_key: "c1" };
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(await tools.cancel(args)).toMatchObject({ ok: false, status: 503 });
    }
    expect(mock.calls("cancel")).toHaveLength(4);
    expect(mock.allBookings().find((b) => b.booking_id === UPCOMING_AC_BOOKING)?.status).toBe("booked");
  });

  it("leaves the mock contract untouched when no fault is set", async () => {
    const { mock } = makeMock();
    const tools = new FaultyTools(mock, {});
    const args = { booking_id: UPCOMING_AC_BOOKING, idempotency_key: "c1" };
    expect(await tools.cancel(args)).toMatchObject({ status: 503 });
    expect(await tools.cancel(args)).toMatchObject({ ok: true, status: "cancelled" });
  });
});
