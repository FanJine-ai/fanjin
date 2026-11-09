import { z } from "zod";
import {
  A4_DELEGATED_AGENT_ROLES_V1,
  A4_DELEGATED_AGENT_ROLES_V2,
  A4_DELEGATED_AGENT_ROLES_V3,
  A4_DELEGATION_PARENT_POLICY_SNAPSHOT_V1,
  A4_DELEGATION_PARENT_POLICY_SNAPSHOT_V2,
  A4_DELEGATION_PARENT_POLICY_SNAPSHOT_V3,
  AGENT_TASK_EXPECTED_ARTIFACT_BY_TASK_TYPE_V2,
  AGENT_TASK_EXPECTED_ARTIFACT_BY_TASK_TYPE_V3,
  AGENT_TASK_EXPECTED_ARTIFACT_TYPES_V1,
  AGENT_TASK_EXPECTED_ARTIFACT_TYPES_V2,
  AGENT_TASK_EXPECTED_ARTIFACT_TYPES_V3,
  AGENT_TASK_RESULT_STATUSES,
  AGENT_TASK_RESULT_VERSION_V1,
  AGENT_TASK_RESULT_VERSION_V2,
  AGENT_TASK_RESULT_VERSION_V3,
  AGENT_TASK_TYPES_V1,
  AGENT_TASK_TYPES_V2,
  AGENT_TASK_TYPES_V3,
  AGENT_TASK_VERSION_V1,
  AGENT_TASK_VERSION_V2,
  AGENT_TASK_VERSION_V3,
  agentTaskConstraintsSchema,
  agentTaskRefSchema,
  agentTaskResultArtifactRefSchema,
  agentTaskResultSchemaV1,
  agentTaskResultSchemaV2,
  agentTaskResultSchemaV3,
  agentTaskSchemaV1,
  agentTaskSchemaV2,
  agentTaskSchemaV3,
  getA4DelegationR0ToolIdsV1,
  getA4DelegationR0ToolIdsV2,
  getA4DelegationR0ToolIdsV3,
  normalizeAgentTaskResultV1,
  normalizeAgentTaskResultV2,
  normalizeAgentTaskResultV3,
  normalizeAgentTaskResultForVersion,
  normalizeAgentTaskV1,
  normalizeAgentTaskV2,
  normalizeAgentTaskV3,
  type A4DelegatedAgentRoleV2,
  type A4DelegatedAgentRoleV3,
  type NormalizeAgentTaskResultV3Options,
} from "@/agent-runtime/delegationContracts";
import {
  A4_DELEGATED_RUN_POLICY_VERSION_V1,
  A4_DELEGATED_RUN_POLICY_VERSION_V2,
  A4_DELEGATED_RUN_POLICY_VERSION_V3,
  createA4DelegatedRunPolicySnapshotV1,
  createA4DelegatedRunPolicySnapshotV2,
  createA4DelegatedRunPolicySnapshotV3,
  parseA4DelegatedRunPolicySnapshot,
  parseA4DelegatedRunPolicySnapshotV1,
  parseA4DelegatedRunPolicySnapshotV2,
  parseA4DelegatedRunPolicySnapshotV3,
  type CreateA4DelegatedRunPolicyInputV1,
  type CreateA4DelegatedRunPolicyInputV2,
  type CreateA4DelegatedRunPolicyInputV3,
  type ParseA4DelegatedRunPolicyOptionsV1,
  type ParseA4DelegatedRunPolicyOptionsV2,
  type ParseA4DelegatedRunPolicyOptionsV3,
} from "@/agent-runtime/delegatedRunPolicy";
import { storyVideoPipelineSpecSchema } from "@/agent-runtime/executionSpec";
import {
  AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION,
  AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION_V4,
  AGENT_MAIN_EXECUTOR_DELEGATION_TOOLS_PROMPT_VERSION,
} from "@/agent-runtime/runtimeConfigRegistry";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import { defineAgentTool } from "@/agent-runtime/tools/registry";

export const AGENT_DELEGATE_ROLES_V4 = A4_DELEGATED_AGENT_ROLES_V1;
export const AGENT_DELEGATE_TASK_TYPES_V4 = AGENT_TASK_TYPES_V1;
export const AGENT_DELEGATE_EXPECTED_ARTIFACT_TYPES_V4 =
  AGENT_TASK_EXPECTED_ARTIFACT_TYPES_V1;

