import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { toSafeAgentApprovalDto } from "@/agent-runtime/approvalDto";
import type { ApprovalEvidence } from "@/agent-runtime/contracts";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import { appendAgentEvent, type AppendAgentEventInput } from "@/agent-runtime/eventStore";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { assertToolId, type ToolId } from "@/agent-runtime/toolIds";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import {
  resolveAgentApprovalRevisionEvidence,
  type AgentApprovalRevisionEvidence,
  type AgentApprovalRevisionEvidenceInput,
} from "@/agent-runtime/tools/gateway";
import { AGENT_APPROVAL_TABLE } from "@/lib/migrations/agentApprovalDelegation";
import {
  AGENT_APPROVAL_BUDGET_RESERVED_COLUMN,
  AGENT_PROJECT_BUDGET_RESERVED_COLUMN,
  PROJECT_TABLE,
} from "@/lib/migrations/agentProjectBudget";
import {
  hasExactAgentRuntimePermission,
  resolveLiveWorkspacePermissions,
} from "@/middleware/permissions";

export const AGENT_APPROVAL_MAX_TTL_MS = 30 * 60 * 1_000;
export const AGENT_APPROVAL_EXPIRY_SWEEP_MAX_LIMIT = 200;

export type AgentApprovalStatus = "pending" | "approved" | "denied" | "consumed" | "revoked" | "expired";
export type AgentApprovalRiskClass = "R2" | "R3";

export interface AgentApprovalQuote {
  currency: "GU";
  estimatedCostMicros: number;
  maximumCostMicros: number;
  quoteId?: string;
  expiresAt?: number;
}

export interface AgentApprovalImpactSummary {
  summary: string;
  affectedResourceRefs: string[];
  destructive: boolean;
}

/**
 * Browser-safe scalar projection of the proposed tool arguments, persisted on
 * the Approval row so the confirmation card can echo/edit the proposal
 * (REVAMP-PLAN 1.2-6). Display-only: argumentsHash/scopeHash remain the
 * authoritative action binding and never leave the server.
 */
export type AgentApprovalArgumentsSummary = Record<string, string | number | boolean | null>;

/**
 * Revision facts handed to the caller-supplied checkpoint hook inside the
 * decide transaction. The hook (owned by the tool loop processor) rewrites the
 * paused model-turn checkpoint so the resumed loop executes the revised call.
 */
export interface AgentApprovalRevisionApplication {
  approvalId: string;
  workspaceId: string;
  projectId: number;
  runId: string;
  modelStepId: string;
  toolId: ToolId;
  previousArgumentsHash: string;
  arguments: unknown;
  argumentsHash: string;
  revision: number;
  now: number;
}

export interface AgentApproval {
  id: string;
  workspaceId: string;
  projectId: number;
  runId: string;
  stepId: string | null;
  toolId: ToolId;
  toolVersion: string;
  riskClass: AgentApprovalRiskClass;
  argumentsHash: string;
  argumentsSummary: AgentApprovalArgumentsSummary | null;
  resourceVersions: Record<string, string>;
  evidenceKind: "quote" | "impact";
  quote: AgentApprovalQuote | null;
  impactSummary: AgentApprovalImpactSummary | null;
  scopeHash: string;
  policyVersion: string;
  status: AgentApprovalStatus;
  requestedBy: number;
  decidedBy: number | null;
  decidedAt: number | null;
  expiresAt: number;
  consumedAt: number | null;
  /** Internal audit evidence. Never expose this identifier through browser DTOs. */
  consumedStepId: string | null;
  revokedAt: number | null;
  revokedBy: number | null;
  /**
   * 预算自主审批:该审批当前持有的项目预算预留(微 GU)。非 NULL 即"预算内
   * 自动批准"持久化标记;审批进入 consumed/expired/denied/revoked 终态时在同一
   * 状态 CAS 内清零并回滚 o_project.agentBudgetReservedMicros。
   */
  budgetReservedMicros: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentApprovalActionInput {
  workspaceId: string;
  projectId: number;
  runId: string;
  stepId?: string | null;
  toolId: ToolId;
  toolVersion: string;
  riskClass: AgentApprovalRiskClass;
  arguments: unknown;
  resourceVersions?: Readonly<Record<string, string>>;
  quote?: AgentApprovalQuote | null;
  impactSummary?: AgentApprovalImpactSummary | null;
  policyVersion: string;
}

export interface RequestAgentApprovalInput extends AgentApprovalActionInput {
  requestedBy: number;
  expiresAt: number;
}

export interface VerifyAgentApprovalInput extends AgentApprovalActionInput {
  approvalId: string;
  expectedRevision: number;
}

export interface ConsumeAgentApprovalInput extends VerifyAgentApprovalInput {
  executionStepId: string;
}

/**
 * Evidence supplied by a server-owned Tool definition immediately before a
 * handler is executed. Identity/scope come from the persisted Run. For an
 * exact consumed replay, ToolGateway also supplies the already-loaded Step
 * identity and this service independently reloads and verifies that terminal
 * Step before allowing TTL-independent replay.
 */
export type AgentApprovalToolExecutionInput = Omit<AgentApprovalActionInput, "stepId"> & {
  approvalId: string;
  actorUserId: number;
  executionStepId: string;
  exactReplayStep?: {
    id: string;
    runId: string;
    idempotencyKey: string;
  };
};

export interface PreparedAgentApprovalExecution {
  approval: AgentApproval;
  executionStepId: string;
  evidence: ApprovalEvidence & { runId: string; revision: number };
  verificationMode: "approved_execution" | "exact_consumed_replay";
}

export interface AgentApprovalServiceOptions {
  clock?: () => number;
  idFactory?: () => string;
  maxTtlMs?: number;
  eventAppender?: (trx: Knex.Transaction, input: AppendAgentEventInput) => Promise<string>;
  /**
   * REVAMP-PLAN 1.2: evidence re-resolution used by decide-with-revision.
   * Defaults to the Gateway entry over the production tool registry; tests
   * inject a resolver bound to their synthetic registry.
   */
  revisionEvidenceResolver?: (
    input: AgentApprovalRevisionEvidenceInput,
  ) => Promise<AgentApprovalRevisionEvidence>;
}

export interface AgentApprovalPage {
  data: AgentApproval[];
  nextCursor: string | null;
}

export interface AgentApprovalExpirySweepResult {
  expiredApprovalIds: readonly string[];
}

export interface AgentApprovalBudgetSweepResult {
  expiredApprovalIds: readonly string[];
  releasedMicros: number;
}

interface AgentApprovalCursorValue {
  createdAt: number;
  id: string;
}

interface NormalizedApprovalAction {
  workspaceId: string;
  projectId: number;
  runId: string;
  stepId: string | null;
  toolId: ToolId;
  toolVersion: string;
  riskClass: AgentApprovalRiskClass;
  argumentsHash: string;
  resourceVersions: Record<string, string>;
  evidenceKind: "quote" | "impact";
  quote: AgentApprovalQuote | null;
  impactSummary: AgentApprovalImpactSummary | null;
  policyVersion: string;
  scopeHash: string;
}

interface RawApprovalRow extends Record<string, unknown> {
  id: string;
  workspaceId: string;
  projectId: number | string;
  runId: string;
  stepId: string | null;
  toolId: string;
  toolVersion: string;
  riskClass: string;
  argumentsHash: string;
  argumentsSummary?: unknown;
  resourceVersions: unknown;
  evidenceKind: string;
  quote: unknown;
  impactSummary: unknown;
  scopeHash: string;
  policyVersion: string;
  status: string;
  requestedBy: number | string;
  decidedBy: number | string | null;
  decidedAt: number | string | null;
  expiresAt: number | string;
  consumedAt: number | string | null;
  consumedStepId: string | null;
  revokedAt: number | string | null;
  revokedBy: number | string | null;
  budgetReservedMicros?: number | string | null;
  revision: number | string;
  createdAt: number | string;
  updatedAt: number | string;
}

function cleanString(value: unknown, field: string, maxLength = 200): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new AgentRuntimeError(400, "approval_input_invalid", `${field} 必填且格式有效`);
  }
  return text;
}

function positiveInteger(value: unknown, field: string, allowZero = false): number {
  const number = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new AgentRuntimeError(400, "approval_input_invalid", `${field} 必须是${allowZero ? "非负" : "正"}整数`);
  }
  return number;
}

function optionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function parseJson(value: unknown, field: string): unknown {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new AgentRuntimeError(500, "approval_record_corrupt", `${field} 无法解析`);
  }
}

function normalizeResourceVersions(value: unknown, status = 400): Record<string, string> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AgentRuntimeError(status, "approval_resource_versions_invalid", "resourceVersions 必须是对象");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) {
    throw new AgentRuntimeError(status, "approval_resource_versions_invalid", "resourceVersions 最多包含 100 项");
  }
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawVersion] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    const key = String(rawKey).trim();
    const version = String(rawVersion ?? "").trim();
    if (!key || key.length > 200 || !version || version.length > 200) {
      throw new AgentRuntimeError(status, "approval_resource_versions_invalid", "resourceVersions 包含无效键或版本");
    }
    normalized[key] = version;
  }
  return normalized;
}

