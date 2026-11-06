import { factsOf, type Facts } from "./facts.ts";
import { checkInvariants, type InvariantResult } from "./invariants.ts";
import type { Scenario } from "./scenario.ts";
import { World } from "./world.ts";

export interface ScenarioResult {
  id: string;
  name: string;
  mode: string;
  expected: Facts;
  actual: Facts;
  mismatches: string[];
  invariants: InvariantResult[];
  pass: boolean;
  notes: string;
  error?: string;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const world = new World(scenario.world);
  let error: string | undefined;
  try {
    await scenario.run(world);
  } catch (caught) {
    error = String(caught);
  }

  const all: Facts = { ...factsOf(world), ...scenario.extra?.(world) };
  const actual = Object.fromEntries(Object.keys(scenario.expect).map((key) => [key, all[key]]));
  const mismatches = Object.keys(scenario.expect).filter((key) => !same(scenario.expect[key], actual[key]));
  const invariants = checkInvariants(world);
  const failed = invariants.filter((invariant) => !invariant.pass);
  const pass = !error && mismatches.length === 0 && failed.length === 0;

  const problems = [
    error ? `error: ${error}` : "",
    ...mismatches.map((key) => `${key} differs`),
    ...failed.map((invariant) => `invariant ${invariant.name}: ${invariant.problems[0]}`),
  ].filter(Boolean);

  return {
    id: scenario.id, name: scenario.name, mode: scenario.mode ?? "scripted",
    expected: scenario.expect, actual, mismatches, invariants, pass,
    notes: problems.length > 0 ? problems.join("; ") : scenario.note,
    error,
  };
}
