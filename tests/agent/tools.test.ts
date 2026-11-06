import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { say, tool } from "../../src/llm/scripted.ts";
import { UPCOMING_AC_BOOKING } from "../../src/mock/seed.ts";
import { INJECTION_FORCE_BOOKING } from "../../src/mock/catalog.ts";
import { makeAgent, PLUMBER_REQUEST, PLUMBER_SEARCH } from "./helpers.ts";

function lastToolResult(llm: { requests: { messages: Anthropic.MessageParam[] }[] }): Record<string, unknown> {
  const content = llm.requests.at(-1)!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
  return JSON.parse(String(content.at(-1)!.content));
}

const SHARMA_SLOT = "2026-11-10T09:00:00+05:30";

async function searched(extra: Parameters<typeof makeAgent>[1] = {}) {
  const made = makeAgent([tool("update_request", PLUMBER_REQUEST), tool("search_providers", PLUMBER_SEARCH), say("Pick one.")], extra);
  await made.send("Find a plumber this week, mornings only, under 1500 in Indiranagar");
  return made;
}

describe("update_request", () => {
  it("creates a task and reports what is missing", async () => {
    const { send, llm, task } = makeAgent([tool("update_request", { service: "plumber", budget_inr: 900 }), say("ok")]);
    await send("plumber under 900");
    expect(lastToolResult(llm).missing).toEqual(["area", "date_window", "time_window"]);
    expect(task()?.state).toBe("COLLECTING");
  });

  it("merges a correction without touching other fields", async () => {
    const { send, llm, task } = makeAgent([tool("update_request", PLUMBER_REQUEST), say("ok")]);
    await send("first");
    llm.add(tool("update_request", { area: "Koramangala" }), say("ok"));
    await send("actually Koramangala");
    expect(task()?.request).toEqual({ ...PLUMBER_REQUEST, area: "Koramangala" });
  });

  it("drops old options and goes back to COLLECTING when the request changes", async () => {
    const { send, llm, task } = await searched();
    expect(task()?.state).toBe("COMPARING");
    llm.add(tool("update_request", { area: "Koramangala" }), say("ok"));
    await send("actually Koramangala");
    expect(task()).toMatchObject({ state: "COLLECTING" });
    expect(task()?.details.options).toBeUndefined();
  });

  it("rejects a badly formatted date", async () => {
    const { send, llm } = makeAgent([tool("update_request", { date_from: "next week" }), say("ok")]);
    await send("next week");
    expect(lastToolResult(llm)).toEqual({ error: "invalid_field", field: "date_from" });
  });

  it("replaces a task when the user switches to a different kind", async () => {
    const { send, llm, agent } = await searched();
    llm.add(tool("update_request", { kind: "cancel", service: "ac_service" }), say("ok"));
    await send("forget that, cancel my AC service");
    const [first, second] = agent.deps.tasks.all("u1");
    expect(first?.state).toBe("FAILED");
    expect(second?.kind).toBe("cancel");
  });
});

describe("search_providers", () => {
  it("applies budget and time limits in code", async () => {
    const { task } = await searched();
    const options = task()!.details.options!;
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.price).toBeLessThanOrEqual(1500);
      for (const slot of option.slots) expect(slot.slice(11, 16) < "12:00").toBe(true);
    }
  });

  it("drops excluded providers", async () => {
    const { send, llm, task } = makeAgent([
      tool("update_request", { ...PLUMBER_REQUEST, exclude_provider_ids: ["pl_1"] }),
      tool("search_providers", PLUMBER_SEARCH),
      say("ok"),
    ]);
    await send("not Sharma");
    expect(task()!.details.options!.map((o) => o.provider_id)).not.toContain("pl_1");
    expect(lastToolResult(llm).removed).toMatchObject({ excluded: 1 });
  });

  it("will not search while fields are missing", async () => {
    const { send, llm, mock } = makeAgent([tool("update_request", { service: "plumber" }), tool("search_providers", PLUMBER_SEARCH), say("ok")]);
    await send("plumber");
    expect(lastToolResult(llm)).toMatchObject({ error: "missing_fields" });
    expect(mock.calls("search_providers")).toHaveLength(0);
  });

  it("will not search for something other than the request", async () => {
    const { send, llm, mock } = makeAgent([
      tool("update_request", PLUMBER_REQUEST),
      tool("search_providers", { ...PLUMBER_SEARCH, area: "Whitefield" }),
      say("ok"),
    ]);
    await send("plumber");
    expect(lastToolResult(llm)).toMatchObject({ error: "request_mismatch" });
    expect(mock.calls("search_providers")).toHaveLength(0);
  });

  it("says so when nothing fits", async () => {
    const { send, llm, task } = makeAgent([
      tool("update_request", { ...PLUMBER_REQUEST, budget_inr: 100 }),
      tool("search_providers", PLUMBER_SEARCH),
      say("Nothing fits."),
    ]);
    await send("plumber under 100");
    expect(lastToolResult(llm)).toMatchObject({ options: [] });
    expect(task()?.state).toBe("NEEDS_USER");
  });
});

