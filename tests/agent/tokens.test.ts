import { describe, expect, it } from "vitest";
import { estimatePayloadTokens } from "../../src/agent/tokens.ts";
import { FIRST_MESSAGE, PLUMBER_REQUEST, PLUMBER_SEARCH } from "../../src/eval/steps.ts";
import { World } from "../../src/eval/world.ts";
import { say, tool } from "../../src/llm/scripted.ts";

// Real counts for this exact conversation, measured with count_tokens by
// scripts/measure-tokens.ts on claude-sonnet-5-5, tool schemas excluded.
const MEASURED_REAL_TOKENS = [780, 1113, 1769];

describe("the local token estimate", () => {
  it("is never below the real count measured for a JSON-heavy conversation", async () => {
    const world = new World();
    world.script(tool("update_request", PLUMBER_REQUEST), tool("search_providers", PLUMBER_SEARCH), say("Here are the options."));
    await world.user(FIRST_MESSAGE);
    expect(world.llm.requests).toHaveLength(3);
    world.llm.requests.forEach((request, index) => {
      expect(estimatePayloadTokens(request.system, request.messages), `call ${index + 1}`).toBeGreaterThanOrEqual(MEASURED_REAL_TOKENS[index]!);
    });
  });
});
