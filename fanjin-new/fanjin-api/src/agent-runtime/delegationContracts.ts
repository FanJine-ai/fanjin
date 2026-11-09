import { z } from "zod";
import type { ToolId } from "@/agent-runtime/toolIds";
import { A4_REVIEW_VERDICTS } from "@/agent-runtime/reviewReportContracts";
import { storyVideoPipelineSpecSchema } from "@/agent-runtime/executionSpec";

/** Immutable role set persisted by the main Prompt v4 delegation contract. */
export const A4_DELEGATED_AGENT_ROLES_V1 = ["writer", "storyboard"] as const;
export type A4DelegatedAgentRoleV1 = (typeof A4_DELEGATED_AGENT_ROLES_V1)[number];

/** Role set persisted by the main Prompt v5 delegation contract. */
export const A4_DELEGATED_AGENT_ROLES_V2 = ["writer", "visual", "storyboard", "reviewer"] as const;
export type A4DelegatedAgentRoleV2 = (typeof A4_DELEGATED_AGENT_ROLES_V2)[number];

/**
 * V3（Executor，REVAMP-PLAN 2.2 / HANDOFF Executor V3 方案）：在 V2 角色集合
 * 之上新增 executor。executor 是确定性执行角色——不走模型 Tool Loop，只按
 * 服务端 ExecutionSpec（storyVideo 管线契约）逐步执行 R2 工具。
 */
export const A4_DELEGATED_AGENT_ROLES_V3 = [
  ...A4_DELEGATED_AGENT_ROLES_V2,
  "executor",
] as const;
export type A4DelegatedAgentRoleV3 = (typeof A4_DELEGATED_AGENT_ROLES_V3)[number];

/** Latest aliases are for newly admitted Runs only; recovery must select an explicit version. */
export const A4_DELEGATED_AGENT_ROLES = A4_DELEGATED_AGENT_ROLES_V3;
export type A4DelegatedAgentRole = A4DelegatedAgentRoleV3;

export const AGENT_TASK_VERSION_V1 = 1 as const;
export const AGENT_TASK_VERSION_V2 = 2 as const;
export const AGENT_TASK_VERSION_V3 = 3 as const;
export const AGENT_TASK_RESULT_VERSION_V1 = 1 as const;
export const AGENT_TASK_RESULT_VERSION_V2 = 2 as const;
export const AGENT_TASK_RESULT_VERSION_V3 = 3 as const;
export const AGENT_TASK_VERSION = AGENT_TASK_VERSION_V3;
export const AGENT_TASK_RESULT_VERSION = AGENT_TASK_RESULT_VERSION_V3;
export type AgentTaskVersion =
  | typeof AGENT_TASK_VERSION_V1
  | typeof AGENT_TASK_VERSION_V2
  | typeof AGENT_TASK_VERSION_V3;
export type AgentTaskResultVersion =
  | typeof AGENT_TASK_RESULT_VERSION_V1
  | typeof AGENT_TASK_RESULT_VERSION_V2
  | typeof AGENT_TASK_RESULT_VERSION_V3;

export const AGENT_TASK_REF_TYPES = [
  "project",
  "session",
  "script",
  "asset",
  "asset_version",
  "storyboard",
  "canvas",
  "message",
] as const;

export const AGENT_TASK_WRITE_TARGET_TYPES_V1 = [
  "script_draft",
  "storyboard_draft",
  "canvas_draft",
] as const;
export const AGENT_TASK_WRITE_TARGET_TYPES_V2 = [
  "script_draft",
  "asset_design_draft",
  "storyboard_draft",
  "canvas_draft",
  "review_report",
] as const;
/** V3 新增 merged_video：executor 拼接成片的唯一写目标。 */
export const AGENT_TASK_WRITE_TARGET_TYPES_V3 = [
  ...AGENT_TASK_WRITE_TARGET_TYPES_V2,
  "merged_video",
] as const;
export const AGENT_TASK_WRITE_TARGET_TYPES = AGENT_TASK_WRITE_TARGET_TYPES_V3;

export const AGENT_TASK_TYPES_V1 = [
  "writer.story_outline",
  "writer.script_draft",
  "writer.copy_draft",
  "storyboard.shot_plan",
  "storyboard.continuity_plan",
  "storyboard.canvas_layout_plan",
] as const;
export const AGENT_TASK_TYPES_V2 = [
  "writer.story_outline",
  "writer.script_draft",
  "writer.copy_draft",
  "visual.character_design_plan",
  "visual.scene_design_plan",
  "visual.prop_design_plan",
  "visual.style_guide_plan",
  "visual.asset_design_plan",
  "storyboard.shot_plan",
  "storyboard.continuity_plan",
  "storyboard.canvas_layout_plan",
  "reviewer.quality_review",
] as const;
export const AGENT_TASK_TYPES_V3 = [
  ...AGENT_TASK_TYPES_V2,
  "executor.story_video",
] as const;
export const AGENT_TASK_TYPES = AGENT_TASK_TYPES_V3;

export const AGENT_TASK_EXPECTED_ARTIFACT_TYPES_V1 = [
  "writer.story_outline_proposal",
  "writer.script_draft_proposal",
  "writer.copy_draft_proposal",
  "storyboard.shot_list_proposal",
  "storyboard.continuity_proposal",
  "storyboard.canvas_layout_proposal",
] as const;
export const AGENT_TASK_EXPECTED_ARTIFACT_TYPES_V2 = [
  "writer.story_outline_proposal",
  "writer.script_draft_proposal",
  "writer.copy_draft_proposal",
  "visual.character_design_proposal",
  "visual.scene_design_proposal",
  "visual.prop_design_proposal",
  "visual.style_guide_proposal",
  "visual.asset_design_proposal",
  "storyboard.shot_list_proposal",
  "storyboard.continuity_proposal",
  "storyboard.canvas_layout_proposal",
  "reviewer.review_report",
] as const;
export const AGENT_TASK_EXPECTED_ARTIFACT_TYPES_V3 = [
  ...AGENT_TASK_EXPECTED_ARTIFACT_TYPES_V2,
  "executor.story_video_plan",
] as const;
export const AGENT_TASK_EXPECTED_ARTIFACT_TYPES = AGENT_TASK_EXPECTED_ARTIFACT_TYPES_V3;