function normalizeQuote(value: unknown, status = 400): AgentApprovalQuote {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentRuntimeError(status, "approval_quote_invalid", "R2 审批必须绑定费用报价");
  }
  const record = value as Record<string, unknown>;
  if (record.currency !== "GU") {
    throw new AgentRuntimeError(status, "approval_quote_invalid", "报价 currency 必须是 GU");
  }
  const estimatedCostMicros = positiveInteger(record.estimatedCostMicros, "estimatedCostMicros", true);
  const maximumCostMicros = positiveInteger(record.maximumCostMicros, "maximumCostMicros", true);
  if (maximumCostMicros < estimatedCostMicros) {
    throw new AgentRuntimeError(status, "approval_quote_invalid", "maximumCostMicros 不能小于 estimatedCostMicros");
  }
  const quoteId = record.quoteId == null ? undefined : cleanString(record.quoteId, "quoteId");
  const expiresAt = record.expiresAt == null
    ? undefined
    : positiveInteger(record.expiresAt, "quote.expiresAt", true);
  return {
    currency: "GU",
    estimatedCostMicros,
    maximumCostMicros,
    ...(quoteId ? { quoteId } : {}),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function normalizeImpactSummary(value: unknown, status = 400): AgentApprovalImpactSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentRuntimeError(status, "approval_impact_invalid", "R3 审批必须绑定影响摘要");
  }
  const record = value as Record<string, unknown>;
  const summary = cleanString(record.summary, "impactSummary.summary", 2_000);
  if (!Array.isArray(record.affectedResourceRefs) || record.affectedResourceRefs.length > 100) {
    throw new AgentRuntimeError(status, "approval_impact_invalid", "affectedResourceRefs 必须是最多 100 项的数组");
  }
  const affectedResourceRefs = record.affectedResourceRefs.map((item) => cleanString(item, "affectedResourceRefs[]"));
  if (new Set(affectedResourceRefs).size !== affectedResourceRefs.length) {
    throw new AgentRuntimeError(status, "approval_impact_invalid", "affectedResourceRefs 不能重复");
  }
  if (typeof record.destructive !== "boolean") {
    throw new AgentRuntimeError(status, "approval_impact_invalid", "destructive 必须是布尔值");
  }
  return { summary, affectedResourceRefs: [...affectedResourceRefs].sort(), destructive: record.destructive };
}

function buildScopeHash(action: Omit<NormalizedApprovalAction, "scopeHash">): string {
  return hashIdempotencyRequest(action);
}

const ARGUMENTS_SUMMARY_MAX_KEYS = 50;
const ARGUMENTS_SUMMARY_MAX_STRING = 2_000;

/**
 * Display-only projection of the parsed proposal arguments for the browser
 * confirmation card. Only scalar entries survive (strings truncated); nested
 * structures are dropped so the persisted summary stays small and can never
 * carry blobs. Not part of the tamper-evident scopeHash — the hashes remain
 * the authoritative binding.
 */
export function summarizeApprovalArguments(value: unknown): AgentApprovalArgumentsSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, ARGUMENTS_SUMMARY_MAX_KEYS);
  const summary: AgentApprovalArgumentsSummary = {};
  for (const [key, raw] of entries) {
    if (raw === null || typeof raw === "boolean") {
      summary[key] = raw;
    } else if (typeof raw === "string") {
      summary[key] = raw.length > ARGUMENTS_SUMMARY_MAX_STRING ? raw.slice(0, ARGUMENTS_SUMMARY_MAX_STRING) : raw;
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      summary[key] = raw;
    }
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

function normalizeArgumentsSummary(value: unknown, status = 400): AgentApprovalArgumentsSummary | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "string" ? parseJson(value, "argumentsSummary") : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentRuntimeError(status, "approval_arguments_summary_invalid", "审批参数摘要必须是对象");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > ARGUMENTS_SUMMARY_MAX_KEYS) {
    throw new AgentRuntimeError(status, "approval_arguments_summary_invalid", "审批参数摘要键数量超限");
  }
  const summary: AgentApprovalArgumentsSummary = {};
  for (const [key, raw] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!key || key.length > 200) {
      throw new AgentRuntimeError(status, "approval_arguments_summary_invalid", "审批参数摘要包含无效键");
    }
    if (raw === null || typeof raw === "boolean") {
      summary[key] = raw;
    } else if (typeof raw === "string" && raw.length <= ARGUMENTS_SUMMARY_MAX_STRING) {
      summary[key] = raw;
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      summary[key] = raw;
    } else {
      throw new AgentRuntimeError(status, "approval_arguments_summary_invalid", "审批参数摘要只能包含标量值");
    }
  }
  return summary;
}

async function assertExactConsumedReplayStep(
  trx: Knex.Transaction,
  input: AgentApprovalToolExecutionInput,
  action: NormalizedApprovalAction,
  consumedStepId: string | null,
): Promise<void> {
  const replay = input.exactReplayStep;
  if (!replay) {
    throw new AgentRuntimeError(409, "approval_replay_step_required", "已消费审批只能重放原工具 Step");
  }
  const stepId = cleanString(replay.id, "exactReplayStep.id");
  const executionStepId = cleanString(input.executionStepId, "executionStepId");
  if (!consumedStepId
    || cleanString(consumedStepId, "approval.consumedStepId") !== stepId
    || executionStepId !== stepId) {
    throw new AgentRuntimeError(409, "approval_replay_step_mismatch", "已消费审批只能重放实际消费它的工具 Step");
  }
  const executionRunId = cleanString(replay.runId, "exactReplayStep.runId");
  const idempotencyKey = cleanString(replay.idempotencyKey, "exactReplayStep.idempotencyKey", 512);
  const step = await trx("o_agent_step")
    .where({
      id: stepId,
      workspaceId: action.workspaceId,
      projectId: action.projectId,
      runId: executionRunId,
      kind: "tool",
      toolName: action.toolId,
      idempotencyKey,
    })
    .select("status", "argumentsDigest", "inputRefs")
    .first();
  const refs = step ? parseJson(step.inputRefs, "step.inputRefs") : null;
  const detachedPrepared = Array.isArray(refs)
    && refs.some((item) => (
      item
      && typeof item === "object"
      && (item as Record<string, unknown>).type === "tool_execution_protocol"
      && (item as Record<string, unknown>).value === "metered-detached/v1"
    ));
  if (
    !step
    || (
      !["succeeded", "failed"].includes(String(step.status))
      && !(String(step.status) === "running" && detachedPrepared)
    )
  ) {
    throw new AgentRuntimeError(409, "approval_replay_step_mismatch", "已消费审批只能重放原工具 Step");
  }
  if (String(step.argumentsDigest || "") !== action.argumentsHash) {
    throw new AgentRuntimeError(409, "approval_replay_step_mismatch", "原工具 Step 与审批参数不匹配");
  }
  const authorization = Array.isArray(refs)
    ? refs.find((item) => (
        item
        && typeof item === "object"
        && (item as Record<string, unknown>).type === "tool_authorization_digest"
      )) as Record<string, unknown> | undefined
    : undefined;
  if (authorization?.value !== hashIdempotencyRequest({ approvalId: input.approvalId })) {
    throw new AgentRuntimeError(409, "approval_replay_step_mismatch", "原工具 Step 与审批授权不匹配");
  }
}

async function assertExecutionStepForConsumption(
  trx: Knex.Transaction,
  input: {
    approvalId: string;
    executionStepId: string;
    actorUserId: number;
  },
  action: NormalizedApprovalAction,
): Promise<string> {
  const executionStepId = cleanString(input.executionStepId, "executionStepId");
  const step = await trx("o_agent_step")
    .where({
      id: executionStepId,
      workspaceId: action.workspaceId,
      projectId: action.projectId,
      kind: "tool",
      status: "running",
      toolName: action.toolId,
    })
    .select("runId", "argumentsDigest", "inputRefs")
    .first();
  if (!step || String(step.argumentsDigest || "") !== action.argumentsHash) {
    throw new AgentRuntimeError(409, "approval_execution_step_mismatch", "审批只能由当前真实运行中的工具 Step 消费");
  }
  const refs = parseJson(step.inputRefs, "step.inputRefs");
  const authorization = Array.isArray(refs)
    ? refs.find((item) => (
        item
        && typeof item === "object"
        && (item as Record<string, unknown>).type === "tool_authorization_digest"
      )) as Record<string, unknown> | undefined
    : undefined;
  if (authorization?.value !== hashIdempotencyRequest({ approvalId: input.approvalId })) {
    throw new AgentRuntimeError(409, "approval_execution_step_mismatch", "工具 Step 与待消费审批不匹配");
  }

  const run = await trx("o_agent_run")
    .where({
      id: String(step.runId),
      workspaceId: action.workspaceId,
      projectId: action.projectId,
    })
    .select("triggerMessageId")
    .first();
  const trigger = run
    ? await trx("o_agent_message")
      .where({
        id: String(run.triggerMessageId),
        workspaceId: action.workspaceId,
        projectId: action.projectId,
        runId: String(step.runId),
      })
      .select("createdBy")
      .first()
    : null;
  if (!trigger || Number(trigger.createdBy) !== positiveInteger(input.actorUserId, "actorUserId")) {
    throw new AgentRuntimeError(409, "approval_execution_step_mismatch", "工具 Step 不属于审批发起用户的 Run");
  }
  return executionStepId;
}

