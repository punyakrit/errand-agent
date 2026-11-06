import { call, say, tool } from "../../llm/scripted.ts";
import { UPCOMING_AC_BOOKING } from "../../mock/seed.ts";
import type { Scenario } from "../scenario.ts";
import { PLUMBER_REQUEST, reachApproval, reachMoveApproval, reachOptions, SATURDAY } from "../steps.ts";
import { USER } from "../world.ts";

const ELECTRICIAN = {
  service: "electrician", area: "Indiranagar", date_from: "2026-11-09", date_to: "2026-11-15",
  time_from: "10:00", any_budget: true, provider_id: "el_1",
};
const ELECTRICIAN_SEARCH = { service: "electrician", area: "Indiranagar", date_range: { from: "2026-11-09", to: "2026-11-15" } };
const NOON = "2026-11-14T12:00:00+05:30";

export const conversationScenarios: Scenario[] = [
  {
    id: "1", name: "Happy path, all details in the first message",
    note: "No questions, then search, pick, hold, approval and a verified booking.",
    expect: { questions: 0, book_calls: 1, new_bookings: 1, approvals_consumed: 1, verified: 1, last_state: "DONE" },
    run: async (w) => {
      w.mock.configure({ forceBook: ["success"] });
      await reachApproval(w);
      await w.user("yes");
    },
  },
  {
    id: "2", name: "Missing details, asks only for those",
    note: "The model also tries to re-ask the area. Code blocks that one.",
    expect: { asked_fields: ["date_window", "time_window"], reask_blocked: 1, book_calls: 0 },
    run: async (w) => {
      w.script(
        tool("update_request", { service: "plumber", area: "Indiranagar", budget_inr: 1500 }),
        tool("ask_user", { field: "area", question: "Which area?" }),
        call(
          { name: "ask_user", input: { field: "date_window", question: "Which dates?" } },
          { name: "ask_user", input: { field: "time_window", question: "What time of day?" } },
        ),
      );
      await w.user("I need a plumber in Indiranagar under 1500.");
    },
  },
  {
    id: "3", name: "One correction keeps all other fields",
    note: "Only the area changes. Old options are dropped because they were for the old area.",
    expect: { unchanged_fields_kept: true, area_after: "Koramangala", options_after: 0, last_state: "COLLECTING" },
    run: async (w) => {
      await reachOptions(w);
      w.script(tool("update_request", { area: "Koramangala" }), say("Noted."));
      await w.user("Actually make that Koramangala.");
    },
    extra: (w) => {
      const task = w.agent.deps.tasks.active(USER);
      const { area, ...rest } = task?.request ?? {};
      const { area: oldArea, ...expected } = PLUMBER_REQUEST;
      return {
        unchanged_fields_kept: JSON.stringify(rest) === JSON.stringify(expected) && oldArea !== area,
        area_after: area,
        options_after: task?.details.options?.length ?? 0,
      };
    },
  },
  {
    id: "4", name: '"Same electrician as last time, not before 10 a.m."',
    note: "Finds the provider from booking history and books a slot at or after 10.",
    expect: { booked_provider: "el_1", slot_at_or_after_ten: true, book_calls: 1, last_state: "DONE" },
    run: async (w) => {
      w.mock.configure({ forceBook: ["success"] });
      w.script(tool("list_bookings"), tool("update_request", ELECTRICIAN), tool("search_providers", ELECTRICIAN_SEARCH), say("Voltline has these slots."));
      await w.user("Book the same electrician as last time, but not before 10 a.m. Indiranagar, this week, any price.");
      w.script(tool("hold_slot", { provider_id: "el_1", slot: "2026-11-10T11:00:00+05:30" }), tool("request_approval"));
      await w.user("Tuesday at 11.");
      await w.user("yes");
    },
    extra: (w) => ({ slot_at_or_after_ten: (w.mock.allBookings().at(-1)?.slot.slice(11, 16) ?? "") >= "10:00" }),
  },
  {
    id: "4b", name: "Same electrician has no slot after 10 a.m.",
    note: "Says so and offers choices. It does not quietly switch provider.",
    expect: { hold_calls: 0, blocked_holds: 1, last_state: "NEEDS_USER", book_calls: 0 },
    run: async (w) => {
      w.mock.configure({ providerSlots: { el_1: ["2026-11-11T09:00:00+05:30"] } });
      w.script(tool("update_request", ELECTRICIAN), tool("search_providers", ELECTRICIAN_SEARCH), say("Voltline has nothing after 10. Do you want an earlier slot or another provider?"));
      await w.user("Book the same electrician as last time, but not before 10 a.m.");
      w.script(tool("hold_slot", { provider_id: "el_2", slot: "2026-11-10T10:00:00+05:30" }), say("Tell me which you prefer."));
      await w.user("Hmm.");
    },
  },
  {
    id: "5", name: '"Move my AC servicing to Saturday"',
    note: "Finds the booking, keeps the provider, moves after approval and verifies the new slot.",
    expect: { reschedule_outcomes: ["ok"], approvals_consumed: 1, verified: 1, last_state: "DONE", moved_to_saturday: true },
    run: async (w) => {
      await reachMoveApproval(w, NOON);
      await w.user("yes");
    },
    extra: (w) => ({ moved_to_saturday: w.mock.allBookings().find((b) => b.booking_id === UPCOMING_AC_BOOKING)?.slot === NOON }),
  },
  {
    id: "5b", name: '"My AC servicing" matches two bookings',
    note: "Asks which one. Nothing moves until the user says.",
    expect: { reschedule_calls: 0, approvals_created: 0, asked_fields: ["which_booking"], last_state: "NEEDS_USER" },
    run: async (w) => {
      w.mock.addBooking({ provider_id: "ac_2", service: "ac_service", slot: "2026-11-13T09:00:00+05:30", price: 999 });
      w.script(
        tool("update_request", { kind: "reschedule", service: "ac_service", date_from: SATURDAY.from, date_to: SATURDAY.to }),
        tool("ask_user", { field: "which_booking", question: "You have two AC services. Which one?" }),
      );
      await w.user("Move my AC servicing to Saturday.");
    },
  },
  {
    id: "first-msg", name: "PDF example 1 reaches real options",
    note: "The options respect the budget and morning limit, applied in code.",
    expect: { options_within_limits: true, book_calls: 0, last_state: "COMPARING" },
    run: reachOptions,
    extra: (w) => {
      const options = w.agent.deps.tasks.active(USER)?.details.options ?? [];
      const fits = options.every((o) => o.price <= 1500 && o.slots.every((slot) => slot.slice(11, 16) < "12:00"));
      return { options_within_limits: options.length > 0 && fits };
    },
  },
];
