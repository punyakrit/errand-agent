import { DatabaseSync } from "node:sqlite";
import { FakeClock } from "../../src/clock.ts";
import { MockEnv } from "../../src/mock/env.ts";
import type { HoldResult } from "../../src/mock/types.ts";

export const WEEK = { from: "2026-11-09", to: "2026-11-15" };

export function makeMock(seed = 1) {
  const clock = new FakeClock();
  const db = new DatabaseSync(":memory:");
  const mock = new MockEnv({ db, clock, seed });
  return { mock, clock, db };
}

// A fresh hold on a known free slot.
export async function holdPlumber(mock: MockEnv): Promise<Extract<HoldResult, { ok: true }>> {
  const hold = await mock.hold_slot({ provider_id: "pl_1", slot: "2026-11-10T09:00:00+05:30" });
  if (!hold.ok) throw new Error(`hold failed: ${hold.error}`);
  return hold;
}
