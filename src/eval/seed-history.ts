import type { DatabaseSync } from "node:sqlite";
import type { Agent } from "../agent/agent.ts";

export const MARKERS = {
  relevantProvider: "Sharma Pipe Works",
  relevantNote: "side gate code 4471",
  forgotten: "Ramesh-the-old-technician",
  superseded: "Whitefield-old-flat",
  unconfirmed: "Zubair-inferred-electrician",
  otherService: "ac-remote-under-the-sofa",
};

// More than 50 stored memories of every kind, for the context budget tests.
export function seedMemories(agent: Agent, userId: string): void {
  const memory = agent.deps.memory;
  const evidence = "seeded for the context budget test";

  memory.remember(userId, "preferred_provider", MARKERS.relevantProvider, "plumber", evidence);
  memory.remember(userId, "entry_note", MARKERS.relevantNote, "global", evidence);
  memory.remember(userId, "earliest_time", "09:00", "global", evidence);
  memory.remember(userId, "preferred_area", "Indiranagar", "global", evidence);

  memory.remember(userId, "ac_note", MARKERS.otherService, "ac_service", evidence);

  memory.remember(userId, "old_home", MARKERS.superseded, "global", evidence);
  memory.remember(userId, "old_home", "Indiranagar flat 12", "global", evidence);

  memory.remember(userId, "old_technician", MARKERS.forgotten, "plumber", evidence);
  memory.forget(userId, "old_technician");

  memory.infer(userId, "usual_provider", MARKERS.unconfirmed, "electrician", "booking:B-0001");

  for (let index = 0; index < 30; index++) memory.remember(userId, `plumber_note_${index}`, `plumbing detail number ${index}`, "plumber", evidence);
  for (let index = 0; index < 15; index++) memory.remember(userId, `ac_detail_${index}`, `air conditioner detail ${index}`, "ac_service", evidence);
  for (let index = 0; index < 10; index++) memory.remember(userId, `koramangala_note_${index}`, `Koramangala only detail ${index}`, "global", evidence);
}

// A long prior conversation, written straight to the chat table.
export function seedLongChat(db: DatabaseSync, userId: string, turns = 220): void {
  const insert = db.prepare("INSERT INTO messages (session_id, user_id, role, text, at) VALUES (?, ?, ?, ?, ?)");
  for (let turn = 0; turn < turns; turn++) {
    insert.run("old-session", userId, "user", `Old question number ${turn} about a repair at home`, turn);
    insert.run("old-session", userId, "assistant", `Old answer number ${turn} with a fairly long explanation of the options that were available at the time`, turn);
  }
}
