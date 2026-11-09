import {
  AGENT_STORYBOARD_DELEGATED_PROMPT_VERSION,
  AGENT_REVIEWER_DELEGATED_PROMPT_VERSION,
  AGENT_VISUAL_DELEGATED_PROMPT_VERSION,
  AGENT_WRITER_DELEGATED_PROMPT_VERSION,
  AGENT_EXECUTOR_DELEGATED_PROMPT_VERSION,
  resolveAgentRuntimeConfigSnapshot,
  type AgentRuntimeConfigSnapshot,
} from "@/agent-runtime/runtimeConfigRegistry";
import {
  A4_DELEGATED_AGENT_ROLES_V1,
  A4_DELEGATED_AGENT_ROLES_V2,
  A4_DELEGATED_AGENT_ROLES_V3,
  AGENT_TASK_VERSION_V1,
  AGENT_TASK_VERSION_V2,
  AGENT_TASK_VERSION_V3,
  getA4DelegationR0ToolIdsV1,
  getA4DelegationR0ToolIdsV2,
  getA4DelegationR0ToolIdsV3,
  type A4DelegatedAgentRoleV1,
  type A4DelegatedAgentRoleV2,
  type A4DelegatedAgentRoleV3,
} from "@/agent-runtime/delegationContracts";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import type { ToolId } from "@/agent-runtime/toolIds";

export const A4_DELEGATED_RUN_PHASE = "A4-delegated-r0" as const;
/** V3 executor Run 的独立 phase：确定性执行，不进入模型 Tool Loop。 */
export const A4_DELEGATED_EXECUTOR_RUN_PHASE = "A4-delegated-executor-v3" as const;
export const A4_DELEGATED_RUN_POLICY_VERSION_V1 = 1 as const;
export const A4_DELEGATED_RUN_POLICY_VERSION_V2 = 2 as const;
export const A4_DELEGATED_RUN_POLICY_VERSION_V3 = 3 as const;
export const A4_DELEGATED_RUN_POLICY_VERSION = A4_DELEGATED_RUN_POLICY_VERSION_V3;
export type A4DelegatedRunPolicyVersion =
  | typeof A4_DELEGATED_RUN_POLICY_VERSION_V1
  | typeof A4_DELEGATED_RUN_POLICY_VERSION_V2
  | typeof A4_DELEGATED_RUN_POLICY_VERSION_V3;

export const A4_DELEGATED_RUN_CONTROLLER_LIMITS = Object.freeze({
  maxTurns: 4,
  maxToolCalls: 8,
  maxArgumentBytes: 32_768,
  maxResultBytes: 65_536,
  maxFinalBytes: 131_072,
  maxDurationSeconds: 300,
} as const);

/**
 * V3 executor 控制器上限：不走模型 Turn（maxTurns 固定 1 仅作结构占位），
 * 工具调用预算覆盖 storyVideo 管线（12 场景 → 12 段 submit + 逐段 quote
 * + merge + preview），时长覆盖异步视频生成的外部等待。
 */
export const A4_DELEGATED_RUN_CONTROLLER_LIMITS_V3 = Object.freeze({
  maxTurns: 1,
  maxToolCalls: 40,
  maxArgumentBytes: 32_768,
  maxResultBytes: 65_536,
  maxFinalBytes: 131_072,
  maxDurationSeconds: 7_200,
} as const);

/** V1/V2 与 V3 控制器上限的联合：键集合一致，数值按版本固定。 */
export type A4DelegatedRunControllerLimits =
  | typeof A4_DELEGATED_RUN_CONTROLLER_LIMITS
  | typeof A4_DELEGATED_RUN_CONTROLLER_LIMITS_V3;

interface A4DelegatedRunTaskPolicyBase {
  delegationId: string;
  parentRunId: string;
  parentStepId: string;
  taskHash: string;
  allowedTools: readonly ToolId[];
  limits: A4DelegatedRunControllerLimits;
}

export interface A4DelegatedRunTaskPolicyV1 extends A4DelegatedRunTaskPolicyBase {
  version: typeof A4_DELEGATED_RUN_POLICY_VERSION_V1;
  role: A4DelegatedAgentRoleV1;
  taskVersion: typeof AGENT_TASK_VERSION_V1;
}

export interface A4DelegatedRunTaskPolicyV2 extends A4DelegatedRunTaskPolicyBase {
  version: typeof A4_DELEGATED_RUN_POLICY_VERSION_V2;
  role: A4DelegatedAgentRoleV2;
  taskVersion: typeof AGENT_TASK_VERSION_V2;
}

