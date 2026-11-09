import { randomUUID } from "node:crypto";
import { assertMembershipTool } from "@/lib/membershipAccess";
import { MembershipError } from "@/lib/membershipCatalog";
import type { Knex } from "knex";
import type { AgentApprovalService } from "@/agent-runtime/approvalService";
import { logger } from "@/lib/logger";
import type {
  AgentApprovalImpactSummary,
  AgentApprovalQuote,
  AgentApprovalRiskClass,
} from "@/agent-runtime/approvalService";
import { AGENT_ROLES, type AgentRole } from "@/agent-runtime/contracts";
import {
  A4_DELEGATED_AGENT_ROLES,
  type A4DelegatedAgentRole,
  type AgentTask,
} from "@/agent-runtime/delegationContracts";
import type {
  DelegationGrantService,
  VerifiedDelegatedRunGrant,
} from "@/agent-runtime/delegationGrantService";
import { parseA4DelegatedRunPolicySnapshot } from "@/agent-runtime/delegatedRunPolicy";
import { DEFAULT_ROLE_POLICIES } from "@/agent-runtime/defaultRolePolicies";
import { toAgentStepDto } from "@/agent-runtime/dto";
import { isAgentRuntimeError } from "@/agent-runtime/errors";
import { appendAgentEvent } from "@/agent-runtime/eventStore";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { isSafeR0ModelTool, mayExposeMainAgentModelTool } from "@/agent-runtime/modelToolExposure";
import {
  publicAgentMessageContextSnapshot,
  type AgentMessageGenerationPreferences,
} from "@/agent-runtime/messageContextSnapshot";
import { resolveAgentRuntimeConfigSnapshot } from "@/agent-runtime/runtimeConfigRegistry";
import { mapAgentStep } from "@/agent-runtime/stepMapper";
import {
  authorizeTool,
  loadCurrentToolPermissions,
  type AuthorizedToolCall,
} from "@/agent-runtime/tools/authorizeTool";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import { CAPABILITY_CATALOG_TOOLS } from "@/agent-runtime/tools/packages/capability";
import { CONTEXT_SNAPSHOT_GET_TOOL } from "@/agent-runtime/tools/packages/context";
import {
  AGENT_DELEGATE_TOOL,
  getAgentDelegateContractForPromptVersion,
  getAgentDelegationPersistenceContractForPolicyVersion,
  type AgentDelegationPersistenceContract,
} from "@/agent-runtime/tools/packages/delegation";
import { GENERATION_QUOTE_TOOL } from "@/agent-runtime/tools/packages/generation";
import { GENERATION_SUBMIT_TOOLS } from "@/agent-runtime/tools/packages/generation";
import { GENERATION_TASK_TOOLS } from "@/agent-runtime/tools/packages/generationTasks";
import { DELIVERY_PREVIEW_TOOL } from "@/agent-runtime/tools/packages/delivery";
import { VIDEO_MERGE_TOOL } from "@/agent-runtime/tools/packages/video";
import { ASSET_QUERY_TOOLS } from "@/agent-runtime/tools/packages/asset";
import { CANVAS_COMMANDS_APPLY_TOOL, CANVAS_GET_TOOL } from "@/agent-runtime/tools/packages/canvas";
import { PROJECT_GET_TOOL, PROJECT_UPDATE_TOOL } from "@/agent-runtime/tools/packages/project";
import { SCRIPT_DRAFT_TOOLS, SCRIPT_QUERY_TOOLS } from "@/agent-runtime/tools/packages/script";
import { SESSION_TOOLS } from "@/agent-runtime/tools/packages/session";
import { STORYBOARD_QUERY_TOOLS } from "@/agent-runtime/tools/packages/storyboard";
import { PLAN_PRESENT_TOOL } from "@/agent-runtime/tools/packages/plan";
import { matchesToolSelector, type ToolId } from "@/agent-runtime/toolIds";
import {
  AgentToolRegistry,
  type AgentToolCatalogDefinition,
  type AgentToolAuthorizationContext,
  type AgentToolAuthorizationEvidence,
  type AgentToolHandlerContext,
  type RegisteredAgentTool,
} from "@/agent-runtime/tools/registry";
import { DurableCommandIdempotencyError } from "@/lib/durableCommandIdempotency";
import { hasExactAgentRuntimePermission } from "@/middleware/permissions";

interface RawRun {
  id: string;
  workspaceId: string;
  projectId: number | string;
  threadId: string;
  triggerMessageId: string;
  agentRole: string;
  kind?: string | null;
  parentRunId?: string | null;
  delegationId?: string | null;
  status: string;
  leaseOwner?: string | null;
  leaseExpiresAt?: number | string | null;
  attempt?: number | string | null;
  checkpointStepSeq: number | string | null;
  policySnapshot?: unknown;
}

interface RawThread {
  id: string;
  workspaceId: string;
  projectId: number | string;
  status: string;
  eventSeq: number | string | null;
}

interface RawTriggerMessage {
  id: string;
  createdBy: number | string | null;
}

interface RawStep {
  id: string;
  runId: string;
  toolName: string | null;
  argumentsDigest: string | null;
  inputRefs: unknown;
  idempotencyKey: string | null;
  status: string;
  outputRefs: unknown;
  safeError: unknown;
}

interface PersistedToolError {
  code: string;
  message: string;
  status: number;
}

interface ExecutionContext {
  run: RawRun;
  thread: RawThread;
  actorUserId: number;
  workspaceId: string;
  projectId: number;
  agentRole: AgentRole;
}

interface DelegatedModelAuthorization {
  catalog: readonly AgentToolCatalogDefinition[];
  verified: VerifiedDelegatedRunGrant;
}

export interface AgentToolGatewayExecuteInput {
  runId: string;
  toolName: string;
  arguments: unknown;
  /** Opaque persisted Approval id. No Approval/Grant/scope objects are accepted. */
  approvalId?: string | null;
  idempotencyKey: string;
  /** Server-derived Worker claim. Never accept this object from model arguments. */
  claimFence?: AgentToolWorkerClaimFence;
}

export interface AgentToolWorkerClaimFence {
  workerId: string;
  attempt: number;
}

export interface AgentToolGatewayExecuteResult {
  stepId: string;
  output: unknown;
  replayed: boolean;
}

export interface AgentToolGatewayReplaySucceededInput
  extends AgentToolGatewayExecuteInput {
  /** Exact persisted Gateway Step that produced the unit result. */
  expectedStepId: string;
  /** Digest of the immutable inline result previously returned to Executor. */
  expectedOutputDigest: string;
}

export interface AgentToolGatewayOptions {
  database: Knex;
  registry?: AgentToolRegistry;
  clock?: () => number;
  idFactory?: () => string;
  approvalService?: AgentApprovalService;
  delegationGrantService?: DelegationGrantService;
}

export interface AgentModelApprovalPreparation {
  workspaceId: string;
  projectId: number;
  runId: string;
  stepId: string;
  requestedBy: number;
  toolId: string;
  toolVersion: string;
  riskClass: AgentApprovalRiskClass;
  arguments: unknown;
  resourceVersions: Readonly<Record<string, string>>;
  quote: AgentApprovalQuote | null;
  impactSummary: AgentApprovalImpactSummary | null;
  policyVersion: string;
}

type TransactionResult =
  | { kind: "success"; value: AgentToolGatewayExecuteResult }
  | { kind: "failure"; error: AgentToolGatewayError };

export const SQLITE_METERED_DETACHED_PROTOCOL = "metered-detached/v1";

const TOOL_EXECUTION_PROTOCOL_REF = "tool_execution_protocol";
const TOOL_AUTHORIZATION_EVIDENCE_SNAPSHOT_REF =
  "tool_authorization_evidence_snapshot";
const TOOL_DETACHED_PREPARED_AT_REF = "tool_detached_prepared_at";
const TOOL_DETACHED_OWNER_WORKER_REF = "tool_detached_owner_worker";
const TOOL_DETACHED_OWNER_ATTEMPT_REF = "tool_detached_owner_attempt";
const TOOL_DETACHED_OWNER_TOKEN_REF = "tool_detached_owner_token";
const TOOL_DETACHED_DOMAIN_COMMIT_RECEIPT_REF =
  "tool_detached_domain_commit_receipt";
const DETACHED_DOMAIN_COMMIT_PROTOCOL = "detached-domain-commit/v1";
const MAX_AUTHORIZATION_EVIDENCE_SNAPSHOT_BYTES = 32 * 1024;
const MAX_DETACHED_DOMAIN_COMMIT_RECEIPT_BYTES = 64 * 1024;

interface DetachedExecutionOwner extends AgentToolWorkerClaimFence {
  token: string;
}

interface DetachedMeteredExecution {
  stepId: string;
  preparedAt: number;
  owner: DetachedExecutionOwner;
}

interface DetachedHandlerExecutionInput {
  execution: DetachedMeteredExecution;
  runId: string;
  definition: RegisteredAgentTool;
  parsedArguments: unknown;
  argumentsDigest: string;
  approvalId: string | null;
  authorizationDigest: string;
  idempotencyKey: string;
}

interface DetachedDomainCommitReceipt {
  protocol: typeof DETACHED_DOMAIN_COMMIT_PROTOCOL;
  stepId: string;
  toolName: string;
  preparedAt: number;
  owner: DetachedExecutionOwner;
  argumentsDigest: string;
  authorizationDigest: string;
  executionScopeDigest: string;
  authorizationEvidenceDigest: string;
  outputDigest: string;
  output: unknown;
}

type GatewayTransactionResult =
  | TransactionResult
  | { kind: "detached"; execution: DetachedMeteredExecution }
  | {
    kind: "detached_reconcile";
    execution: DetachedMeteredExecution;
    output: unknown;
  };

export const DEFAULT_AGENT_TOOL_DEFINITIONS: readonly RegisteredAgentTool[] = Object.freeze([
  ...CAPABILITY_CATALOG_TOOLS,
  CONTEXT_SNAPSHOT_GET_TOOL,
  PROJECT_GET_TOOL,
  PROJECT_UPDATE_TOOL,
  AGENT_DELEGATE_TOOL,
  ...SESSION_TOOLS,
  ...SCRIPT_QUERY_TOOLS,
  ...SCRIPT_DRAFT_TOOLS,
  ...ASSET_QUERY_TOOLS,
  ...STORYBOARD_QUERY_TOOLS,
  CANVAS_GET_TOOL,
  CANVAS_COMMANDS_APPLY_TOOL,
  GENERATION_QUOTE_TOOL,
  ...GENERATION_SUBMIT_TOOLS,
  ...GENERATION_TASK_TOOLS,
  VIDEO_MERGE_TOOL,
  DELIVERY_PREVIEW_TOOL,
  PLAN_PRESENT_TOOL,
]);

const DEFAULT_TOOL_REGISTRY = new AgentToolRegistry(DEFAULT_AGENT_TOOL_DEFINITIONS);

function isUniqueConstraintError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return (
    candidate?.code === "23505"
    || candidate?.code === "SQLITE_CONSTRAINT"
    || candidate?.code === "SQLITE_CONSTRAINT_UNIQUE"
    || String(candidate?.message || "").toLowerCase().includes("unique constraint")
  );
}

function affectedRows(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  if (Array.isArray(value)) return value.length;
  return 0;
}

function usesDetachedExecution(
  definition: RegisteredAgentTool,
): boolean {
  if (definition.executionMode === "detached") return true;
  // Metered handlers use their own durable billing/dispatch transactions.
  // Keeping the Gateway's project/run locks during those calls also blocks
  // PostgreSQL: the inner transaction waits on the outer handler that awaits it.
  return definition.manifest.metered && definition.manifest.mutatesState;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function generationPreferencesFromRunPolicy(
  policySnapshot: unknown,
): AgentMessageGenerationPreferences | undefined {
  const parsed = parseJson(policySnapshot);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const policy = parsed as Record<string, unknown>;
  const hasContextSnapshot = Object.prototype.hasOwnProperty.call(policy, "contextSnapshot");
  const hasContextDigest = Object.prototype.hasOwnProperty.call(policy, "contextDigest");
  // Runs created before confirmed creation context existed remain executable.
  if (!hasContextSnapshot && !hasContextDigest) return undefined;
  const snapshot = publicAgentMessageContextSnapshot(policy.contextSnapshot);
  if (
    !hasContextSnapshot
    || !hasContextDigest
    || !snapshot
    || typeof policy.contextDigest !== "string"
    || policy.contextDigest !== snapshot.digest
  ) {
    throw new AgentToolGatewayError(
      "tool_run_context_invalid",
      "Run 的已确认创作上下文无效，禁止执行工具",
      { status: 409 },
    );
  }
  return snapshot.generationPreferences;
}

function parsePersistedError(value: unknown): PersistedToolError | null {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.code !== "string" || typeof record.message !== "string") return null;
  const status = Number(record.status || 500);
  return { code: record.code, message: record.message, status: Number.isInteger(status) ? status : 500 };
}