const INPUT_REF_TYPES_BY_ROLE: Readonly<Record<A4DelegatedAgentRoleV3, ReadonlySet<string>>> = {
  writer: new Set(["project", "session", "script", "asset", "asset_version", "message"]),
  visual: new Set(["project", "session", "asset", "asset_version"]),
  storyboard: new Set([
    "project",
    "session",
    "script",
    "asset",
    "asset_version",
    "storyboard",
    "canvas",
    "message",
  ]),
  executor: new Set(["project", "session", "asset", "asset_version", "storyboard", "message"]),
  reviewer: new Set([
    "project",
    "session",
    "script",
    "asset",
    "asset_version",
    "storyboard",
    "canvas",
    "message",
  ]),
};

export const AGENT_DELEGATION_COMPACT_LIMITS = Object.freeze({
  summaryCharacters: 1_000,
  listItems: 4,
  listItemCharacters: 250,
  maxUtf8Bytes: 64 * 1_024,
});

const COMPACT_TEXT_NUL_PATTERN = /\u0000/;
const compactText = (max: number) => z.string().trim().min(1).max(max).refine(
  (value) => !COMPACT_TEXT_NUL_PATTERN.test(value),
);
const compactTextList = z.array(compactText(AGENT_DELEGATION_COMPACT_LIMITS.listItemCharacters))
  .max(AGENT_DELEGATION_COMPACT_LIMITS.listItems);

/**
 * Model-visible request only. Identity, project scope, write targets, Grants,
 * Approvals and every Runtime binding are derived by the Controller.
 */
function refineAgentDelegateTask(
  task: {
    role: string;
    taskType: string;
    inputRefs: z.infer<typeof agentTaskRefSchema>[];
    expectedArtifacts: string[];
    executionSpec?: unknown;
  },
  context: z.core.$RefinementCtx,
  options: {
    exactArtifact: boolean;
    artifactByTaskType?: Readonly<Record<string, string>>;
    /** V10：executor 任务必须内嵌 executionSpec，非 executor 任务必须为 null。 */
    requireExecutionSpecForExecutor?: boolean;
  },
): void {
  if (!task.taskType.startsWith(`${task.role}.`)) {
    context.addIssue({
      code: "custom",
      path: ["taskType"],
      message: "taskType 与专项角色不匹配",
      input: task.taskType,
    });
  }
  const artifactByTaskType = options.artifactByTaskType ?? AGENT_TASK_EXPECTED_ARTIFACT_BY_TASK_TYPE_V2;
  task.expectedArtifacts.forEach((artifact, index) => {
    const expected = (artifactByTaskType as Readonly<Record<string, string>>)[task.taskType];
    const valid = options.exactArtifact
      ? artifact === expected
      : artifact.startsWith(`${task.role}.`);
    if (!valid) {
      context.addIssue({
        code: "custom",
        path: ["expectedArtifacts", index],
        message: options.exactArtifact
          ? "expectedArtifact 与专项任务不匹配"
          : "expectedArtifact 与专项角色不匹配",
        input: artifact,
      });
    }
  });

  if (options.requireExecutionSpecForExecutor) {
    if (task.role === "executor" && task.executionSpec == null) {
      context.addIssue({
        code: "custom",
        path: ["executionSpec"],
        message: "executor 任务必须内嵌 storyVideo 管线 executionSpec",
      });
    }
    if (task.role !== "executor" && task.executionSpec != null) {
      context.addIssue({
        code: "custom",
        path: ["executionSpec"],
        message: "非 executor 任务不得携带 executionSpec",
      });
    }
  }

  const roleRefTypes = INPUT_REF_TYPES_BY_ROLE[task.role as A4DelegatedAgentRoleV3];
  const refs = new Set<string>();
  task.inputRefs.forEach((ref, index) => {
    if (!roleRefTypes?.has(ref.type)) {
      context.addIssue({
        code: "custom",
        path: ["inputRefs", index, "type"],
        message: "对象引用超出专项角色只读范围",
        input: ref.type,
      });
    }
    const identity = `${ref.type}\u0000${ref.id}`;
    if (refs.has(identity)) {
      context.addIssue({
        code: "custom",
        path: ["inputRefs", index],
        message: "对象引用重复或版本歧义",
        input: ref,
      });
    }
    refs.add(identity);
  });
}

/** Immutable writer/storyboard-only input understood by main Prompt v4. */
export const agentDelegateTaskInputSchemaV4 = z.object({
  role: z.enum(AGENT_DELEGATE_ROLES_V4),
  taskType: z.enum(AGENT_DELEGATE_TASK_TYPES_V4),
  objective: agentTaskSchemaV1.shape.objective,
  inputRefs: z.array(agentTaskRefSchema).max(50),
  constraints: agentTaskConstraintsSchema,
  expectedArtifacts: z.array(z.enum(AGENT_DELEGATE_EXPECTED_ARTIFACT_TYPES_V4)).min(1).max(6),
  qualityCriteria: agentTaskSchemaV1.shape.qualityCriteria,
}).strict().superRefine((task, context) => refineAgentDelegateTask(
  task,
  context,
  { exactArtifact: false },
));
export type AgentDelegateTaskInputV4 = z.infer<typeof agentDelegateTaskInputSchemaV4>;

