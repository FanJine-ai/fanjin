import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Knex } from "knex";
import {
  type AgentRole,
  type DelegatedAgentRole,
  type DelegationApprovalReference,
  type DelegationGrant,
  type DelegationLimits,
  type DelegationResourceScope,
  type DelegationSpendLimit,
} from "@/agent-runtime/contracts";
import {
  A4_DELEGATED_AGENT_ROLES,
  type A4DelegatedAgentRole,
  type AgentTask,
} from "@/agent-runtime/delegationContracts";
import { DEFAULT_ROLE_POLICIES } from "@/agent-runtime/defaultRolePolicies";
import {
  A4_DELEGATED_RUN_POLICY_VERSION_V2,
  A4_DELEGATED_RUN_POLICY_VERSION_V3,
} from "@/agent-runtime/delegatedRunPolicy";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import { canonicalizeIdempotencyRequest, hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import {
  AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION,
  AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION_V4,
  AGENT_MAIN_EXECUTOR_DELEGATION_TOOLS_PROMPT_VERSION,
  AGENT_MAIN_PROMPT_KEY,
  resolveAgentRuntimeConfigSnapshot,
} from "@/agent-runtime/runtimeConfigRegistry";
import {
  getAgentDelegateContractForPromptVersion,
  type AgentDelegateContract,
} from "@/agent-runtime/tools/packages/delegation";
import {
  TOOL_IDS,
  assertToolId,
  isToolSelector,
  matchesToolSelector,
  type ToolId,
  type ToolSelector,
} from "@/agent-runtime/toolIds";
import {
  AGENT_APPROVAL_TABLE,
  AGENT_DELEGATION_TABLE,
  AGENT_DELEGATION_USAGE_TABLE,
} from "@/lib/migrations/agentApprovalDelegation";
import {
  hasExactAgentRuntimePermission,
  resolveLiveWorkspacePermissions,
} from "@/middleware/permissions";

export const AGENT_DELEGATION_DEFAULT_TTL_MS = 5 * 60 * 1_000;
export const AGENT_DELEGATION_MAX_TTL_MS = 15 * 60 * 1_000;
/**
 * Executor（storyVideo 管线）Grant 的 TTL 上限：管线包含逐段审批等待与
 * 异步视频生成（waiting_external），必须远超普通提案型 Grant 的 15 分钟。
 */
export const AGENT_EXECUTOR_DELEGATION_MAX_TTL_MS = 24 * 60 * 60 * 1_000;
export const AGENT_DELEGATION_MAX_TOOL_CALLS = 1_000;

const RESOURCE_SCOPE_KEYS = [
  "scriptIds",
  "assetIds",
  "assetVersionIds",
  "storyboardIds",
  "canvasIds",
  "taskIds",
] as const satisfies readonly (keyof DelegationResourceScope)[];

export type DelegationResourceType = (typeof RESOURCE_SCOPE_KEYS)[number];

export interface DelegationResourceRef {
  type: DelegationResourceType;
  id: string;
}

export interface ParentDelegationPolicySnapshot {
  version: 1 | 2;
  scopeMode?: "task_refs";
  allowedTools: readonly ToolSelector[];
  resourceScope: DelegationResourceScope;
  limits: DelegationLimits;
  spend: DelegationSpendLimit;
  expiresAt?: number;
}

export interface IssueDelegationGrantInput {
  workspaceId: string;
  projectId: number;
  parentRunId: string;
  parentStepId: string;
  granteeRole: DelegatedAgentRole;
  purpose: string;
  objective: string;
  inputRefs?: readonly string[];
  outputContract: string;
  requestedTools: readonly ToolSelector[];
  resourceScope?: DelegationResourceScope;
  limits: DelegationLimits;
  spend: DelegationSpendLimit;
  approvalId?: string | null;
  ttlMs?: number;
}

export interface DelegationGrantRecord extends DelegationGrant {
  projectId: string;
  boundRunId: string | null;
  consumedToolCalls: number;
  consumedEstimatedMicros: number;
  consumedActualMicros: number;
  revision: number;
  updatedAt: number;
  revokedBy?: number;
}

export interface ConsumeDelegationGrantInput {
  grantId: string;
  workspaceId: string;
  projectId: number;
  runId: string;
  toolId: ToolId;
  resourceRefs?: readonly DelegationResourceRef[];
  estimatedMicros?: number;
  actualMicros?: number;
  idempotencyKey: string;
}

export interface DelegationGrantConsumption {
  id: string;
  grantId: string;
  runId: string;
  toolId: ToolId;
  resourceRefs: DelegationResourceRef[];
  estimatedMicros: number;
  actualMicros: number;
  callOrdinal: number;
  consumedToolCalls: number;
  consumedEstimatedMicros: number;
  consumedActualMicros: number;
  grantStatus: "active" | "consumed";
  grantRevision: number;
  replayed: boolean;
  createdAt: number;
}

export interface DelegationGrantServiceOptions {
  signingSecret: string | Buffer;
  clock?: () => number;
  idFactory?: () => string;
  usageIdFactory?: () => string;
  defaultTtlMs?: number;
  maxTtlMs?: number;
}

/**
 * ToolGateway-only input.  The gateway fills actor/workspace/project/role/run
 * from persisted Runtime rows; a model is never allowed to supply those
 * values or a deserialized Grant object.
 */
export interface DelegationGrantToolExecutionInput extends ConsumeDelegationGrantInput {
  actorUserId: number;
  agentRole: AgentRole;
}

export interface PreparedDelegationGrantExecution {
  grant: DelegationGrantRecord;
  workspaceId: string;
  projectId: number;
  runId: string;
  toolId: ToolId;
  resourceRefs: DelegationResourceRef[];
  estimatedMicros: number;
  actualMicros: number;
  idempotencyKey: string;
  requestHash: string;
  nextToolCalls: number;
  nextEstimatedMicros: number;
  nextActualMicros: number;
  nextStatus: "active" | "consumed";
}

/** Server-derived identity used for a read-only delegated model admission check. */
export interface VerifyDelegatedRunGrantInput {
  grantId: string;
  workspaceId: string;
  projectId: number;
  runId: string;
  actorUserId: number;
  agentRole: A4DelegatedAgentRole;
}

export interface VerifiedDelegatedRunGrant {
  grant: DelegationGrantRecord;
  task: AgentTask;
  taskHash: string;
  taskStatus: "queued" | "running";
}

interface RawDelegationRow extends Record<string, unknown> {
  id: string;
  grantVersion: number | string;
  status: string;
  actorUserId: number | string;
  workspaceId: string;
  projectId: number | string;
  sessionId: string | null;
  parentRunId: string;
  parentStepId: string;
  boundRunId: string | null;
  issuerRole: string;
  granteeRole: string;
  purpose: string;
  objectiveHash: string;
  inputRefs: unknown;
  outputContract: string;
  allowedTools: unknown;
  resourceScope: unknown;
  limits: unknown;
  spend: unknown;
  approvalId: string | null;
  approvalScopeHash: string | null;
  approvalPolicyVersion: string | null;
  idempotencyPrefix: string;
  canDelegate: number | string | boolean;
  issuedAt: number | string;
  expiresAt: number | string;
  revokedAt: number | string | null;
  revokedBy: number | string | null;
  consumedToolCalls: number | string;
  consumedEstimatedMicros: number | string;
  consumedActualMicros: number | string;
  signature: string;
  revision: number | string;
  updatedAt: number | string;
  taskVersion?: number | string | null;
  taskJson?: unknown;
  taskHash?: string | null;
  taskStatus?: string | null;
}

interface RawUsageRow extends Record<string, unknown> {
  id: string;
  workspaceId: string;
  projectId: number | string;
  grantId: string;
  runId: string;
  idempotencyKey: string;
  requestHash: string;
  toolId: string;
  resourceRefs: unknown;
  estimatedMicros: number | string;
  actualMicros: number | string;
  callOrdinal: number | string;
  createdAt: number | string;
}

function cleanString(value: unknown, field: string, maxLength = 500, status = 400): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new AgentRuntimeError(status, "delegation_input_invalid", `${field} 必填且格式有效`);
  }
  return text;
}

function integer(value: unknown, field: string, options: { min?: number; max?: number; status?: number } = {}): number {
  const number = Number(value);
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new AgentRuntimeError(options.status ?? 400, "delegation_input_invalid", `${field} 必须是 ${min} 到 ${max} 的整数`);
  }
  return number;
}

function optionalInteger(value: unknown, field: string, status = 500): number | null {
  if (value == null || value === "") return null;
  return integer(value, field, { status });
}

function parseJson(value: unknown, field: string, status = 500): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new AgentRuntimeError(status, "delegation_record_corrupt", `${field} 无法解析`);
  }
}

function normalizeStringList(value: unknown, field: string, maxItems = 200, status = 400): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new AgentRuntimeError(status, "delegation_input_invalid", `${field} 必须是最多 ${maxItems} 项的数组`);
  }
  const normalized = value.map((item) => cleanString(item, `${field}[]`, 500, status));
  if (new Set(normalized).size !== normalized.length) {
    throw new AgentRuntimeError(status, "delegation_input_invalid", `${field} 不能包含重复项`);
  }
  return [...normalized].sort();
}

function normalizeSelectors(value: unknown, field: string, status = 400): ToolSelector[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > TOOL_IDS.length) {
    throw new AgentRuntimeError(status, "delegation_tools_invalid", `${field} 必须是非空 ToolSelector 数组`);
  }
  const selectors = value.map((item) => {
    if (!isToolSelector(item)) {
      throw new AgentRuntimeError(status, "delegation_tools_invalid", `${field} 包含未知或无匹配项的 ToolSelector`);
    }
    return item;
  });
  if (new Set(selectors).size !== selectors.length) {
    throw new AgentRuntimeError(status, "delegation_tools_invalid", `${field} 不能包含重复项`);
  }
  return selectors;
}

function normalizeResourceScope(value: unknown, status = 400): DelegationResourceScope {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AgentRuntimeError(status, "delegation_resource_scope_invalid", "resourceScope 必须是对象");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(RESOURCE_SCOPE_KEYS as readonly string[]).includes(key))) {
    throw new AgentRuntimeError(status, "delegation_resource_scope_invalid", "resourceScope 包含未知资源类型");
  }
  const normalized: DelegationResourceScope = {};
  for (const key of RESOURCE_SCOPE_KEYS) {
    if (record[key] == null) continue;
    const values = normalizeStringList(record[key], `resourceScope.${key}`, 500, status);
    if (values.length) (normalized as Record<string, readonly string[]>)[key] = values;
  }
  return normalized;
}