export interface A4DelegatedRunTaskPolicyV3 extends A4DelegatedRunTaskPolicyBase {
  version: typeof A4_DELEGATED_RUN_POLICY_VERSION_V3;
  role: A4DelegatedAgentRoleV3;
  taskVersion: typeof AGENT_TASK_VERSION_V3;
}

export type A4DelegatedRunTaskPolicy =
  | A4DelegatedRunTaskPolicyV1
  | A4DelegatedRunTaskPolicyV2
  | A4DelegatedRunTaskPolicyV3;

interface A4DelegatedRunPolicySnapshotBase {
  modelEnabled: true;
  toolsEnabled: true;
  delegationEnabled: false;
  phase: typeof A4_DELEGATED_RUN_PHASE;
  modelAlias: string;
  agentConfig: AgentRuntimeConfigSnapshot;
}

export interface A4DelegatedRunPolicySnapshotV1 extends A4DelegatedRunPolicySnapshotBase {
  delegatedTask: A4DelegatedRunTaskPolicyV1;
}

export interface A4DelegatedRunPolicySnapshotV2 extends A4DelegatedRunPolicySnapshotBase {
  delegatedTask: A4DelegatedRunTaskPolicyV2;
}

/**
 * V3 executor 快照：modelEnabled=false 表示该 Run 永不进入模型 Tool Loop；
 * toolsEnabled=true 表示确定性单元序列可通过 Gateway 执行 R2 工具；
 * phase 固定为 A4-delegated-executor-v3。agentConfig 仍是完整的固定配置
 * 快照（审计与配置一致性），但 executor 处理器不从中派生模型调用。
 */
export interface A4DelegatedRunPolicySnapshotV3 {
  modelEnabled: false;
  toolsEnabled: true;
  delegationEnabled: false;
  phase: typeof A4_DELEGATED_EXECUTOR_RUN_PHASE;
  modelAlias: string;
  agentConfig: AgentRuntimeConfigSnapshot;
  delegatedTask: A4DelegatedRunTaskPolicyV3;
}

export type A4DelegatedRunPolicySnapshot =
  | A4DelegatedRunPolicySnapshotV1
  | A4DelegatedRunPolicySnapshotV2
  | A4DelegatedRunPolicySnapshotV3;

interface CreateA4DelegatedRunPolicyInputBase {
  delegationId: string;
  parentRunId: string;
  parentStepId: string;
  taskHash: string;
  agentConfig: AgentRuntimeConfigSnapshot;
}

export interface CreateA4DelegatedRunPolicyInputV1 extends CreateA4DelegatedRunPolicyInputBase {
  role: A4DelegatedAgentRoleV1;
}

export interface CreateA4DelegatedRunPolicyInputV2 extends CreateA4DelegatedRunPolicyInputBase {
  role: A4DelegatedAgentRoleV2;
}

export interface CreateA4DelegatedRunPolicyInputV3 extends CreateA4DelegatedRunPolicyInputBase {
  role: A4DelegatedAgentRoleV3;
}

export type CreateA4DelegatedRunPolicyInput = CreateA4DelegatedRunPolicyInputV3;

interface ParseA4DelegatedRunPolicyOptionsBase {
  expectedDelegationId?: string;
  expectedParentRunId?: string;
  expectedParentStepId?: string;
  expectedTaskHash?: string;
}

export interface ParseA4DelegatedRunPolicyOptionsV1 extends ParseA4DelegatedRunPolicyOptionsBase {
  expectedRole?: A4DelegatedAgentRoleV1;
}

export interface ParseA4DelegatedRunPolicyOptionsV2 extends ParseA4DelegatedRunPolicyOptionsBase {
  expectedRole?: A4DelegatedAgentRoleV2;
}

export interface ParseA4DelegatedRunPolicyOptionsV3 extends ParseA4DelegatedRunPolicyOptionsBase {
  expectedRole?: A4DelegatedAgentRoleV3;
}