/** Current v5 input; Visual and Reviewer exist only in this version. */
export const agentDelegateTaskInputSchemaV5 = z.object({
  role: z.enum(A4_DELEGATED_AGENT_ROLES_V2),
  taskType: z.enum(AGENT_TASK_TYPES_V2),
  objective: agentTaskSchemaV2.shape.objective,
  // The Controller injects the current project ref/revision before persistence.
  inputRefs: z.array(agentTaskRefSchema).max(50),
  constraints: agentTaskConstraintsSchema,
  expectedArtifacts: z.array(z.enum(AGENT_TASK_EXPECTED_ARTIFACT_TYPES_V2)).length(1),
  qualityCriteria: agentTaskSchemaV2.shape.qualityCriteria,
}).strict().superRefine((task, context) => refineAgentDelegateTask(
  task,
  context,
  { exactArtifact: true },
));
export type AgentDelegateTaskInputV5 = z.infer<typeof agentDelegateTaskInputSchemaV5>;

/**
 * v10 input（main Prompt v10 / Executor V3）：在 v5 五角色之上新增 executor。
 * executor 任务必须内嵌 storyVideo 管线 executionSpec（服务端按
 * storyVideoPipelineSpecSchema 严格校验：帧数=场景数+1、资产版本不重复等），
 * 且每次委派最多一个 executor 任务。
 */
export const agentDelegateTaskInputSchemaV10 = z.object({
  role: z.enum(A4_DELEGATED_AGENT_ROLES_V3),
  taskType: z.enum(AGENT_TASK_TYPES_V3),
  objective: agentTaskSchemaV2.shape.objective,
  // The Controller injects the current project ref/revision before persistence.
  inputRefs: z.array(agentTaskRefSchema).max(50),
  constraints: agentTaskConstraintsSchema,
  expectedArtifacts: z.array(z.enum(AGENT_TASK_EXPECTED_ARTIFACT_TYPES_V3)).length(1),
  qualityCriteria: agentTaskSchemaV2.shape.qualityCriteria,
  /** executor 任务必填；非 executor 任务必须显式 null（strict schema 禁止 optional）。 */
  executionSpec: storyVideoPipelineSpecSchema.nullable(),
}).strict().superRefine((task, context) => refineAgentDelegateTask(
  task,
  context,
  {
    exactArtifact: true,
    artifactByTaskType: AGENT_TASK_EXPECTED_ARTIFACT_BY_TASK_TYPE_V3,
    requireExecutionSpecForExecutor: true,
  },
));
export type AgentDelegateTaskInputV10 = z.infer<typeof agentDelegateTaskInputSchemaV10>;
export type AnyAgentDelegateTaskInput =
  | AgentDelegateTaskInputV4
  | AgentDelegateTaskInputV5
  | AgentDelegateTaskInputV10;
export const agentDelegateTaskInputSchema = agentDelegateTaskInputSchemaV10;
export type AgentDelegateTaskInput = AnyAgentDelegateTaskInput;
export type AgentDelegateTaskInputLatest = AgentDelegateTaskInputV10;

export const agentDelegateInputSchemaV4 = z.object({
  tasks: z.array(agentDelegateTaskInputSchemaV4).min(1).max(3),
}).strict();
export const agentDelegateInputSchemaV5 = z.object({
  tasks: z.array(agentDelegateTaskInputSchemaV5).min(1).max(3),
}).strict();
export const agentDelegateInputSchemaV10 = z.object({
  tasks: z.array(agentDelegateTaskInputSchemaV10).min(1).max(3),
}).strict().superRefine((input, context) => {
  const executorTasks = input.tasks.filter((task) => task.role === "executor");
  if (executorTasks.length > 1) {
    context.addIssue({
      code: "custom",
      path: ["tasks"],
      message: "一次委派最多包含一个 executor 任务",
    });
  }
});
export type AgentDelegateInputV4 = z.infer<typeof agentDelegateInputSchemaV4>;
export type AgentDelegateInputV5 = z.infer<typeof agentDelegateInputSchemaV5>;
export type AgentDelegateInputV10 = z.infer<typeof agentDelegateInputSchemaV10>;
export type AnyAgentDelegateInput =
  | AgentDelegateInputV4
  | AgentDelegateInputV5
  | AgentDelegateInputV10;
export const agentDelegateInputSchema = agentDelegateInputSchemaV10;
export type AgentDelegateInput = AnyAgentDelegateInput;
export type AgentDelegateInputLatest = AgentDelegateInputV10;