export function normalizeAgentApprovalAction(input: AgentApprovalActionInput): NormalizedApprovalAction {
  let toolId: ToolId;
  try {
    assertToolId(input.toolId);
    toolId = input.toolId;
  } catch {
    throw new AgentRuntimeError(400, "approval_tool_invalid", "审批必须绑定 canonical ToolId");
  }
  const workspaceId = cleanString(input.workspaceId, "workspaceId");
  const projectId = positiveInteger(input.projectId, "projectId");
  const runId = cleanString(input.runId, "runId");
  const stepId = input.stepId == null ? null : cleanString(input.stepId, "stepId");
  const toolVersion = cleanString(input.toolVersion, "toolVersion");
  const policyVersion = cleanString(input.policyVersion, "policyVersion");
  const resourceVersions = normalizeResourceVersions(input.resourceVersions);
  let argumentsHash: string;
  try {
    argumentsHash = hashIdempotencyRequest(input.arguments);
  } catch {
    throw new AgentRuntimeError(400, "approval_arguments_invalid", "工具参数必须是可规范化的 JSON 值");
  }

  let evidenceKind: "quote" | "impact";
  let quote: AgentApprovalQuote | null = null;
  let impactSummary: AgentApprovalImpactSummary | null = null;
  if (input.riskClass === "R2") {
    if (input.impactSummary != null) {
      throw new AgentRuntimeError(400, "approval_evidence_ambiguous", "R2 审批只能绑定报价，不能同时绑定影响摘要");
    }
    evidenceKind = "quote";
    quote = normalizeQuote(input.quote);
  } else if (input.riskClass === "R3") {
    if (input.quote != null) {
      throw new AgentRuntimeError(400, "approval_evidence_ambiguous", "R3 审批只能绑定影响摘要，不能同时绑定报价");
    }
    evidenceKind = "impact";
    impactSummary = normalizeImpactSummary(input.impactSummary);
  } else {
    throw new AgentRuntimeError(400, "approval_risk_invalid", "审批仅适用于 R2 或 R3 工具");
  }

  const actionWithoutHash = {
    workspaceId,
    projectId,
    runId,
    stepId,
    toolId,
    toolVersion,
    riskClass: input.riskClass,
    argumentsHash,
    resourceVersions,
    evidenceKind,
    quote,
    impactSummary,
    policyVersion,
  };
  return { ...actionWithoutHash, scopeHash: buildScopeHash(actionWithoutHash) };
}

function mapStatus(value: unknown): AgentApprovalStatus {
  const status = String(value || "");
  if (["pending", "approved", "denied", "consumed", "revoked", "expired"].includes(status)) {
    return status as AgentApprovalStatus;
  }
  throw new AgentRuntimeError(500, "approval_record_corrupt", "审批状态无效");
}

function actionFromRow(row: RawApprovalRow): Omit<NormalizedApprovalAction, "scopeHash"> {
  let toolId: ToolId;
  try {
    assertToolId(row.toolId);
    toolId = row.toolId;
  } catch {
    throw new AgentRuntimeError(500, "approval_record_corrupt", "审批工具不是 canonical ToolId");
  }
  const riskClass = String(row.riskClass);
  if (riskClass !== "R2" && riskClass !== "R3") {
    throw new AgentRuntimeError(500, "approval_record_corrupt", "审批风险等级无效");
  }
  const evidenceKind = String(row.evidenceKind);
  if (evidenceKind !== "quote" && evidenceKind !== "impact") {
    throw new AgentRuntimeError(500, "approval_record_corrupt", "审批证据类型无效");
  }
  const quote = row.quote == null ? null : normalizeQuote(parseJson(row.quote, "quote"), 500);
  const impactSummary = row.impactSummary == null
    ? null
    : normalizeImpactSummary(parseJson(row.impactSummary, "impactSummary"), 500);
  if ((riskClass === "R2" && (evidenceKind !== "quote" || !quote || impactSummary))
    || (riskClass === "R3" && (evidenceKind !== "impact" || !impactSummary || quote))) {
    throw new AgentRuntimeError(500, "approval_record_corrupt", "审批风险等级与证据不匹配");
  }
  return {
    workspaceId: String(row.workspaceId),
    projectId: Number(row.projectId),
    runId: String(row.runId),
    stepId: row.stepId == null ? null : String(row.stepId),
    toolId,
    toolVersion: String(row.toolVersion),
    riskClass,
    argumentsHash: String(row.argumentsHash),
    resourceVersions: normalizeResourceVersions(parseJson(row.resourceVersions, "resourceVersions"), 500),
    evidenceKind,
    quote,
    impactSummary,
    policyVersion: String(row.policyVersion),
  };
}

function mapApproval(row: RawApprovalRow): AgentApproval {
  const action = actionFromRow(row);
  const expectedScopeHash = buildScopeHash(action);
  if (String(row.scopeHash) !== expectedScopeHash) {
    throw new AgentRuntimeError(500, "approval_record_tampered", "审批精确动作哈希校验失败");
  }
  return {
    id: String(row.id),
    ...action,
    argumentsSummary: normalizeArgumentsSummary(row.argumentsSummary ?? null, 500),
    scopeHash: expectedScopeHash,
    status: mapStatus(row.status),
    requestedBy: Number(row.requestedBy),
    decidedBy: optionalNumber(row.decidedBy),
    decidedAt: optionalNumber(row.decidedAt),
    expiresAt: Number(row.expiresAt),
    consumedAt: optionalNumber(row.consumedAt),
    consumedStepId: row.consumedStepId == null ? null : String(row.consumedStepId),
    revokedAt: optionalNumber(row.revokedAt),
    revokedBy: optionalNumber(row.revokedBy),
    budgetReservedMicros: optionalNumber(row.budgetReservedMicros),
    revision: Number(row.revision),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function withEffectiveExpiry(approval: AgentApproval, now: number): AgentApproval {
  return approval.expiresAt <= now && (approval.status === "pending" || approval.status === "approved")
    ? { ...approval, status: "expired" }
    : approval;
}

function revisionConflict(expectedRevision: number, currentRevision: number): AgentRuntimeError {
  return new AgentRuntimeError(409, "approval_revision_conflict", "审批已被其他请求更新", {
    expectedRevision,
    currentRevision,
  });
}

function affectedRows(value: unknown): number {
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.length;
  return Number(value || 0);
}

class ApprovalExpirySweepConflict extends Error {
  constructor() {
    super("approval expiry sweep conflict");
    this.name = "ApprovalExpirySweepConflict";
  }
}

/**
 * Revokes the exact pending Approval that owns an A3 Run pause.
 *
 * The caller owns the surrounding Run/Thread transaction. Keeping the
 * Approval CAS in that transaction makes cancel vs. approve/deny a single
 * winner operation: a decision that moved the revision/status makes the
 * cancellation roll back, and a cancellation that wins makes the decision
 * observe a non-pending Approval.
 */
export async function revokePendingAgentApprovalInTransaction(
  trx: Knex.Transaction,
  input: {
    workspaceId: string;
    projectId: number;
    runId: string;
    approvalId: string;
    revokedBy: number;
    now: number;
  },
): Promise<AgentApproval> {
  const workspaceId = cleanString(input.workspaceId, "workspaceId");
  const projectId = positiveInteger(input.projectId, "projectId");
  const runId = cleanString(input.runId, "runId");
  const approvalId = cleanString(input.approvalId, "approvalId");
  const revokedBy = positiveInteger(input.revokedBy, "revokedBy");
  const now = positiveInteger(input.now, "now", true);
  const row = await trx<RawApprovalRow>(AGENT_APPROVAL_TABLE)
    .where({ id: approvalId, workspaceId, projectId, runId })
    .forUpdate()
    .first();
  if (!row) {
    throw new AgentRuntimeError(409, "approval_wait_conflict", "Run 等待的审批已变化，请重试");
  }

  const approval = mapApproval(row);
  if (approval.status !== "pending") {
    throw new AgentRuntimeError(409, "approval_wait_conflict", "Run 等待的审批已被处理，请重试");
  }
  const updated = await trx(AGENT_APPROVAL_TABLE)
    .where({
      id: approval.id,
      workspaceId: approval.workspaceId,
      projectId: approval.projectId,
      runId: approval.runId,
      revision: approval.revision,
      status: "pending",
    })
    .update({
      status: "revoked",
      revokedBy,
      revokedAt: now,
      revision: approval.revision + 1,
      updatedAt: now,
    });
  if (affectedRows(updated) !== 1) {
    throw new AgentRuntimeError(409, "approval_wait_conflict", "Run 等待的审批已变化，请重试");
  }
  const stored = await trx<RawApprovalRow>(AGENT_APPROVAL_TABLE)
    .where({ id: approval.id, workspaceId, projectId, runId })
    .first();
  if (!stored) throw new AgentRuntimeError(500, "approval_save_failed", "审批更新后无法读取");
  return mapApproval(stored);
}

/**
 * 预算自主审批:把一笔刚刚落库的 pending 审批在同一事务内自动批准。
 * 调用方(toolLoopProcessor.pauseForApproval)必须先完成项目预算的原子预留
 * (check-and-reserve CAS),再调用本函数打标;budgetReservedMicros 同时是
 * "自动批准"标记与精确的待释放金额。CAS 失败抛错,由调用方整体回滚(预留
 * 也随之回滚)。
 */
export async function autoApproveAgentApprovalInTransaction(
  trx: Knex.Transaction,
  input: {
    approval: AgentApproval;
    /** Run 触发者(requestedBy 已经 assertRunAndStep 校验为可验证发起用户)。 */
    decidedBy: number;
    budgetReservedMicros: number;
    now: number;
  },
): Promise<AgentApproval> {
  const decidedBy = positiveInteger(input.decidedBy, "decidedBy");
  const reserved = positiveInteger(input.budgetReservedMicros, "budgetReservedMicros");
  const now = positiveInteger(input.now, "now", true);
  const approval = input.approval;
  const updated = await trx(AGENT_APPROVAL_TABLE)
    .where({
      id: approval.id,
      workspaceId: approval.workspaceId,
      projectId: approval.projectId,
      runId: approval.runId,
      status: "pending",
      revision: approval.revision,
    })
    .update({
      status: "approved",
      decidedBy,
      decidedAt: now,
      [AGENT_APPROVAL_BUDGET_RESERVED_COLUMN]: reserved,
      revision: approval.revision + 1,
      updatedAt: now,
    });
  if (affectedRows(updated) !== 1) {
    throw new AgentRuntimeError(409, "approval_wait_conflict", "审批状态已变化，无法自动批准");
  }
  const stored = await trx<RawApprovalRow>(AGENT_APPROVAL_TABLE)
    .where({ id: approval.id, workspaceId: approval.workspaceId, projectId: approval.projectId })
    .first();
  if (!stored) throw new AgentRuntimeError(500, "approval_save_failed", "审批更新后无法读取");
  return mapApproval(stored);
}

/**
 * 预算自主审批:在审批终态(consumed/expired/denied/revoked)状态 CAS 成功之后、
 * 同一事务内回滚项目预算预留。预留标记已在该状态 CAS 内一并清零,因此只有
 * CAS 赢家会到达这里;并发/重放下释放幂等。预留余额防御性钳到 0:记账漂移
 * 留给 reconcile 对账(后续阶段),绝不阻塞审批状态机。
 */
export async function releaseAgentApprovalBudgetReservationInTransaction(
  trx: Knex.Transaction,
  input: {
    workspaceId: string;
    projectId: number;
    amountMicros: number;
  },
): Promise<void> {
  const amount = positiveInteger(input.amountMicros, "amountMicros");
  await trx(PROJECT_TABLE)
    .where({ id: input.projectId, workspaceId: input.workspaceId })
    .update({
      [AGENT_PROJECT_BUDGET_RESERVED_COLUMN]: trx.raw(
        "CASE WHEN COALESCE(??, 0) >= ? THEN COALESCE(??, 0) - ? ELSE 0 END",
        [
          AGENT_PROJECT_BUDGET_RESERVED_COLUMN,
          amount,
          AGENT_PROJECT_BUDGET_RESERVED_COLUMN,
          amount,
        ],
      ),
    });
}

/**
 * 若该审批持有预算预留则释放(终态状态 CAS 已胜出后调用,同事务)。
 * amount 为 0/NULL 时无操作——人工审批从未持有预留。
 */
async function releaseApprovalBudgetReservationIfHeld(
  trx: Knex.Transaction,
  approval: AgentApproval,
): Promise<void> {
  if (approval.budgetReservedMicros == null || approval.budgetReservedMicros <= 0) return;
  await releaseAgentApprovalBudgetReservationInTransaction(trx, {
    workspaceId: approval.workspaceId,
    projectId: approval.projectId,
    amountMicros: approval.budgetReservedMicros,
  });
}

function decodeAgentApprovalCursor(value: string): AgentApprovalCursorValue {
  // Compatibility for the early frontend contract, whose cursor type allowed
  // numbers. New responses always return the stable opaque tuple below.
  if (/^\d+$/.test(value)) {
    const createdAt = Number(value);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new AgentRuntimeError(400, "approval_cursor_invalid", "审批分页游标无效");
    }
    return { createdAt, id: "" };
  }
  let parsed: Partial<AgentApprovalCursorValue>;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<AgentApprovalCursorValue>;
  } catch {
    throw new AgentRuntimeError(400, "approval_cursor_invalid", "审批分页游标无效");
  }
  if (!Number.isSafeInteger(parsed.createdAt) || Number(parsed.createdAt) < 0
    || typeof parsed.id !== "string" || !parsed.id || parsed.id.length > 200) {
    throw new AgentRuntimeError(400, "approval_cursor_invalid", "审批分页游标无效");
  }
  return { createdAt: Number(parsed.createdAt), id: parsed.id };
}

