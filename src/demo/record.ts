import { mkdirSync, writeFileSync } from "node:fs";
import { MODEL, SMOKE_MODEL } from "../config.ts";
import { RECORDED_RUNS, recordingPath, SMOKE_RUNS } from "../eval/recorded-runs.ts";
import { World } from "../eval/world.ts";
import { AnthropicLLM } from "../llm/anthropic.ts";
import { RecordingLLM } from "../llm/recorded.ts";

// Runs the recorded conversations against a real model.
//   LIVE=1 npm run record -- --smoke happy-path   cheap wiring check, saves nothing
//   LIVE=1 npm run record                         real recordings on the project model
const MAX_SPEND_USD = 0.75; // estimated at Sonnet prices, whichever model runs

const args = process.argv.slice(2);
const smoke = args.includes("--smoke");
const only = args.find((arg) => !arg.startsWith("--"));
const model = smoke ? SMOKE_MODEL : MODEL;

mkdirSync("fixtures/recordings", { recursive: true });
mkdirSync("docs/traces", { recursive: true });

function costOf(world: World): number {
  return world.sink.events.reduce((total, event) => total + Number(event.estimated_cost_usd ?? 0), 0);
}

function report(world: World): void {
  const names = (type: string, field: string) => world.sink.events.filter((event) => event.type === type).map((event) => event[field]);
  console.log(`\ntools: ${names("tool_call", "name").join(", ")}`);
  for (const event of world.sink.events.filter((item) => item.type === "tool_call")) {
    console.log(`  ${event.name} ${JSON.stringify(event.args)} -> ${JSON.stringify(event.result ?? event.error).slice(0, 160)}`);
  }
  console.log(`gate: ${world.sink.events.filter((event) => event.type === "gate_decision").map((event) => `${event.decision}${event.because ? `(${event.because})` : ""}`).join(", ") || "none"}`);
  console.log(`states: ${names("state_transition", "to").join(" > ")}`);
  for (const call of world.sink.events.filter((event) => event.type === "model_call")) {
    console.log(`  model ${call.latency_ms} ms, in ${call.input_tokens} (est ${call.estimated_input_tokens}), out ${call.output_tokens}, ${call.stop_reason ?? `error ${call.error} ${call.status}`}`);
  }
}

let spentBefore = 0;
const runs = smoke ? [...RECORDED_RUNS, ...SMOKE_RUNS] : RECORDED_RUNS;
for (const recorded of runs.filter((item) => !only || item.name === only)) {
  const real = new AnthropicLLM(model);
  // A smoke run saves nothing, so a cheaper model can never reach the fixtures.
  const llm = smoke ? real : new RecordingLLM(real, recordingPath(recorded.name), `${recorded.note} Model: ${model}.`);
  const world = new World({ llm });
  await recorded.setup?.(world);

  console.log(`\n=== ${recorded.name} on ${model}`);
  for (const text of recorded.messages) {
    if (spentBefore + costOf(world) >= MAX_SPEND_USD) throw new Error(`Stopped at the spend cap of $${MAX_SPEND_USD}`);
    console.log(`\nuser: ${text}`);
    const reply = await world.user(text);
    console.log(`agent [${reply.reason}]: ${reply.reply}`);
  }

  report(world);
  spentBefore += costOf(world);

  if (recorded.traceFile && !smoke) {
    writeFileSync(recorded.traceFile, `${world.sink.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    console.log(`trace written to ${recorded.traceFile}`);
  }
}
console.log(`\nestimated spend at Sonnet prices: $${spentBefore.toFixed(4)}${smoke ? " (real Haiku cost is about 1/20 of this)" : ""}`);
