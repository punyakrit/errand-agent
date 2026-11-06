import type { MockEnv } from "./env.ts";
import type { MockTools } from "./types.ts";

// Failures the PDF contract does not include, needed to test the agent's
// failure paths. Keeping them here means MockEnv stays exactly the contract.
export interface Faults {
  throwOn?: Partial<Record<keyof MockTools, number>>; // tool -> how many calls throw
  statusUnavailable?: boolean; // get_booking_status never gives an answer
  cancelAlways503?: boolean; // cancel keeps failing, so retries run out
}

export class FaultyTools implements MockTools {
  private inner: MockEnv;
  private faults: Faults;

  constructor(inner: MockEnv, faults: Faults) {
    this.inner = inner;
    this.faults = { ...faults, throwOn: { ...faults.throwOn } };
  }

  private maybeThrow(tool: keyof MockTools): void {
    const remaining = this.faults.throwOn?.[tool] ?? 0;
    if (remaining > 0) {
      this.faults.throwOn![tool] = remaining - 1;
      throw new Error(`simulated unexpected failure in ${tool}`);
    }
  }

  search_providers: MockTools["search_providers"] = async (args) => {
    this.maybeThrow("search_providers");
    return this.inner.search_providers(args);
  };
  get_provider: MockTools["get_provider"] = async (args) => {
    this.maybeThrow("get_provider");
    return this.inner.get_provider(args);
  };
  hold_slot: MockTools["hold_slot"] = async (args) => {
    this.maybeThrow("hold_slot");
    return this.inner.hold_slot(args);
  };
  book: MockTools["book"] = async (args) => {
    this.maybeThrow("book");
    return this.inner.book(args);
  };
  get_booking_status: MockTools["get_booking_status"] = async (args) => {
    this.maybeThrow("get_booking_status");
    if (this.faults.statusUnavailable) {
      const result = { ok: false as const, error: "status_unavailable", status: 503 };
      this.inner.logFaultedCall("get_booking_status", args, result);
      return result;
    }
    return this.inner.get_booking_status(args);
  };
  cancel: MockTools["cancel"] = async (args) => {
    this.maybeThrow("cancel");
    if (this.faults.cancelAlways503) {
      const result = { ok: false as const, error: "service_unavailable", status: 503 };
      this.inner.logFaultedCall("cancel", args, result);
      return result;
    }
    return this.inner.cancel(args);
  };
  reschedule: MockTools["reschedule"] = async (args) => {
    this.maybeThrow("reschedule");
    return this.inner.reschedule(args);
  };
  list_bookings: MockTools["list_bookings"] = async (args) => {
    this.maybeThrow("list_bookings");
    return this.inner.list_bookings(args);
  };
}