function encodeAgentApprovalCursor(value: AgentApprovalCursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function isAgentApprovalCursor(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 500) return false;
  try {
    decodeAgentApprovalCursor(value);
    return true;
  } catch {
    return false;
  }
}

async function assertProjectAccess(
  trx: Knex.Transaction,
  workspaceId: string,
  projectId: number,
  userId: number,
  permission: "project:read" | "project:write",
): Promise<void> {
  const project = await trx("o_project").where({ id: projectId, workspaceId }).select("id").first();
  if (!project) throw new AgentRuntimeError(404, "approval_scope_not_found", "项目或审批范围不存在");

  const authority = await resolveLiveWorkspacePermissions({
    database: trx,
    actorUserId: userId,
    workspaceId,
  });
  if (!hasExactAgentRuntimePermission(authority.permissions, permission)) {
    throw new AgentRuntimeError(403, "approval_actor_forbidden", "用户不再具有当前项目权限");
  }
}

async function assertRunAndStep(
  trx: Knex.Transaction,
  action: NormalizedApprovalAction,
  requestedBy: number,
): Promise<void> {
  const run = await trx("o_agent_run")
    .where({ id: action.runId, workspaceId: action.workspaceId, projectId: action.projectId })
    .select("id", "threadId", "triggerMessageId", "status")
    .first();
  if (!run) throw new AgentRuntimeError(404, "approval_run_not_found", "Agent Run 不存在");
  if (!["running", "waiting_approval"].includes(String(run.status))) {
    throw new AgentRuntimeError(409, "approval_run_inactive", "只有执行中或等待审批的 Run 可以请求审批");
  }
  const trigger = await trx("o_agent_message")
    .where({
      id: run.triggerMessageId,
      runId: run.id,
      threadId: run.threadId,
      workspaceId: action.workspaceId,
      projectId: action.projectId,
    })
    .select("createdBy")
    .first();
  if (!trigger || Number(trigger.createdBy) !== requestedBy) {
    throw new AgentRuntimeError(403, "approval_requester_mismatch", "审批请求人必须是 Run 的可验证发起用户");
  }
  await assertProjectAccess(trx, action.workspaceId, action.projectId, requestedBy, "project:read");

  if (!action.stepId) return;
  const step = await trx("o_agent_step")
    .where({
      id: action.stepId,
      runId: action.runId,
      workspaceId: action.workspaceId,
      projectId: action.projectId,
    })
    .select("kind", "status", "toolName", "argumentsDigest", "outputRefs")
    .first();
  if (!step) throw new AgentRuntimeError(404, "approval_step_not_found", "Agent Step 不存在");
  if (String(step.kind) === "tool") {
    if (step.toolName != null && String(step.toolName) !== action.toolId) {
      throw new AgentRuntimeError(409, "approval_step_tool_mismatch", "审批工具与 Step 不一致");
    }
    if (step.argumentsDigest != null && String(step.argumentsDigest) !== action.argumentsHash) {
      throw new AgentRuntimeError(409, "approval_step_arguments_mismatch", "审批参数与 Step 不一致");
    }
    return;
  }
  if (String(step.kind) !== "model" || String(step.status) !== "succeeded") {
    throw new AgentRuntimeError(409, "approval_step_invalid", "审批必须绑定已完成的模型或工具 Step");
  }

  const outputRefs = parseJson(step.outputRefs, "step.outputRefs");
  const checkpoint = Array.isArray(outputRefs) && outputRefs.length === 1
    && outputRefs[0] && typeof outputRefs[0] === "object" && !Array.isArray(outputRefs[0])
    ? outputRefs[0] as Record<string, unknown>
    : null;
  const calls = checkpoint && checkpoint.outcome === "tool_calls" && Array.isArray(checkpoint.calls)
    ? checkpoint.calls
    : [];
  const call = calls.length === 1 && calls[0] && typeof calls[0] === "object" && !Array.isArray(calls[0])
    ? calls[0] as Record<string, unknown>
    : null;
  if (!call || String(call.name || "") !== action.toolId) {
    throw new AgentRuntimeError(409, "approval_step_tool_mismatch", "审批工具与模型调用检查点不一致");
  }
  let checkpointArgumentsHash: string;
  try {
    checkpointArgumentsHash = hashIdempotencyRequest(call.arguments);
  } catch {
    throw new AgentRuntimeError(409, "approval_step_arguments_mismatch", "模型调用检查点参数无效");
  }
  if (checkpointArgumentsHash !== action.argumentsHash) {
    throw new AgentRuntimeError(409, "approval_step_arguments_mismatch", "审批参数与模型调用检查点不一致");
  }
}

type TransactionOutcome<T> = { value: T } | { error: AgentRuntimeError };

export class AgentApprovalService {
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly maxTtlMs: number;
  private readonly eventAppender: (trx: Knex.Transaction, input: AppendAgentEventInput) => Promise<string>;
  private readonly revisionEvidenceResolver: (
    input: AgentApprovalRevisionEvidenceInput,
  ) => Promise<AgentApprovalRevisionEvidence>;

  constructor(
    private readonly database: Knex,
    options: AgentApprovalServiceOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.maxTtlMs = positiveInteger(options.maxTtlMs ?? AGENT_APPROVAL_MAX_TTL_MS, "maxTtlMs");
    this.eventAppender = options.eventAppender ?? appendAgentEvent;
    this.revisionEvidenceResolver = options.revisionEvidenceResolver ?? resolveAgentApprovalRevisionEvidence;
  }

  async request(input: RequestAgentApprovalInput): Promise<AgentApproval> {
    return this.database.transaction((trx) => this.requestInTransaction(trx, input));
  }

  /** Creates the exact Approval inside a caller-owned Run pause transaction. */
  async requestInTransaction(
    trx: Knex.Transaction,
    input: RequestAgentApprovalInput,
  ): Promise<AgentApproval> {
    const action = normalizeAgentApprovalAction(input);
    const requestedBy = positiveInteger(input.requestedBy, "requestedBy");
    const now = this.clock();
    const expiresAt = positiveInteger(input.expiresAt, "expiresAt", true);
    if (expiresAt <= now || expiresAt > now + this.maxTtlMs) {
      throw new AgentRuntimeError(400, "approval_expiry_invalid", "审批过期时间必须在允许的 TTL 内");
    }
    if (action.quote?.expiresAt !== undefined && expiresAt > action.quote.expiresAt) {
      throw new AgentRuntimeError(400, "approval_expiry_invalid", "审批有效期不能超过报价有效期");
    }
    const id = cleanString(this.idFactory(), "approvalId");

    await assertRunAndStep(trx, action, requestedBy);
    const argumentsSummary = summarizeApprovalArguments(input.arguments);
    await trx(AGENT_APPROVAL_TABLE).insert({
        id,
        workspaceId: action.workspaceId,
        projectId: action.projectId,
        runId: action.runId,
        stepId: action.stepId,
        toolId: action.toolId,
        toolVersion: action.toolVersion,
        riskClass: action.riskClass,
        argumentsHash: action.argumentsHash,
        argumentsSummary: argumentsSummary ? JSON.stringify(argumentsSummary) : null,
        resourceVersions: JSON.stringify(action.resourceVersions),
        evidenceKind: action.evidenceKind,
        quote: action.quote ? JSON.stringify(action.quote) : null,
        impactSummary: action.impactSummary ? JSON.stringify(action.impactSummary) : null,
        scopeHash: action.scopeHash,
        policyVersion: action.policyVersion,
        status: "pending",
        requestedBy,
        decidedBy: null,
        decidedAt: null,
        expiresAt,
        consumedAt: null,
        consumedStepId: null,
        revokedAt: null,
        revokedBy: null,
        budgetReservedMicros: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
    });
    const row = await trx<RawApprovalRow>(AGENT_APPROVAL_TABLE).where({ id }).first();
    if (!row) throw new AgentRuntimeError(500, "approval_save_failed", "审批保存后无法读取");
    return mapApproval(row);
  }

