import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { Run } from "../run.ts";
import { book, cancel, requestApproval, reschedule } from "./action-tools.ts";
import type { AgentTool } from "./define.ts";
import { memoryCorrect, memoryForget, memoryList, rememberPreference } from "./memory-tools.ts";
import { getBookingStatus, getProvider, holdSlot, listBookings, searchProviders } from "./provider-tools.ts";
import { askUser, updateRequest } from "./request-tools.ts";

export const ALL_TOOLS: AgentTool[] = [
  updateRequest, askUser, searchProviders, getProvider, holdSlot, getBookingStatus, listBookings,
  requestApproval, book, cancel, reschedule,
  rememberPreference, memoryList, memoryCorrect, memoryForget,
];

// zod adds a $schema key the API does not need, and omits `required` when
// nothing is required. Strict tools expect the key to be there.
function strictSchema(tool: AgentTool): Anthropic.Tool.InputSchema {
  const { $schema: _unused, ...schema } = z.toJSONSchema(tool.input) as Anthropic.Tool.InputSchema & { $schema?: string };
  return { ...schema, required: schema.required ?? [] };
}

// strict: true makes the API hold tool inputs to these schemas.
export function toolDefinitions(): Anthropic.Tool[] {
  return ALL_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    strict: true,
    input_schema: strictSchema(tool),
  }));
}

const MOCK_TOOL_NAMES = ["search_providers", "get_provider", "hold_slot", "get_booking_status", "list_bookings"];

function resultBlock(block: Anthropic.ToolUseBlock, result: object, isError = false): Anthropic.ToolResultBlockParam {
  return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result), is_error: isError };
}

function badInput(run: Run, block: Anthropic.ToolUseBlock, detail: object): Anthropic.ToolResultBlockParam {
  run.badInputs += 1;
  run.trace.emit("tool_call", { name: block.name, args: block.input, error: "bad_input", detail });
  if (run.badInputs >= run.deps.limits.maxBadToolInputs) run.end = { reason: "bad_tool_input" };
  return resultBlock(block, { error: "bad_input", ...detail }, true);
}

// Runs one tool call from the model. Input is checked with zod first, and a
// tool that throws ends the run with a clear message rather than a hang.
export async function dispatch(run: Run, block: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
  const tool = ALL_TOOLS.find((candidate) => candidate.name === block.name);
  if (!tool) return badInput(run, block, { message: `Unknown tool ${block.name}` });

  const parsed = tool.input.safeParse(block.input);
  if (!parsed.success) return badInput(run, block, { issues: parsed.error.issues.map((issue) => issue.message) });

  const started = performance.now();
  try {
    const result = await tool.run(run, parsed.data as never);
    // Mock tools trace themselves, one event per attempt.
    if (!MOCK_TOOL_NAMES.includes(block.name)) {
      run.toolCalls += 1;
      const latency_ms = Math.round(performance.now() - started);
      run.trace.emit("tool_call", { name: block.name, args: parsed.data, result, latency_ms, attempt: 1 });
    }
    return resultBlock(block, result);
  } catch (error) {
    if (!MOCK_TOOL_NAMES.includes(block.name)) {
      run.toolCalls += 1;
      run.trace.emit("tool_call", { name: block.name, args: parsed.data, error: String(error) });
    }
    run.end = { reason: "tool_error" };
    return resultBlock(block, { error: "tool_failed" }, true);
  }
}