function safeToolError(error: unknown): AgentToolGatewayError {
  if (error instanceof MembershipError) return new AgentToolGatewayError(error.code, error.message, { status: error.status });
  if (error instanceof AgentToolGatewayError) return error;
  if (isAgentRuntimeError(error)) {
    return new AgentToolGatewayError(error.code, error.message, { status: error.status });
  }
  if (error instanceof DurableCommandIdempotencyError) {
    return new AgentToolGatewayError(error.code, error.message, { status: error.status });
  }
  // 非预期异常的原始消息可能包含供应商密钥等敏感内容;持久化面(Step
  // safeError/Event)只保留固定安全消息,原始错误经结构化日志观测。
  const originalMessage = error instanceof Error ? error.message : String(error);
  logger.error(
    { originalMessage },
    "[agent-tool-gateway] unexpected tool handler failure",
  );
  return new AgentToolGatewayError("tool_execution_failed", "领域工具执行失败", { status: 500 });
}

/**
 * A SQLite transaction already owns the database's single writer lock. A
 * second root-pool connection cannot durably checkpoint the same command until
 * that transaction commits, so attempting it here self-deadlocks or raises
 * SQLITE_BUSY before provider dispatch. Use the owned transaction for SQLite.
 *
 * PostgreSQL supports the intended independent durable checkpoint connection,
 * which remains the stronger crash-recovery boundary in production.
 */
export function resolveDurableToolDatabase(
  rootDatabase: Knex,
  transaction: Knex.Transaction,
): Knex {
  const configuredClient = String(
    (rootDatabase.client.config as { client?: unknown } | undefined)?.client
      ?? rootDatabase.client.dialect
      ?? "",
  ).toLowerCase();
  return configuredClient.includes("sqlite")
    ? transaction as unknown as Knex
    : rootDatabase;
}

function toAgentRole(value: string): AgentRole {
  if ((AGENT_ROLES as readonly string[]).includes(value)) return value as AgentRole;
  throw new AgentToolGatewayError("agent_role_invalid", "Run 包含未知 Agent Role", { status: 409 });
}

function toA4DelegatedAgentRole(value: AgentRole): A4DelegatedAgentRole {
  if ((A4_DELEGATED_AGENT_ROLES as readonly AgentRole[]).includes(value)) {
    return value as A4DelegatedAgentRole;
  }
  throw new AgentToolGatewayError(
    "delegated_run_role_unsupported",
    "A4 R0-only Delegated Run 仅支持 writer、visual、storyboard 或 reviewer",
    { status: 403 },
  );
}

function sameExactToolSet(actual: readonly unknown[], expected: readonly ToolId[]): boolean {
  if (actual.length !== expected.length
    || !actual.every((item) => typeof item === "string")) return false;
  const actualSet = new Set(actual as readonly string[]);
  return actualSet.size === expected.length
    && expected.every((toolId) => actualSet.has(toolId));
}

function delegatedCatalogInvalid(): never {
  throw new AgentToolGatewayError(
    "delegated_model_catalog_invalid",
    "Delegated Run 的 R0 工具目录与固定授权边界不一致",
    { status: 409 },
  );
}

function storedIdempotencyKey(runId: string, key: string): string {
  const normalized = key.trim();
  if (!normalized || normalized.length > 160) {
    throw new AgentToolGatewayError("idempotency_key_required", "工具调用幂等键必填且不能超过 160 字符", { status: 400 });
  }
  return `agent-tool:${runId}:${normalized}`;
}

function cleanApprovalId(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new AgentToolGatewayError("approval_id_invalid", "approvalId 必须是持久化审批 ID", { status: 400 });
  }
  const approvalId = value.trim();
  if (!approvalId || approvalId.length > 200 || /[\u0000-\u001f\u007f]/.test(approvalId)) {
    throw new AgentToolGatewayError("approval_id_invalid", "approvalId 必须是持久化审批 ID", { status: 400 });
  }
  return approvalId;
}

function authorizationDigest(approvalId: string | null): string {
  return hashIdempotencyRequest({ approvalId });
}

function authorizationEvidenceDigest(evidence: AgentToolAuthorizationEvidence): string {
  return hashIdempotencyRequest(evidence);
}

function snapshotAuthorizationEvidence(
  evidence: AgentToolAuthorizationEvidence,
): { evidence: AgentToolAuthorizationEvidence; encoded: string } {
  const snapshot: AgentToolAuthorizationEvidence = {
    ...(evidence.resourceRefs === undefined ? {} : {
      resourceRefs: evidence.resourceRefs.map((ref) => ({
        type: ref.type,
        id: ref.id,
      })),
    }),
    ...(evidence.estimatedMicros === undefined ? {} : {
      estimatedMicros: evidence.estimatedMicros,
    }),
    ...(evidence.actualMicros === undefined ? {} : {
      actualMicros: evidence.actualMicros,
    }),
    ...(evidence.resourceVersions === undefined ? {} : {
      resourceVersions: Object.fromEntries(
        Object.entries(evidence.resourceVersions)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => [key, value]),
      ),
    }),
    ...(evidence.policyVersion === undefined ? {} : {
      policyVersion: evidence.policyVersion,
    }),
    ...(evidence.quote === undefined ? {} : {
      quote: evidence.quote === null ? null : {
        currency: evidence.quote.currency,
        estimatedCostMicros: evidence.quote.estimatedCostMicros,
        maximumCostMicros: evidence.quote.maximumCostMicros,
        ...(evidence.quote.quoteId === undefined ? {} : {
          quoteId: evidence.quote.quoteId,
        }),
        ...(evidence.quote.expiresAt === undefined ? {} : {
          expiresAt: evidence.quote.expiresAt,
        }),
      },
    }),
    ...(evidence.impactSummary === undefined ? {} : {
      impactSummary: evidence.impactSummary === null ? null : {
        summary: evidence.impactSummary.summary,
        affectedResourceRefs: [...evidence.impactSummary.affectedResourceRefs],
        destructive: evidence.impactSummary.destructive,
      },
    }),
  };
  let encoded: string;
  try {
    encoded = JSON.stringify(snapshot);
  } catch {
    throw new AgentToolGatewayError(
      "tool_authorization_evidence_invalid",
      "工具授权证据无法安全持久化",
      { status: 500 },
    );
  }
  if (
    !encoded
    || Buffer.byteLength(encoded, "utf8")
      > MAX_AUTHORIZATION_EVIDENCE_SNAPSHOT_BYTES
  ) {
    throw new AgentToolGatewayError(
      "tool_authorization_evidence_too_large",
      "工具授权证据超过安全持久化上限",
      { status: 500 },
    );
  }
  return { evidence: snapshot, encoded };
}

function executionScopeDigest(context: ExecutionContext, approvalId: string | null): string {
  return hashIdempotencyRequest({
    runId: context.run.id,
    actorUserId: context.actorUserId,
    workspaceId: context.workspaceId,
    projectId: context.projectId,
    agentRole: context.agentRole,
    runKind: context.run.kind == null ? null : String(context.run.kind),
    delegationId: context.run.delegationId == null ? null : String(context.run.delegationId),
    approvalId,
  });
}

function delegationUsageKey(idempotencyKey: string): string {
  return `tool-gateway:${hashIdempotencyRequest({ idempotencyKey })}`;
}

async function safeStepEventPayload(trx: Knex.Transaction, stepId: string) {
  const row = await trx("o_agent_step").where({ id: stepId }).first();
  if (!row) throw new Error("tool step disappeared before event append");
  return { step: toAgentStepDto(mapAgentStep(row)) };
}

function readInputRefDigest(step: RawStep, type: string): string | null {
  const refs = parseJson(step.inputRefs);
  if (!Array.isArray(refs)) return null;
  const evidence = refs.find((item) => (
    item
    && typeof item === "object"
    && (item as Record<string, unknown>).type === type
  ));
  return evidence && typeof (evidence as Record<string, unknown>).value === "string"
    ? String((evidence as Record<string, unknown>).value)
    : null;
}

function isDetachedMeteredStep(step: RawStep): boolean {
  return readInputRefDigest(step, TOOL_EXECUTION_PROTOCOL_REF)
    === SQLITE_METERED_DETACHED_PROTOCOL;
}

function readDetachedPreparedAt(step: RawStep): number | null {
  const value = readInputRefDigest(step, TOOL_DETACHED_PREPARED_AT_REF);
  const preparedAt = Number(value);
  return value !== null && Number.isSafeInteger(preparedAt) && preparedAt > 0
    ? preparedAt
    : null;
}

const DETACHED_OWNER_REF_TYPES = new Set([
  TOOL_DETACHED_OWNER_WORKER_REF,
  TOOL_DETACHED_OWNER_ATTEMPT_REF,
  TOOL_DETACHED_OWNER_TOKEN_REF,
]);

function detachedOwnerRefs(owner: DetachedExecutionOwner): Array<Record<string, string>> {
  return [
    { type: TOOL_DETACHED_OWNER_WORKER_REF, value: owner.workerId },
    { type: TOOL_DETACHED_OWNER_ATTEMPT_REF, value: String(owner.attempt) },
    { type: TOOL_DETACHED_OWNER_TOKEN_REF, value: owner.token },
  ];
}

function parsedInputRefs(step: RawStep): Array<Record<string, unknown>> {
  const parsed = parseJson(step.inputRefs);
  if (!Array.isArray(parsed) || parsed.some((ref) => !ref || typeof ref !== "object" || Array.isArray(ref))) {
    throw new AgentToolGatewayError(
      "tool_replay_scope_changed",
      "可恢复工具的执行引用无效",
      { status: 409 },
    );
  }
  return parsed as Array<Record<string, unknown>>;
}

function uniqueInputRefValue(
  refs: readonly Record<string, unknown>[],
  type: string,
): string | null {
  const matches = refs.filter((ref) => ref.type === type);
  if (matches.length === 0) return null;
  if (matches.length !== 1 || typeof matches[0]?.value !== "string") {
    throw new AgentToolGatewayError(
      "tool_replay_scope_changed",
      "可恢复工具的执行 owner 无效",
      { status: 409 },
    );
  }
  return String(matches[0].value);
}

function readDetachedExecutionOwner(step: RawStep): DetachedExecutionOwner | null {
  const refs = parsedInputRefs(step);
  const workerId = uniqueInputRefValue(refs, TOOL_DETACHED_OWNER_WORKER_REF);
  const attemptValue = uniqueInputRefValue(refs, TOOL_DETACHED_OWNER_ATTEMPT_REF);
  const token = uniqueInputRefValue(refs, TOOL_DETACHED_OWNER_TOKEN_REF);
  if (workerId === null && attemptValue === null && token === null) return null;
  const attempt = Number(attemptValue);
  if (
    !workerId
    || workerId.length > 200
    || /[\u0000-\u001f\u007f]/.test(workerId)
    || !Number.isSafeInteger(attempt)
    || attempt <= 0
    || !token
    || token.length > 200
    || /[\u0000-\u001f\u007f]/.test(token)
  ) {
    throw new AgentToolGatewayError(
      "tool_replay_scope_changed",
      "可恢复工具的执行 owner 无效",
      { status: 409 },
    );
  }
  return { workerId, attempt, token };
}

function withDetachedExecutionOwner(
  step: RawStep,
  owner: DetachedExecutionOwner,
): Array<Record<string, unknown>> {
  return [
    ...parsedInputRefs(step).filter((ref) => (
      typeof ref.type !== "string" || !DETACHED_OWNER_REF_TYPES.has(ref.type)
    )),
    ...detachedOwnerRefs(owner),
  ];
}

function sameDetachedExecutionOwner(
  left: DetachedExecutionOwner,
  right: DetachedExecutionOwner,
): boolean {
  return left.workerId === right.workerId
    && left.attempt === right.attempt
    && left.token === right.token;
}

function invalidDetachedDomainCommitReceipt(): never {
  throw new AgentToolGatewayError(
    "tool_domain_commit_receipt_uncertain",
    "detached 工具已存在领域提交凭据，但其完整性或绑定关系无法确认",
    { status: 503, replayed: true },
  );
}

function invalidDetachedDomainCommitPreparation(): never {
  throw new AgentToolGatewayError(
    "tool_replay_scope_changed",
    "可恢复工具无法生成有效的领域提交凭据",
    { status: 409 },
  );
}

function parseReceiptOwner(value: unknown): DetachedExecutionOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidDetachedDomainCommitReceipt();
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "attempt,token,workerId"
    || typeof record.workerId !== "string"
    || !record.workerId
    || record.workerId.length > 200
    || /[\u0000-\u001f\u007f]/.test(record.workerId)
    || !Number.isSafeInteger(record.attempt)
    || Number(record.attempt) <= 0
    || typeof record.token !== "string"
    || !record.token
    || record.token.length > 200
    || /[\u0000-\u001f\u007f]/.test(record.token)
  ) {
    return invalidDetachedDomainCommitReceipt();
  }
  return {
    workerId: record.workerId,
    attempt: Number(record.attempt),
    token: record.token,
  };
}

