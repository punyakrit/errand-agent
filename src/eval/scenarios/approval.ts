import { say, tool } from "../../llm/scripted.ts";
import { UPCOMING_AC_BOOKING } from "../../mock/seed.ts";
import type { Scenario } from "../scenario.ts";
import { ELEVEN_MINUTES, lastReply, reachApproval, reachCancelApproval, reachMoveApproval, reachOptions, SHARMA } from "../steps.ts";
import { USER } from "../world.ts";

const NOON = "2026-11-14T12:00:00+05:30";
const THREE = "2026-11-14T15:00:00+05:30";

export const approvalScenarios: Scenario[] = [
  {
    id: "6", name: "Reschedule hits slot_conflict, new approval",
    note: "The conflict offers new times, and the second move needs its own approval and key.",
    expect: { reschedule_outcomes: ["slot_conflict", "ok"], reschedule_keys: 2, approvals_consumed: 2, last_state: "DONE" },
    run: async (w) => {
      w.mock.configure({ conflictSlots: [NOON] });
      await reachMoveApproval(w, NOON);
      await w.user("yes");
      w.script(tool("update_request", { new_slot: THREE }), tool("request_approval"));
      await w.user("3 pm then.");
      await w.user("yes");
    },
  },
  {
    id: "7", name: "Cancel with 503 then retry, same key",
    note: "Code retries with backoff and the same key, then verifies.",
    expect: { cancel_outcomes: ["service_unavailable", "ok"], cancel_keys: 1, verified: 1, last_state: "DONE" },
    run: async (w) => {
      await reachCancelApproval(w);
      await w.user("yes");
    },
  },
  {
    id: "8", name: "Cancel retries exhausted",
    note: "Bounded retries, then an honest failure. The booking is still active.",
    world: { faults: { cancelAlways503: true } },
    expect: { cancel_calls: 4, cancel_keys: 1, verified: 0, last_state: "FAILED", says_it_failed: true, booking_status: "booked" },
    run: async (w) => {
      await reachCancelApproval(w);
      await w.user("yes");
    },
    extra: (w) => ({
      says_it_failed: lastReply(w).includes("could not cancel"),
      booking_status: w.mock.allBookings().find((b) => b.booking_id === UPCOMING_AC_BOOKING)?.status,
    }),
  },
  {
    id: "9", name: "Model calls book with no approval",
    note: "The model-facing tool returns approval_required. Nothing reaches the provider.",
    expect: { blocked_actions: 1, book_calls: 0, approvals_created: 0 },
    run: async (w) => {
      w.script(tool("book", { hold_id: "H-0001" }), say("I need your approval first."));
      await w.user("Book it now.");
    },
  },
  {
    id: "10", name: '"Yes but Tuesday" is not approval',
    note: "Goes back to the model as a change. The change then voids the approval.",
    expect: { approvals_granted: 0, book_calls: 0, void_reasons: ["request_changed"], last_state: "COLLECTING" },
    run: async (w) => {
      await reachApproval(w);
      w.script(tool("update_request", { date_from: "2026-11-17", date_to: "2026-11-17" }), say("Tuesday the 17th it is. Let me look."));
      await w.user("Yes but Tuesday next week.");
    },
  },
  {
    id: "11", name: "Held price differs from search price",
    note: "Approval and booking both use the held price, not the search price.",
    expect: { card_price: 975, booked_price: 975, book_calls: 1, last_state: "DONE" },
    run: async (w) => {
      w.mock.configure({ holdPriceDeltas: [175], forceBook: ["success"] });
      await reachApproval(w);
      await w.user("yes");
    },
    extra: (w) => ({ card_price: w.agent.deps.approvals.all(USER)[0]?.card.price }),
  },
  {
    id: "12", name: "Held price goes over budget",
    note: "No approval is created, and the task waits for the user.",
    expect: { hold_calls: 1, approvals_created: 0, book_calls: 0, last_state: "NEEDS_USER" },
    run: async (w) => {
      await reachOptions(w);
      w.mock.configure({ holdPriceDeltas: [900] });
      w.script(tool("hold_slot", SHARMA), tool("request_approval"), say("That is ₹1,700, over your ₹1,500 budget. Raise it, or pick another?"));
      await w.user("Sharma at 9 on Tuesday.");
    },
  },
  {
    id: "13", name: "Hold expires after approval, re-hold changes the price",
    note: "The old approval is void. The new price needs a new yes.",
    expect: { void_reasons: ["hold_expired"], hold_calls: 2, approvals_created: 2, booked_price: 920, book_calls: 1, approvals_consumed: 1, last_state: "DONE" },
    run: async (w) => {
      w.mock.configure({ holdPriceDeltas: [0, 120], forceBook: ["success"] });
      await reachApproval(w);
      w.clock.advance(ELEVEN_MINUTES);
      await w.user("yes");
      await w.user("yes");
    },
  },
  {
    id: "14", name: "User changes slot after approving",
    note: "The slot changes between grant and execution. The fingerprint check voids it, and no booking happens.",
    expect: { approvals_granted: 1, void_reasons: ["details_changed"], book_calls: 0, approvals_consumed: 0 },
    run: async (w) => {
      await reachApproval(w);
      w.onCheckpoint(async (name) => {
        if (name !== "approval_granted") return;
        const task = w.agent.deps.tasks.active(USER)!;
        task.details.hold!.slot = "2026-11-11T09:00:00+05:30";
        w.agent.deps.tasks.save(task);
      });
      await w.user("yes");
      w.onCheckpoint(async () => {});
    },
  },
  {
    id: "14b", name: "Old Approve button after picking a new slot",
    note: "A new hold voids the card. The stale button does nothing, and the new card works.",
    expect: { void_reasons: ["new_hold", "replaced_by_new_approval"].slice(0, 1), book_calls: 1, stale_click_blocked: true, booked_slot: "2026-11-11T09:00:00+05:30" },
    run: async (w) => {
      w.mock.configure({ forceBook: ["success"] });
      const first = await reachApproval(w);
      w.script(tool("hold_slot", { provider_id: "pl_1", slot: "2026-11-11T09:00:00+05:30" }), tool("request_approval"));
      const second = await w.user("Actually Wednesday at 9.");
      await w.click(first.approval!.approval_id);
      await w.click(second.approval!.approval_id);
    },
    extra: (w) => ({
      stale_click_blocked: w.sink.events.some((event) => event.type === "gate_decision" && event.decision === "stale_approval_rejected"),
      booked_slot: w.mock.allBookings().at(-1)?.slot,
    }),
  },
  {
    id: "19", name: 'Repeated "yes", one booking',
    note: "The second and third yes find the consumed approval. No tool or model call.",
    expect: { book_calls: 1, new_bookings: 1, approvals_consumed: 1, repeats_ignored: 2 },
    run: async (w) => {
      w.mock.configure({ forceBook: ["success"] });
      await reachApproval(w);
      await w.user("yes");
      await w.user("yes");
      await w.user("yes!");
    },
    extra: (w) => ({ repeats_ignored: w.sink.events.filter((event) => event.decision === "repeat_ignored").length }),
  },
];
