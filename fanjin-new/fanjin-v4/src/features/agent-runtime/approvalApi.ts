import { ApiError, apiGet, apiPost } from "../../api/http";
import type {
  AgentRuntimeApproval,
  AgentRuntimeApprovalArgumentsSummary,
  AgentRuntimeApprovalDecision,
  AgentRuntimeApprovalImpactSummary,
  AgentRuntimeApprovalPage,
  AgentRuntimeApprovalQuote,
  AgentRuntimeApprovalRiskClass,
  AgentRuntimeApprovalStatus,
} from "./approvalTypes";

const ARGUMENTS_SUMMARY_MAX_KEYS = 50;
const ARGUMENTS_SUMMARY_MAX_STRING = 2_000;

const APPROVAL_STATUSES = new Set<AgentRuntimeApprovalStatus>([
  "pending",
  "approved",
  "denied",
  "consumed",
  "revoked",
  "expired",
]);
const APPROVAL_RISK_CLASSES = new Set<AgentRuntimeApprovalRiskClass>(["R2", "R3"]);

function invalidApprovalResponse(): never {
  throw new ApiError("Agent 审批响应格式无效", { code: "agent_approval_response_invalid" });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidApprovalResponse();
  return value as Record<string, unknown>;
}

function asString(value: unknown, maxLength = 500) {
  if (typeof value !== "string"
    || !value
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)) invalidApprovalResponse();
  return value;
}

function asSafeInteger(value: unknown, min = 0) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    invalidApprovalResponse();
  }
  return value;
}

function asNullableNumber(value: unknown) {
  return value === null ? null : asSafeInteger(value);
}

function projectQuote(value: unknown): AgentRuntimeApprovalQuote | null {
  if (value === null) return null;
  const quote = asRecord(value);
  if (quote.currency !== "GU") invalidApprovalResponse();
  const estimatedCostMicros = asSafeInteger(quote.estimatedCostMicros, 1);
  const maximumCostMicros = asSafeInteger(quote.maximumCostMicros, 1);
  if (maximumCostMicros < estimatedCostMicros) invalidApprovalResponse();
  return {
    currency: "GU",
    estimatedCostMicros,
    maximumCostMicros,
    ...(quote.quoteId === undefined ? {} : { quoteId: asString(quote.quoteId, 200) }),
    ...(quote.expiresAt === undefined ? {} : { expiresAt: asSafeInteger(quote.expiresAt, 1) }),
  };
}

function projectImpactSummary(value: unknown): AgentRuntimeApprovalImpactSummary | null {
  if (value === null) return null;
  const impact = asRecord(value);
  if (!Array.isArray(impact.affectedResourceRefs)
    || impact.affectedResourceRefs.length > 500
    || typeof impact.destructive !== "boolean") {
    invalidApprovalResponse();
  }
  return {
    summary: asString(impact.summary, 4_000),
    affectedResourceRefs: impact.affectedResourceRefs.map((item) => asString(item, 500)),
    destructive: impact.destructive,
  };
}

/**
 * Project the display-only arguments summary. Mirrors the server-side rules
 * (≤50 keys, scalar values, strings ≤2000 chars) so malformed payloads never
 * reach React state.
 */
function projectArgumentsSummary(value: unknown): AgentRuntimeApprovalArgumentsSummary | null {
  if (value === null) return null;
  const summary = asRecord(value);
  const entries = Object.entries(summary);
  if (entries.length > ARGUMENTS_SUMMARY_MAX_KEYS) invalidApprovalResponse();
  const projected: AgentRuntimeApprovalArgumentsSummary = {};
  for (const [key, raw] of entries) {
    if (!key || key.length > 200) invalidApprovalResponse();
    if (raw === null || typeof raw === "boolean") {
      projected[key] = raw;
    } else if (typeof raw === "string") {
      if (raw.length > ARGUMENTS_SUMMARY_MAX_STRING) invalidApprovalResponse();
      projected[key] = raw;
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      projected[key] = raw;
    } else {
      invalidApprovalResponse();
    }
  }
  return projected;
}

