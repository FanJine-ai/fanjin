import type { Knex } from "knex";
import { AGENT_APPROVAL_TABLE } from "@/lib/migrations/agentApprovalDelegation";

/**
 * R2/R3 审批-扣费对账(REVAMP-PLAN 2.4)。
 *
 * 扫描窗口内 status=consumed 的 R2/R3 审批,把审批报价最高额(quote.
 * maximumCostMicros)与 GU 扣费流水(o_billing_ledger freeze + 关联
 * o_usage_record 实际扣费)对账。
 *
 * 与 relay 层对账(lib/billingReconciliation.ts,处理 freeze→settle 生命周期
 * 中断)的关系:本模块是审批维度的只读交叉核对,不消费/不改变
 * o_billing_reconcile_job,不做任何自动修复;不一致只产出报告(日志 +
 * admin 只读端点)。
 *
 * 链接键:
 * - generation.image.submit → `agent-image:{quoteId}`;
 * - generation.video.submit → `agent-video-submit:{quoteId}`;
 * - generation.task.retry → `agent-video-retry:{quoteId}`。
 *
 * 视频从 0.0.8 起必须以报价 ID 锚定 Relay task/provider/GU 幂等语义,
 * 因此优先按审批证据里的 quoteId 精确匹配。旧版
 * `agent-video-submit:{runId}:{consumedStepId}` 流水仍保留只读兼容。
 */

export const AGENT_BILLING_RECONCILE_DEFAULT_LOOKBACK_MS = 24 * 60 * 60_000;
export const AGENT_BILLING_RECONCILE_DEFAULT_GRACE_MS = 60 * 60_000;
export const AGENT_BILLING_RECONCILE_DEFAULT_LIMIT = 200;

/** toolId → 计费 requestId 前缀(与 tools/packages/generation.ts 执行期一致)。 */
const TOOL_REQUEST_ID_PREFIX: Readonly<Record<string, string>> = Object.freeze({
  "generation.image.submit": "agent-image:",
  "generation.video.submit": "agent-video-submit:",
  "generation.task.retry": "agent-video-retry:",
});

export type AgentBillingReconcileCategory =
  /** 实际扣费超过审批报价最高额(真金白银超授权)。 */
  | "overcharged_beyond_maximum"
  /** 审批已消费且超过宽限期,但找不到任何计费流水(疑似计费旁路)。 */
  | "missing_billing_flow"
  /** 已找到冻结流水但关联 usage 行缺失(无法证明实际计费结果)。 */
  | "missing_usage_record"
  /** 冻结流水仍有未结算余额或 usage 仍 pending_reconcile(资金未闭合)。 */
  | "open_reservation";

export type AgentBillingReconcileMatch =
  | "matched"
  | "released_no_charge"
  | "pending_grace"
  | "mismatch";

export interface AgentBillingReconcileFinding {
  readonly approvalId: string;
  readonly workspaceId: string;
  readonly projectId: number;
  readonly runId: string;
  readonly consumedStepId: string | null;
  readonly toolId: string;
  readonly riskClass: string;
  readonly category: AgentBillingReconcileCategory;
  readonly approvalMaximumMicros: number | null;
  readonly reservedMicros: number | null;
  readonly actualCostMicros: number | null;
  readonly usageStatus: string | null;
  /** 从消费/冻结事实到本次观察时刻的年龄。 */
  readonly ageMs: number;
  readonly matchQuality: "exact_quote" | "exact_step" | "run_prefix";
  readonly summary: string;
}

export interface AgentBillingReconcileFacts {
  readonly overcharge: number;
  readonly missingBillingFlow: number;
  readonly missingUsage: number;
  readonly openReservation: number;
  readonly pendingReconcile: number;
  readonly oldestPendingReconcileAgeMs: number;
}

export interface AgentBillingReconcileReport {
  readonly generatedAt: number;
  readonly lookbackMs: number;
  readonly graceMs: number;
  readonly scanned: number;
  readonly matched: number;
  readonly releasedNoCharge: number;
  readonly pendingGrace: number;
  readonly skippedUnsupportedTool: number;
  readonly facts: AgentBillingReconcileFacts;
  readonly findings: readonly AgentBillingReconcileFinding[];
}