  async get(input: { workspaceId: string; projectId: number; approvalId: string }): Promise<AgentApproval> {
    const row = await this.database<RawApprovalRow>(AGENT_APPROVAL_TABLE)
      .where({
        id: cleanString(input.approvalId, "approvalId"),
        workspaceId: cleanString(input.workspaceId, "workspaceId"),
        projectId: positiveInteger(input.projectId, "projectId"),
      })
      .first();
    if (!row) throw new AgentRuntimeError(404, "approval_not_found", "审批不存在");
    return withEffectiveExpiry(mapApproval(row), this.clock());
  }

  /**
   * Read and integrity-check an Approval inside a caller-owned transaction.
   *
   * This method is deliberately read-only: it neither prepares a Tool Step nor
   * consumes/revokes the Approval.  Deterministic executors use it for an
   * admission-only preflight, then must repeat the locked prepare + consume
   * checks in the future dispatch transaction.
   */
  async getInTransaction(
    trx: Knex.Transaction,
    input: { workspaceId: string; projectId: number; approvalId: string },
    now = this.clock(),
  ): Promise<AgentApproval> {
    const checkedAt = positiveInteger(now, "now", true);
    const row = await trx<RawApprovalRow>(AGENT_APPROVAL_TABLE)
      .where({
        id: cleanString(input.approvalId, "approvalId"),
        workspaceId: cleanString(input.workspaceId, "workspaceId"),
        projectId: positiveInteger(input.projectId, "projectId"),
      })
      .first();
    if (!row) throw new AgentRuntimeError(404, "approval_not_found", "审批不存在");
    return withEffectiveExpiry(mapApproval(row), checkedAt);
  }

  /**
   * Resolve an opaque approval id only inside the authenticated workspace.
   * The project/run scope is loaded from durable records and is never accepted
   * from the decision request body.
   */
  async getForWorkspace(input: { workspaceId: string; approvalId: string }): Promise<AgentApproval> {
    const workspaceId = cleanString(input.workspaceId, "workspaceId");
    const approvalId = cleanString(input.approvalId, "approvalId");
    return this.database.transaction(async (trx) => {
      const row = await trx<RawApprovalRow>(AGENT_APPROVAL_TABLE).where({ id: approvalId, workspaceId }).first();
      if (!row) throw new AgentRuntimeError(404, "approval_not_found", "审批不存在");
      const approval = mapApproval(row);
      const run = await trx("o_agent_run")
        .where({ id: approval.runId, workspaceId, projectId: approval.projectId })
        .select("id")
        .first();
      if (!run) throw new AgentRuntimeError(404, "approval_not_found", "审批不存在");
      return withEffectiveExpiry(approval, this.clock());
    });
  }

  /** Stable `(createdAt,id)` pagination for refresh/recovery snapshots. */
  async listForRun(input: {
    workspaceId: string;
    runId: string;
    actorUserId: number;
    after?: string | null;
    limit?: number;
  }): Promise<AgentApprovalPage> {
    const workspaceId = cleanString(input.workspaceId, "workspaceId");
    const runId = cleanString(input.runId, "runId");
    const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
    const limit = Math.min(200, positiveInteger(input.limit ?? 50, "limit"));
    const cursor = input.after ? decodeAgentApprovalCursor(input.after) : null;
    const now = this.clock();

    return this.database.transaction(async (trx) => {
      const run = await trx("o_agent_run")
        .where({ id: runId, workspaceId })
        .select("id", "projectId")
        .first();
      if (!run) throw new AgentRuntimeError(404, "run_not_found", "Agent Run 不存在");
      const projectId = positiveInteger(run.projectId, "projectId");
      await assertProjectAccess(trx, workspaceId, projectId, actorUserId, "project:read");

      const query = trx<RawApprovalRow>(AGENT_APPROVAL_TABLE)
        .where({ workspaceId, projectId, runId })
        .orderBy("createdAt", "asc")
        .orderBy("id", "asc")
        .limit(limit + 1);
      if (cursor) {
        query.andWhere(function (this: Knex.QueryBuilder) {
          this.where("createdAt", ">", cursor.createdAt).orWhere(function (this: Knex.QueryBuilder) {
            this.where("createdAt", cursor.createdAt).andWhere("id", ">", cursor.id);
          });
        });
      }
      const rows = await query;
      const hasMore = rows.length > limit;
      const data = rows.slice(0, limit).map((row) => withEffectiveExpiry(mapApproval(row), now));
      return {
        data,
        nextCursor: hasMore && data.length
          ? encodeAgentApprovalCursor({ createdAt: data[data.length - 1].createdAt, id: data[data.length - 1].id })
          : null,
      };
    });
  }

  /**
   * Atomically expires exact A3 Approval waits and makes their Runs claimable.
   *
   * The candidate query is only an optimization. Every mutation is protected
   * again by Approval/Run/Thread CAS inside a transaction, so expiry, a user
   * decision and cancellation have one winner across concurrent workers.
   */
  async sweepExpiredWaitingApprovals(input: { limit?: number } = {}): Promise<AgentApprovalExpirySweepResult> {
    const limit = Math.min(
      AGENT_APPROVAL_EXPIRY_SWEEP_MAX_LIMIT,
      positiveInteger(input.limit ?? 50, "limit"),
    );
    const now = this.clock();
    const candidates = await this.database(`${AGENT_APPROVAL_TABLE} as approval`)
      .innerJoin("o_agent_run as run", function () {
        this.on("run.id", "=", "approval.runId")
          .andOn("run.workspaceId", "=", "approval.workspaceId")
          .andOn("run.projectId", "=", "approval.projectId");
      })
      .where("approval.status", "pending")
      .andWhere("approval.expiresAt", "<=", now)
      .andWhere("run.status", "waiting_approval")
      .andWhere("run.waitType", "approval")
      .andWhereRaw("?? = ??", ["run.waitRef", "approval.id"])
      .select("approval.id", "approval.expiresAt", "approval.createdAt")
      .orderBy("approval.expiresAt", "asc")
      .orderBy("approval.createdAt", "asc")
      .orderBy("approval.id", "asc")
      .limit(limit) as Array<{ id: string }>;

    const expiredApprovalIds: string[] = [];
    for (const candidate of candidates) {
      try {
        const expiredId = await this.database.transaction(async (trx) => {
          const row = await trx<RawApprovalRow>(AGENT_APPROVAL_TABLE)
            .where({ id: String(candidate.id), status: "pending" })
            .andWhere("expiresAt", "<=", now)
            .forUpdate()
            .first();
          if (!row) return null;
          const approval = mapApproval(row);

          const run = await trx("o_agent_run")
            .where({
              id: approval.runId,
              workspaceId: approval.workspaceId,
              projectId: approval.projectId,
              status: "waiting_approval",
              waitType: "approval",
              waitRef: approval.id,
            })
            .select("id", "threadId", "version")
            .forUpdate()
            .first();
          if (!run) return null;
          const thread = await trx("o_agent_thread")
            .where({
              id: run.threadId,
              workspaceId: approval.workspaceId,
              projectId: approval.projectId,
            })
            .select("id", "eventSeq", "version")
            .forUpdate()
            .first();
          if (!thread) return null;

          const runVersion = Number(run.version || 0);
          const threadVersion = Number(thread.version || 0);
          const currentEventSeq = Number(thread.eventSeq || 0);
          if (!Number.isSafeInteger(runVersion) || runVersion < 0
            || !Number.isSafeInteger(threadVersion) || threadVersion < 0
            || !Number.isSafeInteger(currentEventSeq) || currentEventSeq < 0) {
            return null;
          }

          const approvalUpdated = await trx(AGENT_APPROVAL_TABLE)
            .where({
              id: approval.id,
              workspaceId: approval.workspaceId,
              projectId: approval.projectId,
              runId: approval.runId,
              status: "pending",
              revision: approval.revision,
            })
            .andWhere("expiresAt", "<=", now)
            .update({
              status: "expired",
              revision: approval.revision + 1,
              updatedAt: now,
            });
          if (affectedRows(approvalUpdated) !== 1) return null;

          const runUpdated = await trx("o_agent_run")
            .where({
              id: run.id,
              workspaceId: approval.workspaceId,
              projectId: approval.projectId,
              status: "waiting_approval",
              waitType: "approval",
              waitRef: approval.id,
              version: runVersion,
            })
            .update({
              status: "queued",
              waitType: null,
              waitRef: null,
              wakeAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              error: null,
              completedAt: null,
              version: runVersion + 1,
              updatedAt: now,
            });
          if (affectedRows(runUpdated) !== 1) throw new ApprovalExpirySweepConflict();

          const firstEventSeq = currentEventSeq + 1;
          const threadUpdated = await trx("o_agent_thread")
            .where({
              id: thread.id,
              workspaceId: approval.workspaceId,
              projectId: approval.projectId,
              eventSeq: currentEventSeq,
              version: threadVersion,
            })
            .update({
              eventSeq: firstEventSeq + 1,
              version: threadVersion + 1,
              updatedAt: now,
            });
          if (affectedRows(threadUpdated) !== 1) throw new ApprovalExpirySweepConflict();

          const stored = await this.readStored(trx, approval.id);
          await this.eventAppender(trx, {
            workspaceId: approval.workspaceId,
            projectId: approval.projectId,
            threadId: String(thread.id),
            runId: approval.runId,
            stepId: approval.stepId,
            seq: firstEventSeq,
            type: "approval.expired",
            payload: { approval: toSafeAgentApprovalDto(stored) },
            createdAt: now,
          });
          await this.eventAppender(trx, {
            workspaceId: approval.workspaceId,
            projectId: approval.projectId,
            threadId: String(thread.id),
            runId: approval.runId,
            stepId: approval.stepId,
            seq: firstEventSeq + 1,
            type: "run.queued",
            payload: { runId: approval.runId, status: "queued", reason: "approval_expired" },
            createdAt: now,
          });
          return approval.id;
        });
        if (expiredId) expiredApprovalIds.push(expiredId);
      } catch (error) {
        if (error instanceof ApprovalExpirySweepConflict) continue;
        throw error;
      }
    }
    return { expiredApprovalIds };
  }

