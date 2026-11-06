import type { DatabaseSync } from "node:sqlite";
import type { Agent } from "../agent/agent.ts";
import { finish } from "../agent/finish.ts";
import type { Run } from "../agent/run.ts";
import type { BookingView } from "../mock/types.ts";
import { decide } from "./decide.ts";
import { createRebookTask, offerReplacement } from "./replacement.ts";

const SESSION = "monitor";

// Watches bookings with no user message. tick() runs on a timer in the server
// and on demand in tests.
export class Monitor {
  private agent: Agent;
  private db: DatabaseSync;
  private userIds: string[];

  constructor(agent: Agent, userIds: string[]) {
    this.agent = agent;
    this.db = agent.deps.db;
    this.userIds = userIds;
  }

  async tick(): Promise<void> {
    for (const userId of this.userIds) {
      try {
        await this.checkUser(userId);
      } catch {
        // A failed tick must not stop the server. The next tick tries again,
        // and nothing was recorded as seen.
      }
    }
  }

  private async checkUser(userId: string): Promise<void> {
    const listed = await this.agent.deps.mock.list_bookings({ user_id: userId });
    if (!listed.ok) return;

    this.inferUsualProviders(userId, listed.bookings);
    for (const booking of listed.bookings) {
      await this.check(userId, booking);
      this.markSeen(userId, booking);
    }
  }

  private async check(userId: string, booking: BookingView): Promise<void> {
    const seen = this.lastSeen(booking.booking_id);
    const event = this.event(booking.booking_id);

    if (event?.state === "started") {
      // A crash stopped this one part way. Finish it.
      await this.resume(userId, booking, event.task_id);
      return;
    }
    if (event || seen === booking.status) return;

    if (booking.status === "cancelled_by_provider") {
      await this.handleCancellation(userId, booking);
    } else if (booking.status === "cancelled") {
      const run = this.agent.startBackgroundRun(SESSION, userId, "monitor");
      run.trace.emit("proactive_event", { booking_id: booking.booking_id, event: "user_cancelled", decision: "log_only" });
      run.trace.emit("run_end", { reason: "log_only", silent: true });
    }
  }

  private async handleCancellation(userId: string, booking: BookingView): Promise<void> {
    const run = this.agent.startBackgroundRun(SESSION, userId, "monitor");
    const decision = decide(booking, run.deps.clock.now());
    run.trace.emit("proactive_event", { booking_id: booking.booking_id, event: "provider_cancelled", decision });

    if (decision === "log_only") {
      this.recordEvent(booking.booking_id, userId, decision, "handled", null, run);
      run.trace.emit("run_end", { reason: "log_only", silent: true });
      return;
    }

    const task = createRebookTask(run, booking);
    this.recordEvent(booking.booking_id, userId, decision, "started", task.task_id, run);
    await this.offer(run, booking, task.task_id);
  }

  private async resume(userId: string, booking: BookingView, taskId: string | null): Promise<void> {
    const run = this.agent.startBackgroundRun(SESSION, userId, "monitor");
    run.trace.emit("proactive_event", { booking_id: booking.booking_id, event: "resume_after_restart", decision: "rebook" });
    await this.offer(run, booking, taskId!);
  }

  private async offer(run: Run, booking: BookingView, taskId: string): Promise<void> {
    const task = run.deps.tasks.get(taskId)!;
    await run.deps.checkpoint("rebook_task_created");
    const outcome = await offerReplacement(run, task, booking);
    this.db.prepare("UPDATE proactive_events SET state = 'handled' WHERE booking_id = ?").run(booking.booking_id);
    // Queued, so the user gets it now if connected, or in their next session.
    finish(run, outcome, { queue: true });
  }

  // A rule in code: the provider of the latest finished job for each service.
  // It stays unconfirmed until the user says it is right.
  private inferUsualProviders(userId: string, bookings: BookingView[]): void {
    const finished = bookings.filter((booking) => booking.status === "completed");
    for (const booking of finished) {
      this.agent.deps.memory.infer(userId, "usual_provider", booking.provider_name, booking.service, `booking:${booking.booking_id}`);
    }
  }

  private lastSeen(bookingId: string): string | undefined {
    const row = this.db.prepare("SELECT status FROM seen_bookings WHERE booking_id = ?").get(bookingId) as { status: string } | undefined;
    return row?.status;
  }

  private markSeen(userId: string, booking: BookingView): void {
    this.db.prepare(
      "INSERT INTO seen_bookings (booking_id, user_id, status) VALUES (?, ?, ?) ON CONFLICT (booking_id) DO UPDATE SET status = excluded.status",
    ).run(booking.booking_id, userId, booking.status);
  }

  private event(bookingId: string): { state: string; task_id: string | null } | undefined {
    return this.db.prepare("SELECT state, task_id FROM proactive_events WHERE booking_id = ?").get(bookingId) as { state: string; task_id: string | null } | undefined;
  }

  private recordEvent(bookingId: string, userId: string, decision: string, state: string, taskId: string | null, run: Run): void {
    this.db.prepare("INSERT INTO proactive_events (booking_id, user_id, decision, state, task_id, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(bookingId, userId, decision, state, taskId, run.deps.clock.now());
  }
}