export interface AgentBillingReconciliationMetrics extends AgentBillingReconcileFacts {
  readonly lastScanAt: number;
  readonly lastSuccessAt: number;
  readonly lastFailureAt: number;
  readonly lastScanSucceeded: boolean;
  readonly failuresTotal: number;
  readonly alertActive: boolean;
  readonly scanned: number;
  readonly findings: number;
}

function emptyAgentBillingReconciliationMetrics(): AgentBillingReconciliationMetrics {
  return {
    lastScanAt: 0,
    lastSuccessAt: 0,
    lastFailureAt: 0,
    lastScanSucceeded: false,
    failuresTotal: 0,
    alertActive: false,
    scanned: 0,
    findings: 0,
    overcharge: 0,
    missingBillingFlow: 0,
    missingUsage: 0,
    openReservation: 0,
    pendingReconcile: 0,
    oldestPendingReconcileAgeMs: 0,
  };
}

let agentBillingReconciliationMetrics = emptyAgentBillingReconciliationMetrics();

export function recordAgentBillingReconciliationReport(report: AgentBillingReconcileReport): void {
  agentBillingReconciliationMetrics = {
    ...agentBillingReconciliationMetrics,
    ...report.facts,
    lastScanAt: report.generatedAt,
    lastSuccessAt: report.generatedAt,
    lastScanSucceeded: true,
    alertActive: report.findings.length > 0,
    scanned: report.scanned,
    findings: report.findings.length,
  };
}

export function recordAgentBillingReconciliationFailure(observedAt = Date.now()): void {
  agentBillingReconciliationMetrics = {
    ...agentBillingReconciliationMetrics,
    lastScanAt: observedAt,
    lastFailureAt: observedAt,
    lastScanSucceeded: false,
    failuresTotal: agentBillingReconciliationMetrics.failuresTotal + 1,
    alertActive: true,
  };
}

export function getAgentBillingReconciliationMetrics(): AgentBillingReconciliationMetrics {
  return Object.freeze({ ...agentBillingReconciliationMetrics });
}

export function resetAgentBillingReconciliationMetrics(): void {
  agentBillingReconciliationMetrics = emptyAgentBillingReconciliationMetrics();
}

export interface AgentBillingReconcileLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
}

const defaultLogger: AgentBillingReconcileLogger = {
  info(message, metadata) {
    console.info(message, metadata ?? "");
  },
  warn(message, metadata) {
    console.warn(message, metadata ?? "");
  },
};

interface RawApprovalRow {
  id: string;
  workspaceId: string;
  projectId: number | string;
  runId: string;
  toolId: string;
  riskClass: string;
  quote: unknown;
  consumedStepId: string | null;
  consumedAt: number | string | null;
  createdAt: number | string;
}

interface ParsedApprovalQuote {
  readonly maximumMicros: number | null;
  readonly quoteId: string | null;
}

function parseApprovalQuote(rawQuote: unknown): ParsedApprovalQuote {
  if (typeof rawQuote !== "string" || !rawQuote) {
    return { maximumMicros: null, quoteId: null };
  }
  try {
    const parsed = JSON.parse(rawQuote) as { maximumCostMicros?: unknown; quoteId?: unknown };
    const value = Number(parsed?.maximumCostMicros);
    const quoteId = typeof parsed?.quoteId === "string" && parsed.quoteId.trim()
      ? parsed.quoteId.trim()
      : null;
    return {
      maximumMicros: Number.isSafeInteger(value) && value > 0 ? value : null,
      quoteId,
    };
  } catch {
    return { maximumMicros: null, quoteId: null };
  }
}