describe("asking for a specific provider", () => {
  const ELECTRICIAN = {
    service: "electrician", area: "Indiranagar", date_from: "2026-11-09", date_to: "2026-11-15",
    time_from: "10:00", any_budget: true, provider_id: "el_1",
  };
  const SEARCH = { service: "electrician", area: "Indiranagar", date_range: { from: "2026-11-09", to: "2026-11-15" } };

  it("offers only that provider when it has a slot", async () => {
    const { send, task } = makeAgent([tool("update_request", ELECTRICIAN), tool("search_providers", SEARCH), say("ok")]);
    await send("same electrician, not before 10");
    const options = task()!.details.options!;
    expect(options.map((o) => o.provider_id)).toEqual(["el_1"]);
    for (const slot of options[0]!.slots) expect(slot.slice(11, 16) >= "10:00").toBe(true);
  });

  it("says so and does not switch when it has no slot that fits", async () => {
    const made = makeAgent([tool("update_request", ELECTRICIAN), tool("search_providers", SEARCH), say("It has nothing after 10.")]);
    made.mock.configure({ providerSlots: { el_1: ["2026-11-11T09:00:00+05:30"] } });
    await made.send("same electrician, not before 10");
    const result = lastToolResult(made.llm);
    expect(result).toMatchObject({ requested_provider_has_no_fit: true, requested_provider: "Voltline Electricals" });
    expect(result.its_other_slots).toEqual(["2026-11-11T09:00:00+05:30"]);
    expect((result.other_providers as unknown[]).length).toBeGreaterThan(0);
    expect(made.task()?.state).toBe("NEEDS_USER");

    made.llm.add(tool("hold_slot", { provider_id: "el_2", slot: "2026-11-10T10:00:00+05:30" }), say("ok"));
    await made.send("hmm");
    expect(lastToolResult(made.llm)).toEqual({ error: "provider_not_selected_by_user" });
    expect(made.mock.calls("hold_slot")).toHaveLength(0);
  });
});