/** Safe checkpoint receipt written by the Controller before it pauses the parent Run. */
export const agentDelegateWaitingOutputSchema = z.object({
  status: z.literal("waiting_delegation"),
  waitType: z.literal("delegation"),
  delegationStepId: z.string().trim().min(1).max(200),
  acceptedTaskCount: z.number().int().min(1).max(3),
  childRunIds: z.array(z.string().trim().min(1).max(200)).min(1).max(3),
}).strict().superRefine((output, context) => {
  if (output.acceptedTaskCount !== output.childRunIds.length) {
    context.addIssue({
      code: "custom",
      path: ["acceptedTaskCount"],
      message: "acceptedTaskCount 必须与 childRunIds 数量一致",
    });
  }
  if (new Set(output.childRunIds).size !== output.childRunIds.length) {
    context.addIssue({
      code: "custom",
      path: ["childRunIds"],
      message: "childRunIds 不能重复",
    });
  }
});
export type AgentDelegateWaitingOutput = z.infer<typeof agentDelegateWaitingOutputSchema>;

const compactResultBaseShape = {
  childRunId: z.string().trim().min(1).max(200),
  status: z.enum(AGENT_TASK_RESULT_STATUSES),
  summary: compactText(AGENT_DELEGATION_COMPACT_LIMITS.summaryCharacters),
  assumptions: compactTextList,
  issues: compactTextList,
  suggestedNextActions: compactTextList,
  artifactRefs: z.array(agentTaskResultArtifactRefSchema).max(1),
  internalMessageRef: agentTaskResultArtifactRefSchema,
};

export const agentDelegationCompactResultSchemaV1 = z.object({
  ...compactResultBaseShape,
  role: z.enum(A4_DELEGATED_AGENT_ROLES_V1),
  taskType: z.enum(AGENT_TASK_TYPES_V1),
}).strict().superRefine((result, context) => {
  if (!result.taskType.startsWith(`${result.role}.`)) {
    context.addIssue({
      code: "custom",
      path: ["taskType"],
      message: "taskType 与专项角色不匹配",
    });
  }
});
export type AgentDelegationCompactResultV1 = z.infer<
  typeof agentDelegationCompactResultSchemaV1
> & { review?: never };