export type ParseA4DelegatedRunPolicyOptions = ParseA4DelegatedRunPolicyOptionsV3;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;
const A4_PROMPT_BY_ROLE_V1 = Object.freeze({
  writer: { key: "agent.writer.system", version: AGENT_WRITER_DELEGATED_PROMPT_VERSION },
  storyboard: { key: "agent.storyboard.system", version: AGENT_STORYBOARD_DELEGATED_PROMPT_VERSION },
} as const);
const A4_PROMPT_BY_ROLE_V2 = Object.freeze({
  ...A4_PROMPT_BY_ROLE_V1,
  visual: { key: "agent.visual.system", version: AGENT_VISUAL_DELEGATED_PROMPT_VERSION },
  reviewer: { key: "agent.reviewer.system", version: AGENT_REVIEWER_DELEGATED_PROMPT_VERSION },
} as const);
const A4_PROMPT_BY_ROLE_V3 = Object.freeze({
  ...A4_PROMPT_BY_ROLE_V2,
  executor: { key: "agent.executor.system", version: AGENT_EXECUTOR_DELEGATED_PROMPT_VERSION },
} as const);

type AnyRole = A4DelegatedAgentRoleV3;
type AnyParseOptions = ParseA4DelegatedRunPolicyOptionsV3;

interface PolicyDefinition {
  policyVersion: A4DelegatedRunPolicyVersion;
  taskVersion: typeof AGENT_TASK_VERSION_V1 | typeof AGENT_TASK_VERSION_V2 | typeof AGENT_TASK_VERSION_V3;
  roles: readonly AnyRole[];
  promptByRole: Readonly<Partial<Record<AnyRole, { key: string; version: string }>>>;
  getAllowedTools: (role: AnyRole) => readonly ToolId[];
  /** 期望的 modelEnabled 值：V1/V2 模型提案任务为 true，V3 executor 为 false。 */
  modelEnabled: boolean;
  /** 期望的 phase 值：V1/V2 为 A4-delegated-r0，V3 为 A4-delegated-executor-v3。 */
  phase: string;
  /** 该版本的控制器上限常量。 */
  limits: A4DelegatedRunControllerLimits;
}

const POLICY_DEFINITION_V1: PolicyDefinition = Object.freeze({
  policyVersion: A4_DELEGATED_RUN_POLICY_VERSION_V1,
  taskVersion: AGENT_TASK_VERSION_V1,
  roles: A4_DELEGATED_AGENT_ROLES_V1,
  promptByRole: A4_PROMPT_BY_ROLE_V1,
  getAllowedTools: (role: AnyRole) => getA4DelegationR0ToolIdsV1(role as A4DelegatedAgentRoleV1),
  modelEnabled: true,
  phase: A4_DELEGATED_RUN_PHASE,
  limits: A4_DELEGATED_RUN_CONTROLLER_LIMITS,
});

const POLICY_DEFINITION_V2: PolicyDefinition = Object.freeze({
  policyVersion: A4_DELEGATED_RUN_POLICY_VERSION_V2,
  taskVersion: AGENT_TASK_VERSION_V2,
  roles: A4_DELEGATED_AGENT_ROLES_V2,
  promptByRole: A4_PROMPT_BY_ROLE_V2,
  getAllowedTools: (role: AnyRole) => getA4DelegationR0ToolIdsV2(role as A4DelegatedAgentRoleV2),
  modelEnabled: true,
  phase: A4_DELEGATED_RUN_PHASE,
  limits: A4_DELEGATED_RUN_CONTROLLER_LIMITS,
});

const POLICY_DEFINITION_V3: PolicyDefinition = Object.freeze({
  policyVersion: A4_DELEGATED_RUN_POLICY_VERSION_V3,
  taskVersion: AGENT_TASK_VERSION_V3,
  roles: A4_DELEGATED_AGENT_ROLES_V3,
  promptByRole: A4_PROMPT_BY_ROLE_V3,
  getAllowedTools: getA4DelegationR0ToolIdsV3,
  modelEnabled: false,
  phase: A4_DELEGATED_EXECUTOR_RUN_PHASE,
  limits: A4_DELEGATED_RUN_CONTROLLER_LIMITS_V3,
});

function fail(status = 409): never {
  throw new AgentRuntimeError(
    status,
    "delegated_run_policy_invalid",
    "Delegated Run 的固定策略快照无效",
  );
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      fail();
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail();
  return parsed as Record<string, unknown>;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function cleanId(value: unknown, maxLength = 200): string {
  if (typeof value !== "string") fail();
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || !SAFE_ID_PATTERN.test(normalized)) fail();
  return normalized;
}

function cleanHash(value: unknown): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) fail();
  return value;
}

