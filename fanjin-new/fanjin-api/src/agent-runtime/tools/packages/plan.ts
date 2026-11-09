import { z } from "zod";
import { defineAgentTool } from "@/agent-runtime/tools/registry";

const MAX_PLAN_STEPS = 20;

function boundedText(maxLength: number) {
  return z.string().trim().min(1).max(maxLength);
}

// Optional fields use nullable + default(null) instead of .optional(): the
// OpenAI strict projector rejects optional properties and cannot silently
// widen them to nullable.
const planPresentStepSchema = z.object({
  title: boundedText(120),
  detail: boundedText(500).nullable().default(null),
}).strict();

export const planPresentInputSchema = z.object({
  title: boundedText(120),
  summary: boundedText(500).nullable().default(null),
  steps: z.array(planPresentStepSchema).min(1).max(MAX_PLAN_STEPS),
  estimatedTotal: boundedText(120).nullable().default(null),
}).strict();

const planPresentStepOutputSchema = z.object({
  title: z.string().min(1),
  detail: z.string().min(1).nullable(),
}).strict();

export const planPresentOutputSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1).nullable(),
  steps: z.array(planPresentStepOutputSchema).min(1).max(MAX_PLAN_STEPS),
  estimatedTotal: z.string().min(1).nullable(),
}).strict();

export const PLAN_PRESENT_TOOL = defineAgentTool({
  manifest: {
    name: "plan.present",
    version: "1.0.0",
    displayName: "呈现创作方案",
    description: "把创作方案、分阶段计划或多步骤提案以结构化 Plan 呈现给用户。正例：用户要求制定拍摄/制作方案、拆解实施步骤、给出多条创作路线并等待确认时，调用本工具提交 title 与 steps。负例：简单问答、澄清提问、闲聊，或一步即可完成的操作，不要调用本工具。本工具只呈现方案，不代表任何步骤已执行、已获批或已计费。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A5" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["plan"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: planPresentInputSchema,
  outputSchema: planPresentOutputSchema,
  async execute(input) {
    // R0 presentation echo: the validated arguments ARE the result. The
    // Gateway persists them as the tool Step's inline_tool_result outputRefs;
    // the frontend reads the plan from Step snapshots without any SSE or
    // message-content change.
    return input;
  },
});