function intersectResourceScopes(
  requested: DelegationResourceScope,
  parent: DelegationResourceScope,
): DelegationResourceScope {
  const result: DelegationResourceScope = {};
  for (const key of RESOURCE_SCOPE_KEYS) {
    const parentIds = new Set(parent[key] ?? []);
    const intersection = (requested[key] ?? []).filter((id) => parentIds.has(id));
    if (intersection.length) (result as Record<string, readonly string[]>)[key] = intersection;
  }
  return result;
}

function normalizeLimits(value: unknown, status = 400): DelegationLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentRuntimeError(status, "delegation_limits_invalid", "limits 必须是对象");
  }
  const record = value as Record<string, unknown>;
  const allowedModels = record.allowedModels == null
    ? undefined
    : normalizeStringList(record.allowedModels, "limits.allowedModels", 100, status);
  const optionalLimit = (field: "maxItems" | "maxOutputCount" | "maxDurationSeconds") => (
    record[field] == null ? undefined : integer(record[field], `limits.${field}`, { min: 1, max: 1_000_000, status })
  );
  return {
    maxToolCalls: integer(record.maxToolCalls, "limits.maxToolCalls", {
      min: 1,
      max: AGENT_DELEGATION_MAX_TOOL_CALLS,
      status,
    }),
    ...(optionalLimit("maxItems") === undefined ? {} : { maxItems: optionalLimit("maxItems") }),
    ...(optionalLimit("maxOutputCount") === undefined ? {} : { maxOutputCount: optionalLimit("maxOutputCount") }),
    ...(allowedModels === undefined ? {} : { allowedModels }),
    ...(optionalLimit("maxDurationSeconds") === undefined ? {} : { maxDurationSeconds: optionalLimit("maxDurationSeconds") }),
  };
}

function minOptional(requested: number | undefined, parent: number | undefined): number | undefined {
  if (requested === undefined || parent === undefined) return undefined;
  return Math.min(requested, parent);
}

function intersectLimits(requested: DelegationLimits, parent: DelegationLimits): DelegationLimits {
  const parentModels = new Set(parent.allowedModels ?? []);
  const allowedModels = requested.allowedModels && parent.allowedModels
    ? requested.allowedModels.filter((model) => parentModels.has(model))
    : undefined;
  return {
    maxToolCalls: Math.min(requested.maxToolCalls, parent.maxToolCalls),
    ...(minOptional(requested.maxItems, parent.maxItems) === undefined
      ? {}
      : { maxItems: minOptional(requested.maxItems, parent.maxItems) }),
    ...(minOptional(requested.maxOutputCount, parent.maxOutputCount) === undefined
      ? {}
      : { maxOutputCount: minOptional(requested.maxOutputCount, parent.maxOutputCount) }),
    ...(allowedModels === undefined ? {} : { allowedModels }),
    ...(minOptional(requested.maxDurationSeconds, parent.maxDurationSeconds) === undefined
      ? {}
      : { maxDurationSeconds: minOptional(requested.maxDurationSeconds, parent.maxDurationSeconds) }),
  };
}

function normalizeSpend(value: unknown, status = 400): DelegationSpendLimit {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentRuntimeError(status, "delegation_spend_invalid", "spend 必须是对象");
  }
  const record = value as Record<string, unknown>;
  if (record.currency !== "GU") {
    throw new AgentRuntimeError(status, "delegation_spend_invalid", "spend.currency 必须是 GU");
  }
  const reservationId = record.reservationId == null
    ? undefined
    : cleanString(record.reservationId, "spend.reservationId", 500, status);
  return {
    currency: "GU",
    maxEstimatedMicros: integer(record.maxEstimatedMicros, "spend.maxEstimatedMicros", { status }),
    maxActualMicros: integer(record.maxActualMicros, "spend.maxActualMicros", { status }),
    ...(reservationId ? { reservationId } : {}),
  };
}

function intersectSpend(requested: DelegationSpendLimit, parent: DelegationSpendLimit): DelegationSpendLimit {
  return {
    currency: "GU",
    maxEstimatedMicros: Math.min(requested.maxEstimatedMicros, parent.maxEstimatedMicros),
    maxActualMicros: Math.min(requested.maxActualMicros, parent.maxActualMicros),
    ...(requested.reservationId && requested.reservationId === parent.reservationId
      ? { reservationId: requested.reservationId }
      : {}),
  };
}

function normalizeRole(value: unknown, status = 400): AgentRole {
  const role = String(value || "");
  if (!(role in DEFAULT_ROLE_POLICIES)) {
    throw new AgentRuntimeError(status, "delegation_role_invalid", "未知 Agent Role");
  }
  return role as AgentRole;
}

function normalizeDelegatedRole(value: unknown, status = 400): DelegatedAgentRole {
  const role = normalizeRole(value, status);
  if (role === "main") {
    throw new AgentRuntimeError(status, "delegation_role_invalid", "不能把主 Agent 作为被委派角色");
  }
  return role;
}