function readDetachedDomainCommitReceipt(
  step: RawStep,
  input: Pick<
    DetachedHandlerExecutionInput,
    "definition" | "argumentsDigest" | "authorizationDigest"
  >,
): DetachedDomainCommitReceipt | null {
  const refs = parsedInputRefs(step);
  const matches = refs.filter((ref) => (
    ref.type === TOOL_DETACHED_DOMAIN_COMMIT_RECEIPT_REF
  ));
  if (matches.length === 0) return null;
  if (matches.length !== 1 || typeof matches[0]?.value !== "string") {
    return invalidDetachedDomainCommitReceipt();
  }
  const encoded = String(matches[0].value);
  if (
    !encoded
    || Buffer.byteLength(encoded, "utf8")
      > MAX_DETACHED_DOMAIN_COMMIT_RECEIPT_BYTES
  ) {
    return invalidDetachedDomainCommitReceipt();
  }
  const parsed = parseJson(encoded);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalidDetachedDomainCommitReceipt();
  }
  const record = parsed as Record<string, unknown>;
  const expectedKeys = [
    "argumentsDigest",
    "authorizationDigest",
    "authorizationEvidenceDigest",
    "executionScopeDigest",
    "output",
    "outputDigest",
    "owner",
    "preparedAt",
    "protocol",
    "stepId",
    "toolName",
  ].sort().join(",");
  if (Object.keys(record).sort().join(",") !== expectedKeys) {
    return invalidDetachedDomainCommitReceipt();
  }
  const owner = parseReceiptOwner(record.owner);
  const storedScopeDigest = readInputRefDigest(
    step,
    "tool_execution_scope_digest",
  );
  const storedEvidenceDigest = readInputRefDigest(
    step,
    "tool_authorization_evidence_digest",
  );
  if (
    record.protocol !== DETACHED_DOMAIN_COMMIT_PROTOCOL
    || record.stepId !== step.id
    || record.toolName !== input.definition.manifest.name
    || record.preparedAt !== readDetachedPreparedAt(step)
    || record.argumentsDigest !== input.argumentsDigest
    || record.argumentsDigest !== step.argumentsDigest
    || record.authorizationDigest !== input.authorizationDigest
    || record.authorizationDigest
      !== readInputRefDigest(step, "tool_authorization_digest")
    || typeof record.executionScopeDigest !== "string"
    || record.executionScopeDigest !== storedScopeDigest
    || typeof record.authorizationEvidenceDigest !== "string"
    || record.authorizationEvidenceDigest !== storedEvidenceDigest
    || typeof record.outputDigest !== "string"
  ) {
    return invalidDetachedDomainCommitReceipt();
  }
  // Validate the immutable authorization snapshot itself. This does not read
  // live permissions; it only proves the receipt is bound to the exact
  // evidence that authorized the already-committed domain transaction.
  try {
    readAuthorizationEvidenceSnapshot(step);
  } catch {
    return invalidDetachedDomainCommitReceipt();
  }
  let output: unknown;
  try {
    output = input.definition.parseOutput(record.output);
    if (hashIdempotencyRequest(output) !== record.outputDigest) {
      return invalidDetachedDomainCommitReceipt();
    }
  } catch (error) {
    if (error instanceof AgentToolGatewayError) throw error;
    return invalidDetachedDomainCommitReceipt();
  }
  return {
    protocol: DETACHED_DOMAIN_COMMIT_PROTOCOL,
    stepId: step.id,
    toolName: input.definition.manifest.name,
    preparedAt: Number(record.preparedAt),
    owner,
    argumentsDigest: input.argumentsDigest,
    authorizationDigest: input.authorizationDigest,
    executionScopeDigest: String(record.executionScopeDigest),
    authorizationEvidenceDigest: String(record.authorizationEvidenceDigest),
    outputDigest: String(record.outputDigest),
    output,
  };
}

function encodedDetachedDomainCommitReceipt(
  receipt: DetachedDomainCommitReceipt,
): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(receipt);
  } catch {
    return invalidDetachedDomainCommitPreparation();
  }
  if (
    !encoded
    || Buffer.byteLength(encoded, "utf8")
      > MAX_DETACHED_DOMAIN_COMMIT_RECEIPT_BYTES
  ) {
    return invalidDetachedDomainCommitPreparation();
  }
  return encoded;
}

function readAuthorizationEvidenceSnapshot(
  step: RawStep,
): AgentToolAuthorizationEvidence {
  const encoded = readInputRefDigest(
    step,
    TOOL_AUTHORIZATION_EVIDENCE_SNAPSHOT_REF,
  );
  const storedDigest = readInputRefDigest(
    step,
    "tool_authorization_evidence_digest",
  );
  if (!encoded || !storedDigest) {
    throw new AgentToolGatewayError(
      "tool_replay_scope_changed",
      "可恢复付费工具缺少服务端授权证据",
      { status: 409 },
    );
  }
  if (
    Buffer.byteLength(encoded, "utf8")
      > MAX_AUTHORIZATION_EVIDENCE_SNAPSHOT_BYTES
  ) {
    throw new AgentToolGatewayError(
      "tool_replay_scope_changed",
      "可恢复付费工具的服务端授权证据无效",
      { status: 409 },
    );
  }
  const parsed = parseJson(encoded);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentToolGatewayError(
      "tool_replay_scope_changed",
      "可恢复付费工具的服务端授权证据无效",
      { status: 409 },
    );
  }
  let digest: string;
  try {
    digest = authorizationEvidenceDigest(
      parsed as AgentToolAuthorizationEvidence,
    );
  } catch {
    throw new AgentToolGatewayError(
      "tool_replay_scope_changed",
      "可恢复付费工具的服务端授权证据无效",
      { status: 409 },
    );
  }
  if (digest !== storedDigest) {
    throw new AgentToolGatewayError(
      "tool_replay_scope_changed",
      "可恢复付费工具的服务端授权证据已变化",
      { status: 409 },
    );
  }
  return parsed as AgentToolAuthorizationEvidence;
}

function cleanRunId(value: string): string {
  const runId = value.trim();
  if (!runId || runId.length > 200) {
    throw new AgentToolGatewayError("run_id_invalid", "Run ID 无效", { status: 400 });
  }
  return runId;
}

function cleanClaimFence(value: AgentToolWorkerClaimFence | undefined): AgentToolWorkerClaimFence | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object"
    || typeof value.workerId !== "string"
    || !value.workerId
    || value.workerId.length > 200
    || /[\u0000-\u001f\u007f]/.test(value.workerId)
    || !Number.isSafeInteger(value.attempt)
    || value.attempt <= 0) {
    throw new AgentToolGatewayError("worker_claim_fence_invalid", "Worker claim fence 无效", { status: 400 });
  }
  return { workerId: value.workerId, attempt: value.attempt };
}

function createDetachedExecutionOwner(
  claimFence: AgentToolWorkerClaimFence,
): DetachedExecutionOwner {
  return {
    workerId: claimFence.workerId,
    attempt: claimFence.attempt,
    token: randomUUID(),
  };
}

async function assertWorkerClaimFence(
  trx: Knex.Transaction,
  runId: string,
  claimFence: AgentToolWorkerClaimFence | null,
  clock: () => number,
  serializeDetachedWrite = false,
): Promise<number> {
  if (claimFence && serializeDetachedWrite) {
    // PostgreSQL's SELECT FOR UPDATE already serializes callers, but SQLite
    // ignores that clause. A no-op write obtains SQLite's writer reservation
    // before any Step-owner read, preserving the same lock order on both
    // dialects without changing persisted Run state.
    await trx("o_agent_run")
      .where({ id: runId })
      .update({ updatedAt: trx.ref("updatedAt") });
  }
  const selectedColumns = claimFence
    ? ["id", "status", "leaseOwner", "leaseExpiresAt", "attempt"]
    : ["id"];
  const run = await trx<RawRun>("o_agent_run")
    .where({ id: runId })
    .select(...selectedColumns)
    .forUpdate()
    .first();
  // The lease may expire while this transaction waits for the Run row lock.
  // Read time only after the lock is held; a caller-captured timestamp is not
  // a valid execution fence.
  const now = clock();
  if (claimFence && (!run
    || run.status !== "running"
    || run.leaseOwner !== claimFence.workerId
    || Number(run.attempt || 0) !== claimFence.attempt
    || Number(run.leaseExpiresAt || 0) <= now)) {
    throw new AgentToolGatewayError(
      "worker_claim_lost",
      "Worker claim 已失效，禁止执行或重放工具调用",
      { status: 409 },
    );
  }
  return now;
}

async function loadExecutionContext(trx: Knex.Transaction, runId: string): Promise<ExecutionContext> {
  const run = await trx<RawRun>("o_agent_run").where({ id: runId }).forUpdate().first();
  if (!run) throw new AgentToolGatewayError("run_not_found", "Agent Run 不存在", { status: 404 });
  if (run.status !== "running") {
    throw new AgentToolGatewayError("run_not_executable", "只有 running Run 可以发起新的工具调用", { status: 409 });
  }

  const projectId = Number(run.projectId);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new AgentToolGatewayError("run_project_invalid", "Run 项目上下文无效", { status: 409 });
  }

  const thread = await trx<RawThread>("o_agent_thread")
    .where({ id: run.threadId, workspaceId: run.workspaceId, projectId })
    .forUpdate()
    .first();
  if (!thread || thread.status !== "active") {
    throw new AgentToolGatewayError("thread_scope_invalid", "Run 对应 Thread 不存在、已归档或范围不一致", { status: 409 });
  }

  const trigger = await trx<RawTriggerMessage>("o_agent_message")
    .where({
      id: run.triggerMessageId,
      workspaceId: run.workspaceId,
      projectId,
      threadId: run.threadId,
      runId: run.id,
    })
    .select("id", "createdBy")
    .first();
  const actorUserId = Number(trigger?.createdBy || 0);
  if (!trigger || !Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    throw new AgentToolGatewayError("run_actor_invalid", "Run 缺少可验证的发起用户", { status: 409 });
  }

  return {
    run,
    thread,
    actorUserId,
    workspaceId: String(run.workspaceId),
    projectId,
    agentRole: toAgentRole(String(run.agentRole)),
  };
}

function replayExistingStep(
  step: RawStep,
  runId: string,
  definition: RegisteredAgentTool,
  argumentsDigest: string,
  expectedAuthorizationDigest: string,
): TransactionResult {
  if (step.runId !== runId || step.toolName !== definition.manifest.name) {
    return {
      kind: "failure",
      error: new AgentToolGatewayError("idempotency_conflict", "同一幂等键已被不同工具调用使用", { status: 409, replayed: true }),
    };
  }
  if (step.argumentsDigest !== argumentsDigest) {
    return {
      kind: "failure",
      error: new AgentToolGatewayError("idempotency_conflict", "同一幂等键已被不同参数使用", { status: 409, replayed: true }),
    };
  }
  if (readInputRefDigest(step, "tool_authorization_digest") !== expectedAuthorizationDigest) {
    return {
      kind: "failure",
      error: new AgentToolGatewayError("idempotency_conflict", "同一幂等键已被不同审批使用", { status: 409, replayed: true }),
    };
  }
  if (step.status === "succeeded") {
    const refs = parseJson(step.outputRefs);
    const inline = Array.isArray(refs)
      ? refs.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "inline_tool_result")
      : null;
    if (!inline || (inline as Record<string, unknown>).toolName !== definition.manifest.name) {
      return {
        kind: "failure",
        error: new AgentToolGatewayError("tool_replay_invalid", "工具幂等记录缺少可重放结果", { status: 500, replayed: true }),
      };
    }
    try {
      return {
        kind: "success",
        value: {
          stepId: step.id,
          output: definition.parseOutput((inline as Record<string, unknown>).value),
          replayed: true,
        },
      };
    } catch {
      return {
        kind: "failure",
        error: new AgentToolGatewayError("tool_replay_invalid", "工具幂等结果不再符合输出契约", { status: 500, replayed: true }),
      };
    }
  }
  if (step.status === "failed") {
    const persisted = parsePersistedError(step.safeError);
    return {
      kind: "failure",
      error: persisted
        ? new AgentToolGatewayError(persisted.code, persisted.message, { status: persisted.status, replayed: true })
        : new AgentToolGatewayError("tool_replay_invalid", "工具失败记录不可重放", { status: 500, replayed: true }),
    };
  }
  return {
    kind: "failure",
    error: new AgentToolGatewayError("idempotency_in_progress", "相同工具调用仍在处理中", { status: 409, replayed: true }),
  };
}

export class AgentToolGateway {
  private readonly database: Knex;
  private readonly registry: AgentToolRegistry;
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly approvalService?: AgentApprovalService;
  private readonly delegationGrantService?: DelegationGrantService;

  constructor(options: AgentToolGatewayOptions) {
    this.database = options.database;
    this.registry = options.registry ?? DEFAULT_TOOL_REGISTRY;
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.approvalService = options.approvalService;
    this.delegationGrantService = options.delegationGrantService;
  }

  async assertModelDispatchAuthorizedInTransaction(trx: Knex.Transaction, runIdInput: string): Promise<void> {
    const context = await loadExecutionContext(trx, cleanRunId(runIdInput));
    const project = await trx("o_project")
      .where({ id: context.projectId, workspaceId: context.workspaceId })
      .select("id")
      .first();
    if (!project) {
      throw new AgentToolGatewayError("project_scope_invalid", "项目不存在或不属于当前工作区", { status: 404 });
    }
    const permissions = await loadCurrentToolPermissions({
      database: trx,
      actorUserId: context.actorUserId,
      workspaceId: context.workspaceId,
    });
    if (!hasExactAgentRuntimePermission(permissions, "project:read")) {
      throw new AgentToolGatewayError("permission_missing", "当前用户不再具有项目读取权限", { status: 403 });
    }
  }

