import { describe, expect, it } from "vitest";
import { say, tool } from "../../src/llm/scripted.ts";
import { PAST_ELECTRICIAN_BOOKING, UPCOMING_AC_BOOKING } from "../../src/mock/seed.ts";
import { Monitor } from "../../src/monitor/monitor.ts";
import { decide } from "../../src/monitor/decide.ts";
import { makeAgent, USER, type AgentOptions } from "../agent/helpers.ts";

function setup(options: AgentOptions = {}) {
  const made = makeAgent([], options);
  return { ...made, monitor: new Monitor(made.agent, [USER]) };
}

function eventsAbout(made: ReturnType<typeof setup>, name: string) {
  return made.events("proactive_event").filter((event) => event.event === name);
}

describe("decide", () => {
  const booking = { booking_id: "B", provider_id: "p", provider_name: "P", service: "plumber" as const, slot: "2026-11-10T09:00:00+05:30", status: "cancelled_by_provider" as const, price: 1 };
  const before = Date.parse("2026-11-09T09:00:00+05:30");
  const after = Date.parse("2026-11-11T09:00:00+05:30");

  it("rebooks an upcoming provider cancellation", () => expect(decide(booking, before)).toBe("rebook"));
  it("only logs a past one", () => expect(decide(booking, after)).toBe("log_only"));
  it("only logs a booking the user cancelled", () => expect(decide({ ...booking, status: "cancelled" }, before)).toBe("log_only"));
});

describe("detecting a provider cancellation", () => {
  it("finds it with no user message and no model call", async () => {
    const made = setup();
    await made.monitor.tick();
    made.mock.providerCancels(UPCOMING_AC_BOOKING);
    await made.monitor.tick();
    expect(made.llm.requests).toHaveLength(0);
    expect(made.agent.deps.chat.history(USER).filter((message) => message.role === "user")).toHaveLength(0);
    expect(eventsAbout(made, "provider_cancelled")[0]).toMatchObject({ booking_id: UPCOMING_AC_BOOKING, decision: "rebook" });
  });

  it("finds one that happened before the first tick", async () => {
    const made = setup();
    made.mock.providerCancels(UPCOMING_AC_BOOKING);
    await made.monitor.tick();
    expect(eventsAbout(made, "provider_cancelled")).toHaveLength(1);
  });

  it("does nothing while nothing changes", async () => {
    const made = setup();
    await made.monitor.tick();
    await made.monitor.tick();
    expect(made.events("proactive_event")).toHaveLength(0);
    expect(made.agent.deps.tasks.all(USER)).toHaveLength(0);
  });

  it("survives list_bookings failing", async () => {
    const made = setup({ faults: { throwOn: { list_bookings: 1 } } });
    await expect(made.monitor.tick()).resolves.toBeUndefined();
    made.mock.providerCancels(UPCOMING_AC_BOOKING);
    await made.monitor.tick();
    expect(eventsAbout(made, "provider_cancelled")).toHaveLength(1);
  });
});

describe("what code decides", () => {
  it("only logs a cancellation of a past booking", async () => {
    const made = setup();
    made.mock.providerCancels(PAST_ELECTRICIAN_BOOKING);
    await made.monitor.tick();
    expect(eventsAbout(made, "provider_cancelled")[0]).toMatchObject({ decision: "log_only" });
    expect(made.agent.deps.tasks.all(USER)).toHaveLength(0);
    expect(made.agent.deps.outbox.drain(USER)).toHaveLength(0);
  });

  it("only logs a booking the user cancelled", async () => {
    const made = setup();
    await made.monitor.tick();
    const args = { booking_id: UPCOMING_AC_BOOKING, idempotency_key: "c" };
    await made.mock.cancel(args);
    await made.mock.cancel(args);
    await made.monitor.tick();
    expect(eventsAbout(made, "user_cancelled")[0]).toMatchObject({ decision: "log_only" });
    expect(made.agent.deps.tasks.all(USER)).toHaveLength(0);
    expect(made.agent.deps.outbox.drain(USER)).toHaveLength(0);
  });
});