export const agentDelegationCompactResultSchemaV2 = z.object({
  ...compactResultBaseShape,
  role: z.enum(A4_DELEGATED_AGENT_ROLES_V2),
  taskType: z.enum(AGENT_TASK_TYPES_V2),
  review: z.object({
    verdict: z.enum(["pass", "pass_with_findings", "revise", "block"]),
    reportDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
}).strict().superRefine((result, context) => {
  if (!result.taskType.startsWith(`${result.role}.`)) {
    context.addIssue({
      code: "custom",
      path: ["taskType"],
      message: "taskType 与专项角色不匹配",
    });
  }
  const reviewBindingValid = result.role === "reviewer"
    ? (result.status === "succeeded" ? result.review !== undefined : result.review === undefined)
    : result.review === undefined;
  if (!reviewBindingValid) {
    context.addIssue({
      code: "custom",
      path: ["review"],
      message: "review 摘要与专项角色或终态不匹配",
    });
  }
});
export type AgentDelegationCompactResultV2 = z.infer<
  typeof agentDelegationCompactResultSchemaV2
>;

/** V3（executor）compact result：role 集合含 executor，永不携带 review。 */
export const agentDelegationCompactResultSchemaV3 = z.object({
  ...compactResultBaseShape,
  role: z.enum(A4_DELEGATED_AGENT_ROLES_V3),
  taskType: z.enum(AGENT_TASK_TYPES_V3),
}).strict().superRefine((result, context) => {
  if (!result.taskType.startsWith(`${result.role}.`)) {
    context.addIssue({
      code: "custom",
      path: ["taskType"],
      message: "taskType 与专项角色不匹配",
    });
  }
});
export type AgentDelegationCompactResultV3 = z.infer<
  typeof agentDelegationCompactResultSchemaV3
> & { review?: never };

export const agentDelegationCompactResultSchema = agentDelegationCompactResultSchemaV3;
export type AgentDelegationCompactResult = AgentDelegationCompactResultV3;
export type AnyAgentDelegationCompactResult =
  | AgentDelegationCompactResultV1
  | AgentDelegationCompactResultV2
  | AgentDelegationCompactResultV3;

function addUniqueChildRunIssue(
  output: { results: Array<{ childRunId: string }> },
  context: z.core.$RefinementCtx,
): void {
  const childRunIds = output.results.map((result) => result.childRunId);
  if (new Set(childRunIds).size !== childRunIds.length) {
    context.addIssue({
      code: "custom",
      path: ["results"],
      message: "results 不能包含重复 childRunId",
    });
  }
}

export const agentDelegateCompletedOutputSchemaV1 = z.object({
  status: z.literal("completed"),
  delegationStepId: z.string().trim().min(1).max(200),
  results: z.array(agentDelegationCompactResultSchemaV1).min(1).max(3),
}).strict().superRefine(addUniqueChildRunIssue);
export type AgentDelegateCompletedOutputV1 = z.infer<typeof agentDelegateCompletedOutputSchemaV1>;

export const agentDelegateCompletedOutputSchemaV2 = z.object({
  status: z.literal("completed"),
  delegationStepId: z.string().trim().min(1).max(200),
  results: z.array(agentDelegationCompactResultSchemaV2).min(1).max(3),
}).strict().superRefine(addUniqueChildRunIssue);
export type AgentDelegateCompletedOutputV2 = z.infer<typeof agentDelegateCompletedOutputSchemaV2>;

export const agentDelegateCompletedOutputSchemaV10 = z.object({
  status: z.literal("completed"),
  delegationStepId: z.string().trim().min(1).max(200),
  results: z.array(agentDelegationCompactResultSchemaV3).min(1).max(3),
}).strict().superRefine(addUniqueChildRunIssue);
export type AgentDelegateCompletedOutputV10 = z.infer<typeof agentDelegateCompletedOutputSchemaV10>;

export const agentDelegateCompletedOutputSchema = agentDelegateCompletedOutputSchemaV10;
export type AgentDelegateCompletedOutput = AgentDelegateCompletedOutputV10;
export type AnyAgentDelegateCompletedOutput =
  | AgentDelegateCompletedOutputV1
  | AgentDelegateCompletedOutputV2
  | AgentDelegateCompletedOutputV10;

function controllerOnlyExecute(): never {
  throw new AgentToolGatewayError(
    "agent_delegate_controller_only",
    "agent.delegate 只能由 Agent Runtime Controller 执行",
    { status: 409 },
  );
}

/** Historical catalog/schema snapshot paired only with main Prompt v4. */
export const AGENT_DELEGATE_TOOL_V4 = defineAgentTool({
  manifest: {
    name: "agent.delegate",
    version: "1.0.0",
    displayName: "委派专项 Agent",
    description: "请求 Controller 原子创建 writer/storyboard 的 R0-only 专项任务，并暂停父 Run 等待结果。",
    riskClass: "R1",
    availability: { state: "available", sincePhase: "A4" },
    requiredPermissions: ["project:write"],
    resourceTypes: ["agent_delegation", "agent_run", "agent_task"],
    mutatesState: true,
    metered: false,
  },
  inputSchema: agentDelegateInputSchemaV4,
  outputSchema: agentDelegateWaitingOutputSchema,
  async execute() {
    return controllerOnlyExecute();
  },
});

/** Current catalog/schema snapshot paired only with main Prompt v5. */
export const AGENT_DELEGATE_TOOL_V5 = defineAgentTool({
  manifest: {
    name: "agent.delegate",
    version: "2.0.0",
    displayName: "委派专项 Agent",
    description: "请求 Controller 原子创建 writer/visual/storyboard/reviewer 的受限专项任务，并暂停父 Run 等待结果。",
    riskClass: "R1",
    availability: { state: "available", sincePhase: "A4" },
    requiredPermissions: ["project:write"],
    resourceTypes: ["agent_delegation", "agent_run", "agent_task"],
    mutatesState: true,
    metered: false,
  },
  inputSchema: agentDelegateInputSchemaV5,
  outputSchema: agentDelegateWaitingOutputSchema,
  async execute() {
    return controllerOnlyExecute();
  },
});

/** v10 catalog/schema snapshot paired only with main Prompt v10 (Executor V3). */
export const AGENT_DELEGATE_TOOL_V10 = defineAgentTool({
  manifest: {
    name: "agent.delegate",
    version: "3.0.0",
    displayName: "委派专项 Agent",
    description: "请求 Controller 原子创建 writer/visual/storyboard/reviewer/executor 的受限专项任务，并暂停父 Run 等待结果。",
    riskClass: "R1",
    availability: { state: "available", sincePhase: "A4" },
    requiredPermissions: ["project:write"],
    resourceTypes: ["agent_delegation", "agent_run", "agent_task"],
    mutatesState: true,
    metered: false,
  },
  inputSchema: agentDelegateInputSchemaV10,
  outputSchema: agentDelegateWaitingOutputSchema,
  async execute() {
    return controllerOnlyExecute();
  },
});

/** Default Registry entry for new Runs. Historical catalog projection is explicit. */
export const AGENT_DELEGATE_TOOL = AGENT_DELEGATE_TOOL_V10;

export const AGENT_TASK_RESULT_OUTPUT_CONTRACT_PREFIX_V1 = "agent_task_result:v1:" as const;
export const AGENT_TASK_RESULT_OUTPUT_CONTRACT_PREFIX_V2 = "agent_task_result:v2:" as const;
export const AGENT_TASK_RESULT_OUTPUT_CONTRACT_PREFIX_V3 = "agent_task_result:v3:" as const;
export const AGENT_TASK_RESULT_OUTPUT_CONTRACT_PREFIX =
  AGENT_TASK_RESULT_OUTPUT_CONTRACT_PREFIX_V3;

function outputContract(prefix: string, taskHash: string): string {
  return `${prefix}${taskHash}`;
}

export const AGENT_DELEGATION_PERSISTENCE_CONTRACT_V1 = Object.freeze({
  taskVersion: AGENT_TASK_VERSION_V1,
  resultVersion: AGENT_TASK_RESULT_VERSION_V1,
  policyVersion: A4_DELEGATED_RUN_POLICY_VERSION_V1,
  outputContractPrefix: AGENT_TASK_RESULT_OUTPUT_CONTRACT_PREFIX_V1,
  roles: Object.freeze([...A4_DELEGATED_AGENT_ROLES_V1] as const),
  taskSchema: agentTaskSchemaV1,
  resultSchema: agentTaskResultSchemaV1,
  compactResultSchema: agentDelegationCompactResultSchemaV1,
  completedOutputSchema: agentDelegateCompletedOutputSchemaV1,
  normalizeTask: normalizeAgentTaskV1,
  normalizeResult: (
    input: unknown,
    options: NormalizeAgentTaskResultV3Options = {},
  ) => normalizeAgentTaskResultForVersion(AGENT_TASK_RESULT_VERSION_V1, input, options),
  createChildPolicy: (input: CreateA4DelegatedRunPolicyInputV3) => (
    createA4DelegatedRunPolicySnapshotV1(input as CreateA4DelegatedRunPolicyInputV1)
  ),
  parseChildPolicy: (value: unknown, options: ParseA4DelegatedRunPolicyOptionsV3 = {}) => (
    parseA4DelegatedRunPolicySnapshotV1(value, options as ParseA4DelegatedRunPolicyOptionsV1)
  ),
  getR0ToolIds: (role: A4DelegatedAgentRoleV3) => getA4DelegationR0ToolIdsV1(
    role as (typeof A4_DELEGATED_AGENT_ROLES_V1)[number],
  ),
  parentPolicySnapshot: A4_DELEGATION_PARENT_POLICY_SNAPSHOT_V1,
  createOutputContract: (taskHash: string) => outputContract(
    AGENT_TASK_RESULT_OUTPUT_CONTRACT_PREFIX_V1,
    taskHash,
  ),
});

export const AGENT_DELEGATION_PERSISTENCE_CONTRACT_V2 = Object.freeze({
  taskVersion: AGENT_TASK_VERSION_V2,
  resultVersion: AGENT_TASK_RESULT_VERSION_V2,
  policyVersion: A4_DELEGATED_RUN_POLICY_VERSION_V2,
  outputContractPrefix: AGENT_TASK_RESULT_OUTPUT_CONTRACT_PREFIX_V2,
  roles: Object.freeze([...A4_DELEGATED_AGENT_ROLES_V2] as const),
  taskSchema: agentTaskSchemaV2,
  resultSchema: agentTaskResultSchemaV2,
  compactResultSchema: agentDelegationCompactResultSchemaV2,
  completedOutputSchema: agentDelegateCompletedOutputSchemaV2,
  normalizeTask: normalizeAgentTaskV2,
  normalizeResult: (
    input: unknown,
    options: NormalizeAgentTaskResultV3Options = {},
  ) => normalizeAgentTaskResultForVersion(AGENT_TASK_RESULT_VERSION_V2, input, options),
  createChildPolicy: (input: CreateA4DelegatedRunPolicyInputV3) => (
    createA4DelegatedRunPolicySnapshotV2(input as CreateA4DelegatedRunPolicyInputV2)
  ),
  parseChildPolicy: (value: unknown, options: ParseA4DelegatedRunPolicyOptionsV3 = {}) => (
    parseA4DelegatedRunPolicySnapshotV2(value, options as ParseA4DelegatedRunPolicyOptionsV2)
  ),
  getR0ToolIds: (role: A4DelegatedAgentRoleV3) => getA4DelegationR0ToolIdsV2(
    role as A4DelegatedAgentRoleV2,
  ),
  parentPolicySnapshot: A4_DELEGATION_PARENT_POLICY_SNAPSHOT_V2,
  createOutputContract: (taskHash: string) => outputContract(
    AGENT_TASK_RESULT_OUTPUT_CONTRACT_PREFIX_V2,
    taskHash,
  ),
});

/**
 * V3（v10 主 Prompt / Executor）持久化合同：v10 父 Run 的唯一合同。
 * 它同时承载两类 child：
 * - executor → V3 task/result/policy（确定性执行，modelEnabled=false）
 * - writer/visual/storyboard/reviewer → 沿用 V2 task/result/policy（模型提案）
 * 内部按角色/版本路由；taskVersion/resultVersion/policyVersion 字段描述
 * executor 路径（均为 3），child 侧消费方按 child policy version 重新
 * 选择合同，因此 V3 合同在 processor 语境下只处理 executor child。
 */
export const AGENT_DELEGATION_PERSISTENCE_CONTRACT_V3 = Object.freeze({
  taskVersion: AGENT_TASK_VERSION_V3,
  resultVersion: AGENT_TASK_RESULT_VERSION_V3,
  policyVersion: A4_DELEGATED_RUN_POLICY_VERSION_V3,
  outputContractPrefix: AGENT_TASK_RESULT_OUTPUT_CONTRACT_PREFIX_V3,
  roles: Object.freeze([...A4_DELEGATED_AGENT_ROLES_V3] as const),
  taskSchema: agentTaskSchemaV3,
  resultSchema: agentTaskResultSchemaV3,
  compactResultSchema: agentDelegationCompactResultSchemaV3,
  completedOutputSchema: agentDelegateCompletedOutputSchemaV10,
  normalizeTask: (
    input: unknown,
    options: { expectedProjectId?: number } = {},
  ) => {
    const record = input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : null;
    if (record?.role === "executor") {
      return normalizeAgentTaskV3(
        { ...record, version: AGENT_TASK_VERSION_V3 },
        options,
      );
    }
    const { executionSpec: _executorOnly, ...proposalTask } = record ?? {};
    return normalizeAgentTaskV2(
      { ...proposalTask, version: AGENT_TASK_VERSION_V2 },
      options,
    );
  },
  normalizeResult: (
    input: unknown,
    options: NormalizeAgentTaskResultV3Options = {},
  ) => {
    const record = input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : null;
    if (record?.version === AGENT_TASK_RESULT_VERSION_V3
      || options.expectedRole === "executor") {
      return normalizeAgentTaskResultV3(input, options);
    }
    return normalizeAgentTaskResultForVersion(
      AGENT_TASK_RESULT_VERSION_V2,
      input,
      options,
    );
  },
  createChildPolicy: (input: CreateA4DelegatedRunPolicyInputV3) => (
    input.role === "executor"
      ? createA4DelegatedRunPolicySnapshotV3(input)
      : createA4DelegatedRunPolicySnapshotV2(input as CreateA4DelegatedRunPolicyInputV2)
  ),
  parseChildPolicy: (value: unknown, options: ParseA4DelegatedRunPolicyOptionsV3 = {}) => {
    const record = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    const task = record?.delegatedTask && typeof record.delegatedTask === "object"
      ? record.delegatedTask as Record<string, unknown>
      : null;
    if (task?.role === "executor" || options.expectedRole === "executor") {
      return parseA4DelegatedRunPolicySnapshotV3(value, options);
    }
    if (options.expectedRole === undefined) {
      return parseA4DelegatedRunPolicySnapshot(value, options);
    }
    return parseA4DelegatedRunPolicySnapshotV2(
      value,
      options as ParseA4DelegatedRunPolicyOptionsV2,
    );
  },
  getR0ToolIds: getA4DelegationR0ToolIdsV3,
  parentPolicySnapshot: A4_DELEGATION_PARENT_POLICY_SNAPSHOT_V3,
  createOutputContract: (taskHash: string) => outputContract(
    AGENT_TASK_RESULT_OUTPUT_CONTRACT_PREFIX_V3,
    taskHash,
  ),
});

export type AgentDelegationPersistenceContractV1 =
  typeof AGENT_DELEGATION_PERSISTENCE_CONTRACT_V1;
export type AgentDelegationPersistenceContractV2 =
  typeof AGENT_DELEGATION_PERSISTENCE_CONTRACT_V2;
export type AgentDelegationPersistenceContractV3 =
  typeof AGENT_DELEGATION_PERSISTENCE_CONTRACT_V3;
export type AgentDelegationPersistenceContract =
  | AgentDelegationPersistenceContractV1
  | AgentDelegationPersistenceContractV2
  | AgentDelegationPersistenceContractV3;

const AGENT_DELEGATE_CONTRACT_V4 = Object.freeze({
  ...AGENT_DELEGATION_PERSISTENCE_CONTRACT_V1,
  promptVersion: AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION_V4,
  inputSchema: agentDelegateInputSchemaV4,
  tool: AGENT_DELEGATE_TOOL_V4,
});
const AGENT_DELEGATE_CONTRACT_V5 = Object.freeze({
  ...AGENT_DELEGATION_PERSISTENCE_CONTRACT_V2,
  promptVersion: AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION,
  inputSchema: agentDelegateInputSchemaV5,
  tool: AGENT_DELEGATE_TOOL_V5,
});
export const AGENT_DELEGATE_CONTRACT_V10 = Object.freeze({
  ...AGENT_DELEGATION_PERSISTENCE_CONTRACT_V3,
  promptVersion: AGENT_MAIN_EXECUTOR_DELEGATION_TOOLS_PROMPT_VERSION,
  inputSchema: agentDelegateInputSchemaV10,
  tool: AGENT_DELEGATE_TOOL_V10,
});

export type AgentDelegateContractV4 = typeof AGENT_DELEGATE_CONTRACT_V4;
export type AgentDelegateContractV5 = typeof AGENT_DELEGATE_CONTRACT_V5;
export type AgentDelegateContractV10 = typeof AGENT_DELEGATE_CONTRACT_V10;
export type AgentDelegateContract =
  | AgentDelegateContractV4
  | AgentDelegateContractV5
  | AgentDelegateContractV10;

export function getAgentDelegationPersistenceContractForPromptVersion(
  value: unknown,
): AgentDelegationPersistenceContract | null {
  if (value === AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION_V4) {
    return AGENT_DELEGATION_PERSISTENCE_CONTRACT_V1;
  }
  if (value === AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION) {
    return AGENT_DELEGATION_PERSISTENCE_CONTRACT_V2;
  }
  if (value === AGENT_MAIN_EXECUTOR_DELEGATION_TOOLS_PROMPT_VERSION) {
    return AGENT_DELEGATION_PERSISTENCE_CONTRACT_V3;
  }
  return null;
}

export function getAgentDelegationPersistenceContractForPolicyVersion(
  value: unknown,
): AgentDelegationPersistenceContract | null {
  if (value === A4_DELEGATED_RUN_POLICY_VERSION_V1) {
    return AGENT_DELEGATION_PERSISTENCE_CONTRACT_V1;
  }
  if (value === A4_DELEGATED_RUN_POLICY_VERSION_V2) {
    return AGENT_DELEGATION_PERSISTENCE_CONTRACT_V2;
  }
  if (value === A4_DELEGATED_RUN_POLICY_VERSION_V3) {
    return AGENT_DELEGATION_PERSISTENCE_CONTRACT_V3;
  }
  return null;
}

export function getAgentDelegationPersistenceContractForTaskVersion(
  value: unknown,
): AgentDelegationPersistenceContract | null {
  if (value === AGENT_TASK_VERSION_V1) return AGENT_DELEGATION_PERSISTENCE_CONTRACT_V1;
  if (value === AGENT_TASK_VERSION_V2) return AGENT_DELEGATION_PERSISTENCE_CONTRACT_V2;
  if (value === AGENT_TASK_VERSION_V3) return AGENT_DELEGATION_PERSISTENCE_CONTRACT_V3;
  return null;
}

export function getAgentDelegateContractForPromptVersion(
  value: unknown,
): AgentDelegateContract | null {
  if (value === AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION_V4) return AGENT_DELEGATE_CONTRACT_V4;
  if (value === AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION) return AGENT_DELEGATE_CONTRACT_V5;
  if (value === AGENT_MAIN_EXECUTOR_DELEGATION_TOOLS_PROMPT_VERSION) return AGENT_DELEGATE_CONTRACT_V10;
  return null;
}

export function parseAgentDelegateInputForPromptVersion(
  promptVersion: typeof AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION_V4,
  value: unknown,
): AgentDelegateInputV4 | null;
export function parseAgentDelegateInputForPromptVersion(
  promptVersion: typeof AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION,
  value: unknown,
): AgentDelegateInputV5 | null;
export function parseAgentDelegateInputForPromptVersion(
  promptVersion: typeof AGENT_MAIN_EXECUTOR_DELEGATION_TOOLS_PROMPT_VERSION,
  value: unknown,
): AgentDelegateInputV10 | null;
export function parseAgentDelegateInputForPromptVersion(
  promptVersion: unknown,
  value: unknown,
): AnyAgentDelegateInput | null;
export function parseAgentDelegateInputForPromptVersion(
  promptVersion: unknown,
  value: unknown,
): AnyAgentDelegateInput | null {
  if (promptVersion === AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION_V4) {
    const parsed = agentDelegateInputSchemaV4.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  if (promptVersion === AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION) {
    const parsed = agentDelegateInputSchemaV5.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  if (promptVersion === AGENT_MAIN_EXECUTOR_DELEGATION_TOOLS_PROMPT_VERSION) {
    const parsed = agentDelegateInputSchemaV10.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  return null;
}