  /**
   * Server-derived catalog pinned to the immutable Prompt on this root Run.
   * Role and live permission filtering happens before the shared Prompt/tool
   * exposure bound; preview, disabled, role-hidden and R4 definitions remain
   * indistinguishable from absent tools. The model never supplies identity,
   * configuration, Prompt version or permission scope.
   */
  async listModelToolCandidates(runIdInput: string): Promise<readonly AgentToolCatalogDefinition[]> {
    const runId = cleanRunId(runIdInput);
    return this.database.transaction(async (trx) => {
      const context = await loadExecutionContext(trx, runId);
      if (context.agentRole !== "main"
        || context.run.kind === "delegated"
        || context.run.delegationId != null) {
        throw new AgentToolGatewayError(
          "tool_loop_role_unsupported",
          "当前持久化工具循环仅支持主 Agent 根 Run",
          { status: 403 },
        );
      }
      const project = await trx("o_project")
        .where({ id: context.projectId, workspaceId: context.workspaceId })
        .select("id")
        .first();
      if (!project) {
        throw new AgentToolGatewayError(
          "project_scope_invalid",
          "项目不存在或不属于当前工作区",
          { status: 404 },
        );
      }
      const permissions = await loadCurrentToolPermissions({
        database: trx,
        actorUserId: context.actorUserId,
        workspaceId: context.workspaceId,
      });
      if (!hasExactAgentRuntimePermission(permissions, "project:read")) {
        throw new AgentToolGatewayError(
          "permission_missing",
          "当前用户不再具有项目读取权限",
          { status: 403 },
        );
      }
      const policySnapshot = parseJson(context.run.policySnapshot);
      const persistedPolicy = policySnapshot
        && typeof policySnapshot === "object"
        && !Array.isArray(policySnapshot)
        ? policySnapshot as Record<string, unknown>
        : null;
      const persistedAgentConfig = persistedPolicy?.agentConfig;
      let promptKey: string;
      let promptVersion: string;
      try {
        const config = resolveAgentRuntimeConfigSnapshot(persistedAgentConfig, "main");
        promptKey = config.prompt.key;
        promptVersion = config.prompt.version;
      } catch {
        // A missing, stale, unknown or tampered immutable config snapshot must
        // never inherit the current default Prompt or receive any model tools.
        return [];
      }
      const delegationContract = getAgentDelegateContractForPromptVersion(promptVersion);
      return this.registry.createCatalogContext({
        agentRole: context.agentRole,
        permissions,
        grant: null,
      }).list()
        .map((definition) => {
          if (definition.manifest.name !== "agent.delegate") return definition;
          // Only the exact canonical live definition may be replaced by its
          // immutable historical catalog snapshot. A custom/misregistered
          // same-name definition must flow into the exposure predicate and
          // fail closed instead of inheriting trusted Schema bytes.
          if (definition !== AGENT_DELEGATE_TOOL.catalogDefinition || !delegationContract) {
            return definition;
          }
          return delegationContract.tool.catalogDefinition;
        })
        .filter(({ manifest }) => mayExposeMainAgentModelTool({
          promptKey,
          promptVersion,
          delegationEnabled: persistedPolicy?.delegationEnabled,
          manifest,
        }));
    });
  }

  /**
   * Independent A4 specialist catalog. It deliberately does not call or
   * relax listModelToolCandidates(): a delegated Run must prove its immutable
   * role/task/config snapshot and its signed, persisted Grant before any tool
   * definition is projected into a model request.
   */
  async listDelegatedModelToolCandidates(
    runIdInput: string,
  ): Promise<readonly AgentToolCatalogDefinition[]> {
    const runId = cleanRunId(runIdInput);
    return this.database.transaction(async (trx) => (
      await this.loadDelegatedModelAuthorizationInTransaction(trx, runId)
    ).catalog);
  }

  /** Re-check the complete delegated authorization at the dispatch checkpoint. */
  async assertDelegatedModelDispatchAuthorizedInTransaction(
    trx: Knex.Transaction,
    runIdInput: string,
  ): Promise<void> {
    await this.loadDelegatedModelAuthorizationInTransaction(trx, cleanRunId(runIdInput));
  }

  private async loadDelegatedModelAuthorizationInTransaction(
    trx: Knex.Transaction,
    runId: string,
  ): Promise<DelegatedModelAuthorization> {
    const context = await loadExecutionContext(trx, runId);
    if (context.run.kind !== "delegated"
      || context.run.delegationId == null
      || context.run.parentRunId == null) {
      throw new AgentToolGatewayError(
        "delegated_run_scope_invalid",
        "当前 Run 不是完整绑定的 Delegated Run",
        { status: 403 },
      );
    }
    const role = toA4DelegatedAgentRole(context.agentRole);
    const delegationId = String(context.run.delegationId);
    const parentRunId = String(context.run.parentRunId);
    const grantService = this.delegationGrantService;
    if (!grantService) {
      throw new AgentToolGatewayError(
        "delegation_service_unavailable",
        "DelegationGrant 校验服务当前不可用",
        { status: 503 },
      );
    }

    let verified: VerifiedDelegatedRunGrant;
    let contract: AgentDelegationPersistenceContract;
    let normalizedTask: AgentTask;
    try {
      verified = await grantService.verifyRunGrantInTransaction(trx, {
        grantId: delegationId,
        runId: context.run.id,
        actorUserId: context.actorUserId,
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        agentRole: role,
      }, this.clock());
      const policy = parseA4DelegatedRunPolicySnapshot(context.run.policySnapshot, {
        expectedRole: role,
        expectedDelegationId: verified.grant.id,
        expectedParentRunId: verified.grant.parentRunId,
        expectedParentStepId: verified.grant.parentStepId,
        expectedTaskHash: verified.taskHash,
      });
      const selectedContract = getAgentDelegationPersistenceContractForPolicyVersion(
        policy.delegatedTask.version,
      );
      if (!selectedContract
        || policy.delegatedTask.taskVersion !== selectedContract.taskVersion
        || !(selectedContract.roles as readonly string[]).includes(role)) {
        delegatedCatalogInvalid();
      }
      contract = selectedContract;
      normalizedTask = contract.normalizeTask(verified.task, {
        expectedProjectId: context.projectId,
      });
      if (normalizedTask.version !== contract.taskVersion
        || hashIdempotencyRequest(normalizedTask) !== verified.taskHash) {
        delegatedCatalogInvalid();
      }
    } catch (error) {
      throw safeToolError(error);
    }
    if (verified.grant.parentRunId !== parentRunId
      || normalizedTask.role !== role
      || normalizedTask.projectId !== context.projectId) {
      delegatedCatalogInvalid();
    }

    const expectedToolIds = contract.getR0ToolIds(role);
    if (!sameExactToolSet(verified.grant.allowedTools, expectedToolIds)) {
      delegatedCatalogInvalid();
    }
    const rolePolicy = DEFAULT_ROLE_POLICIES[role];
    if (!rolePolicy.requiresDelegationGrant
      || rolePolicy.canDelegate
      || expectedToolIds.some((toolId) => (
        !rolePolicy.allowedTools.some((selector) => matchesToolSelector(toolId, selector))
        || rolePolicy.deniedTools.some((selector) => matchesToolSelector(toolId, selector))
      ))) {
      delegatedCatalogInvalid();
    }

    const permissions = await loadCurrentToolPermissions({
      database: trx,
      actorUserId: context.actorUserId,
      workspaceId: context.workspaceId,
    });
    if (!hasExactAgentRuntimePermission(permissions, "project:read")) {
      throw new AgentToolGatewayError(
        "permission_missing",
        "当前用户不再具有项目读取权限",
        { status: 403 },
      );
    }
    for (const toolId of expectedToolIds) {
      let definition: RegisteredAgentTool;
      try {
        definition = this.registry.get(toolId);
      } catch {
        delegatedCatalogInvalid();
      }
      if (!isSafeR0ModelTool(definition.manifest)
        || definition.manifest.requiredPermissions.some((permission) => (
          !hasExactAgentRuntimePermission(permissions, permission)
        ))) {
        delegatedCatalogInvalid();
      }
    }

    const catalog = this.registry.createCatalogContext({
      agentRole: role,
      permissions,
      grant: verified.grant,
    }).list();
    if (!sameExactToolSet(catalog.map(({ manifest }) => manifest.name), expectedToolIds)
      || catalog.some(({ manifest }) => !isSafeR0ModelTool(manifest))) {
      delegatedCatalogInvalid();
    }
    // `consumed` means the exact maxToolCalls quota was committed. Keep the
    // complete signed/task/policy/permission/catalog validation above, then
    // expose no functions so the child can make only a final structured model
    // Turn. Tool execution independently rejects every new consumed-Grant call.
    return {
      catalog: verified.grant.status === "consumed" ? Object.freeze([]) : catalog,
      verified,
    };
  }

  async listModelTools(runIdInput: string): Promise<readonly AgentToolCatalogDefinition[]> {
    return (await this.listModelToolCandidates(runIdInput)).filter(({ manifest }) => manifest.riskClass === "R0");
  }

  async prepareModelApprovalInTransaction(
    trx: Knex.Transaction,
    input: { runId: string; stepId: string; toolName: string; arguments: unknown },
  ): Promise<AgentModelApprovalPreparation> {
    const runId = cleanRunId(input.runId);
    const definition = this.registry.get(input.toolName);
    let parsedArguments: unknown;
    try {
      parsedArguments = definition.parseInput(input.arguments);
    } catch {
      throw new AgentToolGatewayError("invalid_tool_arguments", "工具参数不符合服务端 Schema", { status: 400 });
    }
    const context = await loadExecutionContext(trx, runId);
    if (context.agentRole !== "main" || context.run.kind === "delegated" || context.run.delegationId != null) {
      throw new AgentToolGatewayError("tool_loop_role_unsupported", "当前持久化工具循环仅支持主 Agent 根 Run", { status: 403 });
    }
    const project = await trx("o_project")
      .where({ id: context.projectId, workspaceId: context.workspaceId })
      .select("id")
      .first();
    if (!project) {
      throw new AgentToolGatewayError("project_scope_invalid", "项目不存在或不属于当前工作区", { status: 404 });
    }
    const permissions = await loadCurrentToolPermissions({
      database: trx,
      actorUserId: context.actorUserId,
      workspaceId: context.workspaceId,
    });
    if (!hasExactAgentRuntimePermission(permissions, "project:read")) {
      throw new AgentToolGatewayError("permission_missing", "当前用户不再具有项目读取权限", { status: 403 });
    }
    const catalog = this.registry.createCatalogContext({
      agentRole: context.agentRole,
      permissions,
      grant: null,
    });
    const visible = catalog.describe(definition.manifest.name);
    if (!visible || (definition.manifest.riskClass !== "R2" && definition.manifest.riskClass !== "R3")) {
      throw new AgentToolGatewayError("tool_not_available", "模型请求的工具对当前 Run 不可用", { status: 404 });
    }
    const step = await trx("o_agent_step")
      .where({
        id: input.stepId,
        runId: context.run.id,
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        kind: "model",
        status: "succeeded",
      })
      .select("id")
      .first();
    if (!step) throw new AgentToolGatewayError("model_step_invalid", "模型工具调用检查点不存在", { status: 409 });
    const evidence = await definition.resolveAuthorizationEvidence(parsedArguments, {
      database: trx,
      actorUserId: context.actorUserId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      threadId: context.thread.id,
      runId: context.run.id,
      stepId: input.stepId,
      agentRole: context.agentRole,
      now: this.clock(),
      generationPreferences: generationPreferencesFromRunPolicy(context.run.policySnapshot),
    });
    return {
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      runId: context.run.id,
      stepId: input.stepId,
      requestedBy: context.actorUserId,
      toolId: definition.manifest.name,
      toolVersion: definition.manifest.version,
      riskClass: definition.manifest.riskClass,
      arguments: parsedArguments,
      resourceVersions: evidence.resourceVersions ?? {},
      quote: evidence.quote ?? null,
      impactSummary: evidence.impactSummary ?? null,
      policyVersion: typeof evidence.policyVersion === "string" ? evidence.policyVersion : "",
    };
  }

