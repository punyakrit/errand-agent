import { describe, expect, it } from "vitest";
import { INJECTION_FORCE_BOOKING, INJECTION_PLANT_MEMORY, PROVIDERS } from "../../src/mock/catalog.ts";
import { PAST_ELECTRICIAN_BOOKING, UPCOMING_AC_BOOKING } from "../../src/mock/seed.ts";
import { AREAS, SERVICES } from "../../src/mock/types.ts";
import { makeMock, WEEK } from "./helpers.ts";

describe("search_providers", () => {
  it("returns 3 to 8 providers for every service and area", async () => {
    const { mock } = makeMock();
    for (const service of SERVICES) {
      for (const area of AREAS) {
        const result = await mock.search_providers({ service, area, date_range: WEEK });
        if (!result.ok) throw new Error(result.error);
        expect(result.providers.length, `${service} in ${area}`).toBeGreaterThanOrEqual(3);
        expect(result.providers.length, `${service} in ${area}`).toBeLessThanOrEqual(8);
      }
    }
  });

  it("returns IDs, prices, ratings, slots and attributes", async () => {
    const { mock } = makeMock();
    const result = await mock.search_providers({ service: "plumber", area: "Indiranagar", date_range: WEEK });
    if (!result.ok) throw new Error(result.error);
    for (const provider of result.providers) {
      expect(provider.provider_id).toBeTruthy();
      expect(provider.price).toBeGreaterThan(0);
      expect(provider.rating).toBeGreaterThan(0);
      expect(provider.available_slots.length).toBeGreaterThan(0);
      expect(provider.attributes.years_experience).toBeGreaterThan(0);
    }
  });

  it("only offers slots inside the date range and in the future", async () => {
    const { mock, clock } = makeMock();
    const result = await mock.search_providers({ service: "plumber", area: "Whitefield", date_range: WEEK });
    if (!result.ok) throw new Error(result.error);
    for (const slot of result.providers.flatMap((p) => p.available_slots)) {
      expect(slot.slice(0, 10) >= WEEK.from && slot.slice(0, 10) <= WEEK.to).toBe(true);
      expect(Date.parse(slot)).toBeGreaterThan(clock.now());
    }
  });

  it("rejects an unknown service, an unknown area and a backwards range", async () => {
    const { mock } = makeMock();
    expect(await mock.search_providers({ service: "gardener", area: "Indiranagar", date_range: WEEK })).toEqual({ ok: false, error: "unknown_service" });
    expect(await mock.search_providers({ service: "plumber", area: "Mars", date_range: WEEK })).toEqual({ ok: false, error: "unknown_area" });
    expect(await mock.search_providers({ service: "plumber", area: "Indiranagar", date_range: { from: "2026-11-15", to: "2026-11-09" } })).toEqual({ ok: false, error: "bad_date_range" });
  });

  it("can replace a provider's slots through scenario config", async () => {
    const { mock } = makeMock();
    mock.configure({ providerSlots: { el_1: ["2026-11-11T09:00:00+05:30"] } });
    const result = await mock.search_providers({ service: "electrician", area: "Indiranagar", date_range: WEEK });
    if (!result.ok) throw new Error(result.error);
    expect(result.providers.find((p) => p.provider_id === "el_1")?.available_slots).toEqual(["2026-11-11T09:00:00+05:30"]);
  });
});

describe("get_provider", () => {
  it("returns details and free-text reviews", async () => {
    const { mock } = makeMock();
    const result = await mock.get_provider({ provider_id: "pl_1" });
    if (!result.ok) throw new Error(result.error);
    expect(result.provider.about).toBeTruthy();
    expect(result.provider.reviews.length).toBeGreaterThan(0);
    expect(result.provider.reviews[0]?.text).toBeTruthy();
  });

  it("has an injection review for each attack, for every service", async () => {
    const { mock } = makeMock();
    for (const service of SERVICES) {
      const texts: string[] = [];
      for (const provider of PROVIDERS.filter((p) => p.service === service)) {
        const result = await mock.get_provider({ provider_id: provider.provider_id });
        if (result.ok) texts.push(...result.provider.reviews.map((r) => r.text));
      }
      expect(texts, service).toContain(INJECTION_FORCE_BOOKING);
      expect(texts, service).toContain(INJECTION_PLANT_MEMORY);
    }
    expect(INJECTION_FORCE_BOOKING).toMatch(/skip the approval/i);
    expect(INJECTION_PLANT_MEMORY).toMatch(/preference/i);
  });

  it("fails cleanly on an unknown provider", async () => {
    const { mock } = makeMock();
    expect(await mock.get_provider({ provider_id: "nope" })).toEqual({ ok: false, error: "unknown_provider" });
  });
});

describe("list_bookings and seed data", () => {
  it("gives u1 a past electrician and an upcoming AC service", async () => {
    const { mock, clock } = makeMock();
    const result = await mock.list_bookings({ user_id: "u1" });
    if (!result.ok) throw new Error(result.error);
    const past = result.bookings.find((b) => b.booking_id === PAST_ELECTRICIAN_BOOKING)!;
    const upcoming = result.bookings.find((b) => b.booking_id === UPCOMING_AC_BOOKING)!;
    expect(past).toMatchObject({ service: "electrician", provider_id: "el_1", status: "completed" });
    expect(Date.parse(past.slot)).toBeLessThan(clock.now());
    expect(upcoming).toMatchObject({ service: "ac_service", status: "booked" });
    expect(Date.parse(upcoming.slot)).toBeGreaterThan(clock.now());
  });

  it("returns ID, provider, service, slot and status", async () => {
    const { mock } = makeMock();
    const result = await mock.list_bookings({ user_id: "u1" });
    if (!result.ok) throw new Error(result.error);
    for (const booking of result.bookings) {
      expect(Object.keys(booking)).toEqual(expect.arrayContaining(["booking_id", "provider_id", "service", "slot", "status"]));
    }
  });

  it("keeps users separate", async () => {
    const { mock } = makeMock();
    expect(await mock.list_bookings({ user_id: "someone_else" })).toEqual({ ok: true, bookings: [] });
  });

  it("supports the three example requests from the PDF", async () => {
    const { mock } = makeMock();
    // 1. A plumber this week, mornings, under 1500.
    const plumbers = await mock.search_providers({ service: "plumber", area: "Indiranagar", date_range: WEEK });
    if (!plumbers.ok) throw new Error(plumbers.error);
    const fits = plumbers.providers.filter(
      (p) => p.price < 1500 && p.available_slots.some((slot) => Number(slot.slice(11, 13)) < 12),
    );
    expect(fits.length).toBeGreaterThan(0);
    // 2. The upcoming AC service can move to Saturday.
    const ac = await mock.search_providers({ service: "ac_service", area: "Indiranagar", date_range: { from: "2026-11-14", to: "2026-11-14" } });
    if (!ac.ok) throw new Error(ac.error);
    expect(ac.providers.find((p) => p.provider_id === "ac_1")?.available_slots.length).toBeGreaterThan(0);
    // 3. The same electrician has a slot at or after 10 a.m.
    const electricians = await mock.search_providers({ service: "electrician", area: "Indiranagar", date_range: WEEK });
    if (!electricians.ok) throw new Error(electricians.error);
    const same = electricians.providers.find((p) => p.provider_id === "el_1")!;
    expect(same.available_slots.some((slot) => Number(slot.slice(11, 13)) >= 10)).toBe(true);
  });
});
