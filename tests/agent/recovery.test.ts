import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.ts";
import type { Checkpoint } from "../../src/agent/run.ts";
import { FakeClock } from "../../src/clock.ts";
import { openDb } from "../../src/db.ts";
import { say, ScriptedLLM, tool } from "../../src/llm/scripted.ts";
import { MockEnv } from "../../src/mock/env.ts";
import { UPCOMING_AC_BOOKING } from "../../src/mock/seed.ts";
import { TraceSink } from "../../src/trace/tracer.ts";
import { atApproval, makeAgent, USER } from "./helpers.ts";

// A hang at the checkpoint looks like a dead process: the first run never
// finishes, and a new Agent takes over the same databases.
function crashAt(point: Checkpoint) {
  let reached: () => void;
  const crashed = new Promise<void>((resolve) => { reached = resolve; });
  const checkpoint = async (name: Checkpoint) => {
    if (name === point) {
      reached();
      await new Promise(() => {});
    }
  };
  return { crashed, checkpoint };
}

function userBookings(mock: MockEnv) {
  return mock.allBookings().filter((booking) => booking.hold_id !== null);
}

describe("reconcile after a crash", () => {
  it("crash before book: retries with the same key and books once", async () => {
    const { crashed, checkpoint } = crashAt("op_started");
    const made = await atApproval({ checkpoint }, (m) => m.mock.configure({ forceBook: ["success"] }));
    void made.send("yes");
    await crashed;
    expect(made.mock.calls("book")).toHaveLength(0);
    expect(made.agent.deps.ops.open()).toHaveLength(1);
    const op = made.agent.deps.ops.open()[0]!;

    const fresh = made.restart();
    await fresh.reconcile();

    expect(made.mock.calls("book")).toHaveLength(1);
    expect(made.mock.calls("book")[0]?.args.idempotency_key).toBe(op.idempotency_key);
    expect(userBookings(made.mock)).toHaveLength(1);
    expect(fresh.deps.ops.open()).toHaveLength(0);
    expect(fresh.deps.tasks.all(USER)[0]?.state).toBe("DONE");
    expect(fresh.deps.outbox.drain(USER)[0]).toContain("Booked and verified");
  });

  it("crash after book, before saving: finds the booking and does not call book again", async () => {
    const { crashed, checkpoint } = crashAt("book_returned");
    const made = await atApproval({ checkpoint }, (m) => m.mock.configure({ forceBook: ["success"] }));
    void made.send("yes");
    await crashed;
    expect(made.mock.calls("book")).toHaveLength(1);
    expect(made.agent.deps.ops.open()).toHaveLength(1);

    const fresh = made.restart();
    await fresh.reconcile();

    expect(made.mock.calls("book")).toHaveLength(1);
    expect(userBookings(made.mock)).toHaveLength(1);
    expect(fresh.deps.tasks.all(USER)[0]?.state).toBe("DONE");
    expect(fresh.deps.outbox.drain(USER)[0]).toContain("Booked and verified");
  });

  it("crash before book with an expired hold: new hold, new approval, no booking", async () => {
    const { crashed, checkpoint } = crashAt("op_started");
    const made = await atApproval({ checkpoint }, (m) => m.mock.configure({ forceBook: ["success"] }));
    void made.send("yes");
    await crashed;
    made.clock.advance(11 * 60 * 1000);

    const fresh = made.restart();
    await fresh.reconcile();

    expect(made.mock.calls("book")).toHaveLength(0);
    expect(made.mock.calls("hold_slot")).toHaveLength(2);
    expect(fresh.deps.approvals.all(USER).map((approval) => approval.status)).toEqual(["consumed", "pending"]);
    expect(fresh.deps.tasks.all(USER)[0]?.state).toBe("AWAITING_APPROVAL");
    expect(fresh.deps.outbox.drain(USER)[0]).toContain("Please approve");
  });

  it("reconciling twice changes nothing the second time", async () => {
    const { crashed, checkpoint } = crashAt("book_returned");
    const made = await atApproval({ checkpoint }, (m) => m.mock.configure({ forceBook: ["success"] }));
    void made.send("yes");
    await crashed;
    const fresh = made.restart();
    await fresh.reconcile();
    const calls = made.mock.calls().length;
    await made.restart().reconcile();
    expect(made.mock.calls()).toHaveLength(calls);
  });

  it("a yes after recovery returns the result with no second booking", async () => {
    const { crashed, checkpoint } = crashAt("book_returned");
    const made = await atApproval({ checkpoint }, (m) => m.mock.configure({ forceBook: ["success"] }));
    void made.send("yes");
    await crashed;
    const fresh = made.restart();
    await fresh.reconcile();
    const reply = await fresh.handleMessage("s2", USER, "yes");
    expect(reply.reply).toContain("Booked and verified");
    expect(made.mock.calls("book")).toHaveLength(1);
  });

  it("status unknown at startup: leaves the op open and tells the user", async () => {
    const { crashed, checkpoint } = crashAt("book_returned");
    const made = await atApproval({ checkpoint, faults: { statusUnavailable: true } }, (m) => m.mock.configure({ forceBook: ["success"] }));
    void made.send("yes");
    await crashed;
    const fresh = made.restart();
    await fresh.reconcile();
    expect(fresh.deps.ops.open()).toHaveLength(1);
    expect(fresh.deps.outbox.drain(USER)[0]).toContain("can't confirm");
    expect(made.mock.calls("book")).toHaveLength(1);
  });

  it("crash mid-cancel: finishes the cancel with the same key", async () => {
    const { crashed, checkpoint } = crashAt("op_started");
    const made = makeAgent([tool("update_request", { kind: "cancel", service: "ac_service" }), tool("request_approval")], { checkpoint });
    await made.send("cancel my AC service");
    void made.send("yes");
    await crashed;
    const fresh = made.restart();
    await fresh.reconcile();
    expect(made.mock.allBookings().find((booking) => booking.booking_id === UPCOMING_AC_BOOKING)?.status).toBe("cancelled");
    expect(new Set(made.mock.calls("cancel").map((call) => call.args.idempotency_key)).size).toBe(1);
    expect(fresh.deps.tasks.all(USER)[0]?.state).toBe("DONE");
  });

  it("crash after a move: confirms it without moving again", async () => {
    const { crashed, checkpoint } = crashAt("book_returned");
    const saturday = { from: "2026-11-14", to: "2026-11-14" };
    const made = makeAgent([
      tool("update_request", { kind: "reschedule", service: "ac_service", date_from: saturday.from, date_to: saturday.to, any_time: true }),
      tool("search_providers", { service: "ac_service", area: "Indiranagar", date_range: saturday }),
      say("Which time?"),
    ], { checkpoint });
    await made.send("Move my AC servicing to Saturday");
    made.llm.add(tool("update_request", { new_slot: "2026-11-14T12:00:00+05:30" }), tool("request_approval"));
    await made.send("noon");
    void made.send("yes");
    await crashed;
    const fresh = made.restart();
    await fresh.reconcile();
    expect(made.mock.calls("reschedule")).toHaveLength(1);
    expect(fresh.deps.outbox.drain(USER)[0]).toContain("Moved and verified");
  });

  it("crash right after the write-ahead, before the state moved", async () => {
    const { crashed, checkpoint } = crashAt("op_started");
    const made = await atApproval({ checkpoint }, (m) => m.mock.configure({ forceBook: ["success"] }));
    void made.send("yes");
    await crashed;
    const task = made.agent.deps.tasks.all(USER)[0]!;
    task.state = "AWAITING_APPROVAL"; // the state move had not been saved yet
    made.agent.deps.tasks.save(task);

    const fresh = made.restart();
    await fresh.reconcile();
    expect(made.mock.calls("book")).toHaveLength(1);
    expect(fresh.deps.tasks.all(USER)[0]?.state).toBe("DONE");
  });
});