describe("offering a replacement", () => {
  async function cancelled() {
    const made = setup();
    made.mock.providerCancels(UPCOMING_AC_BOOKING);
    await made.monitor.tick();
    return made;
  }

  it("notifies the user with options and books nothing", async () => {
    const made = await cancelled();
    const [notice] = made.agent.deps.outbox.drain(USER);
    expect(notice).toContain("CoolAir Care cancelled");
    expect(notice).toContain("Nothing has been booked");
    expect(made.mock.calls("book")).toHaveLength(0);
    expect(made.mock.calls("hold_slot")).toHaveLength(0);
    expect(made.agent.deps.approvals.all(USER)).toHaveLength(0);
  });

  it("creates a rebook task with options, without the provider that cancelled", async () => {
    const made = await cancelled();
    const task = made.task()!;
    expect(task).toMatchObject({ kind: "rebook_after_provider_cancel", state: "COMPARING" });
    expect(task.details.cancelled_booking_id).toBe(UPCOMING_AC_BOOKING);
    expect(task.details.options!.length).toBeGreaterThan(0);
    expect(task.details.options!.map((option) => option.provider_id)).not.toContain("ac_1");
  });

  it("stays within known preferences", async () => {
    const made = setup();
    made.agent.deps.memory.remember(USER, "max_budget", "1000", "global", "stated words");
    made.agent.deps.memory.remember(USER, "earliest_time", "11:00", "global", "stated words");
    made.mock.providerCancels(UPCOMING_AC_BOOKING);
    await made.monitor.tick();
    const options = made.task()!.details.options!;
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.price).toBeLessThanOrEqual(1000);
      for (const slot of option.slots) expect(slot.slice(11, 16) >= "11:00").toBe(true);
    }
  });

  it("ignores unconfirmed facts when choosing", async () => {
    const made = setup();
    made.agent.deps.memory.infer(USER, "max_budget", "1", "global", "booking:B-0001");
    made.mock.providerCancels(UPCOMING_AC_BOOKING);
    await made.monitor.tick();
    expect(made.task()?.state).toBe("COMPARING");
  });

  it("says so when no replacement fits", async () => {
    const made = setup();
    made.agent.deps.memory.remember(USER, "max_budget", "100", "global", "stated words");
    made.mock.providerCancels(UPCOMING_AC_BOOKING);
    await made.monitor.tick();
    const [notice] = made.agent.deps.outbox.drain(USER);
    expect(notice).toContain("could not find a replacement");
    expect(made.task()?.state).toBe("NEEDS_USER");
    expect(made.mock.calls("hold_slot")).toHaveLength(0);
  });

  it("needs a pick, a new hold and fresh approval before rebooking", async () => {
    const made = await cancelled();
    const option = made.task()!.details.options![0]!;
    made.mock.configure({ forceBook: ["success"] });

    made.llm.add(tool("hold_slot", { provider_id: option.provider_id, slot: option.slots[0]! }), tool("request_approval"));
    const card = await made.send("the first one please");
    expect(card.reason).toBe("awaiting_approval");
    expect(card.reply).toContain(option.name);
    expect(made.mock.calls("book")).toHaveLength(0);

    const done = await made.send("yes");
    expect(done.reply).toContain("Booked and verified");
    const approval = made.agent.deps.approvals.all(USER)[0]!;
    expect(made.mock.calls("book")[0]?.args.idempotency_key).toBe(`book:${approval.approval_id}`);
    expect(made.agent.deps.tasks.all(USER)[0]).toMatchObject({ kind: "rebook_after_provider_cancel", state: "DONE" });
  });

  it("a yes with no card shown books nothing", async () => {
    const made = await cancelled();
    made.llm.add(say("Which option would you like?"));
    await made.send("yes");
    expect(made.mock.calls("book")).toHaveLength(0);
    expect(made.mock.calls("hold_slot")).toHaveLength(0);
  });

  it("keeps the task if the model calls it a booking", async () => {
    const made = await cancelled();
    made.llm.add(tool("update_request", { kind: "book", any_budget: true }), say("ok"));
    await made.send("go on");
    expect(made.task()?.kind).toBe("rebook_after_provider_cancel");
  });
});