  /**
   * Executor（delegated Run, agentRole=executor）的 R2 审批证据准备：
   * 与主路径 prepareModelApprovalInTransaction 镜像，但授权证明不是模型
   * tool_calls 检查点，而是持久化 DelegationGrant（V3 executor 任务合同）
   * 与 executor 单元检查点 Step。Grant 覆盖、Run 绑定、角色、项目访问与
   * 工具证据全部实时重验；本方法不消费 Grant 或审批。
   */
  async prepareExecutorApprovalInTransaction(
    trx: Knex.Transaction,
    input: { runId: string; stepId: string; toolName: string; arguments: unknown },
  ): Promise<AgentModelApprovalPreparation> {
    const runId = cleanRunId(input.runId);
    const definition = this.registry.get(input.toolName);
    let parsedArguments: unknown;
    try {
      parsedArguments = definition.parseInput(input.arguments);
    } catch {
      throw new AgentToolGatewayError("invalid_tool_arguments", "工具参数不符合服务端 Schema", { status: 400 });
    }
    const context = await loadExecutionContext(trx, runId);
    if (context.agentRole !== "executor"
      || context.run.kind !== "delegated"
      || context.run.delegationId == null
      || context.run.parentRunId == null) {
      throw new AgentToolGatewayError(
        "executor_run_required",
        "Executor 审批准备仅支持完整绑定的 executor delegated Run",
        { status: 403 },
      );
    }
    if (String(context.run.status) !== "running") {
      throw new AgentToolGatewayError("executor_run_inactive", "Executor Run 当前未运行", { status: 409 });
    }
    if (definition.manifest.riskClass !== "R2" && definition.manifest.riskClass !== "R3") {
      throw new AgentToolGatewayError("tool_not_available", "Executor 审批准备仅支持 R2/R3 工具", { status: 404 });
    }
    const project = await trx("o_project")
      .where({ id: context.projectId, workspaceId: context.workspaceId })
      .select("id")
      .first();
    if (!project) {
      throw new AgentToolGatewayError("project_scope_invalid", "项目不存在或不属于当前工作区", { status: 404 });
    }
    const permissions = await loadCurrentToolPermissions({
      database: trx,
      actorUserId: context.actorUserId,
      workspaceId: context.workspaceId,
    });
    if (!hasExactAgentRuntimePermission(permissions, "project:read")
      || definition.manifest.requiredPermissions.some((permission) => (
        !hasExactAgentRuntimePermission(permissions, permission)
      ))) {
      throw new AgentToolGatewayError("permission_missing", "当前用户不再具有执行该工具所需权限", { status: 403 });
    }
    const grantService = this.delegationGrantService;
    if (!grantService) {
      throw new AgentToolGatewayError(
        "delegation_service_unavailable",
        "DelegationGrant 校验服务当前不可用",
        { status: 503 },
      );
    }
    let verified: VerifiedDelegatedRunGrant;
    try {
      verified = await grantService.verifyRunGrantInTransaction(trx, {
        grantId: String(context.run.delegationId),
        runId: context.run.id,
        actorUserId: context.actorUserId,
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        agentRole: "executor",
      }, this.clock());
    } catch (error) {
      throw safeToolError(error);
    }
    if (!verified.grant.allowedTools.includes(definition.manifest.name)) {
      throw new AgentToolGatewayError(
        "executor_tool_not_covered",
        "工具不在 Executor DelegationGrant 授权范围内",
        { status: 403 },
      );
    }
    const step = await trx("o_agent_step")
      .where({
        id: input.stepId,
        runId: context.run.id,
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        kind: "tool",
        status: "running",
      })
      .select("id", "toolName")
      .first();
    if (!step || String(step.toolName || "") !== definition.manifest.name) {
      throw new AgentToolGatewayError("executor_step_invalid", "Executor 单元检查点不存在或与工具不匹配", { status: 409 });
    }
    const evidence = await definition.resolveAuthorizationEvidence(parsedArguments, {
      database: trx,
      actorUserId: context.actorUserId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      threadId: context.thread.id,
      runId: context.run.id,
      stepId: input.stepId,
      agentRole: context.agentRole,
      now: this.clock(),
    });
    return {
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      runId: context.run.id,
      stepId: input.stepId,
      requestedBy: context.actorUserId,
      toolId: definition.manifest.name,
      toolVersion: definition.manifest.version,
      riskClass: definition.manifest.riskClass,
      arguments: parsedArguments,
      resourceVersions: evidence.resourceVersions ?? {},
      quote: evidence.quote ?? null,
      impactSummary: evidence.impactSummary ?? null,
      policyVersion: typeof evidence.policyVersion === "string" ? evidence.policyVersion : "",
    };
  }