describe("killing a real child process mid-booking", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "crash-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function runChild(point: Checkpoint) {
    return spawnSync(process.execPath, ["--import", "tsx", "tests/fixtures/crash-child.ts", dir, point], { encoding: "utf8" });
  }

  function restartFromDisk() {
    const clock = new FakeClock();
    const mock = new MockEnv({ db: openDb(join(dir, "mock.sqlite")), clock });
    const agent = new Agent({ db: openDb(join(dir, "agent.sqlite")), mock, llm: new ScriptedLLM(), clock, sink: new TraceSink({ clock }) });
    return { mock, agent };
  }

  it("killed after the write-ahead, before book", async () => {
    const child = runChild("op_started");
    expect(child.signal).toBe("SIGKILL");
    expect(child.stdout).not.toContain("should never get here");

    const { mock, agent } = restartFromDisk();
    expect(agent.deps.ops.open()).toHaveLength(1);
    expect(mock.calls("book")).toHaveLength(0);

    await agent.reconcile();

    expect(mock.calls("book")).toHaveLength(1);
    expect(userBookings(mock)).toHaveLength(1);
    expect(agent.deps.ops.open()).toHaveLength(0);
    expect(agent.deps.tasks.all(USER)[0]?.state).toBe("DONE");
  });

  it("killed after book succeeded, before the result was saved", async () => {
    const child = runChild("book_returned");
    expect(child.signal).toBe("SIGKILL");

    const { mock, agent } = restartFromDisk();
    expect(agent.deps.ops.open()).toHaveLength(1);
    expect(mock.calls("book")).toHaveLength(1);
    expect(userBookings(mock)).toHaveLength(1);

    await agent.reconcile();

    expect(mock.calls("book")).toHaveLength(1); // no second call
    expect(userBookings(mock)).toHaveLength(1);
    expect(agent.deps.ops.open()).toHaveLength(0);
    expect(agent.deps.tasks.all(USER)[0]?.state).toBe("DONE");
    expect(agent.deps.outbox.drain(USER)[0]).toContain("Booked and verified");
  });
});
