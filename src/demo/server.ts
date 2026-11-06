import { SystemClock } from "../clock.ts";
import { AnthropicLLM } from "../llm/anthropic.ts";
import { DemoApp } from "./app.ts";
import { createDemoServer } from "./http.ts";

// `LIVE=1 npm run demo`. The real model client refuses to start without LIVE=1.
const PORT = 4000;
const MONITOR_TICK_MS = 5_000;

const app = new DemoApp({ dataDir: "data", tracesDir: "traces", llm: new AnthropicLLM(), clock: new SystemClock() });
await app.start();

setInterval(() => void app.tick(), MONITOR_TICK_MS);
createDemoServer(app).listen(PORT, "127.0.0.1", () => {
  console.log(`Errand Agent demo on http://localhost:${PORT}`);
});