describe("each event is handled once", () => {
  it("does not act twice on a second tick", async () => {
    const made = setup();
    made.mock.providerCancels(UPCOMING_AC_BOOKING);
    await made.monitor.tick();
    await made.monitor.tick();
    await made.monitor.tick();
    expect(eventsAbout(made, "provider_cancelled")).toHaveLength(1);
    expect(made.agent.deps.tasks.all(USER)).toHaveLength(1);
    expect(made.agent.deps.outbox.drain(USER)).toHaveLength(1);
  });

  it("does not act twice across a restart", async () => {
    const made = setup();
    made.mock.providerCancels(UPCOMING_AC_BOOKING);
    await made.monitor.tick();
    await new Monitor(made.restart(), [USER]).tick();
    expect(eventsAbout(made, "provider_cancelled")).toHaveLength(1);
    expect(made.agent.deps.tasks.all(USER)).toHaveLength(1);
    expect(made.agent.deps.outbox.drain(USER)).toHaveLength(1);
  });

  it("finishes the event after a crash part way through, once", async () => {
    let crashed: () => void;
    const reached = new Promise<void>((resolve) => { crashed = resolve; });
    const made = setup({
      checkpoint: async (name) => {
        if (name === "rebook_task_created") {
          crashed();
          await new Promise(() => {});
        }
      },
    });
    made.mock.providerCancels(UPCOMING_AC_BOOKING);
    void made.monitor.tick();
    await reached;
    expect(made.agent.deps.outbox.drain(USER)).toHaveLength(0);

    const monitor = new Monitor(made.restart(), [USER]);
    await monitor.tick();
    await monitor.tick();
    expect(made.agent.deps.tasks.all(USER)).toHaveLength(1);
    expect(made.agent.deps.outbox.drain(USER)).toHaveLength(1);
  });
});

describe("delivery", () => {
  it("queues for the next session and delivers once", async () => {
    const made = setup();
    made.mock.providerCancels(UPCOMING_AC_BOOKING);
    await made.monitor.tick();

    made.llm.add(say("Hello."));
    const first = await made.agent.handleMessage("next-session", USER, "hi");
    expect(first.notices).toHaveLength(1);
    expect(first.notices[0]).toContain("CoolAir Care cancelled");

    made.llm.add(say("Hello again."));
    expect((await made.agent.handleMessage("next-session", USER, "hi")).notices).toHaveLength(0);
  });

  it("the model sees the notice in chat history on the next message", async () => {
    const made = setup();
    made.mock.providerCancels(UPCOMING_AC_BOOKING);
    await made.monitor.tick();
    made.llm.add(say("ok"));
    await made.send("what happened?");
    expect(JSON.stringify(made.llm.requests[0]!.messages)).toContain("CoolAir Care cancelled");
  });
});

describe("inferred facts from booking history", () => {
  it("creates an unconfirmed fact in code", async () => {
    const made = setup();
    await made.monitor.tick();
    expect(made.agent.deps.memory.all(USER)[0]).toMatchObject({
      key: "usual_provider", value: "Voltline Electricals", scope: "electrician",
      kind: "inferred", confirmed: false, source: `booking:${PAST_ELECTRICIAN_BOOKING}`,
    });
  });

  it("does not create it twice", async () => {
    const made = setup();
    await made.monitor.tick();
    await made.monitor.tick();
    expect(made.agent.deps.memory.all(USER)).toHaveLength(1);
  });
});
