import { describe, expect, it } from "vitest";
import { selectMemories } from "../../src/memory/select.ts";
import type { Memory } from "../../src/memory/store.ts";

let nextId = 1;
function memory(change: Partial<Memory>): Memory {
  return {
    id: nextId++, user_id: "u1", key: "note", value: "a value", scope: "global", kind: "explicit",
    confirmed: true, status: "active", source: "words", created_at: 0, updated_at: 0, ...change,
  };
}

describe("selectMemories", () => {
  it("excludes each kind of fact with its reason", () => {
    const forgotten = memory({ status: "forgotten", value: "" });
    const superseded = memory({ status: "superseded" });
    const unconfirmed = memory({ kind: "inferred", confirmed: false });
    const otherService = memory({ scope: "ac_service" });
    const otherArea = memory({ key: "whitefield_gate", value: "blue gate" });
    const { included, excluded } = selectMemories([forgotten, superseded, unconfirmed, otherService, otherArea], "plumber", "Indiranagar", 300);
    expect(included).toEqual([]);
    expect(excluded).toEqual([
      { id: forgotten.id, reason: "forgotten" },
      { id: superseded.id, reason: "superseded" },
      { id: unconfirmed.id, reason: "unconfirmed" },
      { id: otherService.id, reason: "other_service" },
      { id: otherArea.id, reason: "other_area" },
    ]);
  });

  it("keeps explicit facts and confirmed inferred facts", () => {
    const explicit = memory({});
    const confirmed = memory({ kind: "inferred", confirmed: true });
    expect(selectMemories([explicit, confirmed], undefined, undefined, 300).included).toHaveLength(2);
  });

  it("leaves out service-scoped facts when no service is known", () => {
    const scoped = memory({ scope: "plumber" });
    expect(selectMemories([scoped], undefined, undefined, 300).excluded).toEqual([{ id: scoped.id, reason: "other_service" }]);
  });

  it("recognises an area written with an underscore", () => {
    const fact = memory({ key: "hsr_layout_parking" });
    expect(selectMemories([fact], undefined, "Whitefield", 300).excluded[0]?.reason).toBe("other_area");
    expect(selectMemories([fact], undefined, "HSR Layout", 300).included).toHaveLength(1);
  });

  it("ranks service facts and core keys first", () => {
    const plain = memory({ key: "plain_note" });
    const core = memory({ key: "preferred_area", value: "Indiranagar" });
    const service = memory({ key: "preferred_provider", scope: "plumber" });
    const { included } = selectMemories([plain, core, service], "plumber", "Indiranagar", 300);
    expect(included.map((item) => item.id)).toEqual([service.id, core.id, plain.id]);
  });

  it("trims to budget and reports what was cut", () => {
    const facts = Array.from({ length: 20 }, (_, index) => memory({ key: `note_${index}` }));
    const { included, excluded } = selectMemories(facts, undefined, undefined, 50);
    expect(included.length).toBeGreaterThan(0);
    expect(included.length).toBeLessThan(20);
    expect(excluded.every((item) => item.reason === "over_memory_budget")).toBe(true);
    expect(included.length + excluded.length).toBe(20);
  });

  it("gives the same answer for the same input", () => {
    const facts = Array.from({ length: 10 }, (_, index) => memory({ key: `note_${index}` }));
    const ids = () => selectMemories([...facts].reverse(), undefined, undefined, 60).included.map((item) => item.id);
    expect(ids()).toEqual(ids());
  });
});