  /**
   * 预算自主审批的安全网:清扫"approved 且仍持有预算预留、但已过期"的审批。
   *
   * 自动批准的审批离开 pending 后不再被 sweepExpiredWaitingApprovals 覆盖
   * (该 sweep 只处理 pending + Run waiting_approval);正常情况下预留随
   * consume/expire(prepare/consume 懒过期)/deny/revoke 同事态回滚。若 Run 在
   * 恢复前被取消或长期滞留 queued,approved 行会挂着预留直到 TTL——本清扫在
   * Worker 每个 tick 将其事务性过期并回滚预留。与并发 consume 的竞态由审批行
   * 状态 CAS 保证单一赢家;标记清零与释放在同一事务。不发事件:Run 不在等待
   * 态,前端经 Run 审批分页读取到 expired 投影即可;reconcile 对账列后续。
   */
  async sweepExpiredAutoApprovedReservations(input: { limit?: number } = {}): Promise<AgentApprovalBudgetSweepResult> {
    const limit = Math.min(
      AGENT_APPROVAL_EXPIRY_SWEEP_MAX_LIMIT,
      positiveInteger(input.limit ?? 50, "limit"),
    );
    const now = this.clock();
    const candidates = await this.database<RawApprovalRow>(AGENT_APPROVAL_TABLE)
      .where({ status: "approved" })
      .whereNotNull(AGENT_APPROVAL_BUDGET_RESERVED_COLUMN)
      .andWhere("expiresAt", "<=", now)
      .select("id", "expiresAt", "createdAt")
      .orderBy("expiresAt", "asc")
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .limit(limit);

    const expiredApprovalIds: string[] = [];
    let releasedMicros = 0;
    for (const candidate of candidates) {
      const swept = await this.database.transaction(async (trx) => {
        const row = await trx<RawApprovalRow>(AGENT_APPROVAL_TABLE)
          .where({ id: String(candidate.id), status: "approved" })
          .whereNotNull(AGENT_APPROVAL_BUDGET_RESERVED_COLUMN)
          .andWhere("expiresAt", "<=", now)
          .forUpdate()
          .first();
        if (!row) return null;
        const approval = mapApproval(row);
        const updated = await trx(AGENT_APPROVAL_TABLE)
          .where({ id: approval.id, status: "approved", revision: approval.revision })
          .update({
            status: "expired",
            revision: approval.revision + 1,
            updatedAt: now,
            [AGENT_APPROVAL_BUDGET_RESERVED_COLUMN]: null,
          });
        if (affectedRows(updated) !== 1) return null;
        await releaseApprovalBudgetReservationIfHeld(trx, approval);
        return approval;
      });
      if (swept) {
        expiredApprovalIds.push(swept.id);
        releasedMicros += swept.budgetReservedMicros ?? 0;
      }
    }
    return { expiredApprovalIds, releasedMicros };
  }