function parseParentPolicy(value: unknown): ParentDelegationPolicySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentRuntimeError(409, "parent_delegation_policy_missing", "父 Run 缺少可验证的委派策略快照");
  }
  const record = value as Record<string, unknown>;
  if (Number(record.version) !== 1 && Number(record.version) !== 2) {
    throw new AgentRuntimeError(409, "parent_delegation_policy_invalid", "父 Run 委派策略版本无效");
  }
  const scopeMode = record.scopeMode == null ? undefined : String(record.scopeMode);
  if (scopeMode !== undefined && scopeMode !== "task_refs") {
    throw new AgentRuntimeError(409, "parent_delegation_policy_invalid", "父 Run 委派资源模式无效");
  }
  const expiresAt = record.expiresAt == null
    ? undefined
    : integer(record.expiresAt, "parentPolicy.expiresAt", { status: 409 });
  return {
    version: Number(record.version) as 1 | 2,
    ...(scopeMode === undefined ? {} : { scopeMode: "task_refs" as const }),
    allowedTools: normalizeSelectors(record.allowedTools, "parentPolicy.allowedTools", 409),
    resourceScope: normalizeResourceScope(record.resourceScope, 409),
    limits: normalizeLimits(record.limits, 409),
    spend: normalizeSpend(record.spend, 409),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

interface ParsedRunPolicySnapshot {
  root: Record<string, unknown>;
  delegation: ParentDelegationPolicySnapshot;
}

function parseRunPolicySnapshot(value: unknown): ParsedRunPolicySnapshot {
  const parsed = parseJson(value, "parentRun.policySnapshot", 409);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentRuntimeError(409, "parent_delegation_policy_missing", "父 Run 缺少可验证的委派策略快照");
  }
  const root = parsed as Record<string, unknown>;
  return { root, delegation: parseParentPolicy(root.delegation) };
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalidA4ParentPolicy(message = "父 Run 的 A4 委派策略快照无效"): never {
  throw new AgentRuntimeError(409, "parent_delegation_policy_invalid", message);
}

function assertA4TaskRefsParentPolicy(
  parentRun: Record<string, unknown>,
  root: Record<string, unknown>,
  granteeRole: string,
): AgentDelegateContract {
  const exactKeys = [
    "agentConfig",
    "delegation",
    "delegationEnabled",
    "modelAlias",
    "modelEnabled",
    "phase",
    "toolsEnabled",
  ].sort();
  if (!equalStrings(Object.keys(root).sort(), exactKeys)
    || root.modelEnabled !== true
    || root.toolsEnabled !== true
    || root.delegationEnabled !== true
    || root.phase !== "A4-delegation"
    || String(parentRun.kind) !== "root"
    || String(parentRun.agentRole) !== "main"
    || String(parentRun.rootRunId) !== String(parentRun.id)
    || parentRun.parentRunId != null
    || parentRun.delegationId != null) {
    invalidA4ParentPolicy();
  }
  let resolved: ReturnType<typeof resolveAgentRuntimeConfigSnapshot>;
  try {
    resolved = resolveAgentRuntimeConfigSnapshot(root.agentConfig, "main");
  } catch {
    invalidA4ParentPolicy();
  }
  const contract = getAgentDelegateContractForPromptVersion(resolved.prompt.version);
  if (!contract
    || resolved.prompt.key !== AGENT_MAIN_PROMPT_KEY
    || !resolved.execution.enabled
    || root.modelAlias !== resolved.execution.modelAlias
    || !resolved.modelProfile.capabilities.includes("tools")
    || canonicalizeIdempotencyRequest(root.delegation)
      !== canonicalizeIdempotencyRequest(contract.parentPolicySnapshot)) {
    invalidA4ParentPolicy();
  }
  const isExecutorGrant = granteeRole === "executor";
  const promptVersion = resolved.prompt.version;
  if (promptVersion === AGENT_MAIN_EXECUTOR_DELEGATION_TOOLS_PROMPT_VERSION) {
    // v10（Executor V3）：父 Run 是完整 ToolLoop Run，允许非零 spend 预算；
    // executor Grant 的实际 spend 上限由下方剩余额度钳制，非 executor
    // 提案任务仍保持零花费不变量。
    if (Number(parentRun.actualSpendMicros) !== 0 && !isExecutorGrant) {
      invalidA4ParentPolicy("父 Run 已产生模型花费，不得签发提案型 A4 DelegationGrant");
    }
    if (!isExecutorGrant && contract.policyVersion !== A4_DELEGATED_RUN_POLICY_VERSION_V2) {
      invalidA4ParentPolicy();
    }
    return contract;
  }
  // v4/v5：零花费不变量原样保留（父 Run 零预算、零实际花费、旧合同）。
  if (promptVersion !== AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION_V4
    && promptVersion !== AGENT_MAIN_DELEGATION_TOOLS_PROMPT_VERSION) {
    invalidA4ParentPolicy();
  }
  if (Number(parentRun.spendLimitMicros) !== 0
    || Number(parentRun.actualSpendMicros) !== 0) {
    invalidA4ParentPolicy();
  }
  if (contract.policyVersion === A4_DELEGATED_RUN_POLICY_VERSION_V3) {
    invalidA4ParentPolicy();
  }
  return contract;
}

function assertA4RequestedLimits(
  value: unknown,
  limits: DelegationLimits,
  contract: AgentDelegateContract,
): void {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const expectedKeys = ["maxDurationSeconds", "maxItems", "maxOutputCount", "maxToolCalls"];
  if (!equalStrings(Object.keys(record).sort(), expectedKeys)
    || limits.allowedModels !== undefined
    || limits.maxItems === undefined
    || limits.maxOutputCount === undefined
    || limits.maxDurationSeconds === undefined
    || limits.maxToolCalls > contract.parentPolicySnapshot.limits.maxToolCalls
    || limits.maxItems > contract.parentPolicySnapshot.limits.maxItems
    || limits.maxOutputCount > contract.parentPolicySnapshot.limits.maxOutputCount
    || limits.maxDurationSeconds > contract.parentPolicySnapshot.limits.maxDurationSeconds) {
    throw new AgentRuntimeError(409, "delegation_limits_invalid", "A4 DelegationGrant limits 超出父策略");
  }
}

function canonicalPositiveIds(values: readonly string[], field: string): number[] {
  return values.map((value) => {
    if (!/^[1-9]\d*$/.test(value)) {
      throw new AgentRuntimeError(409, "delegation_resource_scope_invalid", `${field} 包含无效对象 ID`);
    }
    const id = Number(value);
    if (!Number.isSafeInteger(id) || String(id) !== value) {
      throw new AgentRuntimeError(409, "delegation_resource_scope_invalid", `${field} 包含无效对象 ID`);
    }
    return id;
  });
}

async function assertAllScopedRows(
  query: Knex.QueryBuilder,
  expected: readonly string[],
  field: string,
): Promise<void> {
  if (expected.length === 0) return;
  const rows = await query;
  const found = new Set(rows.map((row: Record<string, unknown>) => String(row.id)));
  if (found.size !== expected.length || expected.some((id) => !found.has(id))) {
    throw new AgentRuntimeError(409, "delegation_resource_scope_invalid", `${field} 包含跨项目或不存在的对象`);
  }
}

async function assertTaskRefsResourceScopeOwnership(
  trx: Knex.Transaction,
  projectId: number,
  scope: DelegationResourceScope,
): Promise<void> {
  if ((scope.taskIds ?? []).length > 0) {
    throw new AgentRuntimeError(409, "delegation_resource_scope_invalid", "A4 task_refs 不授权 taskIds");
  }
  const scriptIds = canonicalPositiveIds(scope.scriptIds ?? [], "scriptIds");
  const assetIds = canonicalPositiveIds(scope.assetIds ?? [], "assetIds");
  const assetVersionIds = canonicalPositiveIds(scope.assetVersionIds ?? [], "assetVersionIds");
  const storyboardIds = canonicalPositiveIds(scope.storyboardIds ?? [], "storyboardIds");
  const canvasIds = canonicalPositiveIds(scope.canvasIds ?? [], "canvasIds");
  await assertAllScopedRows(
    trx("o_script").where({ projectId }).whereIn("id", scriptIds).select("id"),
    scriptIds.map(String),
    "scriptIds",
  );
  await assertAllScopedRows(
    trx("o_assets").where({ projectId }).whereIn("id", assetIds).select("id"),
    assetIds.map(String),
    "assetIds",
  );
  await assertAllScopedRows(
    trx("o_image as image")
      .join("o_assets as asset", "asset.id", "image.assetsId")
      .where("asset.projectId", projectId)
      .whereIn("image.id", assetVersionIds)
      .select({ id: "image.id" }),
    assetVersionIds.map(String),
    "assetVersionIds",
  );
  await assertAllScopedRows(
    trx("o_storyboard").where({ projectId }).whereIn("id", storyboardIds).select("id"),
    storyboardIds.map(String),
    "storyboardIds",
  );
  await assertAllScopedRows(
    trx("o_workflow_graph").where({ projectId }).whereIn("id", canvasIds).select("id"),
    canvasIds.map(String),
    "canvasIds",
  );
}

function intersectTools(
  requested: readonly ToolSelector[],
  parentSnapshot: readonly ToolSelector[],
  parentRole: AgentRole,
  granteeRole: DelegatedAgentRole,
  options: { enforceParentDirectPolicy?: boolean } = {},
): ToolId[] {
  const parentPolicy = DEFAULT_ROLE_POLICIES[parentRole];
  const granteePolicy = DEFAULT_ROLE_POLICIES[granteeRole];
  const enforceParentDirectPolicy = options.enforceParentDirectPolicy ?? true;
  return TOOL_IDS.filter((toolId) => (
    requested.some((selector) => matchesToolSelector(toolId, selector))
    && parentSnapshot.some((selector) => matchesToolSelector(toolId, selector))
    && (!enforceParentDirectPolicy || (
      parentPolicy.allowedTools.some((selector) => matchesToolSelector(toolId, selector))
      && !parentPolicy.deniedTools.some((selector) => matchesToolSelector(toolId, selector))
    ))
    && granteePolicy.allowedTools.some((selector) => matchesToolSelector(toolId, selector))
    && !granteePolicy.deniedTools.some((selector) => matchesToolSelector(toolId, selector))
  ));
}

function signaturePayload(grant: DelegationGrant): Record<string, unknown> {
  return {
    id: grant.id,
    version: grant.version,
    actorUserId: grant.actorUserId,
    workspaceId: grant.workspaceId,
    projectId: grant.projectId,
    sessionId: grant.sessionId ?? null,
    parentRunId: grant.parentRunId,
    parentStepId: grant.parentStepId,
    issuerRole: grant.issuerRole,
    granteeRole: grant.granteeRole,
    purpose: grant.purpose,
    objectiveHash: grant.objectiveHash,
    inputRefs: grant.inputRefs,
    outputContract: grant.outputContract,
    allowedTools: grant.allowedTools,
    resourceScope: grant.resourceScope,
    limits: grant.limits,
    spend: grant.spend,
    approval: grant.approval ?? null,
    idempotencyPrefix: grant.idempotencyPrefix,
    canDelegate: grant.canDelegate,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  };
}

function signGrant(grant: DelegationGrant, secret: Buffer): string {
  return createHmac("sha256", secret)
    .update(canonicalizeIdempotencyRequest(signaturePayload(grant)), "utf8")
    .digest("hex");
}

function secureEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function mapGrant(row: RawDelegationRow, secret: Buffer): DelegationGrantRecord {
  const version = integer(row.grantVersion, "grantVersion", { min: 1, max: 1, status: 500 });
  const issuerRole = normalizeRole(row.issuerRole, 500);
  if (issuerRole !== "main") {
    throw new AgentRuntimeError(500, "delegation_record_corrupt", "DelegationGrant 签发角色无效");
  }
  const granteeRole = normalizeDelegatedRole(row.granteeRole, 500);
  const status = String(row.status);
  if (!["active", "consumed", "revoked", "expired"].includes(status)) {
    throw new AgentRuntimeError(500, "delegation_record_corrupt", "DelegationGrant 状态无效");
  }
  const allowedTools = normalizeSelectors(parseJson(row.allowedTools, "allowedTools"), "allowedTools", 500);
  if (!allowedTools.every((selector) => !selector.includes("*"))) {
    throw new AgentRuntimeError(500, "delegation_record_corrupt", "持久化 Grant 必须使用精确 ToolId");
  }
  const approval = row.approvalId == null
    ? undefined
    : {
        approvalId: cleanString(row.approvalId, "approvalId", 500, 500),
        scopeHash: cleanString(row.approvalScopeHash, "approvalScopeHash", 500, 500),
        policyVersion: cleanString(row.approvalPolicyVersion, "approvalPolicyVersion", 500, 500),
      };
  if (row.approvalId == null && (row.approvalScopeHash != null || row.approvalPolicyVersion != null)) {
    throw new AgentRuntimeError(500, "delegation_record_corrupt", "Grant Approval 引用不完整");
  }
  if (Number(row.canDelegate) !== 0) {
    throw new AgentRuntimeError(500, "delegation_record_tampered", "DelegationGrant 禁止再次委派");
  }
  const grant: DelegationGrant = {
    id: String(row.id),
    version: version as 1,
    status: status as DelegationGrant["status"],
    actorUserId: integer(row.actorUserId, "actorUserId", { min: 1, status: 500 }),
    workspaceId: String(row.workspaceId),
    projectId: String(row.projectId),
    ...(row.sessionId == null ? {} : { sessionId: String(row.sessionId) }),
    parentRunId: String(row.parentRunId),
    parentStepId: String(row.parentStepId),
    issuerRole: "main",
    granteeRole,
    purpose: String(row.purpose),
    objectiveHash: String(row.objectiveHash),
    inputRefs: normalizeStringList(parseJson(row.inputRefs, "inputRefs"), "inputRefs", 200, 500),
    outputContract: String(row.outputContract),
    allowedTools,
    resourceScope: normalizeResourceScope(parseJson(row.resourceScope, "resourceScope"), 500),
    limits: normalizeLimits(parseJson(row.limits, "limits"), 500),
    spend: normalizeSpend(parseJson(row.spend, "spend"), 500),
    ...(approval ? { approval } : {}),
    idempotencyPrefix: String(row.idempotencyPrefix),
    canDelegate: false,
    issuedAt: integer(row.issuedAt, "issuedAt", { status: 500 }),
    expiresAt: integer(row.expiresAt, "expiresAt", { status: 500 }),
    ...(row.revokedAt == null ? {} : { revokedAt: integer(row.revokedAt, "revokedAt", { status: 500 }) }),
    signature: String(row.signature),
  };
  const expectedSignature = signGrant(grant, secret);
  if (!secureEqualHex(grant.signature, expectedSignature)) {
    throw new AgentRuntimeError(500, "delegation_record_tampered", "DelegationGrant 服务端签名校验失败");
  }
  return {
    ...grant,
    projectId: String(row.projectId),
    boundRunId: row.boundRunId == null ? null : String(row.boundRunId),
    consumedToolCalls: integer(row.consumedToolCalls, "consumedToolCalls", { status: 500 }),
    consumedEstimatedMicros: integer(row.consumedEstimatedMicros, "consumedEstimatedMicros", { status: 500 }),
    consumedActualMicros: integer(row.consumedActualMicros, "consumedActualMicros", { status: 500 }),
    revision: integer(row.revision, "revision", { min: 1, status: 500 }),
    updatedAt: integer(row.updatedAt, "updatedAt", { status: 500 }),
    ...(row.revokedBy == null ? {} : { revokedBy: integer(row.revokedBy, "revokedBy", { min: 1, status: 500 }) }),
  };
}

function taskBindingInvalid(): never {
  throw new AgentRuntimeError(
    500,
    "delegation_task_tampered",
    "Delegated AgentTask 与持久化 Grant 绑定校验失败",
  );
}

function mapVerifiedTask(
  row: RawDelegationRow,
  grant: DelegationGrantRecord,
  projectId: number,
  contract: AgentDelegateContract,
): Pick<VerifiedDelegatedRunGrant, "task" | "taskHash" | "taskStatus"> {
  if (Number(row.taskVersion) !== contract.taskVersion
    || typeof row.taskHash !== "string"
    || !/^[a-f0-9]{64}$/.test(row.taskHash)) {
    taskBindingInvalid();
  }
  const taskStatus = String(row.taskStatus || "");
  if (taskStatus !== "queued" && taskStatus !== "running") {
    throw new AgentRuntimeError(
      409,
      "delegation_task_inactive",
      "Delegated AgentTask 已不处于可执行状态",
    );
  }
  let task: AgentTask;
  try {
    task = contract.normalizeTask(parseJson(row.taskJson, "taskJson"), { expectedProjectId: projectId });
  } catch {
    taskBindingInvalid();
  }
  const taskHash = hashIdempotencyRequest(task);
  const expectedInputRefs = task.inputRefs
    .map((ref) => canonicalizeIdempotencyRequest(ref))
    .sort((left, right) => left.localeCompare(right));
  if (task.version !== contract.taskVersion
    || task.role !== grant.granteeRole
    || taskHash !== row.taskHash
    || grant.purpose !== `a4-delegated-task:${task.taskType}`
    || grant.objectiveHash !== hashIdempotencyRequest(task.objective)
    || grant.outputContract !== `${contract.outputContractPrefix}${taskHash}`
    || grant.inputRefs.length !== expectedInputRefs.length
    || grant.inputRefs.some((ref, index) => ref !== expectedInputRefs[index])) {
    taskBindingInvalid();
  }
  return { task, taskHash, taskStatus };
}

function normalizeResourceRefs(value: unknown): DelegationResourceRef[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 500) {
    throw new AgentRuntimeError(400, "delegation_resource_refs_invalid", "resourceRefs 必须是最多 500 项的数组");
  }
  const refs = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AgentRuntimeError(400, "delegation_resource_refs_invalid", "resourceRefs 格式无效");
    }
    const record = item as Record<string, unknown>;
    const type = String(record.type) as DelegationResourceType;
    if (!(RESOURCE_SCOPE_KEYS as readonly string[]).includes(type)) {
      throw new AgentRuntimeError(400, "delegation_resource_refs_invalid", "resourceRefs 包含未知资源类型");
    }
    return { type, id: cleanString(record.id, "resourceRefs[].id") };
  });
  const identities = refs.map((ref) => `${ref.type}:${ref.id}`);
  if (new Set(identities).size !== identities.length) {
    throw new AgentRuntimeError(400, "delegation_resource_refs_invalid", "resourceRefs 不能重复");
  }
  return refs.sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
}

