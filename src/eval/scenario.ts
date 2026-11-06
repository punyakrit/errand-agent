import type { Facts } from "./facts.ts";
import type { World, WorldOptions } from "./world.ts";

export interface Scenario {
  id: string;
  name: string;
  note: string;
  mode?: "scripted" | "recorded";
  world?: WorldOptions;
  expect: Facts; // the facts that must hold, compared with what really happened
  run(world: World): Promise<void>;
  extra?(world: World): Facts; // further computed facts for this scenario
}