  async decide(input: {
    workspaceId: string;
    projectId: number;
    approvalId: string;
    decision: "approved" | "denied";
    decidedBy: number;
    expectedRevision: number;
    /** User-facing decisions also append the public recovery event atomically. */
    appendEvent?: boolean;
    /** Resume only an exact A3 waiting_approval waitRef in the same transaction. */
    resumeWaitingRun?: boolean;
    /**
     * REVAMP-PLAN 1.2: optional revised tool arguments for an
     * approve-with-revision decision. Only valid with decision="approved";
     * a denied decision never carries a revision.
     */
    revisedArguments?: unknown;
    /**
     * Required when revisedArguments is present. Invoked inside the decide
     * transaction after the Approval CAS update; owned by the tool loop
     * processor, it rewrites the paused model-turn checkpoint so the resumed
     * Run executes the revised call (and derives a new tool idempotency key).
     */
    applyRevisionInTransaction?: (
      trx: Knex.Transaction,
      application: AgentApprovalRevisionApplication,
    ) => Promise<void>;
  }): Promise<AgentApproval> {
    if (input.decision !== "approved" && input.decision !== "denied") {
      throw new AgentRuntimeError(400, "approval_decision_invalid", "decision 必须是 approved 或 denied");
    }
    const revisionRequested = input.revisedArguments !== undefined;
    if (revisionRequested && input.decision !== "approved") {
      throw new AgentRuntimeError(400, "approval_revision_not_allowed", "拒绝审批不能携带修订参数");
    }
    if (revisionRequested && typeof input.applyRevisionInTransaction !== "function") {
      throw new AgentRuntimeError(500, "approval_revision_handler_missing", "审批修订缺少检查点回写处理器");
    }
    const now = this.clock();
    const outcome = await this.database.transaction<TransactionOutcome<AgentApproval>>(async (trx) => {
      const row = await this.lockScoped(trx, input);
      const approval = mapApproval(row);
      let eventThread: { id: string; eventSeq: unknown; version: unknown } | null = null;
      let eventRun: {
        id: string;
        status: unknown;
        waitType: unknown;
        waitRef: unknown;
        version: unknown;
      } | null = null;
      if (input.appendEvent === true || input.resumeWaitingRun === true) {
        const run = await trx("o_agent_run")
          .where({ id: approval.runId, workspaceId: approval.workspaceId, projectId: approval.projectId })
          .select("id", "threadId", "status", "waitType", "waitRef", "version")
          .first();
        if (!run) throw new AgentRuntimeError(404, "approval_not_found", "审批不存在");
        eventRun = {
          id: String(run.id),
          status: run.status,
          waitType: run.waitType,
          waitRef: run.waitRef,
          version: run.version,
        };
        const thread = await trx("o_agent_thread")
          .where({ id: run.threadId, workspaceId: approval.workspaceId, projectId: approval.projectId })
          .select("id", "eventSeq", "version")
          .first();
        if (!thread) throw new AgentRuntimeError(404, "approval_not_found", "审批不存在");
        eventThread = {
          id: String(thread.id),
          eventSeq: thread.eventSeq,
          version: thread.version,
        };
      }
      const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
      const decidedBy = positiveInteger(input.decidedBy, "decidedBy");
      await assertProjectAccess(trx, approval.workspaceId, approval.projectId, decidedBy, "project:write");
      if (approval.revision !== expectedRevision) return { error: revisionConflict(expectedRevision, approval.revision) };
      if (approval.status !== "pending") {
        return { error: new AgentRuntimeError(409, "approval_not_pending", "审批已被处理") };
      }
      let shouldResume = false;
      if (input.resumeWaitingRun === true && eventRun) {
        if (eventRun.status === "waiting_approval" && eventRun.waitType === "approval") {
          if (eventRun.waitRef === approval.id) shouldResume = true;
          else if (eventRun.waitRef != null) {
            throw new AgentRuntimeError(409, "approval_wait_mismatch", "Run 等待的审批与当前决定不一致");
          }
          // waitRef=null belongs to the pre-A3 preview contract: preserve the
          // old decision-only behavior and do not guess which Run to resume.
        } else if (eventRun.waitRef === approval.id) {
          throw new AgentRuntimeError(409, "approval_wait_mismatch", "Run 当前不在对应审批等待状态");
        }
      }

      // REVAMP-PLAN 1.2: an approve-with-revision recomputes the exact action
      // before the CAS update. Evidence re-resolution is delegated to the
      // Gateway-level entry (tool schema parse/clamp + the tool's own
      // resolveAuthorizationEvidence, which strictly resends the
      // approval-anchored quote); this service never touches tool packages.
      let revisionPlan: {
        action: NormalizedApprovalAction;
        arguments: unknown;
        argumentsSummary: AgentApprovalArgumentsSummary | null;
        expiresAt: number;
      } | null = null;
      if (revisionRequested && approval.expiresAt > now) {
        if (!approval.stepId) {
          throw new AgentRuntimeError(409, "approval_revision_not_supported", "审批未绑定模型检查点，不能修订参数");
        }
        let evidence;
        try {
          evidence = await this.revisionEvidenceResolver({
            database: trx,
            workspaceId: approval.workspaceId,
            projectId: approval.projectId,
            runId: approval.runId,
            approvalId: approval.id,
            modelStepId: approval.stepId,
            actorUserId: approval.requestedBy,
            toolId: approval.toolId,
            toolVersion: approval.toolVersion,
            riskClass: approval.riskClass,
            revisedArguments: input.revisedArguments,
            now,
          });
        } catch (error) {
          if (error instanceof AgentToolGatewayError) {
            throw new AgentRuntimeError(error.status, error.code, error.message);
          }
          throw error;
        }
        const action = normalizeAgentApprovalAction({
          workspaceId: approval.workspaceId,
          projectId: approval.projectId,
          runId: approval.runId,
          stepId: approval.stepId,
          toolId: approval.toolId,
          toolVersion: evidence.toolVersion,
          riskClass: evidence.riskClass,
          arguments: evidence.arguments,
          resourceVersions: evidence.resourceVersions,
          quote: evidence.quote,
          impactSummary: evidence.impactSummary,
          policyVersion: evidence.policyVersion,
        });
        if (action.toolVersion !== approval.toolVersion || action.riskClass !== approval.riskClass) {
          throw new AgentRuntimeError(409, "approval_action_mismatch", "工具版本或风险等级在审批期间已变化");
        }
        // The expiresAt <= quote.expiresAt invariant is preserved by clamping
        // the approval window down to the resent quote; it is never extended.
        let expiresAt = approval.expiresAt;
        if (action.quote?.expiresAt !== undefined) {
          expiresAt = Math.min(expiresAt, action.quote.expiresAt);
        }
        revisionPlan = {
          action,
          arguments: evidence.arguments,
          argumentsSummary: summarizeApprovalArguments(evidence.arguments),
          expiresAt,
        };
      }

      const expiredDecision = (revisionPlan ? revisionPlan.expiresAt : approval.expiresAt) <= now;
      if (expiredDecision) {
        const expired = await trx(AGENT_APPROVAL_TABLE)
          .where({
            id: approval.id,
            workspaceId: approval.workspaceId,
            projectId: approval.projectId,
            runId: approval.runId,
            revision: approval.revision,
            status: "pending",
          })
          .update({
            status: "expired",
            revision: approval.revision + 1,
            updatedAt: now,
            [AGENT_APPROVAL_BUDGET_RESERVED_COLUMN]: null,
          });
        if (affectedRows(expired) !== 1) {
          return { error: revisionConflict(expectedRevision, approval.revision) };
        }
        // 预算自主审批:过期即回滚预留(按不变式 pending 行标记为 NULL,此处为防御)。
        await releaseApprovalBudgetReservationIfHeld(trx, approval);
      } else {
        const updated = await trx(AGENT_APPROVAL_TABLE)
          .where({
            id: approval.id,
            workspaceId: approval.workspaceId,
            projectId: approval.projectId,
            runId: approval.runId,
            revision: approval.revision,
            status: "pending",
          })
          .update({
            status: input.decision,
            decidedBy,
            decidedAt: now,
            revision: approval.revision + 1,
            updatedAt: now,
            // 拒绝即释放;人工批准(pending→approved)不持有也不触碰预留标记。
            ...(input.decision === "denied" ? { [AGENT_APPROVAL_BUDGET_RESERVED_COLUMN]: null } : {}),
            ...(revisionPlan
              ? {
                  argumentsHash: revisionPlan.action.argumentsHash,
                  argumentsSummary: revisionPlan.argumentsSummary
                    ? JSON.stringify(revisionPlan.argumentsSummary)
                    : null,
                  resourceVersions: JSON.stringify(revisionPlan.action.resourceVersions),
                  quote: revisionPlan.action.quote ? JSON.stringify(revisionPlan.action.quote) : null,
                  impactSummary: revisionPlan.action.impactSummary
                    ? JSON.stringify(revisionPlan.action.impactSummary)
                    : null,
                  scopeHash: revisionPlan.action.scopeHash,
                  policyVersion: revisionPlan.action.policyVersion,
                  expiresAt: revisionPlan.expiresAt,
                }
              : {}),
          });
        if (affectedRows(updated) !== 1) return { error: revisionConflict(expectedRevision, approval.revision) };
        // 预算自主审批:拒绝即回滚预留(按不变式 pending 行标记为 NULL,此处为防御)。
        if (input.decision === "denied") await releaseApprovalBudgetReservationIfHeld(trx, approval);
        if (revisionPlan) {
          // Same-transaction checkpoint rewrite: a hook failure rolls back the
          // Approval CAS update and the resent quote together.
          await input.applyRevisionInTransaction!(trx, {
            approvalId: approval.id,
            workspaceId: approval.workspaceId,
            projectId: approval.projectId,
            runId: approval.runId,
            modelStepId: approval.stepId!,
            toolId: approval.toolId,
            previousArgumentsHash: approval.argumentsHash,
            arguments: revisionPlan.arguments,
            argumentsHash: revisionPlan.action.argumentsHash,
            revision: approval.revision + 1,
            now,
          });
        }
      }
      const stored = await this.readStored(trx, approval.id);
      if (!eventThread) {
        return expiredDecision
          ? { error: new AgentRuntimeError(409, "approval_expired", "审批已过期") }
          : { value: stored };
      }

      if (shouldResume && eventRun) {
        const runVersion = Number(eventRun.version || 0);
        if (!Number.isSafeInteger(runVersion) || runVersion < 0) {
          throw new AgentRuntimeError(500, "approval_run_corrupt", "审批对应 Run 版本无效");
        }
        const resumed = await trx("o_agent_run")
          .where({
            id: eventRun.id,
            workspaceId: approval.workspaceId,
            projectId: approval.projectId,
            status: "waiting_approval",
            waitType: "approval",
            waitRef: approval.id,
            version: runVersion,
          })
          .update({
            status: "queued",
            waitType: null,
            waitRef: null,
            wakeAt: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            error: null,
            completedAt: null,
            version: runVersion + 1,
            updatedAt: now,
          });
        if (affectedRows(resumed) !== 1) {
          throw new AgentRuntimeError(409, "approval_wait_conflict", "Run 审批等待状态已变化");
        }
      }

      const threadVersion = Number(eventThread.version || 0);
      const currentEventSeq = Number(eventThread.eventSeq || 0);
      if (!Number.isSafeInteger(threadVersion) || threadVersion < 0
        || !Number.isSafeInteger(currentEventSeq) || currentEventSeq < 0) {
        throw new AgentRuntimeError(500, "approval_thread_corrupt", "审批对应 Thread 版本无效");
      }
      const eventSeq = currentEventSeq + 1;
      const finalEventSeq = eventSeq + (shouldResume ? 1 : 0);
      const threadUpdated = await trx("o_agent_thread")
        .where({
          id: eventThread.id,
          workspaceId: approval.workspaceId,
          projectId: approval.projectId,
          version: threadVersion,
          eventSeq: currentEventSeq,
        })
        .update({ eventSeq: finalEventSeq, version: threadVersion + 1, updatedAt: now });
      if (affectedRows(threadUpdated) !== 1) {
        throw new AgentRuntimeError(409, "thread_version_conflict", "Thread 已被其他请求更新，请重试");
      }

      await this.eventAppender(trx, {
        workspaceId: approval.workspaceId,
        projectId: approval.projectId,
        threadId: eventThread.id,
        runId: approval.runId,
        stepId: approval.stepId,
        seq: eventSeq,
        type: expiredDecision
          ? "approval.expired"
          : input.decision === "approved" ? "approval.approved" : "approval.denied",
        payload: { approval: toSafeAgentApprovalDto(stored) },
        createdAt: now,
      });
      if (shouldResume) {
        await this.eventAppender(trx, {
          workspaceId: approval.workspaceId,
          projectId: approval.projectId,
          threadId: eventThread.id,
          runId: approval.runId,
          stepId: approval.stepId,
          seq: eventSeq + 1,
          type: "run.queued",
          payload: {
            runId: approval.runId,
            status: "queued",
            reason: expiredDecision
              ? "approval_expired"
              : input.decision === "approved" ? "approval_approved" : "approval_denied",
          },
          createdAt: now,
        });
      }
      return expiredDecision
        ? { error: new AgentRuntimeError(409, "approval_expired", "审批已过期") }
        : { value: stored };
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  async verify(input: VerifyAgentApprovalInput): Promise<ApprovalEvidence & { runId: string; revision: number }> {
    const action = normalizeAgentApprovalAction(input);
    const approval = await this.get({
      workspaceId: action.workspaceId,
      projectId: action.projectId,
      approvalId: input.approvalId,
    });
    if (approval.runId !== action.runId || approval.scopeHash !== action.scopeHash) {
      throw new AgentRuntimeError(409, "approval_action_mismatch", "工具参数、版本、报价或影响摘要已变化，必须重新审批");
    }
    if (approval.status !== "approved") {
      throw new AgentRuntimeError(409, "approval_not_approved", "审批当前不可用于执行");
    }
    if (approval.revision !== positiveInteger(input.expectedRevision, "expectedRevision")) {
      throw revisionConflict(input.expectedRevision, approval.revision);
    }
    return {
      id: approval.id,
      status: "approved",
      workspaceId: approval.workspaceId,
      projectId: String(approval.projectId),
      toolName: approval.toolId,
      toolVersion: approval.toolVersion,
      scopeHash: approval.scopeHash,
      policyVersion: approval.policyVersion,
      expiresAt: approval.expiresAt,
      runId: approval.runId,
      revision: approval.revision,
    };
  }

  /**
   * Locks and verifies an approval inside ToolGateway's existing transaction.
   *
   * The stored stepId is intentionally reused when rebuilding the exact action
   * digest.  A model/caller can only provide an opaque approvalId; it cannot
   * move an approval to another Step, Run, workspace, project or action.
   */
  async prepareToolExecutionInTransaction(
    trx: Knex.Transaction,
    input: AgentApprovalToolExecutionInput,
    options: { now: number; mode: "execute" | "exact_consumed_replay" },
  ): Promise<PreparedAgentApprovalExecution> {
    const workspaceId = cleanString(input.workspaceId, "workspaceId");
    const projectId = positiveInteger(input.projectId, "projectId");
    const row = await trx<RawApprovalRow>(AGENT_APPROVAL_TABLE)
      .where({
        id: cleanString(input.approvalId, "approvalId"),
        workspaceId,
        projectId,
      })
      .forUpdate()
      .first();
    if (!row) throw new AgentRuntimeError(404, "approval_not_found", "审批不存在");

    const approval = mapApproval(row);
    const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
    if (approval.requestedBy !== actorUserId) {
      throw new AgentRuntimeError(403, "approval_actor_mismatch", "审批不属于当前 Run 发起用户");
    }
    const action = normalizeAgentApprovalAction({
      ...input,
      workspaceId,
      projectId,
      stepId: approval.stepId,
    });
    if (approval.runId !== action.runId || approval.scopeHash !== action.scopeHash) {
      throw new AgentRuntimeError(
        409,
        "approval_action_mismatch",
        "工具参数、版本、资源、报价或影响摘要已变化，旧审批不可复用",
      );
    }
    const verificationMode = options.mode === "exact_consumed_replay"
      && approval.status === "consumed"
      && approval.consumedAt !== null
      ? "exact_consumed_replay"
      : options.mode === "execute" && approval.status === "approved"
        ? "approved_execution"
        : null;
    if (!verificationMode) {
      throw new AgentRuntimeError(409, "approval_not_approved", "审批当前不可用于执行");
    }
    // TTL gates the first execution only. Once the exact Gateway transaction
    // has committed the side effect, Tool Step and consumed Approval together,
    // a later worker may replay that immutable Step after the original TTL.
    // The explicit replay mode is reachable only from Gateway's existing-Step
    // path; it never makes an expired, merely approved action executable.
    if (verificationMode === "approved_execution" && approval.expiresAt <= options.now) {
      const expired = await trx(AGENT_APPROVAL_TABLE)
        .where({ id: approval.id, revision: approval.revision, status: "approved" })
        .update({
          status: "expired",
          revision: approval.revision + 1,
          updatedAt: options.now,
          [AGENT_APPROVAL_BUDGET_RESERVED_COLUMN]: null,
        });
      // 预算自主审批:只有过期 CAS 的赢家回滚预留;输家由赢家的同一更新清零标记。
      if (affectedRows(expired) === 1) await releaseApprovalBudgetReservationIfHeld(trx, approval);
      throw new AgentRuntimeError(409, "approval_expired", "审批已过期");
    }
    if (verificationMode === "exact_consumed_replay") {
      await assertExactConsumedReplayStep(trx, input, action, approval.consumedStepId);
    } else {
      await assertExecutionStepForConsumption(trx, input, action);
    }

    return {
      approval,
      executionStepId: cleanString(input.executionStepId, "executionStepId"),
      evidence: {
        id: approval.id,
        status: verificationMode === "exact_consumed_replay" ? "consumed" : "approved",
        workspaceId: approval.workspaceId,
        projectId: String(approval.projectId),
        toolName: approval.toolId,
        toolVersion: approval.toolVersion,
        scopeHash: approval.scopeHash,
        policyVersion: approval.policyVersion,
        expiresAt: approval.expiresAt,
        runId: approval.runId,
        revision: approval.revision,
      },
      verificationMode,
    };
  }

  /** Consume exactly the approval locked by prepareToolExecutionInTransaction. */
  async consumePreparedToolExecutionInTransaction(
    trx: Knex.Transaction,
    prepared: PreparedAgentApprovalExecution,
    executionStepId: string,
    now: number,
  ): Promise<AgentApproval> {
    const approval = prepared.approval;
    if (approval.status !== "approved") {
      throw new AgentRuntimeError(409, "approval_not_approved", "审批当前不可用于执行");
    }
    const consumedStepId = cleanString(executionStepId, "executionStepId");
    if (consumedStepId !== prepared.executionStepId) {
      throw new AgentRuntimeError(409, "approval_execution_step_mismatch", "消费 Step 与已校验工具 Step 不一致");
    }
    const updated = await trx(AGENT_APPROVAL_TABLE)
      .where({
        id: approval.id,
        workspaceId: approval.workspaceId,
        projectId: approval.projectId,
        runId: approval.runId,
        scopeHash: approval.scopeHash,
        revision: approval.revision,
        status: "approved",
      })
      .update({
        status: "consumed",
        consumedAt: now,
        consumedStepId,
        revision: approval.revision + 1,
        updatedAt: now,
        [AGENT_APPROVAL_BUDGET_RESERVED_COLUMN]: null,
      });
    if (affectedRows(updated) !== 1) {
      throw revisionConflict(approval.revision, approval.revision + 1);
    }
    // 预算自主审批:消费(实际扣 GU)即回滚预留,同事务;实际消耗由计费链另行记账。
    await releaseApprovalBudgetReservationIfHeld(trx, approval);
    return this.readStored(trx, approval.id);
  }

  async consume(input: ConsumeAgentApprovalInput): Promise<AgentApproval> {
    const action = normalizeAgentApprovalAction(input);
    const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
    const now = this.clock();
    const outcome = await this.database.transaction<TransactionOutcome<AgentApproval>>(async (trx) => {
      const row = await this.lockScoped(trx, {
        workspaceId: action.workspaceId,
        projectId: action.projectId,
        approvalId: input.approvalId,
      });
      const approval = mapApproval(row);
      if (approval.revision !== expectedRevision) return { error: revisionConflict(expectedRevision, approval.revision) };
      if (approval.runId !== action.runId || approval.scopeHash !== action.scopeHash) {
        return {
          error: new AgentRuntimeError(
            409,
            "approval_action_mismatch",
            "工具参数、版本、资源、报价或影响摘要已变化，旧审批不可复用",
          ),
        };
      }
      if (approval.status !== "approved") {
        return { error: new AgentRuntimeError(409, "approval_not_approved", "审批当前不可用于执行") };
      }
      if (approval.expiresAt <= now) {
        const expired = await trx(AGENT_APPROVAL_TABLE)
          .where({ id: approval.id, revision: approval.revision, status: "approved" })
          .update({
            status: "expired",
            revision: approval.revision + 1,
            updatedAt: now,
            [AGENT_APPROVAL_BUDGET_RESERVED_COLUMN]: null,
          });
        // 预算自主审批:只有过期 CAS 的赢家回滚预留。
        if (affectedRows(expired) === 1) await releaseApprovalBudgetReservationIfHeld(trx, approval);
        return { error: new AgentRuntimeError(409, "approval_expired", "审批已过期") };
      }
      let executionStepId: string;
      try {
        executionStepId = await assertExecutionStepForConsumption(trx, {
          approvalId: input.approvalId,
          executionStepId: input.executionStepId,
          actorUserId: approval.requestedBy,
        }, action);
      } catch (error) {
        return { error: error as AgentRuntimeError };
      }
      const updated = await trx(AGENT_APPROVAL_TABLE)
        .where({ id: approval.id, revision: approval.revision, status: "approved", scopeHash: action.scopeHash })
        .update({
          status: "consumed",
          consumedAt: now,
          consumedStepId: executionStepId,
          revision: approval.revision + 1,
          updatedAt: now,
          [AGENT_APPROVAL_BUDGET_RESERVED_COLUMN]: null,
        });
      if (affectedRows(updated) !== 1) return { error: revisionConflict(expectedRevision, approval.revision) };
      // 预算自主审批:消费即回滚预留,同事务。
      await releaseApprovalBudgetReservationIfHeld(trx, approval);
      return { value: await this.readStored(trx, approval.id) };
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  async revoke(input: {
    workspaceId: string;
    projectId: number;
    approvalId: string;
    revokedBy: number;
    expectedRevision: number;
  }): Promise<AgentApproval> {
    const now = this.clock();
    const outcome = await this.database.transaction<TransactionOutcome<AgentApproval>>(async (trx) => {
      const row = await this.lockScoped(trx, input);
      const approval = mapApproval(row);
      const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
      if (approval.revision !== expectedRevision) return { error: revisionConflict(expectedRevision, approval.revision) };
      if (approval.status !== "approved") {
        return { error: new AgentRuntimeError(409, "approval_not_revocable", "只有已批准且未消费的审批可以撤销") };
      }
      const revokedBy = positiveInteger(input.revokedBy, "revokedBy");
      await assertProjectAccess(trx, approval.workspaceId, approval.projectId, revokedBy, "project:write");
      const updated = await trx(AGENT_APPROVAL_TABLE)
        .where({ id: approval.id, revision: approval.revision, status: "approved" })
        .update({
          status: "revoked",
          revokedBy,
          revokedAt: now,
          revision: approval.revision + 1,
          updatedAt: now,
          [AGENT_APPROVAL_BUDGET_RESERVED_COLUMN]: null,
        });
      if (affectedRows(updated) !== 1) return { error: revisionConflict(expectedRevision, approval.revision) };
      // 预算自主审批:撤销自动批准的审批即回滚预留,同事务。
      await releaseApprovalBudgetReservationIfHeld(trx, approval);
      return { value: await this.readStored(trx, approval.id) };
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  private async lockScoped(
    trx: Knex.Transaction,
    input: { workspaceId: string; projectId: number; approvalId: string },
  ): Promise<RawApprovalRow> {
    const row = await trx<RawApprovalRow>(AGENT_APPROVAL_TABLE)
      .where({
        id: cleanString(input.approvalId, "approvalId"),
        workspaceId: cleanString(input.workspaceId, "workspaceId"),
        projectId: positiveInteger(input.projectId, "projectId"),
      })
      .forUpdate()
      .first();
    if (!row) throw new AgentRuntimeError(404, "approval_not_found", "审批不存在");
    return row;
  }

  private async readStored(trx: Knex.Transaction, id: string): Promise<AgentApproval> {
    const row = await trx<RawApprovalRow>(AGENT_APPROVAL_TABLE).where({ id }).first();
    if (!row) throw new AgentRuntimeError(500, "approval_save_failed", "审批更新后无法读取");
    return mapApproval(row);
  }
}
