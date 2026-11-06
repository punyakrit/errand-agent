import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createAgentSchema } from "../../src/agent/schema.ts";
import { FakeClock } from "../../src/clock.ts";
import { MemoryStore, scrubText } from "../../src/memory/store.ts";

function store() {
  const db = new DatabaseSync(":memory:");
  createAgentSchema(db);
  return new MemoryStore(db, new FakeClock());
}

describe("explicit facts", () => {
  it("are active, confirmed and keep their source", () => {
    const memory = store();
    const id = memory.remember("u1", "preferred_area", "Koramangala", "global", "I always use Koramangala");
    expect(memory.get(id)).toMatchObject({ kind: "explicit", confirmed: true, status: "active", source: "I always use Koramangala", scope: "global" });
  });

  it("a new value supersedes the old row instead of overwriting it", () => {
    const memory = store();
    const old = memory.remember("u1", "preferred_area", "Koramangala", "global", "first words");
    const next = memory.remember("u1", "preferred_area", "Whitefield", "global", "second words");
    expect(memory.get(old)).toMatchObject({ status: "superseded", value: "Koramangala" });
    expect(memory.get(next)).toMatchObject({ status: "active", value: "Whitefield" });
    expect(memory.active("u1")).toHaveLength(1);
  });

  it("keeps a service-scoped fact separate from a global one", () => {
    const memory = store();
    memory.remember("u1", "earliest_time", "09:00", "global", "words");
    memory.remember("u1", "earliest_time", "11:00", "plumber", "words");
    expect(memory.active("u1")).toHaveLength(2);
  });

  it("keeps users apart", () => {
    const memory = store();
    memory.remember("u1", "preferred_area", "Koramangala", "global", "words");
    expect(memory.active("u2")).toHaveLength(0);
  });
});

describe("inferred facts", () => {
  it("start unconfirmed and are not usable", () => {
    const memory = store();
    const id = memory.infer("u1", "usual_provider", "Voltline", "electrician", "booking:B-0001")!;
    expect(memory.get(id)).toMatchObject({ kind: "inferred", confirmed: false, status: "active" });
    expect(memory.usable("u1")).toHaveLength(0);
  });

  it("become usable once confirmed", () => {
    const memory = store();
    const id = memory.infer("u1", "usual_provider", "Voltline", "electrician", "booking:B-0001")!;
    expect(memory.confirm("u1", id)).toBe(true);
    expect(memory.usable("u1").map((item) => item.id)).toEqual([id]);
    expect(memory.get(id)?.kind).toBe("inferred");
  });

  it("cannot be confirmed for another user", () => {
    const memory = store();
    const id = memory.infer("u1", "usual_provider", "Voltline", "electrician", "booking:B-0001")!;
    expect(memory.confirm("u2", id)).toBe(false);
  });

  it("the user stating the same value confirms it", () => {
    const memory = store();
    const id = memory.infer("u1", "usual_provider", "Voltline", "electrician", "booking:B-0001")!;
    expect(memory.remember("u1", "usual_provider", "voltline", "electrician", "Voltline is my usual")).toBe(id);
    expect(memory.get(id)?.confirmed).toBe(true);
  });

  it("do not replace something the user stated", () => {
    const memory = store();
    memory.remember("u1", "usual_provider", "Spark Safe", "electrician", "I use Spark Safe");
    expect(memory.infer("u1", "usual_provider", "Voltline", "electrician", "booking:B-0001")).toBeUndefined();
    expect(memory.active("u1").map((item) => item.value)).toEqual(["Spark Safe"]);
  });

  it("are not created twice", () => {
    const memory = store();
    memory.infer("u1", "usual_provider", "Voltline", "electrician", "booking:B-0001");
    expect(memory.infer("u1", "usual_provider", "Voltline", "electrician", "booking:B-0001")).toBeUndefined();
  });

  it("do not come back after the user forgets them", () => {
    const memory = store();
    memory.infer("u1", "usual_provider", "Voltline", "electrician", "booking:B-0001");
    memory.forget("u1", "usual_provider");
    expect(memory.infer("u1", "usual_provider", "Voltline", "electrician", "booking:B-0001")).toBeUndefined();
    expect(memory.active("u1")).toHaveLength(0);
  });
});

describe("forget", () => {
  it("blanks every row for the key and leaves tombstones", () => {
    const memory = store();
    const old = memory.remember("u1", "preferred_area", "Koramangala", "global", "I love Koramangala");
    const next = memory.remember("u1", "preferred_area", "Whitefield", "global", "Whitefield now");
    memory.forget("u1", "preferred_area");
    for (const id of [old, next]) {
      expect(memory.get(id)).toMatchObject({ status: "forgotten", value: "", source: "forgotten" });
    }
    expect(memory.active("u1")).toHaveLength(0);
  });

  it("returns values and the user's words, longest first", () => {
    const memory = store();
    memory.remember("u1", "earliest_time", "10:00", "global", "never before 10 a.m.");
    expect(memory.forget("u1", "earliest_time")).toEqual(["never before 10 a.m.", "10:00"]);
  });

  it("can forget one scope only", () => {
    const memory = store();
    memory.remember("u1", "earliest_time", "09:00", "global", "words here");
    memory.remember("u1", "earliest_time", "11:00", "plumber", "words here");
    memory.forget("u1", "earliest_time", "plumber");
    expect(memory.active("u1").map((item) => item.value)).toEqual(["09:00"]);
  });

  it("returns nothing for an unknown key", () => {
    expect(store().forget("u1", "nothing")).toEqual([]);
  });
});

describe("scrubText", () => {
  it("removes values in any case", () => {
    expect(scrubText("I like KORAMANGALA a lot", ["Koramangala"])).toBe("I like [forgotten] a lot");
  });

  it("only removes whole words", () => {
    expect(scrubText("AC and ACME", ["AC"])).toBe("[forgotten] and ACME");
  });

  it("treats regex characters as plain text", () => {
    expect(scrubText("budget (max) is set", ["(max)"])).toBe("budget [forgotten] is set");
  });
});
