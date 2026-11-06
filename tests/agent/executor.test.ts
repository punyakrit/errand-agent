import { describe, expect, it } from "vitest";
import { say, tool } from "../../src/llm/scripted.ts";
import { UPCOMING_AC_BOOKING } from "../../src/mock/seed.ts";
import { atApproval, makeAgent, USER } from "./helpers.ts";

function booked(made: { mock: { allBookings(): { hold_id: string | null }[] } }) {
  return made.mock.allBookings().filter((booking) => booking.hold_id !== null);
}

describe("verification", () => {
  it("checks the source of truth even after a plain success", async () => {
    const made = await atApproval({}, (m) => m.mock.configure({ forceBook: ["success"] }));
    await made.send("yes");
    const tools = made.mock.calls().map((call) => call.tool);
    expect(tools.indexOf("get_booking_status")).toBeGreaterThan(tools.indexOf("book"));
    expect(made.agent.deps.tasks.all(USER)[0]).toMatchObject({ state: "DONE" });
    expect(made.agent.deps.tasks.all(USER)[0]?.details.result).toMatchObject({ verified_status: "booked" });
  });

  it("does not claim success if verification fails after a success", async () => {
    const made = await atApproval({ faults: { statusUnavailable: true } }, (m) => m.mock.configure({ forceBook: ["success"] }));
    const result = await made.send("yes");
    expect(result.reply).not.toMatch(/booked and verified/i);
    expect(result.reply).toContain("can't confirm");
    expect(made.agent.deps.ops.open()).toHaveLength(1);
  });

  it("walks the states in order", async () => {
    const made = await atApproval({}, (m) => m.mock.configure({ forceBook: ["success"] }));
    await made.send("yes");
    const path = made.events("state_transition").map((event) => event.to);
    expect(path).toEqual(["SEARCHING", "COMPARING", "HOLDING", "AWAITING_APPROVAL", "EXECUTING", "VERIFYING", "DONE"]);
  });
});

describe("timeouts", () => {
  it("timeout that really booked: asks the source of truth and does not retry", async () => {
    const made = await atApproval({}, (m) => m.mock.configure({ forceBook: ["timeout_booked"] }));
    const result = await made.send("yes");
    expect(result.reply).toContain("Booked and verified");
    expect(made.mock.calls("book")).toHaveLength(1);
    expect(booked(made)).toHaveLength(1);
  });

  it("timeout that did not book: retries with the same key", async () => {
    const made = await atApproval({}, (m) => m.mock.configure({ forceBook: ["timeout_not_booked", "success"] }));
    const result = await made.send("yes");
    expect(result.reply).toContain("Booked and verified");
    const calls = made.mock.calls("book");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args.idempotency_key).toBe(calls[1]?.args.idempotency_key);
    expect(booked(made)).toHaveLength(1);
  });

  it("status never answers: reports unconfirmed, does not retry, keeps the op open", async () => {
    const made = await atApproval({ faults: { statusUnavailable: true } }, (m) => m.mock.configure({ forceBook: ["timeout_booked"] }));
    const result = await made.send("yes");
    expect(result.reply).toContain("can't confirm");
    expect(result.reply).not.toMatch(/booked and verified/i);
    expect(made.mock.calls("book")).toHaveLength(1);
    expect(made.agent.deps.ops.open()).toHaveLength(1);
    expect(made.task()?.state).toBe("NEEDS_USER");
    expect(made.mock.calls("get_booking_status")).toHaveLength(4); // bounded
  });

  it("uses bounded backoff on the injected clock", async () => {
    const made = await atApproval({ faults: { statusUnavailable: true } }, (m) => m.mock.configure({ forceBook: ["timeout_booked"] }));
    const before = made.clock.now();
    await made.send("yes");
    expect(made.clock.now() - before).toBe(500 + 1000 + 2000 + 4000);
  });

  it("a repeated yes during an unconfirmed outcome does not book again", async () => {
    const made = await atApproval({ faults: { statusUnavailable: true } }, (m) => m.mock.configure({ forceBook: ["timeout_not_booked", "success"] }));
    await made.send("yes");
    const again = await made.send("yes");
    expect(again.reply).toContain("can't confirm");
    expect(made.mock.calls("book")).toHaveLength(1);
  });

  it("a new hold and a new approval when not booked and the hold has expired", async () => {
    const made = await atApproval(
      { checkpoint: async (name) => { if (name === "book_returned") made.clock.advance(11 * 60 * 1000); } },
      (m) => m.mock.configure({ forceBook: ["timeout_not_booked"] }),
    );
    const result = await made.send("yes");
    expect(result.reason).toBe("awaiting_approval");
    expect(made.mock.calls("book")).toHaveLength(1);
    expect(made.mock.calls("hold_slot")).toHaveLength(2);
    const approvals = made.agent.deps.approvals.all(USER);
    expect(approvals.map((approval) => approval.status)).toEqual(["consumed", "pending"]);
    expect(made.agent.deps.ops.open()).toHaveLength(0);
  });

  it("book returning hold_expired leads to a new hold and a new approval", async () => {
    const made = await atApproval(
      { checkpoint: async (name) => { if (name === "op_started") made.clock.advance(11 * 60 * 1000); } },
      (m) => m.mock.configure({ forceBook: ["success"] }),
    );
    const result = await made.send("yes");
    expect(made.mock.calls("book").map((call) => call.outcome)).toEqual(["hold_expired"]);
    expect(result.reason).toBe("awaiting_approval");
    expect(made.agent.deps.ops.all()[0]?.state).toBe("failed");
    expect(booked(made)).toHaveLength(0);
  });

  it("stops after bounded retries when nothing gets through", async () => {
    const made = await atApproval({}, (m) => m.mock.configure({ forceBook: Array(6).fill("timeout_not_booked") }));
    const result = await made.send("yes");
    expect(made.mock.calls("book")).toHaveLength(4); // first try plus 3 retries
    expect(result.reply).toContain("confirmed nothing was booked");
    expect(booked(made)).toHaveLength(0);
    expect(made.task()?.state).toBe("NEEDS_USER");
  });

  it("treats book throwing as an unknown result, not a failure", async () => {
    const made = await atApproval({ faults: { throwOn: { book: 1 } } }, (m) => m.mock.configure({ forceBook: ["success"] }));
    const result = await made.send("yes");
    expect(result.reply).toContain("Booked and verified");
    expect(booked(made)).toHaveLength(1);
  });

  it("recovers on the next message once the status comes back", async () => {
    const faults = { statusUnavailable: true };
    const made = await atApproval({ faults }, (m) => m.mock.configure({ forceBook: ["timeout_booked"] }));
    await made.send("yes");
    expect(made.agent.deps.ops.open()).toHaveLength(1);
    (made.agent.deps.mock as unknown as { faults: { statusUnavailable: boolean } }).faults.statusUnavailable = false;
    made.llm.add(say("Glad to help."));
    const next = await made.send("any news?");
    expect(next.notices[0]).toContain("Booked and verified");
    expect(made.agent.deps.ops.open()).toHaveLength(0);
    expect(made.mock.calls("book")).toHaveLength(1);
  });
});