function assertResourceRefsAllowed(grant: DelegationGrantRecord, refs: readonly DelegationResourceRef[]): void {
  for (const ref of refs) {
    if (!(grant.resourceScope[ref.type] ?? []).includes(ref.id)) {
      throw new AgentRuntimeError(403, "delegation_resource_not_allowed", "DelegationGrant 未授权该资源");
    }
  }
}

function usageRequestHash(input: {
  runId: string;
  toolId: ToolId;
  resourceRefs: readonly DelegationResourceRef[];
  estimatedMicros: number;
  actualMicros: number;
}): string {
  return hashIdempotencyRequest(input);
}

function mapUsage(
  row: RawUsageRow,
  grant: DelegationGrantRecord,
  replayed: boolean,
): DelegationGrantConsumption {
  let toolId: ToolId;
  try {
    assertToolId(row.toolId);
    toolId = row.toolId;
  } catch {
    throw new AgentRuntimeError(500, "delegation_usage_corrupt", "Delegation usage 工具无效");
  }
  return {
    id: String(row.id),
    grantId: String(row.grantId),
    runId: String(row.runId),
    toolId,
    resourceRefs: normalizeResourceRefs(parseJson(row.resourceRefs, "usage.resourceRefs")),
    estimatedMicros: integer(row.estimatedMicros, "estimatedMicros", { status: 500 }),
    actualMicros: integer(row.actualMicros, "actualMicros", { status: 500 }),
    callOrdinal: integer(row.callOrdinal, "callOrdinal", { min: 1, status: 500 }),
    consumedToolCalls: grant.consumedToolCalls,
    consumedEstimatedMicros: grant.consumedEstimatedMicros,
    consumedActualMicros: grant.consumedActualMicros,
    grantStatus: grant.status === "consumed" ? "consumed" : "active",
    grantRevision: grant.revision,
    replayed,
    createdAt: integer(row.createdAt, "createdAt", { status: 500 }),
  };
}

function affectedRows(value: unknown): number {
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.length;
  return Number(value || 0);
}

function revisionConflict(expectedRevision: number, currentRevision: number): AgentRuntimeError {
  return new AgentRuntimeError(409, "delegation_revision_conflict", "DelegationGrant 已被其他请求更新", {
    expectedRevision,
    currentRevision,
  });
}

async function assertCurrentProjectAccess(
  trx: Knex.Transaction,
  workspaceId: string,
  projectId: number,
  userId: number,
  permission: "project:read" | "project:write",
): Promise<void> {
  const project = await trx("o_project").where({ id: projectId, workspaceId }).select("id").first();
  if (!project) throw new AgentRuntimeError(404, "delegation_scope_not_found", "项目或 DelegationGrant 不存在");
  const authority = await resolveLiveWorkspacePermissions({
    database: trx,
    actorUserId: userId,
    workspaceId,
  });
  if (!hasExactAgentRuntimePermission(authority.permissions, permission)) {
    throw new AgentRuntimeError(403, "delegation_actor_forbidden", "用户不再具有当前项目权限");
  }
}

type TransactionOutcome<T> = { value: T } | { error: AgentRuntimeError };

export class DelegationGrantService {
  private readonly signingSecret: Buffer;
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly usageIdFactory: () => string;
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;