export const AGENT_TASK_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "needs_input",
  "cancelled",
] as const;
export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];

export const AGENT_TASK_RESULT_STATUSES = [
  "succeeded",
  "failed",
  "needs_input",
  "cancelled",
] as const;
export type AgentTaskResultStatus = (typeof AGENT_TASK_RESULT_STATUSES)[number];

export const TERMINAL_AGENT_TASK_STATUSES = [
  "succeeded",
  "failed",
  "needs_input",
  "cancelled",
] as const satisfies readonly AgentTaskStatus[];

const ID_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;
const TEXT_NUL_PATTERN = /\u0000/;

const boundedId = z.string().trim().min(1).max(200).regex(ID_PATTERN);
const boundedVersion = z.string().trim().min(1).max(200).regex(ID_PATTERN);
const boundedText = (max: number) => z.string().trim().min(1).max(max).refine(
  (value) => !TEXT_NUL_PATTERN.test(value),
);
const boundedTextList = (maxItems: number, maxLength: number, minItems = 0) => z
  .array(boundedText(maxLength))
  .min(minItems)
  .max(maxItems);

export const agentTaskRefSchema = z.object({
  type: z.enum(AGENT_TASK_REF_TYPES),
  id: boundedId,
  version: boundedVersion.nullable(),
}).strict();
export type AgentTaskRef = z.infer<typeof agentTaskRefSchema>;

/** A write target coordinates conflicts; it never grants a write capability. */
export const agentTaskWriteTargetSchemaV1 = z.object({
  type: z.enum(AGENT_TASK_WRITE_TARGET_TYPES_V1),
  id: boundedId,
}).strict();
export const agentTaskWriteTargetSchemaV2 = z.object({
  type: z.enum(AGENT_TASK_WRITE_TARGET_TYPES_V2),
  id: boundedId,
}).strict();
/** V3 写目标 schema：在 V2 之上接受 merged_video（executor 唯一写目标）。 */
export const agentTaskWriteTargetSchemaV3 = z.object({
  type: z.enum(AGENT_TASK_WRITE_TARGET_TYPES_V3),
  id: boundedId,
}).strict();
export const agentTaskWriteTargetSchema = agentTaskWriteTargetSchemaV2;
export type AgentTaskWriteTargetV1 = z.infer<typeof agentTaskWriteTargetSchemaV1>;
export type AgentTaskWriteTargetV2 = z.infer<typeof agentTaskWriteTargetSchemaV2>;
export type AgentTaskWriteTargetV3 = z.infer<typeof agentTaskWriteTargetSchemaV3>;
export type AgentTaskWriteTarget = AgentTaskWriteTargetV2;
export type AnyAgentTaskWriteTarget =
  | AgentTaskWriteTargetV1
  | AgentTaskWriteTargetV2
  | AgentTaskWriteTargetV3;

/** Fully-known constraint shape shared by both immutable persistence versions. */
export const agentTaskConstraintsSchema = z.object({
  language: boundedText(100).nullable(),
  tone: boundedText(500).nullable(),
  outputFormat: z.literal("structured_proposal"),
  maxCharacters: z.number().int().min(1).max(1_000_000).nullable(),
  targetDurationSeconds: z.number().int().min(1).max(86_400).nullable(),
  aspectRatio: boundedText(40).nullable(),
  mustInclude: boundedTextList(32, 1_000),
  mustAvoid: boundedTextList(32, 1_000),
  notes: boundedTextList(32, 2_000),
}).strict();
export type AgentTaskConstraints = z.infer<typeof agentTaskConstraintsSchema>;

export const agentTaskSchemaV1 = z.object({
  version: z.literal(AGENT_TASK_VERSION_V1),
  role: z.enum(A4_DELEGATED_AGENT_ROLES_V1),
  projectId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  taskType: z.enum(AGENT_TASK_TYPES_V1),
  objective: boundedText(10_000),
  inputRefs: z.array(agentTaskRefSchema).min(1).max(50),
  constraints: agentTaskConstraintsSchema,
  expectedArtifacts: z.array(z.enum(AGENT_TASK_EXPECTED_ARTIFACT_TYPES_V1)).min(1).max(6),
  qualityCriteria: boundedTextList(16, 1_000, 1),
  writeTargets: z.array(agentTaskWriteTargetSchemaV1).min(1).max(6),
}).strict();
export type AgentTaskV1 = z.infer<typeof agentTaskSchemaV1>;

export const agentTaskSchemaV2 = z.object({
  version: z.literal(AGENT_TASK_VERSION_V2),
  role: z.enum(A4_DELEGATED_AGENT_ROLES_V2),
  projectId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  taskType: z.enum(AGENT_TASK_TYPES_V2),
  objective: boundedText(10_000),
  inputRefs: z.array(agentTaskRefSchema).min(1).max(50),
  constraints: agentTaskConstraintsSchema,
  expectedArtifacts: z.array(z.enum(AGENT_TASK_EXPECTED_ARTIFACT_TYPES_V2)).length(1),
  qualityCriteria: boundedTextList(16, 1_000, 1),
  writeTargets: z.array(agentTaskWriteTargetSchemaV2).min(1).max(6),
}).strict();
export type AgentTaskV2 = z.infer<typeof agentTaskSchemaV2>;

/**
 * V3 Executor 任务：唯一形态是 executor.story_video——确定性执行服务端
 * storyVideo 管线契约（executionSpec.ts 的 storyVideoPipelineSpecSchema）。
 * 与 V1/V2 的模型提案任务不同：expectedArtifacts 固定为 story_video_plan，
 * writeTarget 固定为 merged_video，且 executionSpec 内嵌完整管线参数，
 * executor 不得改写（normalizeAgentTaskV3 校验 spec 与任务的项目一致性）。
 */
