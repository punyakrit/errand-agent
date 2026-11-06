import { describe, expect, it } from "vitest";
import { evalTable } from "../../src/eval/report.ts";
import { runScenario } from "../../src/eval/runner.ts";
import { SCENARIOS } from "../../src/eval/scenarios/index.ts";
import type { Scenario } from "../../src/eval/scenario.ts";
import { reachApproval } from "../../src/eval/steps.ts";
import { runSweep } from "../../src/eval/sweep.ts";

const REQUIRED = Array.from({ length: 36 }, (_, index) => String(index + 1));

describe("scenarios", () => {
  it("covers all 36 required scenarios", () => {
    const ids = SCENARIOS.map((scenario) => scenario.id);
    expect(ids).toEqual(expect.arrayContaining(REQUIRED));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("replays at least 3 real recordings from the project's model", () => {
    const recorded = SCENARIOS.filter((scenario) => scenario.mode === "recorded");
    expect(recorded.length).toBeGreaterThanOrEqual(3);
    for (const scenario of recorded) expect(scenario.expect.model_in_recording).toBe("claude-sonnet-5-5");
  });

  it.each(SCENARIOS.map((scenario) => [`${scenario.id}. ${scenario.name}`, scenario] as const))("%s", async (_, scenario) => {
    const result = await runScenario(scenario);
    expect(result.notes, result.notes).toBe(scenario.note);
    expect(result.pass).toBe(true);
  });
});

describe("the scenario runner", () => {
  const scenario = (expect: Scenario["expect"]): Scenario => ({
    id: "t", name: "test", note: "note", expect,
    run: async (world) => {
      world.mock.configure({ forceBook: ["success"] });
      await reachApproval(world);
      await world.user("yes");
    },
  });

  it("passes when facts match", async () => {
    expect((await runScenario(scenario({ book_calls: 1 }))).pass).toBe(true);
  });

  it("fails when the real facts differ from the expected ones", async () => {
    const result = await runScenario(scenario({ book_calls: 2 }));
    expect(result.pass).toBe(false);
    expect(result.actual).toEqual({ book_calls: 1 });
    expect(result.notes).toContain("book_calls differs");
  });

  it("fails when the scenario throws", async () => {
    const result = await runScenario({ ...scenario({}), run: async () => { throw new Error("boom"); } });
    expect(result.pass).toBe(false);
    expect(result.notes).toContain("boom");
  });

  it("fails when an invariant breaks, even if the facts match", async () => {
    const result = await runScenario({
      ...scenario({ book_calls: 1 }),
      run: async (world) => {
        const hold = await world.mock.hold_slot({ provider_id: "pl_1", slot: "2026-11-10T09:00:00+05:30" });
        if (hold.ok) await world.mock.book({ hold_id: hold.hold_id, idempotency_key: "rogue" });
      },
    });
    expect(result.mismatches).toEqual([]);
    expect(result.pass).toBe(false);
    expect(result.notes).toContain("invariant 1");
  });
});

describe("the generated table", () => {
  it("has the required columns and reports a failure plainly", async () => {
    const failed = await runScenario({ id: "x", name: "fails", note: "n", expect: { book_calls: 9 }, run: async () => {} });
    const table = evalTable([failed], { seeds: 1, passed: 1, failed: 0, outcomes: {}, failures: [] }, "npm run eval");
    expect(table).toContain("| Scenario | Mode | Expected | Actual | Result | Notes |");
    expect(table).toContain("**FAIL**");
    expect(table).toContain("book_calls=0");
    expect(table).toContain("0 of 1 scenarios passed");
  });
});

describe("500-seed sweep at the default odds", () => {
  it("keeps every invariant", async () => {
    const sweep = await runSweep(500);
    expect(sweep.failures).toEqual([]);
    expect(sweep.passed).toBe(500);
    // The sweep must really exercise the failure paths, not just the happy path.
    expect(sweep.outcomes.slot_taken).toBeGreaterThan(30);
    expect(sweep.outcomes.timeout).toBeGreaterThan(30);
  }, 120_000);
});
