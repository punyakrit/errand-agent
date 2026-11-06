import { describe, expect, it } from "vitest";
import { fieldValue, findInvalidField, mergeRequest, missingFields } from "../../src/agent/request.ts";
import type { RequestFields } from "../../src/agent/request.ts";

const FULL: RequestFields = {
  service: "plumber", area: "Indiranagar", date_from: "2026-11-09", date_to: "2026-11-15",
  time_from: "08:00", time_to: "12:00", budget_inr: 1500, notes: "kitchen tap",
};

describe("mergeRequest", () => {
  it("changes only the corrected field", () => {
    const { merged, changed } = mergeRequest(FULL, { area: "Koramangala" });
    expect(merged).toEqual({ ...FULL, area: "Koramangala" });
    expect(changed).toEqual(["area"]);
  });

  it("reports nothing changed when a value is repeated", () => {
    expect(mergeRequest(FULL, { area: "Indiranagar" }).changed).toEqual([]);
  });

  it("does not let undefined wipe a field", () => {
    expect(mergeRequest(FULL, { area: undefined }).merged).toEqual(FULL);
  });

  it("treats an empty string as not given", () => {
    expect(mergeRequest(FULL, { date_from: "", notes: "" })).toEqual({ merged: FULL, changed: [] });
  });

  it("lets the newest of a budget and no-limit win", () => {
    expect(mergeRequest(FULL, { any_budget: true }).merged.budget_inr).toBeUndefined();
    expect(mergeRequest({ any_budget: true }, { budget_inr: 900 }).merged).toEqual({ budget_inr: 900 });
  });

  it("lets the newest of a time window and any-time win", () => {
    const anyTime = mergeRequest(FULL, { any_time: true }).merged;
    expect(anyTime.time_from).toBeUndefined();
    expect(anyTime.time_to).toBeUndefined();
    expect(mergeRequest({ any_time: true }, { time_from: "10:00" }).merged).toEqual({ time_from: "10:00" });
  });

  it("clears a chosen provider only when asked to", () => {
    const pinned = { ...FULL, provider_id: "el_1" };
    expect(mergeRequest(pinned, { clear_provider: true }).merged.provider_id).toBeUndefined();
    expect(mergeRequest(pinned, { area: "Whitefield" }).merged.provider_id).toBe("el_1");
  });
});

describe("missingFields", () => {
  it("is empty when a booking request is complete", () => {
    expect(missingFields("book", FULL, false)).toEqual([]);
  });

  it("lists only what a booking still needs", () => {
    expect(missingFields("book", { service: "plumber", any_budget: true }, false)).toEqual(["area", "date_window", "time_window"]);
  });

  it("treats a window with only one date as missing", () => {
    expect(missingFields("book", { ...FULL, date_to: undefined }, false)).toEqual(["date_window"]);
  });

  it("counts any-time and no-limit answers as known", () => {
    const request = { service: "plumber", area: "HSR Layout", date_from: "2026-11-09", date_to: "2026-11-10", any_time: true, any_budget: true } as RequestFields;
    expect(missingFields("book", request, false)).toEqual([]);
  });

  it("needs only the booking for a cancel", () => {
    expect(missingFields("cancel", {}, false)).toEqual(["which_booking"]);
    expect(missingFields("cancel", {}, true)).toEqual([]);
  });

  it("needs the booking and a date for a reschedule", () => {
    expect(missingFields("reschedule", {}, false)).toEqual(["which_booking", "date_window"]);
    expect(missingFields("reschedule", FULL, true)).toEqual([]);
  });
});

describe("field checks", () => {
  it("rejects badly formatted values", () => {
    expect(findInvalidField({ date_from: "next week" })).toBe("date_from");
    expect(findInvalidField({ time_from: "10am" })).toBe("time_from");
    expect(findInvalidField({ budget_inr: -5 })).toBe("budget_inr");
    expect(findInvalidField({ date_from: "2026-11-09", time_from: "10:00", budget_inr: 900 })).toBeUndefined();
  });

  it("describes known values", () => {
    expect(fieldValue("date_window", FULL)).toBe("2026-11-09 to 2026-11-15");
    expect(fieldValue("budget", { any_budget: true })).toBe("no limit");
    expect(fieldValue("which_booking", FULL)).toBeUndefined();
  });
});
