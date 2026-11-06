import { say, tool } from "../llm/scripted.ts";
import { checkInvariants } from "./invariants.ts";
import { FIRST_MESSAGE, PLUMBER_REQUEST, PLUMBER_SEARCH } from "./steps.ts";
import { USER, World } from "./world.ts";

export interface SweepResult {
  seeds: number;
  passed: number;
  failed: number;
  outcomes: Record<string, number>;
  failures: { seed: number; problem: string }[];
}

const MAX_ROUNDS = 8;

// Plays one full booking at the default odds, following whatever happens.
// A stand-in model picks the first option left, and a simple user says yes.
async function playOneBooking(world: World): Promise<void> {
  world.script(tool("update_request", PLUMBER_REQUEST), tool("search_providers", PLUMBER_SEARCH), say("Here are the options."));
  await world.user(FIRST_MESSAGE);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const task = world.agent.deps.tasks.active(USER);
    if (!task) return;
    if (task.state === "AWAITING_APPROVAL") {
      await world.user("yes");
    } else if (task.state === "COMPARING" && task.details.options?.[0]?.slots[0]) {
      const option = task.details.options[0];
      world.script(tool("hold_slot", { provider_id: option.provider_id, slot: option.slots[0]! }), tool("request_approval"));
      await world.user("The first one, please.");
    } else if (task.state === "NEEDS_USER" && world.agent.deps.ops.open().length === 0 && task.details.hold) {
      world.script(tool("request_approval"));
      await world.user("Please try again.");
    } else {
      return;
    }
  }
}

function tally(world: World, outcomes: Record<string, number>): void {
  const calls = world.mock.calls("book").map((call) => call.outcome);
  for (const outcome of calls) outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  const last = world.sink.events.filter((event) => event.type === "state_transition").at(-1)?.to as string | undefined;
  const key = `ended_${last ?? "unknown"}`;
  outcomes[key] = (outcomes[key] ?? 0) + 1;
}

export async function runSweep(seeds = 500): Promise<SweepResult> {
  const result: SweepResult = { seeds, passed: 0, failed: 0, outcomes: {}, failures: [] };
  for (let seed = 0; seed < seeds; seed++) {
    const world = new World({ seed });
    try {
      await playOneBooking(world);
      const broken = checkInvariants(world).filter((invariant) => !invariant.pass);
      if (broken.length === 0) result.passed += 1;
      else {
        result.failed += 1;
        result.failures.push({ seed, problem: `${broken[0]!.name}: ${broken[0]!.problems[0]}` });
      }
      tally(world, result.outcomes);
    } catch (error) {
      result.failed += 1;
      result.failures.push({ seed, problem: String(error) });
    }
  }
  return result;
}

