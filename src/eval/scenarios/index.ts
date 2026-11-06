import type { Scenario } from "../scenario.ts";
import { adversarialScenarios } from "./adversarial.ts";
import { approvalScenarios } from "./approval.ts";
import { conversationScenarios } from "./conversation.ts";
import { limitScenarios } from "./limits.ts";
import { memoryScenarios } from "./memory.ts";
import { proactiveScenarios } from "./proactive.ts";
import { recordedScenarios } from "./recorded.ts";
import { recoveryScenarios } from "./recovery.ts";

export const SCENARIOS: Scenario[] = [
  ...conversationScenarios, ...approvalScenarios, ...recoveryScenarios, ...adversarialScenarios,
  ...memoryScenarios, ...limitScenarios, ...proactiveScenarios, ...recordedScenarios,
];