function parseRole(value: unknown, definition: PolicyDefinition): AnyRole {
  if (typeof value !== "string" || !definition.roles.includes(value as AnyRole)) fail();
  return value as AnyRole;
}

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseAllowedTools(
  value: unknown,
  role: AnyRole,
  definition: PolicyDefinition,
): readonly ToolId[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) fail();
  const expected = definition.getAllowedTools(role);
  if (!equalStringArrays(value as string[], expected)) fail();
  return expected;
}

function parseLimits(value: unknown, definition: PolicyDefinition): A4DelegatedRunControllerLimits {
  const limits = parseJsonObject(value);
  if (!hasExactKeys(limits, Object.keys(definition.limits))) fail();
  for (const [key, expected] of Object.entries(definition.limits)) {
    if (limits[key] !== expected) fail();
  }
  return definition.limits;
}

function cloneConfig(snapshot: AgentRuntimeConfigSnapshot): AgentRuntimeConfigSnapshot {
  try {
    return JSON.parse(JSON.stringify(snapshot)) as AgentRuntimeConfigSnapshot;
  } catch {
    fail(500);
  }
}

function assertA4RoleConfig(
  config: ReturnType<typeof resolveAgentRuntimeConfigSnapshot>,
  role: AnyRole,
  definition: PolicyDefinition,
  status = 409,
): void {
  const prompt = definition.promptByRole[role];
  if (!prompt
    || config.prompt.key !== prompt.key
    || config.prompt.version !== prompt.version
    || !config.execution.enabled
    || !config.modelProfile.capabilities.includes("tools")
    || !config.modelProfile.capabilities.includes("structured-output")) {
    fail(status);
  }
}

function freezePolicy<TPolicy extends A4DelegatedRunPolicySnapshot>(snapshot: TPolicy): TPolicy {
  Object.freeze(snapshot.agentConfig.prompt);
  Object.freeze(snapshot.agentConfig.modelProfile);
  for (const skill of snapshot.agentConfig.skills) Object.freeze(skill);
  Object.freeze(snapshot.agentConfig.skills);
  if (snapshot.agentConfig.execution) Object.freeze(snapshot.agentConfig.execution);
  Object.freeze(snapshot.agentConfig);
  Object.freeze(snapshot.delegatedTask.allowedTools);
  Object.freeze(snapshot.delegatedTask);
  return Object.freeze(snapshot);
}

function parsePolicySnapshot(
  value: unknown,
  options: AnyParseOptions,
  definition: PolicyDefinition,
): A4DelegatedRunPolicySnapshot {
  const policy = parseJsonObject(value);
  if (!hasExactKeys(policy, [
    "modelEnabled",
    "toolsEnabled",
    "delegationEnabled",
    "phase",
    "modelAlias",
    "agentConfig",
    "delegatedTask",
  ])) fail();
  if (policy.modelEnabled !== definition.modelEnabled
    || policy.toolsEnabled !== true
    || policy.delegationEnabled !== false
    || policy.phase !== definition.phase) fail();

  const task = parseJsonObject(policy.delegatedTask);
  if (!hasExactKeys(task, [
    "version",
    "role",
    "delegationId",
    "parentRunId",
    "parentStepId",
    "taskVersion",
    "taskHash",
    "allowedTools",
    "limits",
  ])) fail();
  const role = parseRole(task.role, definition);
  if (task.version !== definition.policyVersion || task.taskVersion !== definition.taskVersion) fail();
  const delegationId = cleanId(task.delegationId);
  const parentRunId = cleanId(task.parentRunId);
  const parentStepId = cleanId(task.parentStepId);
  const taskHash = cleanHash(task.taskHash);
  const allowedTools = parseAllowedTools(task.allowedTools, role, definition);
  const limits = parseLimits(task.limits, definition);

  if ((options.expectedRole !== undefined && role !== options.expectedRole)
    || (options.expectedDelegationId !== undefined && delegationId !== options.expectedDelegationId)
    || (options.expectedParentRunId !== undefined && parentRunId !== options.expectedParentRunId)
    || (options.expectedParentStepId !== undefined && parentStepId !== options.expectedParentStepId)
    || (options.expectedTaskHash !== undefined && taskHash !== options.expectedTaskHash)) fail();

  const modelAlias = cleanId(policy.modelAlias);
  let config: ReturnType<typeof resolveAgentRuntimeConfigSnapshot>;
  try {
    config = resolveAgentRuntimeConfigSnapshot(policy.agentConfig, role);
  } catch {
    fail();
  }
  assertA4RoleConfig(config, role, definition);
  if (config.execution.modelAlias !== modelAlias) fail();

  const delegatedTask = {
    role,
    delegationId,
    parentRunId,
    parentStepId,
    taskHash,
    allowedTools,
    limits,
  };
  if (definition.policyVersion === A4_DELEGATED_RUN_POLICY_VERSION_V1) {
    return {
      modelEnabled: true as const,
      toolsEnabled: true as const,
      delegationEnabled: false as const,
      phase: A4_DELEGATED_RUN_PHASE,
      modelAlias,
      agentConfig: config.snapshot,
      delegatedTask: {
        ...delegatedTask,
        version: A4_DELEGATED_RUN_POLICY_VERSION_V1,
        role: role as A4DelegatedAgentRoleV1,
        taskVersion: AGENT_TASK_VERSION_V1,
      },
    };
  }
  if (definition.policyVersion === A4_DELEGATED_RUN_POLICY_VERSION_V2) {
    return {
      modelEnabled: true as const,
      toolsEnabled: true as const,
      delegationEnabled: false as const,
      phase: A4_DELEGATED_RUN_PHASE,
      modelAlias,
      agentConfig: config.snapshot,
      delegatedTask: {
        ...delegatedTask,
        role: role as A4DelegatedAgentRoleV2,
        version: A4_DELEGATED_RUN_POLICY_VERSION_V2,
        taskVersion: AGENT_TASK_VERSION_V2,
      },
    };
  }
  return {
    modelEnabled: false as const,
    toolsEnabled: true as const,
    delegationEnabled: false as const,
    phase: A4_DELEGATED_EXECUTOR_RUN_PHASE,
    modelAlias,
    agentConfig: config.snapshot,
    delegatedTask: {
      ...delegatedTask,
      version: A4_DELEGATED_RUN_POLICY_VERSION_V3,
      taskVersion: AGENT_TASK_VERSION_V3,
    },
  };
}