/** Project the response onto the documented safe DTO before it enters React state. */
function projectApproval(value: unknown): AgentRuntimeApproval {
  const approval = asRecord(value);
  const riskClass = asString(approval.riskClass, 2) as AgentRuntimeApprovalRiskClass;
  const status = asString(approval.status, 20) as AgentRuntimeApprovalStatus;
  if (!APPROVAL_RISK_CLASSES.has(riskClass) || !APPROVAL_STATUSES.has(status)) invalidApprovalResponse();
  if (approval.stepId !== null && typeof approval.stepId !== "string") invalidApprovalResponse();
  // autoApproved 是预算自主审批的新 DTO 字段;旧服务端不下发时按 false 投影。
  const autoApproved = approval.autoApproved === undefined ? false : approval.autoApproved === true;
  const quote = projectQuote(approval.quote);
  const impactSummary = projectImpactSummary(approval.impactSummary);
  if ((riskClass === "R2" && !quote) || (riskClass === "R3" && !impactSummary)) invalidApprovalResponse();
  return {
    id: asString(approval.id, 200),
    runId: asString(approval.runId, 200),
    stepId: approval.stepId === null ? null : asString(approval.stepId, 200),
    toolId: asString(approval.toolId, 200),
    toolVersion: asString(approval.toolVersion, 100),
    riskClass,
    status,
    quote,
    impactSummary,
    argumentsSummary: projectArgumentsSummary(approval.argumentsSummary),
    autoApproved,
    expiresAt: asSafeInteger(approval.expiresAt, 1),
    revision: asSafeInteger(approval.revision, 1),
    decidedAt: asNullableNumber(approval.decidedAt),
    createdAt: asSafeInteger(approval.createdAt),
    updatedAt: asSafeInteger(approval.updatedAt),
  };
}

function projectApprovalPage(value: unknown): AgentRuntimeApprovalPage {
  const page = asRecord(value);
  if (!Array.isArray(page.data) || page.data.length > 200) invalidApprovalResponse();
  const nextCursor = page.nextCursor;
  if (nextCursor !== null && typeof nextCursor !== "string" && typeof nextCursor !== "number") {
    invalidApprovalResponse();
  }
  if (typeof nextCursor === "string" && (!nextCursor || nextCursor.length > 1_000)) invalidApprovalResponse();
  if (typeof nextCursor === "number" && (!Number.isSafeInteger(nextCursor) || nextCursor < 0)) {
    invalidApprovalResponse();
  }
  return {
    data: page.data.map(projectApproval),
    nextCursor,
  };
}

export async function listAgentRunApprovals(
  runId: string,
  options?: { after?: string | number; limit?: number; signal?: AbortSignal },
) {
  const params = new URLSearchParams({ limit: String(options?.limit ?? 200) });
  if (options?.after !== undefined) params.set("after", String(options.after));
  const response = await apiGet<unknown>(
    `/agent/runs/${encodeURIComponent(runId)}/approvals?${params.toString()}`,
    undefined,
    { signal: options?.signal },
  );
  return projectApprovalPage(response);
}

export async function listAllAgentRunApprovals(runId: string, signal?: AbortSignal) {
  const approvals = new Map<string, AgentRuntimeApproval>();
  let after: string | number | undefined;
  let exhausted = false;
  for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
    const page = await listAgentRunApprovals(runId, { after, limit: 200, signal });
    if (!page || !Array.isArray(page.data)) {
      throw new ApiError("Agent 审批接口暂不可用", { code: "agent_approvals_unavailable" });
    }
    page.data.forEach((approval) => approvals.set(approval.id, approval));
    if (page.nextCursor === null) {
      exhausted = true;
      break;
    }
    if (page.nextCursor === after) {
      throw new ApiError("Agent 审批分页游标未前进", { code: "agent_approval_cursor_invalid" });
    }
    after = page.nextCursor;
  }
  if (!exhausted) {
    throw new ApiError("Agent 审批记录过多，无法安全完整恢复", { code: "agent_approvals_too_many" });
  }
  return Array.from(approvals.values()).sort((left, right) => (
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  ));
}

/**
 * Approve-with-revision arguments must be the complete tool-call payload
 * (the server re-parses it through the tool's strict input schema), built
 * from scalars only — same shape the arguments summary uses.
 */
function assertValidRevisedArguments(value: unknown): AgentRuntimeApprovalArgumentsSummary {
  try {
    const projected = projectArgumentsSummary(value);
    if (!projected) invalidApprovalResponse();
    return projected;
  } catch {
    throw new ApiError("修订参数格式无效，未提交审批决定", { code: "agent_approval_revision_invalid" });
  }
}

export async function decideAgentApproval(
  approvalId: string,
  input: {
    decision: AgentRuntimeApprovalDecision;
    expectedRevision: number;
    /**
     * REVAMP-PLAN 1.5: complete revised tool arguments for 修订批准. Only sent
     * when decision === "approved"; the backend 400s a denied+revision combo.
     */
    revisedArguments?: AgentRuntimeApprovalArgumentsSummary;
  },
  signal?: AbortSignal,
) {
  const body: Record<string, unknown> = {
    decision: input.decision,
    expectedRevision: input.expectedRevision,
  };
  if (input.decision === "approved" && input.revisedArguments !== undefined) {
    body.revisedArguments = assertValidRevisedArguments(input.revisedArguments);
  }
  const response = await apiPost<unknown>(
    `/agent/approvals/${encodeURIComponent(approvalId)}/decision`,
    body,
    undefined,
    { signal },
  );
  return projectApproval(response);
}