function safeNonNegative(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

interface BillingFlowMatch {
  readonly reservationId: string | null;
  readonly reservedMicros: number | null;
  readonly remainingMicros: number | null;
  readonly usageStatus: string | null;
  readonly actualCostMicros: number | null;
  readonly usageRecordPresent: boolean;
  readonly reservationCreatedAt: number | null;
  readonly matchQuality: "exact_quote" | "exact_step" | "run_prefix";
}

async function findBillingFlow(
  database: Knex | Knex.Transaction,
  approval: RawApprovalRow,
  requestIdPrefix: string,
  quoteId: string | null,
): Promise<BillingFlowMatch | null> {
  const consumedStepId = approval.consumedStepId == null ? "" : String(approval.consumedStepId).trim();
  const baseQuery = () => database("o_billing_ledger")
    .where({ workspaceId: String(approval.workspaceId), type: "freeze" })
    .orderBy("createdAt", "desc");
  let matchQuality: BillingFlowMatch["matchQuality"] = "exact_quote";
  let reservation;
  if (quoteId) {
    const rawRequestId = `${requestIdPrefix}${quoteId}`;
    const candidates = await baseQuery()
      .where((builder: Knex.QueryBuilder) => {
        builder
          .where({ requestId: rawRequestId })
          .orWhere("requestId", "like", `${rawRequestId}:scope:%`);
      })
      .limit(20);
    reservation = candidates.find((candidate: Record<string, unknown>) => {
      const metadata = parseObject(candidate.metadata);
      const authorization = parseObject(metadata.billingAuthorization);
      const authorizedQuoteId = String(authorization.quoteId || "");
      return authorizedQuoteId ? authorizedQuoteId === quoteId : true;
    });
  }
  if (consumedStepId) {
    if (!reservation) {
      matchQuality = "exact_step";
      reservation = await baseQuery()
        .where({ requestId: `${requestIdPrefix}${approval.runId}:${consumedStepId}` })
        .first();
    }
  }
  if (!reservation) {
    // 历史行(无 consumedStepId)或 requestId 约定漂移:退化为 run 前缀匹配。
    matchQuality = "run_prefix";
    reservation = await baseQuery()
      .where("requestId", "like", `${requestIdPrefix}${approval.runId}:%`)
      .first();
  }
  if (!reservation) return null;
  const usage = reservation.relatedUsageId
    ? await database("o_usage_record").where({ id: String(reservation.relatedUsageId) }).first()
    : null;
  return {
    reservationId: String(reservation.id),
    reservedMicros: safeNonNegative(reservation.amountMicros),
    remainingMicros: safeNonNegative(reservation.remainingMicros),
    usageStatus: usage ? String(usage.status ?? "") || null : null,
    actualCostMicros: usage ? safeNonNegative(usage.costMicros) : null,
    usageRecordPresent: Boolean(usage),
    reservationCreatedAt: safeNonNegative(reservation.createdAt),
    matchQuality,
  };
}

interface ClassifiedApproval {
  readonly match: AgentBillingReconcileMatch;
  readonly finding: AgentBillingReconcileFinding | null;
}

function classifyApproval(input: {
  approval: RawApprovalRow;
  flow: BillingFlowMatch | null;
  requestIdPrefix: string;
  maximumMicros: number | null;
  now: number;
  graceMs: number;
}): ClassifiedApproval {
  const { approval, flow, maximumMicros } = input;
  const consumedAt = safeNonNegative(approval.consumedAt) ?? safeNonNegative(approval.createdAt) ?? 0;
  const observedFrom = flow?.reservationCreatedAt ?? consumedAt;
  const ageMs = observedFrom > 0 ? Math.max(0, input.now - observedFrom) : 0;
  const base = {
    approvalId: String(approval.id),
    workspaceId: String(approval.workspaceId),
    projectId: Number(approval.projectId),
    runId: String(approval.runId),
    consumedStepId: approval.consumedStepId == null ? null : String(approval.consumedStepId),
    toolId: String(approval.toolId),
    riskClass: String(approval.riskClass),
    approvalMaximumMicros: maximumMicros,
    reservedMicros: flow?.reservedMicros ?? null,
    actualCostMicros: flow?.actualCostMicros ?? null,
    usageStatus: flow?.usageStatus ?? null,
    ageMs,
    matchQuality: flow?.matchQuality ?? "exact_step",
  } as const;
  if (!flow) {
    if (consumedAt > 0 && consumedAt <= input.now - input.graceMs) {
      return {
        match: "mismatch",
        finding: {
          ...base,
          category: "missing_billing_flow",
          summary: "审批已消费且超过宽限期,但未找到任何 GU 冻结/扣费流水(疑似计费旁路)",
        },
      };
    }
    return { match: "pending_grace", finding: null };
  }

  if (!flow.usageRecordPresent) {
    if (ageMs < input.graceMs) return { match: "pending_grace", finding: null };
    return {
      match: "mismatch",
      finding: {
        ...base,
        category: "missing_usage_record",
        summary: "已找到 GU 冻结流水,但超过宽限期仍无关联 usage 记录,无法证明实际扣费结果",
      },
    };
  }

  if ((flow.remainingMicros ?? 0) > 0 || flow.usageStatus === "pending_reconcile") {
    return {
      match: "mismatch",
      finding: {
        ...base,
        category: "open_reservation",
        summary: `冻结流水未闭合(remainingMicros=${flow.remainingMicros ?? "unknown"},usage=${flow.usageStatus ?? "missing"}),资金仍冻结待核`,
      },
    };
  }

  // settle 终态 usage=charged/free(billing.ts settleApiTaskReservation);
  // release/refund 终态 = 未产生扣费,属执行失败后的正常回滚,记一致。
  if (flow.usageStatus === "released" || flow.usageStatus === "refunded") {
    return { match: "released_no_charge", finding: null };
  }

  if (flow.usageStatus !== "charged" && flow.usageStatus !== "free") {
    // 冻结已闭合(remaining=0)但 usage 不在任何已知终态:保守判未闭合。
    return {
      match: "mismatch",
      finding: {
        ...base,
        category: "open_reservation",
        summary: `冻结流水余额已清零但 usage 状态未知(${flow.usageStatus ?? "missing"}),需人工核对`,
      },
    };
  }

  const actual = flow.actualCostMicros;
  if (actual !== null && maximumMicros !== null && actual > maximumMicros) {
    return {
      match: "mismatch",
      finding: {
        ...base,
        category: "overcharged_beyond_maximum",
        summary: `实际扣费 ${actual} micros 超过审批报价最高额 ${maximumMicros} micros`,
      },
    };
  }
  return { match: "matched", finding: null };
}

/**
 * 只读扫描:不在任何写事务内变更业务状态。limit 之外的窗口靠后续周期推进。
 */
export async function scanAgentApprovalBillingReconciliation(input: {
  database: Knex | Knex.Transaction;
  now?: number;
  lookbackMs?: number;
  graceMs?: number;
  limit?: number;
}): Promise<AgentBillingReconcileReport> {
  const now = input.now ?? Date.now();
  const lookbackMs = Math.max(60_000, Number(input.lookbackMs ?? AGENT_BILLING_RECONCILE_DEFAULT_LOOKBACK_MS));
  const graceMs = Math.max(0, Number(input.graceMs ?? AGENT_BILLING_RECONCILE_DEFAULT_GRACE_MS));
  const limit = Math.max(1, Math.min(Number(input.limit ?? AGENT_BILLING_RECONCILE_DEFAULT_LIMIT), 1000));
  const windowStart = now - lookbackMs;

  const approvals = (await input.database(AGENT_APPROVAL_TABLE)
    .where({ status: "consumed" })
    .whereIn("riskClass", ["R2", "R3"])
    .andWhere("consumedAt", ">=", windowStart)
    .orderBy("consumedAt", "asc")
    .limit(limit)) as RawApprovalRow[];

  const findings: AgentBillingReconcileFinding[] = [];
  let matched = 0;
  let releasedNoCharge = 0;
  let pendingGrace = 0;
  let skippedUnsupportedTool = 0;
  let overcharge = 0;
  let missingBillingFlow = 0;
  let missingUsage = 0;
  let openReservation = 0;
  let pendingReconcile = 0;
  let oldestPendingReconcileAgeMs = 0;

  for (const approval of approvals) {
    const requestIdPrefix = TOOL_REQUEST_ID_PREFIX[String(approval.toolId)];
    if (!requestIdPrefix) {
      skippedUnsupportedTool += 1;
      continue;
    }
    const parsedQuote = parseApprovalQuote(approval.quote);
    const maximumMicros = parsedQuote.maximumMicros;
    const flow = await findBillingFlow(input.database, approval, requestIdPrefix, parsedQuote.quoteId);
    const classified = classifyApproval({
      approval,
      flow,
      requestIdPrefix,
      maximumMicros,
      now,
      graceMs,
    });
    if (classified.finding) findings.push(classified.finding);
    if (classified.finding?.category === "overcharged_beyond_maximum") overcharge += 1;
    if (classified.finding?.category === "missing_billing_flow") missingBillingFlow += 1;
    if (classified.finding?.category === "missing_usage_record") missingUsage += 1;
    if (classified.match === "mismatch" && flow && (
      (flow.remainingMicros ?? 0) > 0
      || !["charged", "free", "released", "refunded"].includes(flow.usageStatus || "")
    )) openReservation += 1;
    if (flow?.usageStatus === "pending_reconcile") {
      pendingReconcile += 1;
      const pendingAgeMs = flow.reservationCreatedAt == null
        ? 0
        : Math.max(0, now - flow.reservationCreatedAt);
      oldestPendingReconcileAgeMs = Math.max(oldestPendingReconcileAgeMs, pendingAgeMs);
    }
    if (classified.match === "matched") matched += 1;
    else if (classified.match === "released_no_charge") releasedNoCharge += 1;
    else if (classified.match === "pending_grace") pendingGrace += 1;
  }

  return Object.freeze({
    generatedAt: now,
    lookbackMs,
    graceMs,
    scanned: approvals.length,
    matched,
    releasedNoCharge,
    pendingGrace,
    skippedUnsupportedTool,
    facts: Object.freeze({
      overcharge,
      missingBillingFlow,
      missingUsage,
      openReservation,
      pendingReconcile,
      oldestPendingReconcileAgeMs,
    }),
    findings: Object.freeze(findings),
  });
}

export interface AgentBillingReconcilerOptions {
  readonly database: Knex;
  readonly logger?: AgentBillingReconcileLogger;
  readonly lookbackMs?: number;
  readonly graceMs?: number;
  readonly limit?: number;
  readonly clock?: () => number;
}

/**
 * Worker 周期对账器:扫一遍并输出报告。不一致逐条 warn + 汇总 info/warn,
 * 绝不自动修复(对账结论交人工/relay 层既有核账链路)。
 */
export class AgentBillingReconciler {
  private readonly database: Knex;
  private readonly logger: AgentBillingReconcileLogger;
  private readonly lookbackMs: number | undefined;
  private readonly graceMs: number | undefined;
  private readonly limit: number | undefined;
  private readonly clock: () => number;

  constructor(options: AgentBillingReconcilerOptions) {
    this.database = options.database;
    this.logger = options.logger ?? defaultLogger;
    this.lookbackMs = options.lookbackMs;
    this.graceMs = options.graceMs;
    this.limit = options.limit;
    this.clock = options.clock ?? Date.now;
  }

  async reconcile(input: { now?: number } = {}): Promise<AgentBillingReconcileReport> {
    const report = await scanAgentApprovalBillingReconciliation({
      database: this.database,
      now: input.now ?? this.clock(),
      lookbackMs: this.lookbackMs,
      graceMs: this.graceMs,
      limit: this.limit,
    });
    recordAgentBillingReconciliationReport(report);
    for (const finding of report.findings) {
      this.logger.warn("[agent-billing-reconcile] approval/billing mismatch", { ...finding });
    }
    const summary = {
      scanned: report.scanned,
      matched: report.matched,
      releasedNoCharge: report.releasedNoCharge,
      pendingGrace: report.pendingGrace,
      skippedUnsupportedTool: report.skippedUnsupportedTool,
      mismatches: report.findings.length,
      ...report.facts,
    };
    if (report.findings.length > 0) {
      this.logger.warn("[agent-billing-reconcile] reconciliation report has mismatches", summary);
    } else {
      this.logger.info("[agent-billing-reconcile] reconciliation report clean", summary);
    }
    return report;
  }
}