export const agentTaskSchemaV3 = z.object({
  version: z.literal(AGENT_TASK_VERSION_V3),
  role: z.literal("executor"),
  projectId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  taskType: z.literal("executor.story_video"),
  objective: boundedText(10_000),
  inputRefs: z.array(agentTaskRefSchema).min(1).max(50),
  constraints: agentTaskConstraintsSchema,
  expectedArtifacts: z.array(z.literal("executor.story_video_plan")).length(1),
  qualityCriteria: boundedTextList(16, 1_000, 1),
  writeTargets: z.array(agentTaskWriteTargetSchemaV3).length(1),
  executionSpec: storyVideoPipelineSpecSchema,
}).strict().superRefine((task, context) => {
  if (task.writeTargets[0].type !== "merged_video") {
    context.addIssue({
      code: "custom",
      path: ["writeTargets", 0, "type"],
      message: "executor 任务写目标必须是 merged_video",
    });
  }
  if (task.executionSpec.projectRef.id !== String(task.projectId)) {
    context.addIssue({
      code: "custom",
      path: ["executionSpec", "projectRef"],
      message: "executionSpec 与任务的项目范围不一致",
    });
  }
});
export type AgentTaskV3 = z.infer<typeof agentTaskSchemaV3>;

export const agentTaskSchema = agentTaskSchemaV3;
export type AnyAgentTask = AgentTaskV1 | AgentTaskV2 | AgentTaskV3;
export type AgentTask = AnyAgentTask;
export type AgentTaskLatest = AgentTaskV3;

export const agentTaskResultArtifactRefSchema = z.object({
  type: z.literal("message"),
  id: boundedId,
  version: z.null(),
}).strict();
export type AgentTaskResultArtifactRef = z.infer<typeof agentTaskResultArtifactRefSchema>;

export const agentTaskUsageSchema = z.object({
  modelProfile: boundedId,
  inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  costMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
}).strict();
export type AgentTaskUsage = z.infer<typeof agentTaskUsageSchema>;