function createPolicySnapshot(
  input: CreateA4DelegatedRunPolicyInputV3,
  definition: PolicyDefinition,
): A4DelegatedRunPolicySnapshot {
  const role = parseRole(input.role, definition);
  const agentConfig = cloneConfig(input.agentConfig);
  let resolved: ReturnType<typeof resolveAgentRuntimeConfigSnapshot>;
  try {
    resolved = resolveAgentRuntimeConfigSnapshot(agentConfig, role);
  } catch {
    fail(500);
  }
  assertA4RoleConfig(resolved, role, definition, 500);
  const common = {
    modelEnabled: definition.modelEnabled,
    toolsEnabled: true as const,
    delegationEnabled: false as const,
    phase: definition.phase,
    modelAlias: resolved.execution.modelAlias,
    agentConfig,
  };
  const delegatedTask = {
    role,
    delegationId: cleanId(input.delegationId),
    parentRunId: cleanId(input.parentRunId),
    parentStepId: cleanId(input.parentStepId),
    taskHash: cleanHash(input.taskHash),
    allowedTools: [...definition.getAllowedTools(role)],
    limits: definition.limits,
  };
  let candidate: A4DelegatedRunPolicySnapshot;
  if (definition.policyVersion === A4_DELEGATED_RUN_POLICY_VERSION_V1) {
    candidate = {
      ...common,
      modelEnabled: true as const,
      phase: A4_DELEGATED_RUN_PHASE,
      delegatedTask: {
        ...delegatedTask,
        version: A4_DELEGATED_RUN_POLICY_VERSION_V1,
        role: role as A4DelegatedAgentRoleV1,
        taskVersion: AGENT_TASK_VERSION_V1,
      },
    };
  } else if (definition.policyVersion === A4_DELEGATED_RUN_POLICY_VERSION_V2) {
    candidate = {
      ...common,
      modelEnabled: true as const,
      phase: A4_DELEGATED_RUN_PHASE,
      delegatedTask: {
        ...delegatedTask,
        role: role as A4DelegatedAgentRoleV2,
        version: A4_DELEGATED_RUN_POLICY_VERSION_V2,
        taskVersion: AGENT_TASK_VERSION_V2,
      },
    };
  } else {
    candidate = {
      ...common,
      modelEnabled: false as const,
      phase: A4_DELEGATED_EXECUTOR_RUN_PHASE,
      delegatedTask: {
        ...delegatedTask,
        version: A4_DELEGATED_RUN_POLICY_VERSION_V3,
        taskVersion: AGENT_TASK_VERSION_V3,
      },
    };
  }
  const parsed = parsePolicySnapshot(candidate, {
    expectedRole: role,
    expectedDelegationId: candidate.delegatedTask.delegationId,
    expectedParentRunId: candidate.delegatedTask.parentRunId,
    expectedParentStepId: candidate.delegatedTask.parentStepId,
    expectedTaskHash: candidate.delegatedTask.taskHash,
  }, definition);
  return freezePolicy(parsed);
}

