import type { z } from "zod";
import type { Run } from "../run.ts";

export interface AgentTool {
  name: string;
  description: string;
  input: z.ZodObject;
  run(run: Run, input: never): Promise<object>;
}

export function defineTool<S extends z.ZodObject>(tool: {
  name: string;
  description: string;
  input: S;
  run: (run: Run, input: z.infer<S>) => Promise<object>;
}): AgentTool {
  return tool as unknown as AgentTool;
}
