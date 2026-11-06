import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.ts";
import { openDb } from "../../src/db.ts";
import { MockEnv } from "../../src/mock/env.ts";

const SLOT = "2026-11-10T09:00:00+05:30";

describe("restart keeps mock state", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mock-restart-"));
    path = join(dir, "mock.sqlite");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function open(clock: FakeClock, seed = 1) {
    const db = openDb(path);
    return { db, mock: new MockEnv({ db, clock, seed }) };
  }

  it("keeps bookings, the idempotency record and the call log", async () => {
    const clock = new FakeClock();
    const first = open(clock);
    first.mock.configure({ forceBook: ["success"] });
    const hold = await first.mock.hold_slot({ provider_id: "pl_1", slot: SLOT });
    if (!hold.ok) throw new Error(hold.error);
    const booked = await first.mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" });
    first.db.close();

    const second = open(clock);
    expect(await second.mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" })).toEqual(booked);
    expect(second.mock.allBookings().filter((b) => b.hold_id === hold.hold_id)).toHaveLength(1);
    expect(second.mock.calls("book")).toHaveLength(2);
    second.db.close();
  });

  it("does not seed twice", async () => {
    const clock = new FakeClock();
    const first = open(clock);
    const before = first.mock.allBookings().length;
    first.db.close();
    const second = open(clock);
    expect(second.mock.allBookings()).toHaveLength(before);
    second.db.close();
  });

  it("keeps a forced outcome queued across a restart", async () => {
    const clock = new FakeClock();
    const first = open(clock);
    first.mock.configure({ forceBook: ["slot_taken"] });
    first.db.close();

    const second = open(clock);
    const hold = await second.mock.hold_slot({ provider_id: "pl_1", slot: SLOT });
    if (!hold.ok) throw new Error(hold.error);
    expect(await second.mock.book({ hold_id: hold.hold_id, idempotency_key: "k1" })).toEqual({ ok: false, error: "slot_taken" });
    second.db.close();
  });

  it("continues the random sequence instead of replaying it", async () => {
    async function outcomes(mock: MockEnv, days: string[]): Promise<string[]> {
      const results: string[] = [];
      for (const day of days) {
        const hold = await mock.hold_slot({ provider_id: "pl_2", slot: `2026-11-${day}T08:00:00+05:30` });
        if (!hold.ok) throw new Error(hold.error);
        const result = await mock.book({ hold_id: hold.hold_id, idempotency_key: `k${day}` });
        results.push(result.ok ? "success" : result.error);
      }
      return results;
    }

    const clock = new FakeClock();
    const unbroken = new MockEnv({ db: openDb(":memory:"), clock, seed: 7 });
    const expected = await outcomes(unbroken, ["10", "11", "12", "13"]);

    const first = open(clock, 7);
    const before = await outcomes(first.mock, ["10", "11"]);
    first.db.close();
    const second = open(clock, 7);
    const after = await outcomes(second.mock, ["12", "13"]);
    second.db.close();

    expect([...before, ...after]).toEqual(expected);
  });
});
