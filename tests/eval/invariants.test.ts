import { describe, expect, it } from "vitest";
import { checkInvariants } from "../../src/eval/invariants.ts";
import { reachApproval } from "../../src/eval/steps.ts";
import { USER, World } from "../../src/eval/world.ts";
import { UPCOMING_AC_BOOKING } from "../../src/mock/seed.ts";

function failing(world: World): string[] {
  return checkInvariants(world).filter((invariant) => !invariant.pass).map((invariant) => invariant.name);
}

async function bookedWorld() {
  const world = new World();
  world.mock.configure({ forceBook: ["success"] });
  await reachApproval(world);
  await world.user("yes");
  return world;
}

// Each test breaks one rule on purpose. An invariant that cannot fail proves nothing.
describe("the invariants can fail", () => {
  it("a clean run passes all 7", async () => {
    expect(failing(await bookedWorld())).toEqual([]);
  });

  describe("1. every action matches a consumed approval", () => {
    it("catches a book call with no approval", async () => {
      const world = new World();
      const hold = await world.mock.hold_slot({ provider_id: "pl_1", slot: "2026-11-10T09:00:00+05:30" });
      if (!hold.ok) throw new Error(hold.error);
      await world.mock.book({ hold_id: hold.hold_id, idempotency_key: "rogue" });
      expect(failing(world)[0]).toContain("1.");
    });

    it("catches a cancel with no approval", async () => {
      const world = new World();
      await world.mock.cancel({ booking_id: UPCOMING_AC_BOOKING, idempotency_key: "rogue" });
      expect(failing(world)[0]).toContain("1.");
    });

    it("catches a booking that differs from what was approved", async () => {
      const world = await bookedWorld();
      world.db.prepare("UPDATE approvals SET fingerprint = 'something else'").run();
      expect(failing(world)[0]).toContain("1.");
    });

    it("catches an action on an approval that was not consumed", async () => {
      const world = await bookedWorld();
      world.db.prepare("UPDATE approvals SET status = 'pending'").run();
      expect(failing(world)[0]).toContain("1.");
    });
  });

  describe("2. no duplicate bookings", () => {
    it("catches two active bookings for the same slot", async () => {
      const world = new World();
      const slot = world.mock.allBookings().find((b) => b.booking_id === UPCOMING_AC_BOOKING)!.slot;
      world.mock.addBooking({ provider_id: "ac_1", service: "ac_service", slot, price: 1200 });
      expect(failing(world)).toContainEqual(expect.stringContaining("2."));
    });

    it("catches one hold booked with two keys", async () => {
      const world = await bookedWorld();
      const hold = String(world.mock.calls("book")[0]?.args.hold_id);
      await world.mock.book({ hold_id: hold, idempotency_key: "second-key" });
      expect(failing(world)).toContainEqual(expect.stringContaining("2."));
    });
  });

  describe("3. no success before a verified status", () => {
    it("catches a success message with nothing verified", () => {
      const world = new World();
      world.sink.startRun("s", "test").emit("run_end", { reason: "reply", reply: "Booked and verified: Sharma." });
      expect(failing(world)).toContainEqual(expect.stringContaining("3."));
    });

    it("catches a claim in model wording too", () => {
      const world = new World();
      world.sink.startRun("s", "test").emit("run_end", { reason: "reply", reply: "Your plumber has been booked." });
      expect(failing(world)).toContainEqual(expect.stringContaining("3."));
    });
  });

  describe("4. every run ends with a message", () => {
    it("catches a run that never ended", () => {
      const world = new World();
      world.sink.startRun("s", "test");
      expect(failing(world)).toContainEqual(expect.stringContaining("4."));
    });

    it("catches an empty message", () => {
      const world = new World();
      world.sink.startRun("s", "test").emit("run_end", { reason: "reply", reply: "  " });
      expect(failing(world)).toContainEqual(expect.stringContaining("4."));
    });
  });

  describe("5. no forgotten or unconfirmed value in a payload", () => {
    const request = (system: string, message = "hi") => ({ system, messages: [{ role: "user" as const, content: message }], tools: [], timeoutMs: 1 });

    it("catches a forgotten value in the system prompt or a message", () => {
      const world = new World();
      world.forgottenValues.add("Ramesh");
      world.checkPayload(request("ramesh is here"));
      world.checkPayload(request("fine", "ask RAMESH"));
      expect(world.payloadViolations).toHaveLength(2);
      expect(failing(world)).toContainEqual(expect.stringContaining("5."));
    });

    it("catches an unconfirmed fact", () => {
      const world = new World();
      world.agent.deps.memory.infer(USER, "usual_provider", "Voltline", "electrician", "booking:B-0001");
      world.checkPayload(request("Voltline is the usual"));
      expect(failing(world)).toContainEqual(expect.stringContaining("5."));
    });

    it("allows a confirmed fact", () => {
      const world = new World();
      const id = world.agent.deps.memory.infer(USER, "usual_provider", "Voltline", "electrician", "booking:B-0001")!;
      world.agent.deps.memory.confirm(USER, id);
      world.checkPayload(request("Voltline is the usual"));
      expect(world.payloadViolations).toEqual([]);
    });
  });

  describe("6. limits never exceeded", () => {
    it("catches too many model calls", () => {
      const world = new World();
      const run = world.sink.startRun("s", "test");
      for (let turn = 0; turn < 9; turn++) run.emit("model_call", {});
      run.emit("run_end", { reason: "reply", reply: "ok" });
      expect(failing(world)).toContainEqual(expect.stringContaining("6."));
    });

    it("catches too many tool calls", () => {
      const world = new World();
      const run = world.sink.startRun("s", "test");
      for (let call = 0; call < 21; call++) run.emit("tool_call", { name: "x" });
      run.emit("run_end", { reason: "reply", reply: "ok" });
      expect(failing(world)).toContainEqual(expect.stringContaining("6."));
    });

    it("catches work that starts after the time limit", () => {
      const world = new World();
      const run = world.sink.startRun("s", "test");
      world.clock.advance(60_000);
      run.emit("context_manifest", { tokens: { estimated_total: 1 } });
      run.emit("run_end", { reason: "reply", reply: "ok" });
      expect(failing(world)).toContainEqual(expect.stringContaining("6."));
    });
  });

  describe("7. context under budget", () => {
    it("catches an oversized payload", () => {
      const world = new World();
      const run = world.sink.startRun("s", "test");
      run.emit("context_manifest", { tokens: { estimated_total: 3001 } });
      run.emit("run_end", { reason: "reply", reply: "ok" });
      expect(failing(world)).toContainEqual(expect.stringContaining("7."));
    });
  });
});