export const agentTaskResultReviewSchema = z.object({
  verdict: z.enum(A4_REVIEW_VERDICTS),
  reportDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type AgentTaskResultReview = z.infer<typeof agentTaskResultReviewSchema>;

const agentTaskResultBaseShape = {
  status: z.enum(AGENT_TASK_RESULT_STATUSES),
  artifactRefs: z.array(agentTaskResultArtifactRefSchema).max(10),
  summary: boundedText(4_000),
  assumptions: boundedTextList(32, 1_000),
  issues: boundedTextList(32, 1_000),
  suggestedNextActions: boundedTextList(16, 1_000),
  usage: agentTaskUsageSchema,
};

export const agentTaskResultSchemaV1 = z.object({
  version: z.literal(AGENT_TASK_RESULT_VERSION_V1),
  ...agentTaskResultBaseShape,
}).strict();
/** `review?: never` keeps union consumers ergonomic while the strict schema rejects the field. */
export type AgentTaskResultV1 = z.infer<typeof agentTaskResultSchemaV1> & { review?: never };

export const agentTaskResultSchemaV2 = z.object({
  version: z.literal(AGENT_TASK_RESULT_VERSION_V2),
  ...agentTaskResultBaseShape,
  review: agentTaskResultReviewSchema.optional(),
}).strict();
export type AgentTaskResultV2 = z.infer<typeof agentTaskResultSchemaV2>;

/**
 * V3 Executor 任务结果：确定性执行产物。executor 不是 reviewer，
 * 结果永不携带 review；usage 记录的是管线实际发生的生成花费事实
 * （由处理器从 Grant/任务终态汇总），不涉及模型 Token。
 */
export const agentTaskResultSchemaV3 = z.object({
  version: z.literal(AGENT_TASK_RESULT_VERSION_V3),
  ...agentTaskResultBaseShape,
}).strict();
export type AgentTaskResultV3 = z.infer<typeof agentTaskResultSchemaV3> & { review?: never };

export const agentTaskResultSchema = agentTaskResultSchemaV3;
export type AnyAgentTaskResult = AgentTaskResultV1 | AgentTaskResultV2 | AgentTaskResultV3;
export type AgentTaskResult = AnyAgentTaskResult;
export type AgentTaskResultLatest = AgentTaskResultV3;

export type AgentDelegationContractErrorCode =
  | "agent_task_invalid"
  | "agent_task_project_scope_invalid"
  | "agent_task_role_scope_invalid"
  | "agent_task_ref_duplicate"
  | "agent_task_write_target_duplicate"
  | "agent_task_result_invalid"
  | "agent_task_status_invalid"
  | "agent_task_status_transition_invalid";

const SAFE_MESSAGES: Readonly<Record<AgentDelegationContractErrorCode, string>> = Object.freeze({
  agent_task_invalid: "专项 AgentTask 格式无效",
  agent_task_project_scope_invalid: "专项 AgentTask 项目范围无效",
  agent_task_role_scope_invalid: "专项 AgentTask 超出当前角色范围",
  agent_task_ref_duplicate: "专项 AgentTask 包含重复对象引用",
  agent_task_write_target_duplicate: "专项 AgentTask 包含重复写目标",
  agent_task_result_invalid: "专项 AgentTaskResult 格式无效",
  agent_task_status_invalid: "专项 AgentTask 状态无效",
  agent_task_status_transition_invalid: "专项 AgentTask 状态转换无效",
});

export class AgentDelegationContractError extends Error {
  readonly code: AgentDelegationContractErrorCode;

  constructor(code: AgentDelegationContractErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "AgentDelegationContractError";
    this.code = code;
  }
}

const TASK_TYPES_BY_ROLE_V1: Readonly<Record<A4DelegatedAgentRoleV1, ReadonlySet<string>>> = {
  writer: new Set(["writer.story_outline", "writer.script_draft", "writer.copy_draft"]),
  storyboard: new Set([
    "storyboard.shot_plan",
    "storyboard.continuity_plan",
    "storyboard.canvas_layout_plan",
  ]),
};

const TASK_TYPES_BY_ROLE_V2: Readonly<Record<A4DelegatedAgentRoleV2, ReadonlySet<string>>> = {
  ...TASK_TYPES_BY_ROLE_V1,
  visual: new Set([
    "visual.character_design_plan",
    "visual.scene_design_plan",
    "visual.prop_design_plan",
    "visual.style_guide_plan",
    "visual.asset_design_plan",
  ]),
  reviewer: new Set(["reviewer.quality_review"]),
};

const TASK_TYPES_BY_ROLE_V3: Readonly<Record<A4DelegatedAgentRoleV3, ReadonlySet<string>>> = {
  ...TASK_TYPES_BY_ROLE_V2,
  executor: new Set(["executor.story_video"]),
};

const EXPECTED_ARTIFACTS_BY_ROLE_V1: Readonly<Record<A4DelegatedAgentRoleV1, ReadonlySet<string>>> = {
  writer: new Set([
    "writer.story_outline_proposal",
    "writer.script_draft_proposal",
    "writer.copy_draft_proposal",
  ]),
  storyboard: new Set([
    "storyboard.shot_list_proposal",
    "storyboard.continuity_proposal",
    "storyboard.canvas_layout_proposal",
  ]),
};

const EXPECTED_ARTIFACTS_BY_ROLE_V2: Readonly<Record<A4DelegatedAgentRoleV2, ReadonlySet<string>>> = {
  ...EXPECTED_ARTIFACTS_BY_ROLE_V1,
  visual: new Set([
    "visual.character_design_proposal",
    "visual.scene_design_proposal",
    "visual.prop_design_proposal",
    "visual.style_guide_proposal",
    "visual.asset_design_proposal",
  ]),
  reviewer: new Set(["reviewer.review_report"]),
};

const EXPECTED_ARTIFACTS_BY_ROLE_V3: Readonly<Record<A4DelegatedAgentRoleV3, ReadonlySet<string>>> = {
  ...EXPECTED_ARTIFACTS_BY_ROLE_V2,
  executor: new Set(["executor.story_video_plan"]),
};

export const AGENT_TASK_EXPECTED_ARTIFACT_BY_TASK_TYPE_V1 = Object.freeze({
  "writer.story_outline": "writer.story_outline_proposal",
  "writer.script_draft": "writer.script_draft_proposal",
  "writer.copy_draft": "writer.copy_draft_proposal",
  "storyboard.shot_plan": "storyboard.shot_list_proposal",
  "storyboard.continuity_plan": "storyboard.continuity_proposal",
  "storyboard.canvas_layout_plan": "storyboard.canvas_layout_proposal",
} as const satisfies Readonly<Record<
  (typeof AGENT_TASK_TYPES_V1)[number],
  (typeof AGENT_TASK_EXPECTED_ARTIFACT_TYPES_V1)[number]
>>);

export const AGENT_TASK_EXPECTED_ARTIFACT_BY_TASK_TYPE_V2 = Object.freeze({
  ...AGENT_TASK_EXPECTED_ARTIFACT_BY_TASK_TYPE_V1,
  "visual.character_design_plan": "visual.character_design_proposal",
  "visual.scene_design_plan": "visual.scene_design_proposal",
  "visual.prop_design_plan": "visual.prop_design_proposal",
  "visual.style_guide_plan": "visual.style_guide_proposal",
  "visual.asset_design_plan": "visual.asset_design_proposal",
  "reviewer.quality_review": "reviewer.review_report",
} as const satisfies Readonly<Record<
  (typeof AGENT_TASK_TYPES_V2)[number],
  (typeof AGENT_TASK_EXPECTED_ARTIFACT_TYPES_V2)[number]
>>);
export const AGENT_TASK_EXPECTED_ARTIFACT_BY_TASK_TYPE_V3 = Object.freeze({
  ...AGENT_TASK_EXPECTED_ARTIFACT_BY_TASK_TYPE_V2,
  "executor.story_video": "executor.story_video_plan",
} as const satisfies Readonly<Record<
  (typeof AGENT_TASK_TYPES_V3)[number],
  (typeof AGENT_TASK_EXPECTED_ARTIFACT_TYPES_V3)[number]
>>);
export const AGENT_TASK_EXPECTED_ARTIFACT_BY_TASK_TYPE =
  AGENT_TASK_EXPECTED_ARTIFACT_BY_TASK_TYPE_V3;

const INPUT_REF_TYPES_BY_ROLE_V1: Readonly<Record<A4DelegatedAgentRoleV1, ReadonlySet<string>>> = {
  writer: new Set(["project", "session", "script", "asset", "asset_version", "message"]),
  storyboard: new Set(AGENT_TASK_REF_TYPES),
};

const INPUT_REF_TYPES_BY_ROLE_V2: Readonly<Record<A4DelegatedAgentRoleV2, ReadonlySet<string>>> = {
  ...INPUT_REF_TYPES_BY_ROLE_V1,
  visual: new Set(["project", "session", "asset", "asset_version"]),
  reviewer: new Set(AGENT_TASK_REF_TYPES),
};

const INPUT_REF_TYPES_BY_ROLE_V3: Readonly<Record<A4DelegatedAgentRoleV3, ReadonlySet<string>>> = {
  ...INPUT_REF_TYPES_BY_ROLE_V2,
  executor: new Set(["project", "session", "asset", "asset_version", "storyboard", "message"]),
};

const WRITE_TARGET_TYPES_BY_ROLE_V1: Readonly<Record<A4DelegatedAgentRoleV1, ReadonlySet<string>>> = {
  writer: new Set(["script_draft"]),
  storyboard: new Set(["storyboard_draft", "canvas_draft"]),
};

const WRITE_TARGET_TYPES_BY_ROLE_V2: Readonly<Record<A4DelegatedAgentRoleV2, ReadonlySet<string>>> = {
  ...WRITE_TARGET_TYPES_BY_ROLE_V1,
  visual: new Set(["asset_design_draft"]),
  reviewer: new Set(["review_report"]),
};

const WRITE_TARGET_TYPES_BY_ROLE_V3: Readonly<Record<A4DelegatedAgentRoleV3, ReadonlySet<string>>> = {
  ...WRITE_TARGET_TYPES_BY_ROLE_V2,
  executor: new Set(["merged_video"]),
};

export const A4_DELEGATION_R0_TOOL_IDS_BY_ROLE_V1 = Object.freeze({
  writer: Object.freeze([
    "context.snapshot.get",
    "project.get",
    "session.get",
    "script.list",
    "script.get",
    "asset.search",
    "asset.get",
    "asset.version.list",
  ] as const satisfies readonly ToolId[]),
  storyboard: Object.freeze([
    "context.snapshot.get",
    "project.get",
    "session.get",
    "script.list",
    "script.get",
    "asset.search",
    "asset.get",
    "asset.version.list",
    "storyboard.list",
    "storyboard.get",
    "canvas.get",
  ] as const satisfies readonly ToolId[]),
} satisfies Readonly<Record<A4DelegatedAgentRoleV1, readonly ToolId[]>>);

export const A4_DELEGATION_R0_TOOL_IDS_BY_ROLE_V2 = Object.freeze({
  writer: A4_DELEGATION_R0_TOOL_IDS_BY_ROLE_V1.writer,
  visual: Object.freeze([
    "context.snapshot.get",
    "project.get",
    "session.get",
    "asset.search",
    "asset.get",
    "asset.version.list",
  ] as const satisfies readonly ToolId[]),
  storyboard: A4_DELEGATION_R0_TOOL_IDS_BY_ROLE_V1.storyboard,
  reviewer: A4_DELEGATION_R0_TOOL_IDS_BY_ROLE_V1.storyboard,
} satisfies Readonly<Record<A4DelegatedAgentRoleV2, readonly ToolId[]>>);

/**
 * V3 executor 确定性执行工具集：读工具 + 报价（R1）+ storyVideo 管线
 * R2 工具（generation.video.submit / video.merge / delivery.preview）。
 * 与 V1/V2 的 R0-only 集不同，executor 的每个 R2 调用仍必须通过
 * 独立审批 + Grant 消费（authorizeTool 原子链），集合本身不放宽任何
 * 运行时校验。
 */
export const A4_DELEGATION_R0_TOOL_IDS_BY_ROLE_V3 = Object.freeze({
  ...A4_DELEGATION_R0_TOOL_IDS_BY_ROLE_V2,
  executor: Object.freeze([
    "context.snapshot.get",
    "project.get",
    "session.get",
    "asset.get",
    "asset.version.list",
    "storyboard.list",
    "storyboard.get",
    "generation.quote",
    "generation.video.submit",
    "video.merge",
    "delivery.preview",
  ] as const satisfies readonly ToolId[]),
} satisfies Readonly<Record<A4DelegatedAgentRoleV3, readonly ToolId[]>>);
export const A4_DELEGATION_R0_TOOL_IDS_BY_ROLE = A4_DELEGATION_R0_TOOL_IDS_BY_ROLE_V3;

const parentAllowedTools = <TRole extends string>(
  roles: readonly TRole[],
  toolsByRole: Readonly<Record<TRole, readonly ToolId[]>>,
): readonly ToolId[] => Object.freeze(
  [...new Set<ToolId>(roles.flatMap((role) => [...toolsByRole[role]]))]
    .sort((left, right) => left.localeCompare(right)),
);

const A4_DELEGATION_PARENT_ALLOWED_TOOLS_V1 = parentAllowedTools(
  A4_DELEGATED_AGENT_ROLES_V1,
  A4_DELEGATION_R0_TOOL_IDS_BY_ROLE_V1,
);
const A4_DELEGATION_PARENT_ALLOWED_TOOLS_V2 = parentAllowedTools(
  A4_DELEGATED_AGENT_ROLES_V2,
  A4_DELEGATION_R0_TOOL_IDS_BY_ROLE_V2,
);
const A4_DELEGATION_PARENT_ALLOWED_TOOLS_V3 = parentAllowedTools(
  A4_DELEGATED_AGENT_ROLES_V3,
  A4_DELEGATION_R0_TOOL_IDS_BY_ROLE_V3,
);

function createParentPolicySnapshot(allowedTools: readonly ToolId[]) {
  return Object.freeze({
    // Parent policy format itself did not change: Visual reads are a subset of
    // Writer reads and Reviewer reads equal Storyboard reads.
    version: 1,
    scopeMode: "task_refs",
    allowedTools,
    resourceScope: Object.freeze({}),
    limits: Object.freeze({
      maxToolCalls: 8,
      maxItems: 100,
      maxOutputCount: 1,
      maxDurationSeconds: 300,
    }),
    spend: Object.freeze({
      currency: "GU",
      maxEstimatedMicros: 0,
      maxActualMicros: 0,
    }),
  } as const);
}

/**
 * V3（Prompt v10 / executor）父策略快照：allowedTools 并集新增 executor 的
 * 确定性执行工具集；limits 放宽到 storyVideo 管线上限（12 场景 → 12 段
 * submit + quote + merge + preview）；spend 上限语义改为"跟随父 Run 剩余
 * 预算"——Grant 签发时由 delegationGrantService 以父 Run
 * spendLimitMicros - actualSpendMicros 做最终钳制，快照值本身不再是零。
 */
function createParentPolicySnapshotV3(allowedTools: readonly ToolId[]) {
  return Object.freeze({
    version: 2,
    scopeMode: "task_refs",
    allowedTools,
    resourceScope: Object.freeze({}),
    limits: Object.freeze({
      maxToolCalls: 40,
      maxItems: 100,
      maxOutputCount: 13,
      maxDurationSeconds: 7_200,
    }),
    spend: Object.freeze({
      currency: "GU",
      maxEstimatedMicros: Number.MAX_SAFE_INTEGER,
      maxActualMicros: Number.MAX_SAFE_INTEGER,
    }),
  } as const);
}

/** Prompt v4 parent policy. Empty resourceScope remains intentionally fail-closed. */
export const A4_DELEGATION_PARENT_POLICY_SNAPSHOT_V1 = createParentPolicySnapshot(
  A4_DELEGATION_PARENT_ALLOWED_TOOLS_V1,
);
/** Prompt v5 parent policy; separately selected even though its canonical bytes match V1. */
export const A4_DELEGATION_PARENT_POLICY_SNAPSHOT_V2 = createParentPolicySnapshot(
  A4_DELEGATION_PARENT_ALLOWED_TOOLS_V2,
);
/** Prompt v10（executor）parent policy。 */
export const A4_DELEGATION_PARENT_POLICY_SNAPSHOT_V3 = createParentPolicySnapshotV3(
  A4_DELEGATION_PARENT_ALLOWED_TOOLS_V3,
);
export const A4_DELEGATION_PARENT_POLICY_SNAPSHOT = A4_DELEGATION_PARENT_POLICY_SNAPSHOT_V3;
export type A4DelegationParentPolicySnapshotV1 =
  typeof A4_DELEGATION_PARENT_POLICY_SNAPSHOT_V1;
export type A4DelegationParentPolicySnapshotV2 =
  typeof A4_DELEGATION_PARENT_POLICY_SNAPSHOT_V2;
export type A4DelegationParentPolicySnapshotV3 =
  typeof A4_DELEGATION_PARENT_POLICY_SNAPSHOT_V3;
export type A4DelegationParentPolicySnapshot = A4DelegationParentPolicySnapshotV3;

function fail(code: AgentDelegationContractErrorCode): never {
  throw new AgentDelegationContractError(code);
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function normalizeRefs(refs: readonly AgentTaskRef[]): AgentTaskRef[] {
  const byIdentity = new Set<string>();
  const normalized = refs.map((ref) => {
    const identity = `${ref.type}\u0000${ref.id}`;
    if (byIdentity.has(identity)) fail("agent_task_ref_duplicate");
    byIdentity.add(identity);
    return { type: ref.type, id: ref.id, version: ref.version };
  });
  return normalized.sort((left, right) => (
    left.type.localeCompare(right.type)
    || left.id.localeCompare(right.id)
    || String(left.version ?? "").localeCompare(String(right.version ?? ""))
  ));
}

function normalizeWriteTargets<TTarget extends AnyAgentTaskWriteTarget>(
  targets: readonly TTarget[],
): TTarget[] {
  const identities = new Set<string>();
  const normalized = targets.map((target) => {
    const identity = `${target.type}:${target.id}`;
    if (identities.has(identity)) fail("agent_task_write_target_duplicate");
    identities.add(identity);
    return { type: target.type, id: target.id } as TTarget;
  });
  return normalized.sort((left, right) => (
    `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`)
  ));
}

function normalizeConstraints(constraints: AgentTaskConstraints): AgentTaskConstraints {
  return {
    language: constraints.language,
    tone: constraints.tone,
    outputFormat: "structured_proposal",
    maxCharacters: constraints.maxCharacters,
    targetDurationSeconds: constraints.targetDurationSeconds,
    aspectRatio: constraints.aspectRatio,
    mustInclude: uniqueSortedStrings(constraints.mustInclude),
    mustAvoid: uniqueSortedStrings(constraints.mustAvoid),
    notes: uniqueSortedStrings(constraints.notes),
  };
}

export function agentTaskWriteTargetKey(input: AnyAgentTaskWriteTarget): string {
  const target = agentTaskWriteTargetSchemaV3.safeParse(input);
  if (!target.success) fail("agent_task_invalid");
  return `${target.data.type}:${target.data.id}`;
}

export interface NormalizeAgentTaskOptions {
  expectedProjectId?: number;
}

function assertProjectScope(task: Pick<AnyAgentTask, "projectId">, inputRefs: AgentTaskRef[], options: NormalizeAgentTaskOptions) {
  if (options.expectedProjectId !== undefined
    && (!Number.isSafeInteger(options.expectedProjectId)
      || options.expectedProjectId <= 0
      || task.projectId !== options.expectedProjectId)) {
    fail("agent_task_project_scope_invalid");
  }
  const projectRefs = inputRefs.filter((ref) => ref.type === "project");
  if (projectRefs.length !== 1 || projectRefs[0].id !== String(task.projectId)) {
    fail("agent_task_project_scope_invalid");
  }
}

export function normalizeAgentTaskV1(
  input: unknown,
  options: NormalizeAgentTaskOptions = {},
): AgentTaskV1 {
  const parsed = agentTaskSchemaV1.safeParse(input);
  if (!parsed.success) fail("agent_task_invalid");
  const task = parsed.data;
  const inputRefs = normalizeRefs(task.inputRefs);
  const writeTargets = normalizeWriteTargets(task.writeTargets);
  assertProjectScope(task, inputRefs, options);
  if (!TASK_TYPES_BY_ROLE_V1[task.role].has(task.taskType)
    || task.expectedArtifacts.some((item) => !EXPECTED_ARTIFACTS_BY_ROLE_V1[task.role].has(item))
    || inputRefs.some((ref) => !INPUT_REF_TYPES_BY_ROLE_V1[task.role].has(ref.type))
    || writeTargets.some((target) => !WRITE_TARGET_TYPES_BY_ROLE_V1[task.role].has(target.type))) {
    fail("agent_task_role_scope_invalid");
  }
  return {
    version: AGENT_TASK_VERSION_V1,
    role: task.role,
    projectId: task.projectId,
    taskType: task.taskType,
    objective: task.objective,
    inputRefs,
    constraints: normalizeConstraints(task.constraints),
    expectedArtifacts: uniqueSortedStrings(task.expectedArtifacts) as AgentTaskV1["expectedArtifacts"],
    qualityCriteria: uniqueSortedStrings(task.qualityCriteria),
    writeTargets,
  };
}

export function normalizeAgentTaskV2(
  input: unknown,
  options: NormalizeAgentTaskOptions = {},
): AgentTaskV2 {
  const parsed = agentTaskSchemaV2.safeParse(input);
  if (!parsed.success) fail("agent_task_invalid");
  const task = parsed.data;
  const inputRefs = normalizeRefs(task.inputRefs);
  const writeTargets = normalizeWriteTargets(task.writeTargets);
  assertProjectScope(task, inputRefs, options);
  if (!TASK_TYPES_BY_ROLE_V2[task.role].has(task.taskType)
    || task.expectedArtifacts.some((item) => !EXPECTED_ARTIFACTS_BY_ROLE_V2[task.role].has(item))
    || task.expectedArtifacts[0] !== AGENT_TASK_EXPECTED_ARTIFACT_BY_TASK_TYPE_V2[task.taskType]
    || inputRefs.some((ref) => !INPUT_REF_TYPES_BY_ROLE_V2[task.role].has(ref.type))
    || writeTargets.some((target) => !WRITE_TARGET_TYPES_BY_ROLE_V2[task.role].has(target.type))) {
    fail("agent_task_role_scope_invalid");
  }
  return {
    version: AGENT_TASK_VERSION_V2,
    role: task.role,
    projectId: task.projectId,
    taskType: task.taskType,
    objective: task.objective,
    inputRefs,
    constraints: normalizeConstraints(task.constraints),
    expectedArtifacts: uniqueSortedStrings(task.expectedArtifacts) as AgentTaskV2["expectedArtifacts"],
    qualityCriteria: uniqueSortedStrings(task.qualityCriteria),
    writeTargets,
  };
}

/**
 * Explicit latest normalizer for newly admitted Runs. Executor tasks resolve
 * to V3; writer/visual/storyboard/reviewer proposals keep the immutable V2
 * shape (the v10 persistence contract routes the same way). The version
 * field is injected per branch, mirroring the persistence contracts.
 */
export function normalizeAgentTaskLatest(
  input: unknown,
  options: NormalizeAgentTaskOptions = {},
): AnyAgentTask {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
  if (record?.role === "executor") {
    return normalizeAgentTaskV3({ ...record, version: AGENT_TASK_VERSION_V3 }, options);
  }
  return normalizeAgentTaskV2({ ...(record ?? {}), version: AGENT_TASK_VERSION_V2 }, options);
}

export function normalizeAgentTaskV3(
  input: unknown,
  options: NormalizeAgentTaskOptions = {},
): AgentTaskV3 {
  const parsed = agentTaskSchemaV3.safeParse(input);
  if (!parsed.success) fail("agent_task_invalid");
  const task = parsed.data;
  const inputRefs = normalizeRefs(task.inputRefs);
  const writeTargets = normalizeWriteTargets(task.writeTargets);
  assertProjectScope(task, inputRefs, options);
  if (!TASK_TYPES_BY_ROLE_V3.executor.has(task.taskType)
    || task.expectedArtifacts[0] !== AGENT_TASK_EXPECTED_ARTIFACT_BY_TASK_TYPE_V3[task.taskType]
    || inputRefs.some((ref) => !INPUT_REF_TYPES_BY_ROLE_V3.executor.has(ref.type))
    || writeTargets.some((target) => !WRITE_TARGET_TYPES_BY_ROLE_V3.executor.has(target.type))) {
    fail("agent_task_role_scope_invalid");
  }
  return {
    version: AGENT_TASK_VERSION_V3,
    role: "executor",
    projectId: task.projectId,
    taskType: task.taskType,
    objective: task.objective,
    inputRefs,
    constraints: normalizeConstraints(task.constraints),
    expectedArtifacts: [task.expectedArtifacts[0]],
    qualityCriteria: uniqueSortedStrings(task.qualityCriteria),
    writeTargets,
    executionSpec: task.executionSpec,
  };
}

export function normalizeAgentTaskForVersion(
  version: unknown,
  input: unknown,
  options: NormalizeAgentTaskOptions = {},
): AnyAgentTask {
  if (version === AGENT_TASK_VERSION_V1) return normalizeAgentTaskV1(input, options);
  if (version === AGENT_TASK_VERSION_V2) return normalizeAgentTaskV2(input, options);
  if (version === AGENT_TASK_VERSION_V3) return normalizeAgentTaskV3(input, options);
  fail("agent_task_invalid");
}

export function normalizeAgentTaskByVersion(
  input: unknown,
  options: NormalizeAgentTaskOptions = {},
): AnyAgentTask {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("agent_task_invalid");
  return normalizeAgentTaskForVersion((input as Record<string, unknown>).version, input, options);
}

/** Compatibility router; persisted input.version is authoritative. */
export function normalizeAgentTask(
  input: unknown,
  options: NormalizeAgentTaskOptions = {},
): AnyAgentTask {
  return normalizeAgentTaskByVersion(input, options);
}

function normalizeArtifactRefs(
  refs: readonly AgentTaskResultArtifactRef[],
): AgentTaskResultArtifactRef[] {
  const ids = new Set<string>();
  const normalized = refs.map((ref) => {
    if (ids.has(ref.id)) fail("agent_task_result_invalid");
    ids.add(ref.id);
    return { type: "message" as const, id: ref.id, version: null };
  });
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

function assertResultEvidence(result: AnyAgentTaskResult): void {
  const hasArtifacts = result.artifactRefs.length > 0;
  if ((result.status === "succeeded" && !hasArtifacts)
    || (result.status !== "succeeded" && hasArtifacts)
    || (result.status === "failed" && result.issues.length === 0)
    || (result.status === "needs_input" && result.suggestedNextActions.length === 0)) {
    fail("agent_task_result_invalid");
  }
}

export function normalizeAgentTaskResultV1(input: unknown): AgentTaskResultV1 {
  const parsed = agentTaskResultSchemaV1.safeParse(input);
  if (!parsed.success) fail("agent_task_result_invalid");
  const result = parsed.data;
  assertResultEvidence(result);
  return {
    version: AGENT_TASK_RESULT_VERSION_V1,
    status: result.status,
    artifactRefs: normalizeArtifactRefs(result.artifactRefs),
    summary: result.summary,
    assumptions: uniqueSortedStrings(result.assumptions),
    issues: uniqueSortedStrings(result.issues),
    suggestedNextActions: uniqueSortedStrings(result.suggestedNextActions),
    usage: { ...result.usage },
  };
}

export interface NormalizeAgentTaskResultV2Options {
  expectedRole?: A4DelegatedAgentRoleV2;
}

export function normalizeAgentTaskResultV2(
  input: unknown,
  options: NormalizeAgentTaskResultV2Options = {},
): AgentTaskResultV2 {
  const parsed = agentTaskResultSchemaV2.safeParse(input);
  if (!parsed.success) fail("agent_task_result_invalid");
  const result = parsed.data;
  assertResultEvidence(result);
  if ((result.status !== "succeeded" && result.review !== undefined)
    || (options.expectedRole === "reviewer"
      && result.status === "succeeded"
      && result.review === undefined)
    || (options.expectedRole !== undefined
      && options.expectedRole !== "reviewer"
      && result.review !== undefined)) {
    fail("agent_task_result_invalid");
  }
  return {
    version: AGENT_TASK_RESULT_VERSION_V2,
    status: result.status,
    artifactRefs: normalizeArtifactRefs(result.artifactRefs),
    summary: result.summary,
    assumptions: uniqueSortedStrings(result.assumptions),
    issues: uniqueSortedStrings(result.issues),
    suggestedNextActions: uniqueSortedStrings(result.suggestedNextActions),
    usage: { ...result.usage },
    ...(result.review === undefined ? {} : { review: { ...result.review } }),
  };
}

/** Explicit latest normalizer for newly admitted Runs. */
export interface NormalizeAgentTaskResultV3Options {
  expectedRole?: A4DelegatedAgentRoleV3;
}

export function normalizeAgentTaskResultV3(
  input: unknown,
  options: NormalizeAgentTaskResultV3Options = {},
): AgentTaskResultV3 {
  const parsed = agentTaskResultSchemaV3.safeParse(input);
  if (!parsed.success) fail("agent_task_result_invalid");
  const result = parsed.data;
  assertResultEvidence(result);
  if (options.expectedRole !== undefined && options.expectedRole !== "executor") {
    fail("agent_task_result_invalid");
  }
  return {
    version: AGENT_TASK_RESULT_VERSION_V3,
    status: result.status,
    artifactRefs: normalizeArtifactRefs(result.artifactRefs),
    summary: result.summary,
    assumptions: uniqueSortedStrings(result.assumptions),
    issues: uniqueSortedStrings(result.issues),
    suggestedNextActions: uniqueSortedStrings(result.suggestedNextActions),
    usage: { ...result.usage },
  };
}

export const normalizeAgentTaskResultLatest = normalizeAgentTaskResultV3;

export function normalizeAgentTaskResultForVersion(
  version: unknown,
  input: unknown,
  options: NormalizeAgentTaskResultV3Options = {},
): AnyAgentTaskResult {
  if (version === AGENT_TASK_RESULT_VERSION_V1) return normalizeAgentTaskResultV1(input);
  if (version === AGENT_TASK_RESULT_VERSION_V2) {
    const { expectedRole } = options;
    if (expectedRole === "executor") fail("agent_task_result_invalid");
    return normalizeAgentTaskResultV2(input, { expectedRole });
  }
  if (version === AGENT_TASK_RESULT_VERSION_V3) return normalizeAgentTaskResultV3(input, options);
  fail("agent_task_result_invalid");
}

export function normalizeAgentTaskResultByVersion(
  input: unknown,
  options: NormalizeAgentTaskResultV3Options = {},
): AnyAgentTaskResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("agent_task_result_invalid");
  return normalizeAgentTaskResultForVersion(
    (input as Record<string, unknown>).version,
    input,
    options,
  );
}

/** Compatibility router; persisted input.version is authoritative. */
export function normalizeAgentTaskResult(
  input: unknown,
  options: NormalizeAgentTaskResultV3Options = {},
): AnyAgentTaskResult {
  return normalizeAgentTaskResultByVersion(input, options);
}

export function normalizeAgentTaskStatus(value: unknown): AgentTaskStatus {
  if (typeof value !== "string" || !(AGENT_TASK_STATUSES as readonly string[]).includes(value)) {
    fail("agent_task_status_invalid");
  }
  return value as AgentTaskStatus;
}

export function isTerminalAgentTaskStatus(value: AgentTaskStatus): boolean {
  return (TERMINAL_AGENT_TASK_STATUSES as readonly AgentTaskStatus[]).includes(value);
}

const AGENT_TASK_STATUS_TRANSITIONS: Readonly<Record<AgentTaskStatus, readonly AgentTaskStatus[]>> = {
  queued: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "needs_input", "cancelled"],
  succeeded: [],
  failed: [],
  needs_input: [],
  cancelled: [],
};

export function assertAgentTaskStatusTransition(from: unknown, to: unknown): void {
  const current = normalizeAgentTaskStatus(from);
  const next = normalizeAgentTaskStatus(to);
  if (!AGENT_TASK_STATUS_TRANSITIONS[current].includes(next)) {
    fail("agent_task_status_transition_invalid");
  }
}

export function getA4DelegationR0ToolIdsV1(role: A4DelegatedAgentRoleV1): readonly ToolId[] {
  if (!(A4_DELEGATED_AGENT_ROLES_V1 as readonly string[]).includes(role)) {
    fail("agent_task_role_scope_invalid");
  }
  return A4_DELEGATION_R0_TOOL_IDS_BY_ROLE_V1[role];
}

export function getA4DelegationR0ToolIdsV2(role: A4DelegatedAgentRoleV2): readonly ToolId[] {
  if (!(A4_DELEGATED_AGENT_ROLES_V2 as readonly string[]).includes(role)) {
    fail("agent_task_role_scope_invalid");
  }
  return A4_DELEGATION_R0_TOOL_IDS_BY_ROLE_V2[role];
}

export function getA4DelegationR0ToolIdsV3(role: A4DelegatedAgentRoleV3): readonly ToolId[] {
  if (!(A4_DELEGATED_AGENT_ROLES_V3 as readonly string[]).includes(role)) {
    fail("agent_task_role_scope_invalid");
  }
  return A4_DELEGATION_R0_TOOL_IDS_BY_ROLE_V3[role];
}

/** Latest helper for newly admitted Runs. */
export const getA4DelegationR0ToolIds = getA4DelegationR0ToolIdsV3;
