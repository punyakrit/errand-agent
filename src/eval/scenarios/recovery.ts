import { tool } from "../../llm/scripted.ts";
import type { Scenario } from "../scenario.ts";
import { lastReply, reachApproval } from "../steps.ts";

export const recoveryScenarios: Scenario[] = [
  {
    id: "15", name: "Timeout, really booked, no retry",
    note: "The source of truth shows the booking, so book is not called again.",
    expect: { book_outcomes: ["timeout"], new_bookings: 1, verified: 1, last_state: "DONE" },
    run: async (w) => {
      w.mock.configure({ forceBook: ["timeout_booked"] });
      await reachApproval(w);
      await w.user("yes");
    },
  },
  {
    id: "16", name: "Timeout, not booked, retry with same key",
    note: "Confirmed not booked and the hold is valid, so it retries with the same key.",
    expect: { book_outcomes: ["timeout", "ok"], book_keys: 1, new_bookings: 1, last_state: "DONE" },
    run: async (w) => {
      w.mock.configure({ forceBook: ["timeout_not_booked", "success"] });
      await reachApproval(w);
      await w.user("yes");
    },
  },
  {
    id: "17", name: "Timeout, status stays unknown",
    note: "Reported as unconfirmed, not retried, and the op stays open.",
    world: { faults: { statusUnavailable: true } },
    expect: { book_calls: 1, open_ops: 1, verified: 0, last_state: "NEEDS_USER", says_unconfirmed: true, claims_success: false },
    run: async (w) => {
      w.mock.configure({ forceBook: ["timeout_booked"] });
      await reachApproval(w);
      await w.user("yes");
    },
    extra: (w) => ({ says_unconfirmed: lastReply(w).includes("can't confirm"), claims_success: /verified/i.test(lastReply(w)) }),
  },
  {
    id: "18", name: "slot_taken leads to a fresh option and fresh approval",
    note: "Code offers alternatives. The new pick needs a new hold, approval and key.",
    expect: { book_outcomes: ["slot_taken", "ok"], book_keys: 2, hold_calls: 2, approvals_consumed: 2, booked_provider: "pl_2", new_bookings: 1, last_state: "DONE" },
    run: async (w) => {
      w.mock.configure({ forceBook: ["slot_taken", "success"] });
      await reachApproval(w);
      await w.user("yes");
      w.script(tool("hold_slot", { provider_id: "pl_2", slot: "2026-11-10T08:00:00+05:30" }), tool("request_approval"));
      await w.user("Aqua Fix then.");
      await w.user("yes");
    },
  },
  {
    id: "20", name: "Crash before book",
    note: "The write-ahead row survives. Reconcile finds nothing booked and retries with the same key.",
    expect: { book_calls: 1, book_keys: 1, new_bookings: 1, open_ops: 0, last_state: "DONE", user_told: true },
    run: async (w) => {
      w.mock.configure({ forceBook: ["success"] });
      await reachApproval(w);
      await w.userThenCrash("yes", "op_started");
      await w.restart();
    },
    extra: (w) => ({ user_told: lastReply(w).includes("Booked and verified") }),
  },
  {
    id: "21", name: "Crash after book, before saving",
    note: "Reconcile finds the booking through the source of truth. book is not called again.",
    expect: { book_calls: 1, new_bookings: 1, open_ops: 0, last_state: "DONE", user_told: true },
    run: async (w) => {
      w.mock.configure({ forceBook: ["success"] });
      await reachApproval(w);
      await w.userThenCrash("yes", "book_returned");
      await w.restart();
    },
    extra: (w) => ({ user_told: lastReply(w).includes("Booked and verified") }),
  },
];