describe("hold_slot", () => {
  it("is blocked until the user has picked", async () => {
    const { send, mock, events, llm } = makeAgent([
      tool("update_request", PLUMBER_REQUEST),
      tool("search_providers", PLUMBER_SEARCH),
      tool("hold_slot", { provider_id: "pl_1", slot: SHARMA_SLOT }),
      say("Pick one."),
    ]);
    await send("plumber");
    expect(lastToolResult(llm)).toEqual({ error: "user_must_pick" });
    expect(mock.calls("hold_slot")).toHaveLength(0);
    expect(events("gate_decision")[0]).toMatchObject({ decision: "hold_blocked", because: "user_must_pick" });
  });

  it("a repeat search in the same message does not undo the user's pick", async () => {
    const { send, llm, mock } = await searched();
    llm.add(tool("search_providers", PLUMBER_SEARCH), tool("hold_slot", { provider_id: "pl_1", slot: SHARMA_SLOT }), say("ok"));
    await send("Sharma at 9 on Tuesday");
    expect(mock.calls("hold_slot")).toHaveLength(1);
  });

  it("a provider that first appears in this message still needs a pick", async () => {
    const { send, llm, mock, task } = await searched();
    const options = task()!.details.options!;
    expect(options.map((option) => option.provider_id)).toContain("pl_1");
    llm.add(tool("update_request", { area: "Whitefield" }), tool("search_providers", { ...PLUMBER_SEARCH, area: "Whitefield" }), tool("hold_slot", { provider_id: "pl_6", slot: "2026-11-10T09:00:00+05:30" }), say("ok"));
    await send("try Whitefield");
    expect(lastToolResult(llm)).toEqual({ error: "user_must_pick" });
    expect(mock.calls("hold_slot")).toHaveLength(0);
  });

  it("is blocked before a search", async () => {
    const { send, llm, mock } = makeAgent([tool("update_request", PLUMBER_REQUEST), tool("hold_slot", { provider_id: "pl_1", slot: SHARMA_SLOT }), say("ok")]);
    await send("plumber");
    expect(lastToolResult(llm)).toEqual({ error: "search_first" });
    expect(mock.calls("hold_slot")).toHaveLength(0);
  });

  it("is blocked for a slot code did not offer", async () => {
    const { send, llm, mock } = await searched();
    llm.add(tool("hold_slot", { provider_id: "pl_1", slot: "2026-11-10T15:00:00+05:30" }), say("ok"));
    await send("the afternoon one");
    expect(lastToolResult(llm)).toEqual({ error: "not_an_offered_option" });
    expect(mock.calls("hold_slot")).toHaveLength(0);
  });

  it("holds after the user picks and reports the held price", async () => {
    const { send, llm, task, mock } = await searched();
    mock.configure({ holdPriceDeltas: [150] });
    llm.add(tool("hold_slot", { provider_id: "pl_1", slot: SHARMA_SLOT }), say("ok"));
    await send("Sharma at 9 on Tuesday");
    expect(lastToolResult(llm)).toMatchObject({ price: 950, search_price: 800, price_changed: true, over_budget: false });
    expect(task()).toMatchObject({ state: "HOLDING" });
    expect(task()?.details.hold?.price).toBe(950);
  });

  it("stops at NEEDS_USER when the held price is over budget", async () => {
    const { send, llm, task, mock } = await searched();
    mock.configure({ holdPriceDeltas: [800] });
    llm.add(tool("hold_slot", { provider_id: "pl_1", slot: SHARMA_SLOT }), say("It went up."));
    await send("Sharma at 9 on Tuesday");
    expect(lastToolResult(llm)).toMatchObject({ price: 1600, over_budget: true });
    expect(task()?.state).toBe("NEEDS_USER");
  });

  it("keeps the hold when the user raises the budget to cover it", async () => {
    const { send, llm, task, mock } = await searched();
    mock.configure({ holdPriceDeltas: [800] });
    llm.add(tool("hold_slot", { provider_id: "pl_1", slot: SHARMA_SLOT }), say("It went up."));
    await send("Sharma at 9 on Tuesday");
    llm.add(tool("update_request", { budget_inr: 1700 }), say("ok"));
    await send("fine, up to 1700");
    expect(task()?.details.hold?.price).toBe(1600);
  });
});

describe("get_provider", () => {
  it("marks review text as data and flags it in the trace only", async () => {
    const { send, llm, events } = makeAgent([tool("get_provider", { provider_id: "pl_3" }), say("ok")]);
    await send("tell me about them");
    const result = lastToolResult(llm) as { reviews: { text: string }[]; note: string };
    expect(result.note).toContain("data");
    for (const review of result.reviews) {
      expect(review.text.startsWith("<untrusted_data>")).toBe(true);
      expect(review.text.endsWith("</untrusted_data>")).toBe(true);
    }
    expect(events("gate_decision")[0]).toMatchObject({ decision: "suspicious_text_flagged", provider_id: "pl_3" });
    expect(INJECTION_FORCE_BOOKING.length).toBeGreaterThan(0);
  });
});

describe("finding the booking to change", () => {
  it("resolves one matching booking", async () => {
    const { send, task } = makeAgent([tool("update_request", { kind: "reschedule", service: "ac_service" }), say("ok")]);
    await send("move my AC servicing");
    expect(task()?.details.target_booking?.booking_id).toBe(UPCOMING_AC_BOOKING);
    expect(task()?.request).toMatchObject({ service: "ac_service", provider_id: "ac_1" });
  });

  it("asks which one when two bookings match", async () => {
    const made = makeAgent([tool("update_request", { kind: "reschedule", service: "ac_service" }), say("Which one?")]);
    made.mock.addBooking({ provider_id: "ac_2", service: "ac_service", slot: "2026-11-13T09:00:00+05:30", price: 999 });
    await made.send("move my AC servicing to Saturday");
    expect(lastToolResult(made.llm)).toMatchObject({ error: "ambiguous_booking" });
    expect(made.task()).toMatchObject({ state: "NEEDS_USER" });
    expect(made.task()?.details.target_booking).toBeUndefined();

    made.llm.add(tool("update_request", { target_booking_id: UPCOMING_AC_BOOKING }), say("ok"));
    await made.send("the CoolAir one");
    expect(made.task()?.details.target_booking?.booking_id).toBe(UPCOMING_AC_BOOKING);
  });

  it("will not take a booking that is not the user's", async () => {
    const { send, llm } = makeAgent([tool("update_request", { kind: "cancel", target_booking_id: "B-9999" }), say("ok")]);
    await send("cancel B-9999");
    expect(lastToolResult(llm)).toEqual({ error: "no_matching_booking" });
  });
});