  constructor(
    private readonly database: Knex,
    options: DelegationGrantServiceOptions,
  ) {
    this.signingSecret = Buffer.isBuffer(options.signingSecret)
      ? Buffer.from(options.signingSecret)
      : Buffer.from(String(options.signingSecret || ""), "utf8");
    if (this.signingSecret.byteLength < 32) {
      throw new AgentRuntimeError(500, "delegation_signing_key_invalid", "DelegationGrant 签名密钥至少需要 32 字节");
    }
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `dg_${randomBytes(24).toString("base64url")}`);
    this.usageIdFactory = options.usageIdFactory ?? randomUUID;
    this.maxTtlMs = integer(options.maxTtlMs ?? AGENT_DELEGATION_MAX_TTL_MS, "maxTtlMs", { min: 1 });
    this.defaultTtlMs = integer(options.defaultTtlMs ?? AGENT_DELEGATION_DEFAULT_TTL_MS, "defaultTtlMs", {
      min: 1,
      max: this.maxTtlMs,
    });
  }

  async issue(input: IssueDelegationGrantInput): Promise<DelegationGrantRecord> {
    return this.database.transaction((trx) => this.issueInTransaction(trx, input));
  }

  async issueInTransaction(
    trx: Knex.Transaction,
    input: IssueDelegationGrantInput,
  ): Promise<DelegationGrantRecord> {
    const workspaceId = cleanString(input.workspaceId, "workspaceId");
    const projectId = integer(input.projectId, "projectId", { min: 1 });
    const parentRunId = cleanString(input.parentRunId, "parentRunId");
    const parentStepId = cleanString(input.parentStepId, "parentStepId");
    const granteeRole = normalizeDelegatedRole(input.granteeRole);
    const purpose = cleanString(input.purpose, "purpose", 1_000);
    const objective = cleanString(input.objective, "objective", 10_000);
    const inputRefs = normalizeStringList(input.inputRefs, "inputRefs");
    const outputContract = cleanString(input.outputContract, "outputContract", 4_000);
    const requestedTools = normalizeSelectors(input.requestedTools, "requestedTools");
    const requestedScope = normalizeResourceScope(input.resourceScope);
    const requestedLimits = normalizeLimits(input.limits);
    const requestedSpend = normalizeSpend(input.spend);
    const requestedTtlMs = integer(input.ttlMs ?? this.defaultTtlMs, "ttlMs", { min: 1 });
    const now = this.clock();
    const id = cleanString(this.idFactory(), "grantId");

    const parentRun = await trx("o_agent_run")
        .where({ id: parentRunId, workspaceId, projectId })
        .forUpdate()
        .first();
      if (!parentRun) throw new AgentRuntimeError(404, "parent_run_not_found", "父 Agent Run 不存在");
      if (String(parentRun.status) !== "running") {
        throw new AgentRuntimeError(409, "parent_run_inactive", "只有 running 父 Run 可以签发 DelegationGrant");
      }
      const parentRole = normalizeRole(parentRun.agentRole, 409);
      const parentRolePolicy = DEFAULT_ROLE_POLICIES[parentRole];
      if (!parentRolePolicy.canDelegate || !parentRolePolicy.delegateTo.includes(granteeRole)) {
        throw new AgentRuntimeError(403, "delegation_role_not_allowed", "父 Agent Role 无权委派给目标角色");
      }
      if (!DEFAULT_ROLE_POLICIES[granteeRole].requiresDelegationGrant || DEFAULT_ROLE_POLICIES[granteeRole].canDelegate) {
        throw new AgentRuntimeError(500, "delegation_role_policy_invalid", "目标 Role Policy 不满足最小委派约束");
      }

      const thread = await trx("o_agent_thread")
        .where({ id: parentRun.threadId, workspaceId, projectId, status: "active" })
        .select("id", "sessionId")
        .first();
      if (!thread) throw new AgentRuntimeError(409, "parent_thread_invalid", "父 Run 的 Thread 范围无效");
      const trigger = await trx("o_agent_message")
        .where({
          id: parentRun.triggerMessageId,
          runId: parentRun.id,
          threadId: parentRun.threadId,
          workspaceId,
          projectId,
        })
        .select("createdBy")
        .first();
      const actorUserId = Number(trigger?.createdBy || 0);
      if (!trigger || !Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
        throw new AgentRuntimeError(409, "parent_run_actor_invalid", "父 Run 缺少可验证的用户身份");
      }
      await assertCurrentProjectAccess(trx, workspaceId, projectId, actorUserId, "project:read");

      const parentStep = await trx("o_agent_step")
        .where({ id: parentStepId, runId: parentRunId, workspaceId, projectId })
        .select("id", "kind", "status")
        .first();
      if (!parentStep) throw new AgentRuntimeError(404, "parent_step_not_found", "父 Delegation Step 不存在");
      if (String(parentStep.kind) !== "delegation" || !["queued", "running", "waiting_external"].includes(String(parentStep.status))) {
        throw new AgentRuntimeError(409, "parent_step_invalid", "父 Step 不是可签发 Grant 的委派步骤");
      }

      const parsedParentSnapshot = parseRunPolicySnapshot(parentRun.policySnapshot);
      const parentSnapshot = parsedParentSnapshot.delegation;
      if (parentSnapshot.expiresAt !== undefined && parentSnapshot.expiresAt <= now) {
        throw new AgentRuntimeError(409, "parent_delegation_policy_expired", "父 Run 委派策略已过期");
      }
      const taskRefsMode = parentSnapshot.scopeMode === "task_refs";
      let allowedTools: ToolId[];
      let resourceScope: DelegationResourceScope;
      let limits: DelegationLimits;
      let spend: DelegationSpendLimit;
      if (taskRefsMode) {
        const contract = assertA4TaskRefsParentPolicy(parentRun, parsedParentSnapshot.root, granteeRole);
        if (!(contract.roles as readonly string[]).includes(granteeRole)) {
          throw new AgentRuntimeError(403, "delegation_role_not_allowed", "目标专项角色不属于父 Run 的固定委派契约");
        }
        const a4Role = granteeRole as A4DelegatedAgentRole;
        const exactRoleTools = contract.getR0ToolIds(a4Role);
        if (!equalStrings(requestedTools, exactRoleTools)) {
          throw new AgentRuntimeError(403, "delegation_tools_invalid", "A4 DelegationGrant 工具必须精确匹配角色固定清单");
        }
        // The immutable A4 contract is the parent's delegation authority.
        // A tool may be child-only (for example video.merge) and intentionally
        // denied from the main Agent's direct catalog without invalidating the
        // executor Grant. The grantee policy remains mandatory here.
        const intersected = intersectTools(
          requestedTools,
          parentSnapshot.allowedTools,
          parentRole,
          granteeRole,
          { enforceParentDirectPolicy: false },
        );
        if (!equalStrings([...intersected].sort(), [...exactRoleTools].sort())) {
          throw new AgentRuntimeError(403, "delegation_tools_empty", "角色策略已收紧，无法签发 A4 DelegationGrant");
        }
        if (input.approvalId != null) {
          throw new AgentRuntimeError(409, "delegation_approval_invalid", "A4 固定清单 DelegationGrant 不得引用审批");
        }
        assertA4RequestedLimits(input.limits, requestedLimits, contract);
        const isExecutorGrant = granteeRole === "executor";
        if (requestedSpend.currency !== "GU"
          || requestedSpend.reservationId !== undefined
          || (!isExecutorGrant && (
            requestedSpend.maxEstimatedMicros !== 0
            || requestedSpend.maxActualMicros !== 0
          ))
          || (isExecutorGrant && (
            requestedSpend.maxEstimatedMicros < 0
            || requestedSpend.maxActualMicros < 0
            || requestedSpend.maxEstimatedMicros > Number.MAX_SAFE_INTEGER
            || requestedSpend.maxActualMicros > Number.MAX_SAFE_INTEGER
          ))) {
          throw new AgentRuntimeError(409, "delegation_spend_invalid", isExecutorGrant
            ? "A4 executor DelegationGrant spend 上限无效"
            : "A4 R0-only DelegationGrant spend 必须为零");
        }
        await assertTaskRefsResourceScopeOwnership(trx, projectId, requestedScope);
        allowedTools = [...exactRoleTools];
        resourceScope = requestedScope;
        limits = requestedLimits;
        spend = requestedSpend;
      } else {
        allowedTools = intersectTools(requestedTools, parentSnapshot.allowedTools, parentRole, granteeRole);
        if (!allowedTools.length) {
          throw new AgentRuntimeError(403, "delegation_tools_empty", "父权限与目标 Role Policy 的工具交集为空");
        }
        resourceScope = intersectResourceScopes(requestedScope, parentSnapshot.resourceScope);
        limits = intersectLimits(requestedLimits, parentSnapshot.limits);
        spend = intersectSpend(requestedSpend, parentSnapshot.spend);
      }
      const parentSpendLimit = integer(parentRun.spendLimitMicros, "parentRun.spendLimitMicros", { status: 409 });
      const parentActualSpend = integer(parentRun.actualSpendMicros, "parentRun.actualSpendMicros", { status: 409 });
      const remainingParentSpend = Math.max(0, parentSpendLimit - parentActualSpend);
      spend = { ...spend, maxActualMicros: Math.min(spend.maxActualMicros, remainingParentSpend) };

      let approval: DelegationApprovalReference | undefined;
      let approvalExpiresAt: number | undefined;
      if (input.approvalId != null) {
        const approvalId = cleanString(input.approvalId, "approvalId");
        const approvalRow = await trx(AGENT_APPROVAL_TABLE)
          .where({ id: approvalId, workspaceId, projectId, runId: parentRunId, status: "approved" })
          .select("id", "scopeHash", "policyVersion", "expiresAt", "toolId")
          .first();
        if (!approvalRow || Number(approvalRow.expiresAt) <= now || !allowedTools.includes(String(approvalRow.toolId) as ToolId)) {
          throw new AgentRuntimeError(409, "delegation_approval_invalid", "Grant 引用的审批不存在、已过期或不匹配授权工具");
        }
        approval = {
          approvalId: String(approvalRow.id),
          scopeHash: String(approvalRow.scopeHash),
          policyVersion: String(approvalRow.policyVersion),
        };
        approvalExpiresAt = Number(approvalRow.expiresAt);
      }

      const effectiveMaxTtlMs = granteeRole === "executor"
        ? Math.max(this.maxTtlMs, AGENT_EXECUTOR_DELEGATION_MAX_TTL_MS)
        : this.maxTtlMs;
      const expiresAt = Math.min(
        now + Math.min(requestedTtlMs, effectiveMaxTtlMs),
        parentSnapshot.expiresAt ?? Number.MAX_SAFE_INTEGER,
        approvalExpiresAt ?? Number.MAX_SAFE_INTEGER,
      );
      if (expiresAt <= now) {
        throw new AgentRuntimeError(409, "delegation_expiry_invalid", "无法在父权限有效期内签发 Grant");
      }
      const baseGrant: DelegationGrant = {
        id,
        version: 1,
        status: "active",
        actorUserId,
        workspaceId,
        projectId: String(projectId),
        ...(thread.sessionId == null ? {} : { sessionId: String(thread.sessionId) }),
        parentRunId,
        parentStepId,
        issuerRole: "main",
        granteeRole,
        purpose,
        objectiveHash: hashIdempotencyRequest(objective),
        inputRefs,
        outputContract,
        allowedTools,
        resourceScope,
        limits,
        spend,
        ...(approval ? { approval } : {}),
        idempotencyPrefix: `agent-delegation:${id}`,
        canDelegate: false,
        issuedAt: now,
        expiresAt,
        signature: "",
      };
      const signature = signGrant(baseGrant, this.signingSecret);
      await trx(AGENT_DELEGATION_TABLE).insert({
        id,
        grantVersion: 1,
        status: "active",
        actorUserId,
        workspaceId,
        projectId,
        sessionId: baseGrant.sessionId ?? null,
        parentRunId,
        parentStepId,
        boundRunId: null,
        issuerRole: "main",
        granteeRole,
        purpose,
        objectiveHash: baseGrant.objectiveHash,
        inputRefs: JSON.stringify(inputRefs),
        outputContract,
        allowedTools: JSON.stringify(allowedTools),
        resourceScope: JSON.stringify(resourceScope),
        limits: JSON.stringify(limits),
        spend: JSON.stringify(spend),
        approvalId: approval?.approvalId ?? null,
        approvalScopeHash: approval?.scopeHash ?? null,
        approvalPolicyVersion: approval?.policyVersion ?? null,
        idempotencyPrefix: baseGrant.idempotencyPrefix,
        canDelegate: 0,
        issuedAt: now,
        expiresAt,
        revokedAt: null,
        revokedBy: null,
        consumedToolCalls: 0,
        consumedEstimatedMicros: 0,
        consumedActualMicros: 0,
        signature,
        revision: 1,
        updatedAt: now,
      });
    return this.readStored(trx, id);
  }

  async get(input: { grantId: string; workspaceId: string; projectId: number }): Promise<DelegationGrantRecord> {
    const row = await this.database<RawDelegationRow>(AGENT_DELEGATION_TABLE)
      .where({
        id: cleanString(input.grantId, "grantId"),
        workspaceId: cleanString(input.workspaceId, "workspaceId"),
        projectId: integer(input.projectId, "projectId", { min: 1 }),
      })
      .first();
    if (!row) throw new AgentRuntimeError(404, "delegation_not_found", "DelegationGrant 不存在");
    const grant = mapGrant(row, this.signingSecret);
    return grant.expiresAt <= this.clock() && grant.status === "active" ? { ...grant, status: "expired" } : grant;
  }

  /** Authenticated transactional read used by Coordinator replay validation. */
  async getInTransaction(
    trx: Knex.Transaction,
    input: { grantId: string; workspaceId: string; projectId: number },
  ): Promise<DelegationGrantRecord> {
    const row = await trx<RawDelegationRow>(AGENT_DELEGATION_TABLE)
      .where({
        id: cleanString(input.grantId, "grantId"),
        workspaceId: cleanString(input.workspaceId, "workspaceId"),
        projectId: integer(input.projectId, "projectId", { min: 1 }),
      })
      .first();
    if (!row) throw new AgentRuntimeError(404, "delegation_not_found", "DelegationGrant 不存在");
    const grant = mapGrant(row, this.signingSecret);
    return grant.expiresAt <= this.clock() && grant.status === "active" ? { ...grant, status: "expired" } : grant;
  }

  /**
   * Read-only A4 admission check used before catalog projection and again at
   * model dispatch. It authenticates the persisted Grant and the complete
   * parent/child/task binding without locking, binding, consuming quota or
   * changing an expired row's durable status. A consumed Grant remains valid
   * only as final-only model admission after its tool-call quota was exhausted;
   * ToolGateway must project an empty catalog and tool execution still rejects
   * every new call.
   */
  async verifyRunGrantInTransaction(
    trx: Knex.Transaction,
    input: VerifyDelegatedRunGrantInput,
    now = this.clock(),
  ): Promise<VerifiedDelegatedRunGrant> {
    const workspaceId = cleanString(input.workspaceId, "workspaceId");
    const projectId = integer(input.projectId, "projectId", { min: 1 });
    const grantId = cleanString(input.grantId, "grantId");
    const runId = cleanString(input.runId, "runId");
    const actorUserId = integer(input.actorUserId, "actorUserId", { min: 1 });
    const agentRole = normalizeDelegatedRole(input.agentRole);
    if (!(A4_DELEGATED_AGENT_ROLES as readonly string[]).includes(agentRole)) {
      throw new AgentRuntimeError(403, "delegation_role_mismatch", "A4 Delegated Run 角色无效");
    }
    const verifiedAt = integer(now, "now");

    const row = await trx<RawDelegationRow>(AGENT_DELEGATION_TABLE)
      .where({ id: grantId, workspaceId, projectId })
      .first();
    if (!row) throw new AgentRuntimeError(404, "delegation_not_found", "DelegationGrant 不存在");
    const grant = mapGrant(row, this.signingSecret);
    if (grant.status === "revoked" || grant.revokedAt !== undefined) {
      throw new AgentRuntimeError(403, "delegation_revoked", "DelegationGrant 已撤销");
    }
    if (grant.status === "expired" || grant.expiresAt <= verifiedAt) {
      throw new AgentRuntimeError(403, "delegation_expired", "DelegationGrant 已过期");
    }
    if ((grant.status !== "active" && grant.status !== "consumed") || grant.issuedAt > verifiedAt) {
      throw new AgentRuntimeError(403, "delegation_inactive", "DelegationGrant 当前不可用");
    }
    const toolQuotaExhausted = grant.consumedToolCalls === grant.limits.maxToolCalls;
    if ((grant.status === "consumed" && !toolQuotaExhausted)
      || (grant.status === "active" && grant.consumedToolCalls >= grant.limits.maxToolCalls)
      || grant.consumedEstimatedMicros > grant.spend.maxEstimatedMicros
      || grant.consumedActualMicros > grant.spend.maxActualMicros) {
      throw new AgentRuntimeError(
        500,
        "delegation_record_corrupt",
        "DelegationGrant 消费状态与固定限额不一致",
      );
    }
    if (grant.actorUserId !== actorUserId) {
      throw new AgentRuntimeError(403, "delegation_actor_mismatch", "DelegationGrant 不属于当前 Run 发起用户");
    }
    if (grant.workspaceId !== workspaceId || grant.projectId !== String(projectId)) {
      throw new AgentRuntimeError(403, "delegation_scope_mismatch", "DelegationGrant 工作区或项目范围不匹配");
    }
    if (grant.granteeRole !== agentRole) {
      throw new AgentRuntimeError(403, "delegation_role_mismatch", "DelegationGrant 与当前 Agent Role 不匹配");
    }
    if (grant.boundRunId !== runId) {
      throw new AgentRuntimeError(403, "delegation_run_mismatch", "DelegationGrant 未精确绑定当前 Run");
    }
    await assertCurrentProjectAccess(trx, workspaceId, projectId, actorUserId, "project:read");

    const childRun = await trx("o_agent_run")
      .where({ id: runId, workspaceId, projectId, delegationId: grant.id })
      .select(
        "id",
        "rootRunId",
        "parentRunId",
        "agentRole",
        "kind",
        "status",
        "threadId",
        "triggerMessageId",
      )
      .first();
    if (!childRun) throw new AgentRuntimeError(404, "delegated_run_not_found", "Delegated Run 不存在");
    if (String(childRun.parentRunId || "") !== grant.parentRunId
      || String(childRun.agentRole) !== grant.granteeRole
      || String(childRun.kind) !== "delegated") {
      throw new AgentRuntimeError(403, "delegated_run_scope_mismatch", "Delegated Run 与 Grant 不匹配");
    }
    if (!["queued", "running"].includes(String(childRun.status))) {
      throw new AgentRuntimeError(409, "delegated_run_inactive", "Delegated Run 已不处于可执行状态");
    }

    const parentRun = await trx("o_agent_run")
      .where({ id: grant.parentRunId, workspaceId, projectId })
      .select(
        "id",
        "rootRunId",
        "parentRunId",
        "delegationId",
        "agentRole",
        "kind",
        "status",
        "threadId",
        "triggerMessageId",
        "policySnapshot",
        "spendLimitMicros",
        "actualSpendMicros",
      )
      .first();
    if (!parentRun
      || String(parentRun.kind) !== "root"
      || String(parentRun.agentRole) !== "main"
      || parentRun.parentRunId != null
      || parentRun.delegationId != null
      || String(parentRun.rootRunId) !== grant.parentRunId
      || String(childRun.rootRunId) !== grant.parentRunId
      || String(parentRun.threadId) !== String(childRun.threadId)
      || !["running", "waiting_delegation"].includes(String(parentRun.status))) {
      throw new AgentRuntimeError(403, "delegation_parent_run_mismatch", "父 Run 与 Delegated Run 绑定无效");
    }
    const parsedParentSnapshot = parseRunPolicySnapshot(parentRun.policySnapshot);
    const parentContract = assertA4TaskRefsParentPolicy(parentRun, parsedParentSnapshot.root, agentRole);
    if (!(parentContract.roles as readonly string[]).includes(agentRole)) {
      throw new AgentRuntimeError(403, "delegation_role_mismatch", "Delegated Run 角色超出父 Run 的固定委派契约");
    }
    const parentStep = await trx("o_agent_step")
      .where({
        id: grant.parentStepId,
        runId: grant.parentRunId,
        workspaceId,
        projectId,
        kind: "delegation",
      })
      .select("id", "status")
      .first();
    if (!parentStep || !["running", "waiting_external"].includes(String(parentStep.status))) {
      throw new AgentRuntimeError(403, "delegation_parent_step_mismatch", "Delegation Step 与 Grant 不匹配");
    }

    const [childTrigger, parentTrigger, thread] = await Promise.all([
      trx("o_agent_message")
        .where({
          id: childRun.triggerMessageId,
          runId,
          threadId: childRun.threadId,
          workspaceId,
          projectId,
        })
        .select("createdBy")
        .first(),
      trx("o_agent_message")
        .where({
          id: parentRun.triggerMessageId,
          runId: grant.parentRunId,
          threadId: parentRun.threadId,
          workspaceId,
          projectId,
        })
        .select("createdBy")
        .first(),
      trx("o_agent_thread")
        .where({ id: childRun.threadId, workspaceId, projectId, status: "active" })
        .select("sessionId")
        .first(),
    ]);
    if (!childTrigger
      || !parentTrigger
      || Number(childTrigger.createdBy) !== actorUserId
      || Number(parentTrigger.createdBy) !== actorUserId) {
      throw new AgentRuntimeError(403, "delegation_actor_mismatch", "Delegated Run 发起用户与 Grant 不匹配");
    }
    const threadSessionId = thread?.sessionId == null ? undefined : String(thread.sessionId);
    if (!thread || grant.sessionId !== threadSessionId) {
      throw new AgentRuntimeError(403, "delegation_session_mismatch", "Delegated Run 会话范围与 Grant 不匹配");
    }

    const verifiedTask = mapVerifiedTask(row, grant, projectId, parentContract);
    return { grant, ...verifiedTask };
  }

  /**
   * Lock, authenticate and scope-check the Grant used by a ToolGateway call.
   * No quota is consumed until consumePreparedToolExecutionInTransaction is
   * invoked after evaluateToolPolicy has allowed the call.
   */
  async prepareToolExecutionInTransaction(
    trx: Knex.Transaction,
    input: DelegationGrantToolExecutionInput,
    now: number,
  ): Promise<PreparedDelegationGrantExecution> {
    const validated = await this.validateToolExecutionInTransaction(trx, input, now, false);
    if (validated.existing) {
      throw new AgentRuntimeError(
        409,
        "delegation_usage_already_recorded",
        "该 Grant 工具调用已记录，必须通过原 Step 幂等重放",
      );
    }
    const grant = validated.grant;
    if (grant.status !== "active") {
      throw new AgentRuntimeError(409, "delegation_consumed", "DelegationGrant 已消费完毕");
    }

    const nextToolCalls = grant.consumedToolCalls + 1;
    const nextEstimatedMicros = grant.consumedEstimatedMicros + validated.estimatedMicros;
    const nextActualMicros = grant.consumedActualMicros + validated.actualMicros;
    if (nextToolCalls > grant.limits.maxToolCalls) {
      throw new AgentRuntimeError(409, "delegation_tool_call_limit", "DelegationGrant 工具调用次数已用尽");
    }
    if (nextEstimatedMicros > grant.spend.maxEstimatedMicros) {
      throw new AgentRuntimeError(409, "delegation_estimated_budget_exceeded", "DelegationGrant 预估预算不足");
    }
    if (nextActualMicros > grant.spend.maxActualMicros) {
      throw new AgentRuntimeError(409, "delegation_actual_budget_exceeded", "DelegationGrant 实际预算不足");
    }

    return {
      grant,
      workspaceId: validated.workspaceId,
      projectId: validated.projectId,
      runId: validated.runId,
      toolId: validated.toolId,
      resourceRefs: validated.resourceRefs,
      estimatedMicros: validated.estimatedMicros,
      actualMicros: validated.actualMicros,
      idempotencyKey: validated.idempotencyKey,
      requestHash: validated.requestHash,
      nextToolCalls,
      nextEstimatedMicros,
      nextActualMicros,
      nextStatus: nextToolCalls >= grant.limits.maxToolCalls ? "consumed" : "active",
    };
  }

  /**
   * Read-only authenticated admission check for a future deterministic
   * executor. It reuses the Tool execution verifier (signature, actor, current
   * project access, child Run, Thread/session, role/tool/resource/Approval and
   * idempotency) and additionally proves the immutable parent Run +
   * Delegation Step topology. It never binds a Run, records usage or consumes
   * quota; dispatch must later call prepare + consume in its write transaction.
   */
  async verifyToolExecutionPreflightInTransaction(
    trx: Knex.Transaction,
    input: DelegationGrantToolExecutionInput,
    now: number,
  ): Promise<DelegationGrantRecord> {
    const validated = await this.validateToolExecutionInTransaction(trx, input, now, false, false);
    if (validated.existing) {
      throw new AgentRuntimeError(
        409,
        "delegation_usage_already_recorded",
        "该 Grant 幂等执行已存在，预检不得再次派发",
      );
    }
    const grant = validated.grant;
    if (grant.status !== "active") {
      throw new AgentRuntimeError(409, "delegation_consumed", "DelegationGrant 已消费完毕");
    }

    const childRun = await trx("o_agent_run")
      .where({
        id: validated.runId,
        workspaceId: validated.workspaceId,
        projectId: validated.projectId,
        delegationId: grant.id,
      })
      .select("id", "rootRunId", "parentRunId", "threadId", "triggerMessageId", "agentRole", "kind", "status")
      .first();
    const parentRun = await trx("o_agent_run")
      .where({
        id: grant.parentRunId,
        workspaceId: validated.workspaceId,
        projectId: validated.projectId,
      })
      .select(
        "id",
        "rootRunId",
        "parentRunId",
        "delegationId",
        "threadId",
        "triggerMessageId",
        "agentRole",
        "kind",
        "status",
      )
      .first();
    if (!childRun
      || !parentRun
      || String(childRun.parentRunId || "") !== grant.parentRunId
      || String(childRun.rootRunId || "") !== grant.parentRunId
      || String(childRun.threadId || "") !== String(parentRun.threadId || "")
      || String(childRun.agentRole) !== grant.granteeRole
      || String(childRun.kind) !== "delegated"
      || String(childRun.status) !== "running"
      || String(parentRun.rootRunId || "") !== grant.parentRunId
      || parentRun.parentRunId != null
      || parentRun.delegationId != null
      || String(parentRun.agentRole) !== "main"
      || String(parentRun.kind) !== "root"
      || !["running", "waiting_delegation"].includes(String(parentRun.status))) {
      throw new AgentRuntimeError(403, "delegation_parent_run_mismatch", "父 Run 与 Executor Grant 绑定无效");
    }

    const [parentStep, parentTrigger] = await Promise.all([
      trx("o_agent_step")
        .where({
          id: grant.parentStepId,
          runId: grant.parentRunId,
          workspaceId: validated.workspaceId,
          projectId: validated.projectId,
          kind: "delegation",
        })
        .select("id", "status")
        .first(),
      trx("o_agent_message")
        .where({
          id: parentRun.triggerMessageId,
          runId: grant.parentRunId,
          threadId: parentRun.threadId,
          workspaceId: validated.workspaceId,
          projectId: validated.projectId,
        })
        .select("createdBy")
        .first(),
    ]);
    if (!parentStep || !["running", "waiting_external"].includes(String(parentStep.status))) {
      throw new AgentRuntimeError(403, "delegation_parent_step_mismatch", "Delegation Step 与 Executor Grant 不匹配");
    }
    if (!parentTrigger || Number(parentTrigger.createdBy) !== grant.actorUserId) {
      throw new AgentRuntimeError(403, "delegation_actor_mismatch", "父 Run 发起用户与 Executor Grant 不匹配");
    }
    return grant;
  }

  /** Atomically bind the Run and consume the quota prepared above. */
  async consumePreparedToolExecutionInTransaction(
    trx: Knex.Transaction,
    prepared: PreparedDelegationGrantExecution,
    now: number,
  ): Promise<DelegationGrantConsumption> {
    const grant = prepared.grant;
    const updated = await trx(AGENT_DELEGATION_TABLE)
      .where({ id: grant.id, revision: grant.revision, status: "active" })
      .where((builder) => builder.whereNull("boundRunId").orWhere("boundRunId", prepared.runId))
      .update({
        boundRunId: prepared.runId,
        status: prepared.nextStatus,
        consumedToolCalls: prepared.nextToolCalls,
        consumedEstimatedMicros: prepared.nextEstimatedMicros,
        consumedActualMicros: prepared.nextActualMicros,
        revision: grant.revision + 1,
        updatedAt: now,
      });
    if (affectedRows(updated) !== 1) {
      throw revisionConflict(grant.revision, grant.revision + 1);
    }

    const usageId = cleanString(this.usageIdFactory(), "usageId");
    await trx(AGENT_DELEGATION_USAGE_TABLE).insert({
      id: usageId,
      workspaceId: prepared.workspaceId,
      projectId: prepared.projectId,
      grantId: grant.id,
      runId: prepared.runId,
      idempotencyKey: prepared.idempotencyKey,
      requestHash: prepared.requestHash,
      toolId: prepared.toolId,
      resourceRefs: JSON.stringify(prepared.resourceRefs),
      estimatedMicros: prepared.estimatedMicros,
      actualMicros: prepared.actualMicros,
      callOrdinal: prepared.nextToolCalls,
      createdAt: now,
    });
    const updatedGrant = await this.readStored(trx, grant.id);
    const usage = await trx<RawUsageRow>(AGENT_DELEGATION_USAGE_TABLE).where({ id: usageId }).first();
    if (!usage) throw new AgentRuntimeError(500, "delegation_usage_save_failed", "Grant usage 保存后无法读取");
    return mapUsage(usage, updatedGrant, false);
  }

  /**
   * Re-authorize an already-audited Step without charging quota again.  A
   * consumed Grant is accepted only when the exact persisted usage record is
   * present; revoked/expired/tampered Grants still fail closed.
   */
  async verifyToolReplayInTransaction(
    trx: Knex.Transaction,
    input: DelegationGrantToolExecutionInput,
    now: number,
  ): Promise<DelegationGrantRecord> {
    const validated = await this.validateToolExecutionInTransaction(trx, input, now, true);
    if (validated.grant.status === "consumed" && !validated.existing) {
      throw new AgentRuntimeError(409, "delegation_consumed", "DelegationGrant 已消费完毕");
    }
    return validated.grant;
  }

  private async validateToolExecutionInTransaction(
    trx: Knex.Transaction,
    input: DelegationGrantToolExecutionInput,
    now: number,
    replay: boolean,
    persistExpired = true,
  ): Promise<{
    grant: DelegationGrantRecord;
    workspaceId: string;
    projectId: number;
    runId: string;
    toolId: ToolId;
    resourceRefs: DelegationResourceRef[];
    estimatedMicros: number;
    actualMicros: number;
    idempotencyKey: string;
    requestHash: string;
    existing: RawUsageRow | null;
  }> {
    const workspaceId = cleanString(input.workspaceId, "workspaceId");
    const projectId = integer(input.projectId, "projectId", { min: 1 });
    const grantId = cleanString(input.grantId, "grantId");
    const runId = cleanString(input.runId, "runId");
    const actorUserId = integer(input.actorUserId, "actorUserId", { min: 1 });
    const agentRole = normalizeRole(input.agentRole);
    let toolId: ToolId;
    try {
      assertToolId(input.toolId);
      toolId = input.toolId;
    } catch {
      throw new AgentRuntimeError(400, "delegation_tool_invalid", "工具必须是 canonical ToolId");
    }
    const resourceRefs = normalizeResourceRefs(input.resourceRefs);
    const estimatedMicros = integer(input.estimatedMicros ?? 0, "estimatedMicros");
    const actualMicros = integer(input.actualMicros ?? 0, "actualMicros");
    const idempotencyKey = cleanString(input.idempotencyKey, "idempotencyKey", 200);
    const requestHash = usageRequestHash({ runId, toolId, resourceRefs, estimatedMicros, actualMicros });

    const row = await trx<RawDelegationRow>(AGENT_DELEGATION_TABLE)
      .where({ id: grantId, workspaceId, projectId })
      .forUpdate()
      .first();
    if (!row) throw new AgentRuntimeError(404, "delegation_not_found", "DelegationGrant 不存在");
    const grant = mapGrant(row, this.signingSecret);
    if (grant.status === "revoked") {
      throw new AgentRuntimeError(403, "delegation_revoked", "DelegationGrant 已撤销");
    }
    if (grant.expiresAt <= now || grant.status === "expired") {
      if (persistExpired && grant.status === "active") {
        await trx(AGENT_DELEGATION_TABLE)
          .where({ id: grant.id, revision: grant.revision, status: "active" })
          .update({ status: "expired", revision: grant.revision + 1, updatedAt: now });
      }
      throw new AgentRuntimeError(403, "delegation_expired", "DelegationGrant 已过期");
    }
    if (grant.actorUserId !== actorUserId) {
      throw new AgentRuntimeError(403, "delegation_actor_mismatch", "DelegationGrant 不属于当前 Run 发起用户");
    }
    if (grant.workspaceId !== workspaceId || grant.projectId !== String(projectId)) {
      throw new AgentRuntimeError(403, "delegation_scope_mismatch", "DelegationGrant 工作区或项目范围不匹配");
    }
    if (grant.granteeRole !== agentRole) {
      throw new AgentRuntimeError(403, "delegation_role_mismatch", "DelegationGrant 与当前 Agent Role 不匹配");
    }
    await assertCurrentProjectAccess(trx, workspaceId, projectId, actorUserId, "project:read");

    const childRun = await trx("o_agent_run")
      .where({ id: runId, workspaceId, projectId, delegationId: grant.id })
      .select("id", "parentRunId", "agentRole", "kind", "status", "threadId", "triggerMessageId")
      .first();
    if (!childRun) throw new AgentRuntimeError(404, "delegated_run_not_found", "Delegated Run 不存在");
    if (String(childRun.parentRunId) !== grant.parentRunId
      || String(childRun.agentRole) !== grant.granteeRole
      || String(childRun.kind) !== "delegated") {
      throw new AgentRuntimeError(403, "delegated_run_scope_mismatch", "Delegated Run 与 Grant 不匹配");
    }
    if (!replay && String(childRun.status) !== "running") {
      throw new AgentRuntimeError(409, "delegated_run_inactive", "只有 running Delegated Run 可以消费 Grant");
    }
    const trigger = await trx("o_agent_message")
      .where({
        id: childRun.triggerMessageId,
        runId,
        threadId: childRun.threadId,
        workspaceId,
        projectId,
      })
      .select("createdBy")
      .first();
    if (!trigger || Number(trigger.createdBy) !== grant.actorUserId) {
      throw new AgentRuntimeError(403, "delegation_actor_mismatch", "Delegated Run 发起用户与 Grant 不匹配");
    }
    const thread = await trx("o_agent_thread")
      .where({ id: childRun.threadId, workspaceId, projectId, status: "active" })
      .select("sessionId")
      .first();
    if (!thread || (grant.sessionId !== undefined && String(thread.sessionId || "") !== grant.sessionId)) {
      throw new AgentRuntimeError(403, "delegation_session_mismatch", "Delegated Run 会话范围与 Grant 不匹配");
    }
    if (grant.boundRunId && grant.boundRunId !== runId) {
      throw new AgentRuntimeError(403, "delegation_run_mismatch", "DelegationGrant 已绑定其他 Run");
    }
    if (!grant.allowedTools.includes(toolId)) {
      throw new AgentRuntimeError(403, "delegation_tool_not_allowed", "DelegationGrant 未授权该工具");
    }
    const currentRolePolicy = DEFAULT_ROLE_POLICIES[grant.granteeRole];
    if (!currentRolePolicy.allowedTools.some((selector) => matchesToolSelector(toolId, selector))
      || currentRolePolicy.deniedTools.some((selector) => matchesToolSelector(toolId, selector))) {
      throw new AgentRuntimeError(403, "delegation_role_policy_changed", "当前 Role Policy 已不再允许该工具");
    }
    assertResourceRefsAllowed(grant, resourceRefs);

    const existing = await trx<RawUsageRow>(AGENT_DELEGATION_USAGE_TABLE)
      .where({ grantId: grant.id, idempotencyKey })
      .first() ?? null;
    if (existing && String(existing.requestHash) !== requestHash) {
      throw new AgentRuntimeError(409, "delegation_idempotency_conflict", "幂等键已被不同调用使用");
    }
    if (grant.status === "consumed" && !(replay && existing)) {
      throw new AgentRuntimeError(409, "delegation_consumed", "DelegationGrant 已消费完毕");
    }
    if (grant.approval) {
      const approval = await trx(AGENT_APPROVAL_TABLE)
        .where({
          id: grant.approval.approvalId,
          workspaceId,
          projectId,
          runId: grant.parentRunId,
          toolId,
          scopeHash: grant.approval.scopeHash,
          policyVersion: grant.approval.policyVersion,
        })
        .whereIn("status", replay && existing ? ["approved", "consumed"] : ["approved"])
        .select("expiresAt")
        .first();
      if (!approval || Number(approval.expiresAt) <= now) {
        throw new AgentRuntimeError(403, "delegation_approval_invalid", "Grant 引用的精确审批已失效");
      }
    }

    return {
      grant,
      workspaceId,
      projectId,
      runId,
      toolId,
      resourceRefs,
      estimatedMicros,
      actualMicros,
      idempotencyKey,
      requestHash,
      existing,
    };
  }

  async consume(input: ConsumeDelegationGrantInput): Promise<DelegationGrantConsumption> {
    const workspaceId = cleanString(input.workspaceId, "workspaceId");
    const projectId = integer(input.projectId, "projectId", { min: 1 });
    const grantId = cleanString(input.grantId, "grantId");
    const runId = cleanString(input.runId, "runId");
    let toolId: ToolId;
    try {
      assertToolId(input.toolId);
      toolId = input.toolId;
    } catch {
      throw new AgentRuntimeError(400, "delegation_tool_invalid", "工具必须是 canonical ToolId");
    }
    const resourceRefs = normalizeResourceRefs(input.resourceRefs);
    const estimatedMicros = integer(input.estimatedMicros ?? 0, "estimatedMicros");
    const actualMicros = integer(input.actualMicros ?? 0, "actualMicros");
    const idempotencyKey = cleanString(input.idempotencyKey, "idempotencyKey", 200);
    const requestHash = usageRequestHash({ runId, toolId, resourceRefs, estimatedMicros, actualMicros });
    const now = this.clock();

    const outcome = await this.database.transaction<TransactionOutcome<DelegationGrantConsumption>>(async (trx) => {
      const row = await trx<RawDelegationRow>(AGENT_DELEGATION_TABLE)
        .where({ id: grantId, workspaceId, projectId })
        .forUpdate()
        .first();
      if (!row) throw new AgentRuntimeError(404, "delegation_not_found", "DelegationGrant 不存在");
      let grant = mapGrant(row, this.signingSecret);

      if (grant.status === "revoked") {
        return { error: new AgentRuntimeError(403, "delegation_revoked", "DelegationGrant 已撤销") };
      }
      if (grant.expiresAt <= now || grant.status === "expired") {
        if (grant.status === "active") {
          await trx(AGENT_DELEGATION_TABLE)
            .where({ id: grant.id, revision: grant.revision, status: "active" })
            .update({ status: "expired", revision: grant.revision + 1, updatedAt: now });
        }
        return { error: new AgentRuntimeError(403, "delegation_expired", "DelegationGrant 已过期") };
      }
      await assertCurrentProjectAccess(trx, workspaceId, projectId, grant.actorUserId, "project:read");

      const childRun = await trx("o_agent_run")
        .where({ id: runId, workspaceId, projectId, delegationId: grant.id })
        .select("id", "parentRunId", "agentRole", "kind", "status")
        .first();
      if (!childRun) throw new AgentRuntimeError(404, "delegated_run_not_found", "Delegated Run 不存在");
      if (String(childRun.parentRunId) !== grant.parentRunId
        || String(childRun.agentRole) !== grant.granteeRole
        || String(childRun.kind) !== "delegated") {
        return { error: new AgentRuntimeError(403, "delegated_run_scope_mismatch", "Delegated Run 与 Grant 不匹配") };
      }
      if (grant.boundRunId && grant.boundRunId !== runId) {
        return { error: new AgentRuntimeError(403, "delegation_run_mismatch", "DelegationGrant 已绑定其他 Run") };
      }
      if (!grant.allowedTools.includes(toolId)) {
        return { error: new AgentRuntimeError(403, "delegation_tool_not_allowed", "DelegationGrant 未授权该工具") };
      }
      const currentRolePolicy = DEFAULT_ROLE_POLICIES[grant.granteeRole];
      if (!currentRolePolicy.allowedTools.some((selector) => matchesToolSelector(toolId, selector))
        || currentRolePolicy.deniedTools.some((selector) => matchesToolSelector(toolId, selector))) {
        return { error: new AgentRuntimeError(403, "delegation_role_policy_changed", "当前 Role Policy 已不再允许该工具") };
      }
      if (grant.approval) {
        const approval = await trx(AGENT_APPROVAL_TABLE)
          .where({
            id: grant.approval.approvalId,
            workspaceId,
            projectId,
            runId: grant.parentRunId,
            toolId,
            scopeHash: grant.approval.scopeHash,
            policyVersion: grant.approval.policyVersion,
            status: "approved",
          })
          .select("expiresAt")
          .first();
        if (!approval || Number(approval.expiresAt) <= now) {
          return { error: new AgentRuntimeError(403, "delegation_approval_invalid", "Grant 引用的精确审批已失效") };
        }
      }
      assertResourceRefsAllowed(grant, resourceRefs);

      const existing = await trx<RawUsageRow>(AGENT_DELEGATION_USAGE_TABLE)
        .where({ grantId: grant.id, idempotencyKey })
        .first();
      if (existing) {
        if (String(existing.requestHash) !== requestHash) {
          return { error: new AgentRuntimeError(409, "delegation_idempotency_conflict", "幂等键已被不同调用使用") };
        }
        if (!["active", "consumed"].includes(grant.status)) {
          return { error: new AgentRuntimeError(403, "delegation_inactive", "DelegationGrant 当前不可用") };
        }
        return { value: mapUsage(existing, grant, true) };
      }

      if (grant.status !== "active") {
        return { error: new AgentRuntimeError(409, "delegation_consumed", "DelegationGrant 已消费完毕") };
      }
      if (String(childRun.status) !== "running") {
        return { error: new AgentRuntimeError(409, "delegated_run_inactive", "只有 running Delegated Run 可以消费 Grant") };
      }
      const nextToolCalls = grant.consumedToolCalls + 1;
      const nextEstimatedMicros = grant.consumedEstimatedMicros + estimatedMicros;
      const nextActualMicros = grant.consumedActualMicros + actualMicros;
      if (nextToolCalls > grant.limits.maxToolCalls) {
        return { error: new AgentRuntimeError(409, "delegation_tool_call_limit", "DelegationGrant 工具调用次数已用尽") };
      }
      if (nextEstimatedMicros > grant.spend.maxEstimatedMicros) {
        return { error: new AgentRuntimeError(409, "delegation_estimated_budget_exceeded", "DelegationGrant 预估预算不足") };
      }
      if (nextActualMicros > grant.spend.maxActualMicros) {
        return { error: new AgentRuntimeError(409, "delegation_actual_budget_exceeded", "DelegationGrant 实际预算不足") };
      }

      const nextStatus = nextToolCalls >= grant.limits.maxToolCalls ? "consumed" : "active";
      const updated = await trx(AGENT_DELEGATION_TABLE)
        .where({ id: grant.id, revision: grant.revision, status: "active" })
        .where((builder) => builder.whereNull("boundRunId").orWhere("boundRunId", runId))
        .update({
          boundRunId: runId,
          status: nextStatus,
          consumedToolCalls: nextToolCalls,
          consumedEstimatedMicros: nextEstimatedMicros,
          consumedActualMicros: nextActualMicros,
          revision: grant.revision + 1,
          updatedAt: now,
        });
      if (affectedRows(updated) !== 1) {
        return { error: revisionConflict(grant.revision, grant.revision + 1) };
      }
      const usageId = cleanString(this.usageIdFactory(), "usageId");
      await trx(AGENT_DELEGATION_USAGE_TABLE).insert({
        id: usageId,
        workspaceId,
        projectId,
        grantId: grant.id,
        runId,
        idempotencyKey,
        requestHash,
        toolId,
        resourceRefs: JSON.stringify(resourceRefs),
        estimatedMicros,
        actualMicros,
        callOrdinal: nextToolCalls,
        createdAt: now,
      });
      grant = await this.readStored(trx, grant.id);
      const usage = await trx<RawUsageRow>(AGENT_DELEGATION_USAGE_TABLE).where({ id: usageId }).first();
      if (!usage) throw new AgentRuntimeError(500, "delegation_usage_save_failed", "Grant usage 保存后无法读取");
      return { value: mapUsage(usage, grant, false) };
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  async revoke(input: {
    grantId: string;
    workspaceId: string;
    projectId: number;
    revokedBy: number;
    expectedRevision: number;
  }): Promise<DelegationGrantRecord> {
    const outcome = await this.database.transaction<TransactionOutcome<DelegationGrantRecord>>(async (trx) => {
      try {
        return { value: await this.revokeInTransaction(trx, input) };
      } catch (error) {
        if (error instanceof AgentRuntimeError) return { error };
        throw error;
      }
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  /**
   * Transactional revoke used by orchestration services that already own the
   * parent/child lock order.  Keeping the mutation inside the caller's
   * transaction prevents a cancellation from committing only half of the
   * Run/Grant/task state.
   */
  async revokeInTransaction(
    trx: Knex.Transaction,
    input: {
      grantId: string;
      workspaceId: string;
      projectId: number;
      revokedBy: number;
      expectedRevision: number;
      now?: number;
    },
  ): Promise<DelegationGrantRecord> {
    const now = integer(input.now ?? this.clock(), "now");
    const row = await trx<RawDelegationRow>(AGENT_DELEGATION_TABLE)
      .where({
        id: cleanString(input.grantId, "grantId"),
        workspaceId: cleanString(input.workspaceId, "workspaceId"),
        projectId: integer(input.projectId, "projectId", { min: 1 }),
      })
      .forUpdate()
      .first();
    if (!row) throw new AgentRuntimeError(404, "delegation_not_found", "DelegationGrant 不存在");
    const grant = mapGrant(row, this.signingSecret);
    const expectedRevision = integer(input.expectedRevision, "expectedRevision", { min: 1 });
    if (grant.revision !== expectedRevision) throw revisionConflict(expectedRevision, grant.revision);
    if (grant.status !== "active") {
      throw new AgentRuntimeError(409, "delegation_not_revocable", "只有 active Grant 可以撤销");
    }
    if (grant.expiresAt <= now) {
      const expired = await trx(AGENT_DELEGATION_TABLE)
        .where({ id: grant.id, revision: grant.revision, status: "active" })
        .update({ status: "expired", revision: grant.revision + 1, updatedAt: now });
      if (affectedRows(expired) !== 1) throw revisionConflict(expectedRevision, grant.revision);
      throw new AgentRuntimeError(409, "delegation_expired", "DelegationGrant 已过期");
    }
    const revokedBy = integer(input.revokedBy, "revokedBy", { min: 1 });
    await assertCurrentProjectAccess(trx, grant.workspaceId, Number(grant.projectId), revokedBy, "project:write");
    const updated = await trx(AGENT_DELEGATION_TABLE)
      .where({ id: grant.id, revision: grant.revision, status: "active" })
      .update({
        status: "revoked",
        revokedAt: now,
        revokedBy,
        revision: grant.revision + 1,
        updatedAt: now,
      });
    if (affectedRows(updated) !== 1) throw revisionConflict(expectedRevision, grant.revision);
    return this.readStored(trx, grant.id);
  }

  private async readStored(trx: Knex.Transaction, id: string): Promise<DelegationGrantRecord> {
    const row = await trx<RawDelegationRow>(AGENT_DELEGATION_TABLE).where({ id }).first();
    if (!row) throw new AgentRuntimeError(500, "delegation_save_failed", "DelegationGrant 保存后无法读取");
    return mapGrant(row, this.signingSecret);
  }
}
