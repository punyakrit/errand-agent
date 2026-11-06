import { mkdirSync, writeFileSync } from "node:fs";
import { AnthropicLLM } from "../llm/anthropic.ts";
import { RecordingLLM } from "../llm/recorded.ts";
import { RECORDED_RUNS, recordingPath } from "../eval/recorded-runs.ts";
import { World } from "../eval/world.ts";

// `LIVE=1 npm run record`. Runs the recorded conversations against the real
// model and saves its responses as fixtures for the offline evals.
mkdirSync("fixtures/recordings", { recursive: true });
mkdirSync("docs/traces", { recursive: true });

const only = process.argv[2];
for (const recorded of RECORDED_RUNS.filter((item) => !only || item.name === only)) {
  const llm = new RecordingLLM(new AnthropicLLM(), recordingPath(recorded.name), recorded.note);
  const world = new World({ llm });
  await recorded.setup?.(world);

  console.log(`\n=== ${recorded.name}`);
  for (const text of recorded.messages) {
    console.log(`user: ${text}`);
    const reply = await world.user(text);
    console.log(`agent [${reply.reason}]: ${reply.reply}`);
  }

  const calls = world.sink.events.filter((event) => event.type === "model_call");
  const cost = calls.reduce((total, event) => total + Number(event.estimated_cost_usd ?? 0), 0);
  console.log(`model calls: ${calls.length}, estimated cost: $${cost.toFixed(4)}`);

  if (recorded.traceFile) {
    writeFileSync(recorded.traceFile, world.sink.events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    console.log(`trace written to ${recorded.traceFile}`);
  }
}
