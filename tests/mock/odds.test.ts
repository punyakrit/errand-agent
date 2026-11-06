import { describe, expect, it } from "vitest";
import { makeMock } from "./helpers.ts";

const SEEDS = 2000;
const TOLERANCE = 0.03; // about 3 standard deviations at n = 2,000

describe("book odds across 2,000 seeds", () => {
  it("matches 70% success, 15% slot_taken, 15% timeout with half really booked", async () => {
    const counts = { success: 0, slot_taken: 0, timeout: 0, timeoutBooked: 0 };
    for (let seed = 0; seed < SEEDS; seed++) {
      const { mock } = makeMock(seed);
      const hold = await mock.hold_slot({ provider_id: "pl_1", slot: "2026-11-10T09:00:00+05:30" });
      if (!hold.ok) throw new Error(hold.error);
      const result = await mock.book({ hold_id: hold.hold_id, idempotency_key: "k" });
      if (result.ok) counts.success++;
      else if (result.error === "slot_taken") counts.slot_taken++;
      else {
        expect(result.error).toBe("timeout");
        counts.timeout++;
        const status = await mock.get_booking_status({ idempotency_key: "k" });
        if (status.ok && status.status === "booked") counts.timeoutBooked++;
      }
    }
    expect(Math.abs(counts.success / SEEDS - 0.7)).toBeLessThan(TOLERANCE);
    expect(Math.abs(counts.slot_taken / SEEDS - 0.15)).toBeLessThan(TOLERANCE);
    expect(Math.abs(counts.timeout / SEEDS - 0.15)).toBeLessThan(TOLERANCE);
    expect(Math.abs(counts.timeoutBooked / counts.timeout - 0.5)).toBeLessThan(0.1);
    console.log("book odds", counts);
  });

  it("is reproducible: the same seed gives the same outcomes", async () => {
    async function run(seed: number): Promise<string[]> {
      const { mock } = makeMock(seed);
      const outcomes: string[] = [];
      for (const day of ["10", "11", "12", "13"]) {
        const hold = await mock.hold_slot({ provider_id: "pl_1", slot: `2026-11-${day}T09:00:00+05:30` });
        if (!hold.ok) throw new Error(hold.error);
        const result = await mock.book({ hold_id: hold.hold_id, idempotency_key: `k${day}` });
        outcomes.push(result.ok ? "success" : result.error);
      }
      return outcomes;
    }
    expect(await run(42)).toEqual(await run(42));
  });
});
