import { estimatePayloadTokens } from "../src/agent/tokens.ts";
import { FIRST_MESSAGE, PLUMBER_REQUEST, PLUMBER_SEARCH } from "../src/eval/steps.ts";
import { World } from "../src/eval/world.ts";
import { AnthropicLLM } from "../src/llm/anthropic.ts";
import { say, tool } from "../src/llm/scripted.ts";

// `LIVE=1 npx tsx scripts/measure-tokens.ts`. Compares the local token estimate
// with the real count for a typical conversation. Uses count_tokens only, so no
// model runs.
const world = new World();
world.script(tool("update_request", PLUMBER_REQUEST), tool("search_providers", PLUMBER_SEARCH), say("Here are the options."));
await world.user(FIRST_MESSAGE);

const real = new AnthropicLLM();
const first = world.llm.requests[0]!;
const withoutTools = await real.countTokens({ system: first.system, messages: first.messages, tools: [] });
const withTools = await real.countTokens(first);
const toolCost = withTools - withoutTools;
console.log(`tool schemas cost ${toolCost} tokens per call, outside the budget`);

for (const [index, request] of world.llm.requests.entries()) {
  const estimated = estimatePayloadTokens(request.system, request.messages);
  const counted = (await real.countTokens(request)) - toolCost;
  const verdict = estimated >= counted ? "high, as intended" : "TOO LOW";
  console.log(`call ${index + 1}: estimate ${estimated}, real ${counted}, ratio ${(estimated / counted).toFixed(2)} (${verdict})`);
}
