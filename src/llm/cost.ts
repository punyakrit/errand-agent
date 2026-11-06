import type Anthropic from "@anthropic-ai/sdk";
import { PRICING } from "../config.ts";

export function estimateCostUsd(usage: Anthropic.Usage): number {
  const cached = usage.cache_read_input_tokens ?? 0;
  const dollars =
    usage.input_tokens * PRICING.input + usage.output_tokens * PRICING.output + cached * PRICING.cacheRead;
  return dollars / 1_000_000;
}