export function parseA4DelegatedRunPolicySnapshotV1(
  value: unknown,
  options: ParseA4DelegatedRunPolicyOptionsV1 = {},
): A4DelegatedRunPolicySnapshotV1 {
  return parsePolicySnapshot(value, options, POLICY_DEFINITION_V1) as A4DelegatedRunPolicySnapshotV1;
}

export function parseA4DelegatedRunPolicySnapshotV2(
  value: unknown,
  options: ParseA4DelegatedRunPolicyOptionsV2 = {},
): A4DelegatedRunPolicySnapshotV2 {
  return parsePolicySnapshot(value, options, POLICY_DEFINITION_V2) as A4DelegatedRunPolicySnapshotV2;
}

export function parseA4DelegatedRunPolicySnapshotV3(
  value: unknown,
  options: ParseA4DelegatedRunPolicyOptionsV3 = {},
): A4DelegatedRunPolicySnapshotV3 {
  return parsePolicySnapshot(value, options, POLICY_DEFINITION_V3) as A4DelegatedRunPolicySnapshotV3;
}

/** Recovery router: persisted policy version is authoritative and never upgraded. */
export function parseA4DelegatedRunPolicySnapshot(
  value: unknown,
  options: ParseA4DelegatedRunPolicyOptions = {},
): A4DelegatedRunPolicySnapshot {
  const policy = parseJsonObject(value);
  const task = parseJsonObject(policy.delegatedTask);
  if (task.version === A4_DELEGATED_RUN_POLICY_VERSION_V1) {
    return parseA4DelegatedRunPolicySnapshotV1(value, options as ParseA4DelegatedRunPolicyOptionsV1);
  }
  if (task.version === A4_DELEGATED_RUN_POLICY_VERSION_V2) {
    if (options.expectedRole === "executor") fail();
    return parseA4DelegatedRunPolicySnapshotV2(
      value,
      options as ParseA4DelegatedRunPolicyOptionsV2,
    );
  }
  if (task.version === A4_DELEGATED_RUN_POLICY_VERSION_V3) {
    return parseA4DelegatedRunPolicySnapshotV3(value, options);
  }
  fail();
}

export function createA4DelegatedRunPolicySnapshotV1(
  input: CreateA4DelegatedRunPolicyInputV1,
): A4DelegatedRunPolicySnapshotV1 {
  return createPolicySnapshot(
    input as CreateA4DelegatedRunPolicyInputV3,
    POLICY_DEFINITION_V1,
  ) as A4DelegatedRunPolicySnapshotV1;
}

export function createA4DelegatedRunPolicySnapshotV2(
  input: CreateA4DelegatedRunPolicyInputV2,
): A4DelegatedRunPolicySnapshotV2 {
  return createPolicySnapshot(input, POLICY_DEFINITION_V2) as A4DelegatedRunPolicySnapshotV2;
}

export function createA4DelegatedRunPolicySnapshotV3(
  input: CreateA4DelegatedRunPolicyInputV3,
): A4DelegatedRunPolicySnapshotV3 {
  return createPolicySnapshot(input, POLICY_DEFINITION_V3) as A4DelegatedRunPolicySnapshotV3;
}

/**
 * Latest creator for newly admitted Runs: executor children resolve to the
 * V3 deterministic policy; proposal roles keep the immutable V2 policy
 * (the v10 persistence contract routes the same way).
 */
export function createA4DelegatedRunPolicySnapshot(
  input: CreateA4DelegatedRunPolicyInputV3,
): A4DelegatedRunPolicySnapshot {
  if (input.role === "executor") {
    return createA4DelegatedRunPolicySnapshotV3(input);
  }
  return createA4DelegatedRunPolicySnapshotV2(input as CreateA4DelegatedRunPolicyInputV2);
}