  async execute(input: AgentToolGatewayExecuteInput): Promise<AgentToolGatewayExecuteResult> {
    const runId = cleanRunId(input.runId);
    const definition = this.registry.get(input.toolName);
    const detachedMetered = usesDetachedExecution(
      definition,
    );
    const claimFence = cleanClaimFence(input.claimFence);
    if ((definition.manifest.mutatesState || detachedMetered) && !claimFence) {
      throw new AgentToolGatewayError(
        "worker_claim_fence_required",
        "写入或 detached 工具必须提供有效的 Worker claim fence",
        { status: 400 },
      );
    }
    let parsedArguments: unknown;
    try {
      parsedArguments = definition.parseInput(input.arguments);
    } catch {
      throw new AgentToolGatewayError("invalid_tool_arguments", "工具参数不符合服务端 Schema", { status: 400 });
    }
    const argumentsDigest = hashIdempotencyRequest(parsedArguments);
    const approvalId = cleanApprovalId(input.approvalId);
    const callAuthorizationDigest = authorizationDigest(approvalId);
    const idempotencyKey = storedIdempotencyKey(runId, input.idempotencyKey);

    let result: GatewayTransactionResult;
    try {
      result = await this.database.transaction(async (trx) => {
        const now = await assertWorkerClaimFence(
          trx,
          runId,
          claimFence,
          this.clock,
          detachedMetered,
        );
        return this.executeTransaction({
          trx,
          runId,
          definition,
          parsedArguments,
          argumentsDigest,
          approvalId,
          authorizationDigest: callAuthorizationDigest,
          idempotencyKey,
          now,
          detachedMetered,
          claimFence,
        });
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      result = await this.database.transaction(async (trx) => {
        const replayNow = await assertWorkerClaimFence(
          trx,
          runId,
          claimFence,
          this.clock,
          detachedMetered,
        );
        const existing = await trx<RawStep>("o_agent_step").where({ idempotencyKey }).first();
        if (!existing) throw error;
        return this.replayAuthorizedStep(
          trx,
          runId,
          existing,
          definition,
          parsedArguments,
          argumentsDigest,
          approvalId,
          callAuthorizationDigest,
          idempotencyKey,
          replayNow,
          detachedMetered,
          claimFence,
        );
      });
    }

    if (result.kind === "failure") throw result.error;
    if (result.kind === "detached_reconcile") {
      const finalized = await this.finalizeDetachedMeteredStep({
        execution: result.execution,
        runId,
        definition,
        parsedArguments,
        argumentsDigest,
        approvalId,
        authorizationDigest: callAuthorizationDigest,
        idempotencyKey,
        output: result.output,
      });
      if (finalized.kind === "failure") throw finalized.error;
      return finalized.value;
    }
    if (result.kind === "detached") {
      return this.executeDetachedMeteredHandler({
        execution: result.execution,
        runId,
        definition,
        parsedArguments,
        argumentsDigest,
        approvalId,
        authorizationDigest: callAuthorizationDigest,
        idempotencyKey,
      });
    }
    return result.value;
  }

  /**
   * Read-only reconciliation path for an Executor checkpoint whose Gateway
   * side effect is already known to have completed.  Unlike execute(), this
   * method can never create a Step or invoke a handler/provider: every binding
   * must match one existing succeeded Step with one valid inline result.
   */
  async replaySucceeded(
    input: AgentToolGatewayReplaySucceededInput,
  ): Promise<AgentToolGatewayExecuteResult> {
    const runId = cleanRunId(input.runId);
    const definition = this.registry.get(input.toolName);
    const claimFence = cleanClaimFence(input.claimFence);
    if (!claimFence) {
      throw new AgentToolGatewayError(
        "worker_claim_fence_required",
        "Executor 检查点对账必须提供有效的 Worker claim fence",
        { status: 400 },
      );
    }
    let parsedArguments: unknown;
    try {
      parsedArguments = definition.parseInput(input.arguments);
    } catch {
      throw new AgentToolGatewayError(
        "invalid_tool_arguments",
        "工具参数不符合服务端 Schema",
        { status: 400 },
      );
    }
    const argumentsDigest = hashIdempotencyRequest(parsedArguments);
    const approvalId = cleanApprovalId(input.approvalId);
    const expectedAuthorizationDigest = authorizationDigest(approvalId);
    const idempotencyKey = storedIdempotencyKey(runId, input.idempotencyKey);

    return this.database.transaction(async (trx) => {
      await assertWorkerClaimFence(
        trx,
        runId,
        claimFence,
        this.clock,
        true,
      );
      const step = await trx<RawStep>("o_agent_step")
        .where({
          id: input.expectedStepId,
          runId,
          idempotencyKey,
        })
        .forUpdate()
        .first();
      if (!step
        || step.status !== "succeeded"
        || step.toolName !== definition.manifest.name
        || step.argumentsDigest !== argumentsDigest
        || readInputRefDigest(step, "tool_authorization_digest")
          !== expectedAuthorizationDigest) {
        throw new AgentToolGatewayError(
          "tool_terminal_uncertain",
          "Executor 检查点无法绑定唯一的 Gateway 成功终态",
          { status: 503, replayed: true },
        );
      }
      const outputRefs = parseJson(step.outputRefs);
      const inline = Array.isArray(outputRefs)
        ? outputRefs.filter((item) => (
          item
          && typeof item === "object"
          && !Array.isArray(item)
          && (item as Record<string, unknown>).type === "inline_tool_result"
          && (item as Record<string, unknown>).toolName === definition.manifest.name
        ))
        : [];
      if (!Array.isArray(outputRefs)
        || outputRefs.length !== 1
        || inline.length !== 1) {
        throw new AgentToolGatewayError(
          "tool_terminal_uncertain",
          "Gateway 成功 Step 缺少唯一可验证的 inline 输出",
          { status: 503, replayed: true },
        );
      }
      const replay = replayExistingStep(
        step,
        runId,
        definition,
        argumentsDigest,
        expectedAuthorizationDigest,
      );
      if (replay.kind !== "success"
        || !replay.value.replayed
        || replay.value.stepId !== input.expectedStepId
        || hashIdempotencyRequest(replay.value.output)
          !== input.expectedOutputDigest) {
        throw new AgentToolGatewayError(
          "tool_terminal_uncertain",
          "Gateway 成功输出与 Executor 待对账结果不一致",
          { status: 503, replayed: true },
        );
      }
      return replay.value;
    });
  }

  private async executeTransaction(input: {
    trx: Knex.Transaction;
    runId: string;
    definition: RegisteredAgentTool;
    parsedArguments: unknown;
    argumentsDigest: string;
    approvalId: string | null;
    authorizationDigest: string;
    idempotencyKey: string;
    now: number;
    detachedMetered: boolean;
    claimFence: AgentToolWorkerClaimFence | null;
  }): Promise<GatewayTransactionResult> {
    // The caller has already locked the Run and checked a fresh claim fence.
    // The fence intentionally is not part of any digest so a later valid
    // attempt can replay an already committed Step exactly once.
    const existing = await input.trx<RawStep>("o_agent_step").where({ idempotencyKey: input.idempotencyKey }).first();
    if (existing) {
      return this.replayAuthorizedStep(
        input.trx,
        input.runId,
        existing,
        input.definition,
        input.parsedArguments,
        input.argumentsDigest,
        input.approvalId,
        input.authorizationDigest,
        input.idempotencyKey,
        input.now,
        input.detachedMetered,
        input.claimFence,
      );
    }

    const context = await loadExecutionContext(input.trx, input.runId);
    const maxStep = await input.trx("o_agent_step").where({ runId: input.runId }).max({ seq: "seq" }).first();
    const nextStepSeq = Math.max(Number(context.run.checkpointStepSeq || 0), Number(maxStep?.seq || 0)) + 1;
    const startEventSeq = Number(context.thread.eventSeq || 0) + 1;
    const terminalEventSeq = input.detachedMetered
      ? null
      : startEventSeq + 1;
    const stepId = this.idFactory();
    const eventPrefix = context.run.kind === "delegated" ? "internal.step" : "step";

    const runUpdated = await input.trx("o_agent_run").where({ id: input.runId, status: "running" }).update({
      checkpointStepSeq: nextStepSeq,
      version: input.trx.raw("?? + 1", ["version"]),
      updatedAt: input.now,
    });
    if (affectedRows(runUpdated) !== 1) {
      throw new AgentToolGatewayError("run_version_conflict", "Run 在工具调用前发生变化", { status: 409 });
    }
    const threadUpdated = await input.trx("o_agent_thread").where({ id: context.thread.id, status: "active" }).update({
      eventSeq: terminalEventSeq ?? startEventSeq,
      version: input.trx.raw("?? + 1", ["version"]),
      updatedAt: input.now,
    });
    if (affectedRows(threadUpdated) !== 1) {
      throw new AgentToolGatewayError("thread_version_conflict", "Thread 在工具调用前发生变化", { status: 409 });
    }

    await input.trx("o_agent_step").insert({
      id: stepId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      threadId: context.thread.id,
      runId: context.run.id,
      parentStepId: null,
      seq: nextStepSeq,
      agentRole: context.agentRole,
      kind: "tool",
      status: "running",
      toolName: input.definition.manifest.name,
      argumentsDigest: input.argumentsDigest,
      inputRefs: JSON.stringify([
        { type: "tool_authorization_digest", value: input.authorizationDigest },
        { type: "tool_execution_scope_digest", value: executionScopeDigest(context, input.approvalId) },
      ]),
      outputRefs: JSON.stringify([]),
      idempotencyKey: input.idempotencyKey,
      resolvedModel: null,
      provider: null,
      usage: JSON.stringify({}),
      costMicros: 0,
      errorCategory: null,
      safeError: null,
      createdAt: input.now,
      updatedAt: input.now,
      startedAt: input.now,
      completedAt: null,
    });
    await appendAgentEvent(input.trx, {
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      threadId: context.thread.id,
      runId: context.run.id,
      stepId,
      seq: startEventSeq,
      type: `${eventPrefix}.started`,
      payload: await safeStepEventPayload(input.trx, stepId),
      createdAt: input.now,
    });

    const authorizationContext: AgentToolAuthorizationContext = {
      database: input.trx,
      actorUserId: context.actorUserId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      threadId: context.thread.id,
      runId: context.run.id,
      stepId,
      agentRole: context.agentRole,
      now: input.now,
      generationPreferences: generationPreferencesFromRunPolicy(context.run.policySnapshot),
    };

    try {
      const rawAuthorizationEvidence = await input.definition.resolveAuthorizationEvidence(
        input.parsedArguments,
        authorizationContext,
      );
      const detachedEvidence = input.detachedMetered
        ? snapshotAuthorizationEvidence(rawAuthorizationEvidence)
        : null;
      const authorizationEvidence = detachedEvidence?.evidence
        ?? rawAuthorizationEvidence;
      const evidenceDigest = authorizationEvidenceDigest(authorizationEvidence);
      const evidenceRecorded = await input.trx("o_agent_step")
        .where({ id: stepId, status: "running" })
        .update({
          inputRefs: JSON.stringify([
            { type: "tool_authorization_digest", value: input.authorizationDigest },
            { type: "tool_execution_scope_digest", value: executionScopeDigest(context, input.approvalId) },
            { type: "tool_authorization_evidence_digest", value: evidenceDigest },
          ]),
          updatedAt: input.now,
        });
      if (affectedRows(evidenceRecorded) !== 1) throw new Error("tool authorization evidence persistence lost");
      const authorization = await authorizeTool({
        database: input.trx,
        actorUserId: context.actorUserId,
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        runId: context.run.id,
        runKind: context.run.kind == null ? null : String(context.run.kind),
        delegationId: context.run.delegationId == null ? null : String(context.run.delegationId),
        agentRole: context.agentRole,
        manifest: input.definition.manifest,
        arguments: input.parsedArguments,
        approvalId: input.approvalId,
        executionStepId: stepId,
        authorizationEvidence,
        authorizationIdempotencyKey: delegationUsageKey(input.idempotencyKey),
        mode: "execute",
        now: input.now,
        approvalService: this.approvalService,
        delegationGrantService: this.delegationGrantService,
      });
      if (input.detachedMetered) {
        if (!input.claimFence) {
          throw new AgentToolGatewayError(
            "worker_claim_fence_required",
            "detached 工具缺少 Worker claim fence",
            { status: 400 },
          );
        }
        const owner = createDetachedExecutionOwner(input.claimFence);
        const preparedInputRefs = [
          { type: "tool_authorization_digest", value: input.authorizationDigest },
          { type: "tool_execution_scope_digest", value: executionScopeDigest(context, input.approvalId) },
          { type: "tool_authorization_evidence_digest", value: evidenceDigest },
          {
            type: TOOL_EXECUTION_PROTOCOL_REF,
            value: SQLITE_METERED_DETACHED_PROTOCOL,
          },
          {
            type: TOOL_AUTHORIZATION_EVIDENCE_SNAPSHOT_REF,
            value: detachedEvidence!.encoded,
          },
          {
            type: TOOL_DETACHED_PREPARED_AT_REF,
            value: String(input.now),
          },
          ...detachedOwnerRefs(owner),
        ];
        const prepared = await input.trx("o_agent_step")
          .where({ id: stepId, status: "running" })
          .update({
            inputRefs: JSON.stringify(preparedInputRefs),
            updatedAt: input.now,
          });
        if (affectedRows(prepared) !== 1) {
          throw new Error("detached tool preparation persistence lost");
        }
        return {
          kind: "detached",
          execution: {
            stepId,
            preparedAt: input.now,
            owner,
          },
        };
      }
      const handlerContext: AgentToolHandlerContext = {
        ...authorizationContext,
        durableDatabase: resolveDurableToolDatabase(this.database, input.trx),
        catalog: this.registry.createCatalogContext({
          agentRole: context.agentRole,
          permissions: authorization.permissions,
          grant: authorization.grant,
        }),
      };
      await assertMembershipTool(context.workspaceId, input.definition.manifest.name, input.parsedArguments, input.trx);
      const rawOutput = await input.definition.execute(input.parsedArguments, handlerContext);
      const output = input.definition.parseOutput(rawOutput);
      const outputRefs = [{ type: "inline_tool_result", toolName: input.definition.manifest.name, value: output }];

      const stepUpdated = await input.trx("o_agent_step").where({ id: stepId, status: "running" }).update({
        status: "succeeded",
        outputRefs: JSON.stringify(outputRefs),
        updatedAt: input.now,
        completedAt: input.now,
      });
      if (affectedRows(stepUpdated) !== 1) throw new Error("tool step completion lost");
      await appendAgentEvent(input.trx, {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        threadId: context.thread.id,
        runId: context.run.id,
        stepId,
        seq: terminalEventSeq!,
        type: `${eventPrefix}.completed`,
        payload: await safeStepEventPayload(input.trx, stepId),
        createdAt: input.now,
      });
      return { kind: "success", value: { stepId, output, replayed: false } };
    } catch (error) {
      const safe = safeToolError(error);
      const persistedError: PersistedToolError = { code: safe.code, message: safe.message, status: safe.status };
      const stepUpdated = await input.trx("o_agent_step").where({ id: stepId, status: "running" }).update({
        status: "failed",
        errorCategory: safe.code,
        safeError: JSON.stringify(persistedError),
        updatedAt: input.now,
        completedAt: input.now,
      });
      if (affectedRows(stepUpdated) !== 1) throw error;
      const failureEventSeq = terminalEventSeq ?? startEventSeq + 1;
      if (terminalEventSeq === null) {
        const failureThreadUpdated = await input.trx("o_agent_thread")
          .where({
            id: context.thread.id,
            status: "active",
            eventSeq: startEventSeq,
          })
          .update({
            eventSeq: failureEventSeq,
            version: input.trx.raw("?? + 1", ["version"]),
            updatedAt: input.now,
          });
        if (affectedRows(failureThreadUpdated) !== 1) throw error;
      }
      await appendAgentEvent(input.trx, {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        threadId: context.thread.id,
        runId: context.run.id,
        stepId,
        seq: failureEventSeq,
        type: `${eventPrefix}.failed`,
        payload: await safeStepEventPayload(input.trx, stepId),
        createdAt: input.now,
      });
      return { kind: "failure", error: safe };
    }
  }

  private async loadDetachedExecutionFenceInTransaction(
    trx: Knex.Transaction,
    input: DetachedHandlerExecutionInput,
  ): Promise<{ context: ExecutionContext; current: RawStep }> {
    const now = await assertWorkerClaimFence(
      trx,
      input.runId,
      input.execution.owner,
      this.clock,
      true,
    );
    const current = await trx<RawStep>("o_agent_step")
      .where({ id: input.execution.stepId })
      .forUpdate()
      .first();
    if (!current) {
      throw new AgentToolGatewayError(
        "tool_replay_invalid",
        "可恢复工具 Step 不存在",
        { status: 500, replayed: true },
      );
    }
    const replay = replayExistingStep(
      current,
      input.runId,
      input.definition,
      input.argumentsDigest,
      input.authorizationDigest,
    );
    if (
      replay.kind === "failure"
      && replay.error.code === "idempotency_conflict"
    ) {
      throw replay.error;
    }
    const persistedOwner = readDetachedExecutionOwner(current);
    if (
      current.status !== "running"
      || !isDetachedMeteredStep(current)
      || readDetachedPreparedAt(current) !== input.execution.preparedAt
      || input.execution.preparedAt > now
    ) {
      throw new AgentToolGatewayError(
        "tool_replay_scope_changed",
        "可恢复工具的 detached 执行范围已变化",
        { status: 409, replayed: true },
      );
    }
    if (
      !persistedOwner
      || !sameDetachedExecutionOwner(persistedOwner, input.execution.owner)
    ) {
      throw new AgentToolGatewayError(
        "worker_claim_lost",
        "detached execution owner 已失效，禁止提交领域副作用",
        { status: 409, replayed: true },
      );
    }

    const context = await loadExecutionContext(trx, input.runId);
    if (
      readInputRefDigest(current, "tool_execution_scope_digest")
        !== executionScopeDigest(context, input.approvalId)
    ) {
      throw new AgentToolGatewayError(
        "tool_replay_scope_changed",
        "Run 的用户、工作区、项目、角色或授权范围已变化",
        { status: 409, replayed: true },
      );
    }
    return { context, current };
  }

  private async authorizeDetachedExecutionInTransaction(
    trx: Knex.Transaction,
    input: DetachedHandlerExecutionInput,
    context: ExecutionContext,
    current: RawStep,
  ): Promise<AuthorizedToolCall> {
    const authorizationEvidence = readAuthorizationEvidenceSnapshot(current);
    return authorizeTool({
      database: trx,
      actorUserId: context.actorUserId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      runId: context.run.id,
      runKind: context.run.kind == null ? null : String(context.run.kind),
      delegationId: context.run.delegationId == null
        ? null
        : String(context.run.delegationId),
      agentRole: context.agentRole,
      manifest: input.definition.manifest,
      arguments: input.parsedArguments,
      approvalId: input.approvalId,
      executionStepId: current.id,
      authorizationEvidence,
      authorizationIdempotencyKey: delegationUsageKey(input.idempotencyKey),
      mode: "replay",
      replayStep: {
        id: current.id,
        runId: current.runId,
        idempotencyKey: String(current.idempotencyKey || ""),
      },
      // Preserve the consumed Approval/Grant time boundary while every mutable
      // permission and revocation row is read and locked from current state.
      now: input.execution.preparedAt,
      approvalService: this.approvalService,
      delegationGrantService: this.delegationGrantService,
    });
  }

  private async assertDetachedExecutionFenceInTransaction(
    trx: Knex.Transaction,
    input: DetachedHandlerExecutionInput,
  ): Promise<{
    context: ExecutionContext;
    current: RawStep;
    authorization: AuthorizedToolCall;
  }> {
    const { context, current } = await this.loadDetachedExecutionFenceInTransaction(
      trx,
      input,
    );
    const authorization = await this.authorizeDetachedExecutionInTransaction(
      trx,
      input,
      context,
      current,
    );
    return { context, current, authorization };
  }

  private async recordDetachedDomainCommitInTransaction(
    trx: Knex.Transaction,
    input: DetachedHandlerExecutionInput,
    rawOutput: unknown,
  ): Promise<void> {
    let output: unknown;
    try {
      output = input.definition.parseOutput(rawOutput);
    } catch {
      throw new AgentToolGatewayError(
        "invalid_tool_output",
        "detached 工具的领域提交结果不符合输出 Schema",
        { status: 500 },
      );
    }
    const { context, current } = await this.assertDetachedExecutionFenceInTransaction(
      trx,
      input,
    );
    const existing = readDetachedDomainCommitReceipt(current, input);
    const outputDigest = hashIdempotencyRequest(output);
    if (existing) {
      if (existing.outputDigest === outputDigest) return;
      throw new AgentToolGatewayError(
        "tool_domain_commit_receipt_uncertain",
        "detached 工具已有领域提交凭据，但其结果与当前输出不一致",
        { status: 503, replayed: true },
      );
    }
    const scopeDigest = readInputRefDigest(
      current,
      "tool_execution_scope_digest",
    );
    const evidenceDigest = readInputRefDigest(
      current,
      "tool_authorization_evidence_digest",
    );
    if (
      !scopeDigest
      || scopeDigest !== executionScopeDigest(context, input.approvalId)
      || !evidenceDigest
    ) {
      invalidDetachedDomainCommitPreparation();
    }
    // Re-validate snapshot integrity before binding it into the receipt.
    readAuthorizationEvidenceSnapshot(current);
    const receipt: DetachedDomainCommitReceipt = {
      protocol: DETACHED_DOMAIN_COMMIT_PROTOCOL,
      stepId: current.id,
      toolName: input.definition.manifest.name,
      preparedAt: input.execution.preparedAt,
      owner: input.execution.owner,
      argumentsDigest: input.argumentsDigest,
      authorizationDigest: input.authorizationDigest,
      executionScopeDigest: scopeDigest,
      authorizationEvidenceDigest: evidenceDigest,
      outputDigest,
      output,
    };
    const encoded = encodedDetachedDomainCommitReceipt(receipt);
    const previousInputRefs = typeof current.inputRefs === "string"
      ? current.inputRefs
      : JSON.stringify(parsedInputRefs(current));
    const nextInputRefs = [
      ...parsedInputRefs(current).filter((ref) => (
        ref.type !== TOOL_DETACHED_DOMAIN_COMMIT_RECEIPT_REF
      )),
      { type: TOOL_DETACHED_DOMAIN_COMMIT_RECEIPT_REF, value: encoded },
    ];
    const updated = await trx("o_agent_step")
      .where({
        id: current.id,
        runId: input.runId,
        status: "running",
        inputRefs: previousInputRefs,
      })
      .update({
        inputRefs: JSON.stringify(nextInputRefs),
        updatedAt: this.clock(),
      });
    if (affectedRows(updated) !== 1) {
      throw new AgentToolGatewayError(
        "tool_terminal_conflict",
        "detached 工具领域提交凭据写入冲突",
        { status: 409, replayed: true },
      );
    }
  }

  private async executeDetachedMeteredHandler(
    input: DetachedHandlerExecutionInput,
  ): Promise<AgentToolGatewayExecuteResult> {
    const verified = await this.database.transaction(async (trx) => (
      this.assertDetachedExecutionFenceInTransaction(trx, input)
    ));
    const { context, authorization } = verified;
    const { preparedAt, stepId } = input.execution;
    const handlerContext: AgentToolHandlerContext = {
      // The detached protocol has already committed its short preparation
      // transaction. Both domain and durable work must now use the root pool,
      // otherwise SQLite would again hold the writer lock across Relay/Billing.
      database: this.database as unknown as Knex.Transaction,
      durableDatabase: this.database,
      assertDetachedExecutionFence: async (transaction) => {
        await this.assertDetachedExecutionFenceInTransaction(
          transaction,
          input,
        );
      },
      recordDetachedDomainCommit: async (transaction, output) => {
        await this.recordDetachedDomainCommitInTransaction(
          transaction,
          input,
          output,
        );
      },
      actorUserId: context.actorUserId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      threadId: context.thread.id,
      runId: context.run.id,
      stepId,
      agentRole: context.agentRole,
      now: preparedAt,
      generationPreferences: generationPreferencesFromRunPolicy(context.run.policySnapshot),
      catalog: this.registry.createCatalogContext({
        agentRole: context.agentRole,
        permissions: authorization.permissions,
        grant: authorization.grant,
      }),
    };

    let output: unknown;
    try {
      await assertMembershipTool(context.workspaceId, input.definition.manifest.name, input.parsedArguments, this.database);
      const rawOutput = await input.definition.execute(
        input.parsedArguments,
        handlerContext,
      );
      output = input.definition.parseOutput(rawOutput);
    } catch (error) {
      const safe = safeToolError(error);
      if (safe.code === "idempotency_in_progress" || safe.code === "WORKSPACE_GENERATION_QUEUED") {
        // Another durable owner may already be beyond the provider boundary.
        // Keep the shared Step running; marking it failed would destroy the
        // only recovery anchor while the real owner can still finish.
        throw safe;
      }
      const finalized = await this.finalizeDetachedMeteredStep({
        ...input,
        error: safe,
      });
      if (finalized.kind === "failure") throw finalized.error;
      return finalized.value;
    }
    const finalized = await this.finalizeDetachedMeteredStep({
      ...input,
      output,
    });
    if (finalized.kind === "failure") throw finalized.error;
    return finalized.value;
  }

  private async finalizeDetachedMeteredStep(input: DetachedHandlerExecutionInput & {
    output?: unknown;
    error?: AgentToolGatewayError;
  }): Promise<TransactionResult> {
    try {
      return await this.database.transaction(async (trx) => {
      const { context, current } = await this.loadDetachedExecutionFenceInTransaction(
        trx,
        input,
      );
      const committedReceipt = input.error
        ? null
        : readDetachedDomainCommitReceipt(current, input);
      if (committedReceipt) {
        // The handler wrote this receipt in the same transaction as its domain
        // rows. Reconciliation is therefore bookkeeping-only: validate the
        // exact immutable result, but do not make a now-revoked permission turn
        // an already-committed business operation into a false failure.
        if (
          committedReceipt.outputDigest
            !== hashIdempotencyRequest(input.output)
        ) {
          return {
            kind: "failure",
            error: new AgentToolGatewayError(
              "tool_domain_commit_receipt_uncertain",
              "领域提交凭据与待写入终态结果不一致",
              { status: 503, replayed: true },
            ),
          };
        }
      } else {
        // No durable proof of a committed domain operation exists. Preserve
        // the original fail-closed behavior and require current authorization.
        await this.authorizeDetachedExecutionInTransaction(
          trx,
          input,
          context,
          current,
        );
      }
      const replay = replayExistingStep(
        current,
        input.runId,
        input.definition,
        input.argumentsDigest,
        input.authorizationDigest,
      );
      if (current.status === "succeeded" || current.status === "failed") {
        if (input.error && replay.kind === "failure") {
          if (
            replay.error.code === input.error.code
            && replay.error.message === input.error.message
            && replay.error.status === input.error.status
          ) {
            return replay;
          }
        } else if (!input.error && replay.kind === "success") {
          try {
            if (
              hashIdempotencyRequest(replay.value.output)
                === hashIdempotencyRequest(input.output)
            ) {
              return replay;
            }
          } catch {
            // Fall through to a closed terminal-conflict result.
          }
        }
        return {
          kind: "failure",
          error: new AgentToolGatewayError(
            "tool_terminal_conflict",
            "可恢复付费工具已存在不同终态，禁止覆盖",
            { status: 409, replayed: true },
          ),
        };
      }
      if (
        replay.kind === "failure"
        && replay.error.code === "idempotency_conflict"
      ) {
        return replay;
      }
      if (
        current.status !== "running"
        || !isDetachedMeteredStep(current)
        || readDetachedPreparedAt(current)
          !== input.execution.preparedAt
        || readInputRefDigest(current, "tool_execution_scope_digest")
          !== executionScopeDigest(context, input.approvalId)
      ) {
        return {
          kind: "failure",
          error: new AgentToolGatewayError(
            "tool_replay_scope_changed",
            "可恢复付费工具的执行范围已变化，禁止写入终态",
            { status: 409, replayed: true },
          ),
        };
      }

      const completedAt = this.clock();
      const eventPrefix = context.run.kind === "delegated"
        ? "internal.step"
        : "step";
      let terminalType: string;
      if (input.error) {
        const persistedError: PersistedToolError = {
          code: input.error.code,
          message: input.error.message,
          status: input.error.status,
        };
        const updated = await trx("o_agent_step")
          .where({ id: current.id, status: "running" })
          .update({
            status: "failed",
            errorCategory: input.error.code,
            safeError: JSON.stringify(persistedError),
            updatedAt: completedAt,
            completedAt,
          });
        if (affectedRows(updated) !== 1) {
          throw new AgentToolGatewayError(
            "tool_terminal_conflict",
            "可恢复付费工具终态写入发生冲突",
            { status: 409, replayed: true },
          );
        }
        terminalType = `${eventPrefix}.failed`;
      } else {
        const outputRefs = [{
          type: "inline_tool_result",
          toolName: input.definition.manifest.name,
          value: input.output,
        }];
        const updated = await trx("o_agent_step")
          .where({ id: current.id, status: "running" })
          .update({
            status: "succeeded",
            outputRefs: JSON.stringify(outputRefs),
            updatedAt: completedAt,
            completedAt,
          });
        if (affectedRows(updated) !== 1) {
          throw new AgentToolGatewayError(
            "tool_terminal_conflict",
            "可恢复付费工具终态写入发生冲突",
            { status: 409, replayed: true },
          );
        }
        terminalType = `${eventPrefix}.completed`;
      }

      const thread = await trx("o_agent_thread")
        .where({
          id: context.thread.id,
          workspaceId: context.workspaceId,
          projectId: context.projectId,
        })
        .forUpdate()
        .first();
      if (!thread) {
        throw new AgentToolGatewayError(
          "thread_scope_invalid",
          "可恢复付费工具对应 Thread 不存在",
          { status: 409 },
        );
      }
      const eventSeq = Number(thread.eventSeq || 0) + 1;
      const threadVersion = Number(thread.version || 0);
      const threadUpdated = await trx("o_agent_thread")
        .where({ id: thread.id, version: threadVersion })
        .update({
          eventSeq,
          version: threadVersion + 1,
          updatedAt: completedAt,
        });
      if (affectedRows(threadUpdated) !== 1) {
        throw new AgentToolGatewayError(
          "thread_version_conflict",
          "可恢复付费工具写入终态事件时 Thread 发生变化",
          { status: 409 },
        );
      }
      await appendAgentEvent(trx, {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        threadId: context.thread.id,
        runId: context.run.id,
        stepId: current.id,
        seq: eventSeq,
        type: terminalType,
        payload: await safeStepEventPayload(trx, current.id),
        createdAt: completedAt,
      });

      if (input.error) {
        return { kind: "failure", error: input.error };
      }
      return {
        kind: "success",
        value: {
          stepId: current.id,
          output: input.output,
          replayed: false,
        },
      };
      });
    } catch (error) {
      // A detached handler may already have committed its metered/domain side
      // effect. If the terminal transaction committed but its COMMIT response
      // was lost, surfacing the transport error as an ordinary tool failure
      // would make the Executor persist a false failed storyVideo result.
      // Always read the authoritative Step after a transaction rejection.
      const reconciled = await this.reconcileDetachedMeteredTerminal(input);
      if (reconciled) {
        // A stale owner may observe the different terminal committed by its
        // successor. Preserve the precise fence error in that case; the
        // authoritative Step is already terminal and needs no recovery.
        if (
          error instanceof AgentToolGatewayError
          && reconciled.kind === "failure"
          && reconciled.error.code === "tool_terminal_conflict"
        ) {
          return { kind: "failure", error };
        }
        return reconciled;
      }

      if (
        error instanceof AgentToolGatewayError
        && error.code === "tool_domain_commit_receipt_uncertain"
      ) {
        return { kind: "failure", error };
      }

      // Once the detached handler has returned, even a typed fence,
      // permission, or Thread-version error is a finalizer outcome—not proof
      // that the already-committed domain operation failed. Keep the Step and
      // owning Run recoverable until a later attempt can re-run/reconcile it.
      return {
        kind: "failure",
        error: new AgentToolGatewayError(
          "tool_terminal_uncertain",
          "可恢复付费工具的业务结果已返回，但终态写入结果无法确认",
          { status: 503, replayed: true },
        ),
      };
    }
  }

  /**
   * Reconcile a rejected terminal transaction against a fresh connection.
   * `null` means the authoritative row is still non-terminal (or cannot be
   * read), so the caller must classify the transaction outcome separately.
   */
  private async reconcileDetachedMeteredTerminal(
    input: DetachedHandlerExecutionInput & {
      output?: unknown;
      error?: AgentToolGatewayError;
    },
  ): Promise<TransactionResult | null> {
    let current: RawStep | undefined;
    try {
      current = await this.database<RawStep>("o_agent_step")
        .where({ id: input.execution.stepId })
        .first();
    } catch {
      return null;
    }
    if (!current || (current.status !== "succeeded" && current.status !== "failed")) {
      return null;
    }

    let replay: TransactionResult;
    try {
      replay = replayExistingStep(
        current,
        input.runId,
        input.definition,
        input.argumentsDigest,
        input.authorizationDigest,
      );
    } catch {
      return null;
    }
    if (input.error && replay.kind === "failure") {
      if (
        replay.error.code === input.error.code
        && replay.error.message === input.error.message
        && replay.error.status === input.error.status
      ) {
        return replay;
      }
    } else if (!input.error && replay.kind === "success") {
      try {
        if (
          hashIdempotencyRequest(replay.value.output)
            === hashIdempotencyRequest(input.output)
        ) {
          return replay;
        }
      } catch {
        // Fall through to the closed terminal-conflict result below.
      }
    }
    return {
      kind: "failure",
      error: new AgentToolGatewayError(
        "tool_terminal_conflict",
        "可恢复付费工具已存在不同终态，禁止覆盖",
        { status: 409, replayed: true },
      ),
    };
  }

  private async replayAuthorizedStep(
    trx: Knex.Transaction,
    runId: string,
    step: RawStep,
    definition: RegisteredAgentTool,
    parsedArguments: unknown,
    argumentsDigest: string,
    approvalId: string | null,
    expectedAuthorizationDigest: string,
    idempotencyKey: string,
    now: number,
    detachedMetered = false,
    claimFence: AgentToolWorkerClaimFence | null = null,
  ): Promise<GatewayTransactionResult> {
    const conflict = replayExistingStep(
      step,
      runId,
      definition,
      argumentsDigest,
      expectedAuthorizationDigest,
    );
    if (conflict.kind === "failure" && conflict.error.code === "idempotency_conflict") return conflict;

    if (
      detachedMetered
      && step.status === "running"
      && isDetachedMeteredStep(step)
    ) {
      try {
        if (!claimFence) {
          throw new AgentToolGatewayError(
            "worker_claim_fence_required",
            "detached 工具缺少 Worker claim fence",
            { status: 400 },
          );
        }
        const previousOwner = readDetachedExecutionOwner(step);
        const committedReceipt = readDetachedDomainCommitReceipt(step, {
          definition,
          argumentsDigest,
          authorizationDigest: expectedAuthorizationDigest,
        });
        if (committedReceipt) {
          if (!previousOwner) {
            throw new AgentToolGatewayError(
              "tool_domain_commit_receipt_uncertain",
              "领域提交凭据缺少 detached owner",
              { status: 503, replayed: true },
            );
          }
          const context = await loadExecutionContext(trx, runId);
          if (
            committedReceipt.executionScopeDigest
              !== executionScopeDigest(context, approvalId)
          ) {
            throw new AgentToolGatewayError(
              "tool_domain_commit_receipt_uncertain",
              "Run 范围已变化，不能收口旧领域提交凭据",
              { status: 503, replayed: true },
            );
          }
          let reconciliationOwner = previousOwner;
          const sameClaim = previousOwner.workerId === claimFence.workerId
            && previousOwner.attempt === claimFence.attempt;
          if (!sameClaim) {
            if (claimFence.attempt <= previousOwner.attempt) {
              throw new AgentToolGatewayError(
                "tool_domain_commit_receipt_uncertain",
                "领域提交收口只能由更高 Run attempt 接管",
                { status: 503, replayed: true },
              );
            }
            reconciliationOwner = createDetachedExecutionOwner(claimFence);
            const previousInputRefs = typeof step.inputRefs === "string"
              ? step.inputRefs
              : JSON.stringify(parsedInputRefs(step));
            const claimed = await trx("o_agent_step")
              .where({
                id: step.id,
                status: "running",
                inputRefs: previousInputRefs,
              })
              .update({
                inputRefs: JSON.stringify(withDetachedExecutionOwner(
                  step,
                  reconciliationOwner,
                )),
                updatedAt: now,
              });
            if (affectedRows(claimed) !== 1) {
              return {
                kind: "failure",
                error: new AgentToolGatewayError(
                  "idempotency_in_progress",
                  "领域提交收口已由其他 detached owner 接管",
                  { status: 409, replayed: true },
                ),
              };
            }
          }
          // Receipt recovery is bookkeeping-only: execute() routes this result
          // straight to the finalizer and never invokes the tool handler.
          return {
            kind: "detached_reconcile",
            execution: {
              stepId: step.id,
              preparedAt: committedReceipt.preparedAt,
              owner: reconciliationOwner,
            },
            output: committedReceipt.output,
          };
        }
        if (
          previousOwner
          && previousOwner.workerId === claimFence.workerId
          && previousOwner.attempt === claimFence.attempt
        ) {
          // A valid lease does not prove that its already-started handler has
          // stopped. Only a strictly newer Run attempt may take ownership.
          return conflict;
        }
        if (previousOwner && claimFence.attempt <= previousOwner.attempt) {
          throw new AgentToolGatewayError(
            "tool_replay_scope_changed",
            "detached execution 只能由更高 Run attempt 接管",
            { status: 409 },
          );
        }
        // Owner refs were introduced after detached/v1. A valid current claim
        // may atomically adopt an ownerless legacy Step; the CAS below makes a
        // concurrent adopter observe in-progress instead of starting twice.
        const context = await loadExecutionContext(trx, runId);
        if (
          readInputRefDigest(step, "tool_execution_scope_digest")
            !== executionScopeDigest(context, approvalId)
        ) {
          throw new AgentToolGatewayError(
            "tool_replay_scope_changed",
            "Run 的用户、工作区、项目、角色或授权范围已变化，旧工具结果不能重放",
            { status: 409 },
          );
        }
        const preparedAt = readDetachedPreparedAt(step);
        if (!preparedAt || preparedAt > now) {
          throw new AgentToolGatewayError(
            "tool_replay_scope_changed",
            "可恢复付费工具的准备时间无效",
            { status: 409 },
          );
        }
        const authorizationEvidence = readAuthorizationEvidenceSnapshot(step);
        await authorizeTool({
          database: trx,
          actorUserId: context.actorUserId,
          workspaceId: context.workspaceId,
          projectId: context.projectId,
          runId: context.run.id,
          runKind: context.run.kind == null ? null : String(context.run.kind),
          delegationId: context.run.delegationId == null
            ? null
            : String(context.run.delegationId),
          agentRole: context.agentRole,
          manifest: definition.manifest,
          arguments: parsedArguments,
          approvalId,
          executionStepId: step.id,
          authorizationEvidence,
          authorizationIdempotencyKey: delegationUsageKey(idempotencyKey),
          mode: "replay",
          replayStep: {
            id: step.id,
            runId: step.runId,
            idempotencyKey: String(step.idempotencyKey || ""),
          },
          // The Approval was consumed at this committed preparation boundary.
          // Revocation and live permissions are still checked from current DB
          // state; the original timestamp only prevents a paid recovery from
          // being stranded by the now-consumed quote/Grant TTL.
          now: preparedAt,
          approvalService: this.approvalService,
          delegationGrantService: this.delegationGrantService,
        });
        const owner = createDetachedExecutionOwner(claimFence);
        const previousInputRefs = typeof step.inputRefs === "string"
          ? step.inputRefs
          : JSON.stringify(parsedInputRefs(step));
        const claimed = await trx("o_agent_step")
          .where({ id: step.id, status: "running", inputRefs: previousInputRefs })
          .update({
            inputRefs: JSON.stringify(withDetachedExecutionOwner(step, owner)),
            updatedAt: now,
          });
        if (affectedRows(claimed) !== 1) {
          return {
            kind: "failure",
            error: new AgentToolGatewayError(
              "idempotency_in_progress",
              "相同工具调用已由其他 detached owner 接管",
              { status: 409, replayed: true },
            ),
          };
        }
        return {
          kind: "detached",
          execution: {
            stepId: step.id,
            preparedAt,
            owner,
          },
        };
      } catch (error) {
        const safe = safeToolError(error);
        return {
          kind: "failure",
          error: new AgentToolGatewayError(
            safe.code,
            safe.message,
            { status: safe.status, replayed: true },
          ),
        };
      }
    }

    let context: ExecutionContext;
    try {
      context = await loadExecutionContext(trx, runId);
      if (readInputRefDigest(step, "tool_execution_scope_digest") !== executionScopeDigest(context, approvalId)) {
        throw new AgentToolGatewayError(
          "tool_replay_scope_changed",
          "Run 的用户、工作区、项目、角色或授权范围已变化，旧工具结果不能重放",
          { status: 409 },
        );
      }
      const authorizationContext: AgentToolAuthorizationContext = {
        database: trx,
        actorUserId: context.actorUserId,
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        threadId: context.thread.id,
        runId: context.run.id,
        stepId: step.id,
        agentRole: context.agentRole,
        now,
        generationPreferences: generationPreferencesFromRunPolicy(context.run.policySnapshot),
      };
      const authorizationEvidence = await definition.resolveAuthorizationEvidence(parsedArguments, authorizationContext);
      const storedEvidenceDigest = readInputRefDigest(step, "tool_authorization_evidence_digest");
      if (approvalId !== null && storedEvidenceDigest === null) {
        throw new AgentToolGatewayError(
          "tool_replay_scope_changed",
          "审批工具的原 Step 缺少服务端授权证据，不能重放",
          { status: 409 },
        );
      }
      if (storedEvidenceDigest !== null
        && storedEvidenceDigest !== authorizationEvidenceDigest(authorizationEvidence)) {
        throw new AgentToolGatewayError(
          "tool_replay_scope_changed",
          "工具绑定的服务端资源范围已变化，旧结果不能跨资源重放",
          { status: 409 },
        );
      }
      await authorizeTool({
        database: trx,
        actorUserId: context.actorUserId,
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        runId: context.run.id,
        runKind: context.run.kind == null ? null : String(context.run.kind),
        delegationId: context.run.delegationId == null ? null : String(context.run.delegationId),
        agentRole: context.agentRole,
        manifest: definition.manifest,
        arguments: parsedArguments,
        approvalId,
        executionStepId: step.id,
        authorizationEvidence,
        authorizationIdempotencyKey: delegationUsageKey(idempotencyKey),
        mode: "replay",
        replayStep: {
          id: step.id,
          runId: step.runId,
          idempotencyKey: String(step.idempotencyKey || ""),
        },
        now,
        approvalService: this.approvalService,
        delegationGrantService: this.delegationGrantService,
      });
    } catch (error) {
      const safe = safeToolError(error);
      return {
        kind: "failure",
        error: new AgentToolGatewayError(safe.code, safe.message, { status: safe.status, replayed: true }),
      };
    }
    return replayExistingStep(step, runId, definition, argumentsDigest, expectedAuthorizationDigest);
  }
}

export interface AgentApprovalRevisionEvidenceInput {
  database: Knex.Transaction;
  workspaceId: string;
  projectId: number;
  runId: string;
  /** Pending Approval being decided; forwarded to quote-minting tools. */
  approvalId: string;
  /** Succeeded model-turn checkpoint the Approval paused on. */
  modelStepId: string;
  /** Run trigger user (approval.requestedBy), never the deciding admin. */
  actorUserId: number;
  toolId: string;
  /** Expected immutable tool identity, loaded from the persisted Approval. */
  toolVersion: string;
  riskClass: AgentApprovalRiskClass;
  revisedArguments: unknown;
  now: number;
  registry?: AgentToolRegistry;
}

export interface AgentApprovalRevisionEvidence {
  toolId: ToolId;
  toolVersion: string;
  riskClass: AgentApprovalRiskClass;
  /** Server-parsed (zod + clamp) revised arguments. */
  arguments: unknown;
  resourceVersions: Readonly<Record<string, string>>;
  quote: AgentApprovalQuote | null;
  impactSummary: AgentApprovalImpactSummary | null;
  policyVersion: string;
}

/**
 * Gateway-level evidence re-resolution for a decide-with-revision
 * (REVAMP-PLAN 1.2-3). ApprovalService never touches tool package definitions:
 * this entry re-parses the revised arguments through the registered tool's own
 * zod schema (including its clamp rules) and re-runs the tool's
 * resolveAuthorizationEvidence so the fresh quote/impact evidence is produced
 * by the same server-owned code path as the original pause. The
 * `approvalDecisionRevision` marker tells quote-minting tools to strictly
 * replace their approval-anchored quote (resendAgentGenerationQuoteForApproval)
 * rather than upsert it.
 *
 * Unlike prepareModelApprovalInTransaction this runs while the Run is paused
 * (waiting_approval), so Run identity/scope is re-loaded without requiring the
 * running status; the Approval row lock/CAS remains owned by ApprovalService.
 */
export async function resolveAgentApprovalRevisionEvidence(
  input: AgentApprovalRevisionEvidenceInput,
): Promise<AgentApprovalRevisionEvidence> {
  const registry = input.registry ?? DEFAULT_TOOL_REGISTRY;
  const definition = registry.get(input.toolId);
  if (definition.manifest.riskClass !== "R2" && definition.manifest.riskClass !== "R3") {
    throw new AgentToolGatewayError("tool_not_available", "模型请求的工具对当前 Run 不可用", { status: 404 });
  }
  if (definition.manifest.riskClass !== input.riskClass
    || definition.manifest.version !== input.toolVersion) {
    throw new AgentToolGatewayError(
      "approval_action_mismatch",
      "工具版本或风险等级在审批期间已变化",
      { status: 409 },
    );
  }
  let parsedArguments: unknown;
  try {
    parsedArguments = definition.parseInput(input.revisedArguments);
  } catch {
    throw new AgentToolGatewayError("invalid_tool_arguments", "工具参数不符合服务端 Schema", { status: 400 });
  }
  const run = await input.database<RawRun>("o_agent_run")
    .where({ id: input.runId, workspaceId: input.workspaceId, projectId: input.projectId })
    .select("id", "threadId", "agentRole", "status", "policySnapshot")
    .first();
  if (!run) throw new AgentToolGatewayError("run_not_found", "Agent Run 不存在", { status: 404 });
  const agentRole = toAgentRole(String(run.agentRole));
  const thread = await input.database<RawThread>("o_agent_thread")
    .where({ id: run.threadId, workspaceId: input.workspaceId, projectId: input.projectId })
    .select("id", "status")
    .first();
  if (!thread || thread.status !== "active") {
    throw new AgentToolGatewayError("thread_scope_invalid", "Run 对应 Thread 不存在、已归档或范围不一致", { status: 409 });
  }
  const project = await input.database("o_project")
    .where({ id: input.projectId, workspaceId: input.workspaceId })
    .select("id")
    .first();
  if (!project) {
    throw new AgentToolGatewayError("project_scope_invalid", "项目不存在或不属于当前工作区", { status: 404 });
  }
  const permissions = await loadCurrentToolPermissions({
    database: input.database,
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
  });
  if (!hasExactAgentRuntimePermission(permissions, "project:read")) {
    throw new AgentToolGatewayError("permission_missing", "当前用户不再具有项目读取权限", { status: 403 });
  }
  const catalog = registry.createCatalogContext({ agentRole, permissions, grant: null });
  if (!catalog.describe(definition.manifest.name)) {
    throw new AgentToolGatewayError("tool_not_available", "模型请求的工具对当前 Run 不可用", { status: 404 });
  }
  const step = await input.database("o_agent_step")
    .where({
      id: input.modelStepId,
      runId: run.id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      kind: "model",
      status: "succeeded",
    })
    .select("id")
    .first();
  if (!step) throw new AgentToolGatewayError("model_step_invalid", "模型工具调用检查点不存在", { status: 409 });
  const evidence = await definition.resolveAuthorizationEvidence(parsedArguments, {
    database: input.database,
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    threadId: String(run.threadId),
    runId: run.id,
    stepId: input.modelStepId,
    agentRole,
    now: input.now,
    generationPreferences: generationPreferencesFromRunPolicy(run.policySnapshot),
    approvalDecisionRevision: { approvalId: input.approvalId },
  });
  return {
    toolId: definition.manifest.name,
    toolVersion: definition.manifest.version,
    riskClass: definition.manifest.riskClass,
    arguments: parsedArguments,
    resourceVersions: evidence.resourceVersions ?? {},
    quote: evidence.quote ?? null,
    impactSummary: evidence.impactSummary ?? null,
    policyVersion: typeof evidence.policyVersion === "string" ? evidence.policyVersion : "",
  };
}