describe("slot_taken", () => {
  it("offers fresh options, then needs a fresh hold and approval", async () => {
    const made = await atApproval({}, (m) => m.mock.configure({ forceBook: ["slot_taken", "success"] }));
    const taken = await made.send("yes");
    expect(taken.reply).toContain("was taken");
    expect(taken.reply).toContain("Nothing".toLowerCase());
    expect(made.task()?.state).toBe("COMPARING");

    made.llm.add(tool("hold_slot", { provider_id: "pl_2", slot: "2026-11-10T08:00:00+05:30" }), tool("request_approval"));
    const card = await made.send("Aqua Fix then");
    expect(card.reason).toBe("awaiting_approval");
    await made.send("yes");

    const approvals = made.agent.deps.approvals.all(USER);
    expect(approvals).toHaveLength(2);
    const keys = made.mock.calls("book").map((call) => call.args.idempotency_key);
    expect(new Set(keys).size).toBe(2);
    expect(booked(made)).toHaveLength(1);
    expect(booked(made)[0]).toMatchObject({ provider_id: "pl_2" });
  });

  it("does not offer the taken slot again", async () => {
    const made = await atApproval({}, (m) => m.mock.configure({ forceBook: ["slot_taken"] }));
    await made.send("yes");
    const sharma = made.task()!.details.options!.find((option) => option.provider_id === "pl_1");
    expect(sharma?.slots).not.toContain("2026-11-10T09:00:00+05:30");
  });

  it("closes the failed op, so a later yes does not replay it", async () => {
    const made = await atApproval({}, (m) => m.mock.configure({ forceBook: ["slot_taken"] }));
    await made.send("yes");
    expect(made.agent.deps.ops.all()[0]?.state).toBe("failed");
    made.llm.add(say("Which option would you like?"));
    expect((await made.send("yes")).reply).toBe("Which option would you like?");
    expect(made.mock.calls("book")).toHaveLength(1);
  });
});

describe("cancel retries", () => {
  it("stops after bounded retries, with the same key, and says it failed", async () => {
    const made = makeAgent([tool("update_request", { kind: "cancel", service: "ac_service" }), tool("request_approval")], { faults: { cancelAlways503: true } });
    await made.send("cancel my AC service");
    const before = made.clock.now();
    const result = await made.send("yes");
    const calls = made.mock.calls("cancel");
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((call) => call.args.idempotency_key)).size).toBe(1);
    expect(made.clock.now() - before).toBe(500 + 1000 + 2000);
    expect(result.reply).toContain("could not cancel");
    expect(result.reply).not.toMatch(/cancelled and verified/i);
    expect(made.mock.allBookings().find((booking) => booking.booking_id === UPCOMING_AC_BOOKING)?.status).toBe("booked");
    expect(made.agent.deps.tasks.all(USER)[0]?.state).toBe("FAILED");
  });
});
