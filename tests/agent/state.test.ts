import { describe, expect, it } from "vitest";
import { IllegalTransition, STATES, TERMINAL_STATES, TRANSITIONS } from "../../src/agent/state.ts";
import { Run } from "../../src/agent/run.ts";
import { makeAgent, SESSION, USER } from "./helpers.ts";

function setup() {
  const made = makeAgent();
  const run = new Run(made.agent.deps, SESSION, USER, 1, made.sink.startRun(SESSION, "test"));
  const task = made.agent.deps.tasks.create(SESSION, USER, "book");
  return { ...made, run, task };
}

describe("state machine", () => {
  it("only moves between known states", () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      expect(STATES).toContain(from);
      for (const to of targets) expect(STATES).toContain(to);
    }
  });

  it("has no way out of DONE or FAILED", () => {
    for (const state of TERMINAL_STATES) expect(TRANSITIONS[state]).toEqual([]);
  });

  it("can reach DONE from COLLECTING along the booking path", () => {
    const { run, task } = setup();
    for (const state of ["SEARCHING", "COMPARING", "HOLDING", "AWAITING_APPROVAL", "EXECUTING", "VERIFYING", "DONE"] as const) {
      run.setState(task, state);
    }
    expect(task.state).toBe("DONE");
  });

  it("saves each move and traces it", () => {
    const { run, task, agent, events } = setup();
    run.setState(task, "SEARCHING", { because: "test" });
    expect(agent.deps.tasks.get(task.task_id)?.state).toBe("SEARCHING");
    expect(events("state_transition")).toHaveLength(1);
    expect(events("state_transition")[0]).toMatchObject({ from: "COLLECTING", to: "SEARCHING", because: "test" });
  });

  it("throws on an illegal move, traces it and keeps the old state", () => {
    const { run, task, agent, events } = setup();
    expect(() => run.setState(task, "EXECUTING")).toThrow(IllegalTransition);
    expect(events("state_transition")[0]).toMatchObject({ from: "COLLECTING", to: "EXECUTING", illegal: true });
    expect(agent.deps.tasks.get(task.task_id)?.state).toBe("COLLECTING");
  });

  it("cannot jump straight from search results to executing", () => {
    const { run, task } = setup();
    run.setState(task, "SEARCHING");
    run.setState(task, "COMPARING");
    expect(() => run.setState(task, "EXECUTING")).toThrow(IllegalTransition);
  });

  it("does not leave a finished task", () => {
    const { run, task } = setup();
    run.setState(task, "FAILED");
    expect(() => run.setState(task, "COLLECTING")).toThrow(IllegalTransition);
  });

  it("treats a move to the current state as no change", () => {
    const { run, task, events } = setup();
    run.setState(task, "COLLECTING");
    expect(events("state_transition")).toHaveLength(0);
  });
});
