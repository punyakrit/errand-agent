import { describe, expect, it } from "vitest";
import { UPCOMING_AC_BOOKING } from "../../src/mock/seed.ts";
import { holdPlumber, makeMock, WEEK } from "./helpers.ts";

describe("mock_calls log", () => {
  it("records every side-effect call with its outcome", async () => {
    const { mock } = makeMock();
    const hold = await holdPlumber(mock);
    mock.configure({ forceBook: ["slot_taken"], conflictSlots: ["2026-11-14T10:00:00+05:30"] });
    await mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" });
    await mock.cancel({ booking_id: UPCOMING_AC_BOOKING, idempotency_key: "c1" });
    await mock.reschedule({ booking_id: UPCOMING_AC_BOOKING, slot: "2026-11-14T10:00:00+05:30", idempotency_key: "r1" });

    const effects = mock.calls().filter((call) => call.side_effect);
    expect(effects.map((call) => [call.tool, call.outcome])).toEqual([
      ["hold_slot", "ok"],
      ["book", "slot_taken"],
      ["cancel", "service_unavailable"],
      ["reschedule", "slot_conflict"],
    ]);
  });

  it("marks reads as not being side effects", async () => {
    const { mock } = makeMock();
    await mock.search_providers({ service: "plumber", area: "Indiranagar", date_range: WEEK });
    await mock.list_bookings({ user_id: "u1" });
    await mock.get_provider({ provider_id: "pl_1" });
    await mock.get_booking_status({ idempotency_key: "nothing" });
    expect(mock.calls().filter((call) => call.side_effect)).toHaveLength(0);
    expect(mock.calls()).toHaveLength(4);
  });

  it("stores the arguments and result of each call", async () => {
    const { mock } = makeMock();
    const hold = await holdPlumber(mock);
    const [call] = mock.calls("hold_slot");
    expect(call?.args).toEqual({ provider_id: "pl_1", slot: hold.slot });
    expect(call?.result).toMatchObject({ hold_id: hold.hold_id, price: 800 });
  });
});
