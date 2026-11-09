import { buildScriptAssetPlatformAbsorption, SCRIPT_ASSET_ABSORPTION_CONTRACT } from "./scriptAssetPlatformAbsorption";
import { buildVideoExpiryAbsorption, VIDEO_RESERVATION_EXPIRY_POLICY } from "./videoReservationExpiry";
import { internalModelId } from "@/lib/minimaxH3PublicIdentity";
import { acquireWorkspaceGeneration, markWorkspaceGenerationDispatched, releaseWorkspaceGeneration, recordWorkspaceGenerationQueue, WorkspaceGenerationQueued } from "./workspaceResources";
import { membershipGrantApplies } from "./membershipCatalog";
import { resolveMembershipFunding } from "./membershipFunding";
import { Knex } from "knex";
import { isDefinitiveVideoRejection } from "./definitiveVideoRejection";
import { additionalImageReferenceCost } from "./imageReferencePricing";
import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import { isPostgresClient } from "@/lib/dbDialect";
import { isRelayBillingSuccess } from "@/lib/relayMockPolicy";
import { isRecoveryOnlyMode } from "@/lib/recoveryOnlyMode";
import type { RelayEndpointType, RelayProvider } from "@/lib/sharedTypes";
import { computeUnifiedPricingCost, mergeTokenParams, type TokenParams } from "@/lib/billingExpr/unified";
import { resolveTimePricing } from "@/lib/timePricing";
import {
  AccountWalletInsufficientFundsError,
  accountWalletAvailable,
  applyAccountWalletCredit,
  applyAccountWalletDebit,
  captureOwnerAccountSpend,
  ensureAccountWallet,
  expireAccountGiftGrants,
  linkAccountWalletLedgerToWorkspaceLedger,
  readAccountWalletReadonly,
  releaseOwnerAccountSpend,
  reserveOwnerAccountSpend,
  type AccountSpendBreakdownItem,
  type AccountWallet,
  type AccountWalletLedger,
} from "@/lib/accountWallet";
import { restoreCommercialCreditLots } from "@/lib/commercialTenant";
import { ensureWorkspaceBillingAccountRecord } from "@/lib/workspaceBillingAccount";
import { assertRelayWorkerExecutionAttestation } from "@/lib/relayWorkerExecutionAttestation";
import { recordConsumptionAllocationsInTransaction, recordProviderCostForCapturedUsage } from "@/lib/consumptionAllocation";
import { settlementV2Mode } from "@/lib/tenantAttribution";
import { applyGuChargeRounding, ceilGuChargeMicros, guChargeRoundingVersion } from "./billingUnits";
import {
  applyPricingAudienceForGroup,
  applyPricingAudienceForWorkspace,
  type AudiencePricingResolution,
} from "@/lib/pricingAudience";

export const billingLedgerTypes = [
  "recharge",
  "deduct",
  "freeze",
  "release",
  "refund",
  "credit_set",
] as const;
export const billingLedgerStatuses = [
  "succeeded",
  "frozen",
  "released",
  "partially_released",
  "captured",
  "partially_captured",
] as const;
export const billingPlanStatuses = ["active", "archived"] as const;
export const billingSubscriptionStatuses = ["active", "cancelled", "expired"] as const;
export const apiTaskChargeModes = ["charge", "reserve", "none"] as const;
export const billingCurrency = "GU";
import { guPerYuan, guMicrosPerGu, guMicrosPerYuan } from "./billingUnits";
export { guPerYuan, guMicrosPerGu, guMicrosPerYuan, guUnitVersion } from "./billingUnits";
export const API_KEY_QUOTA_UNIT_GU_MICROS = "gu_micros";

export type BillingLedgerType = (typeof billingLedgerTypes)[number];
export type BillingLedgerStatus = (typeof billingLedgerStatuses)[number];
export type BillingPlanStatus = (typeof billingPlanStatuses)[number];
export type BillingSubscriptionStatus = (typeof billingSubscriptionStatuses)[number];
export type ApiTaskChargeMode = (typeof apiTaskChargeModes)[number];

type BillingDb = Knex | Knex.Transaction;

export class BillingError extends Error {
  status: number;
  readonly isBillingError = true;
  readonly publicDetails: Readonly<{
    requiredGu: number;
    availableGu: number;
  }> | null;

  constructor(
    message: string,
    status = 400,
    options: {
      publicDetails?: { requiredGu: number; availableGu: number } | null;
    } = {},
  ) {
    super(message);
    this.name = "BillingError";
    this.status = status;
    this.publicDetails = options.publicDetails
      ? Object.freeze({ ...options.publicDetails })
      : null;
  }
}

function publicGuFromMicros(micros: number): number {
  return Number((Math.max(0, micros) / guMicrosPerGu).toFixed(6));
}

function formatPublicGu(value: number): string {
  return value.toFixed(6).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

export function insufficientBalanceBillingError(
  requiredMicros: number,
  availableMicros: number,
): BillingError {
  const publicDetails = {
    requiredGu: publicGuFromMicros(requiredMicros),
    availableGu: publicGuFromMicros(availableMicros),
  };
  return new BillingError(
    `余额不足：预估所需 ${formatPublicGu(publicDetails.requiredGu)} GU，当前可用 ${formatPublicGu(publicDetails.availableGu)} GU`,
    402,
    { publicDetails },
  );
}

export function publicBillingErrorDetails(
  error: unknown,
): { requiredGu: number; availableGu: number } | null {
  if (!(error instanceof BillingError) || error.status !== 402 || !error.publicDetails) return null;
  return { ...error.publicDetails };
}

export interface BillingAccount {
  id: string;
  workspaceId: string;
  currency: string;
  balanceMicros: number;
  creditLimitMicros: number;
  frozenMicros: number;
  availableMicros: number;
  planId: string | null;
  status: string;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  metadata: Record<string, unknown>;
  createTime: number;
  updateTime: number;
}

export interface BillingLedger {
  /** Display-only model identity, resolved from usage in the same workspace. */
  model?: string | null;
  id: string;
  workspaceId: string;
  accountId: string;
  type: BillingLedgerType;
  status: BillingLedgerStatus;
  amountMicros: number;
  remainingMicros: number;
  currency: string;
  balanceBeforeMicros: number;
  balanceAfterMicros: number;
  frozenBeforeMicros: number;
  frozenAfterMicros: number;
  creditLimitMicros: number;
  relatedLedgerId: string | null;
  usageRecordId: string | null;
  taskId: string | null;
  apiKeyId: string | null;
  requestId: string | null;
  idempotencyKey: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  operatorUserId: number | null;
  createTime: number;
  updateTime: number;
}

export interface UsageRecord {
  id: string;
  taskId: string | null;
  apiKeyId: string | null;
  workspaceId: string | null;
  provider: string | null;
  channelId: string | null;
  endpointType: string;
  model: string | null;
  units: number;
  unit: string;
  costMicros: number;
  currency: string;
  status: string;
  createTime: number;
}

export interface BillingPlan {
  id: string;
  code: string;
  name: string;
  status: BillingPlanStatus;
  currency: string;
  billingPeriod: string;
  priceMicros: number;
  includedCreditsMicros: number;
  creditLimitMicros: number;
  quotas: Record<string, unknown>;
  features: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createTime: number;
  updateTime: number;
}

export interface WorkspacePlanSubscription {
  id: string;
  workspaceId: string;
  planId: string;
  status: BillingSubscriptionStatus;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  cancelAt: number | null;
  metadata: Record<string, unknown>;
  createTime: number;
  updateTime: number;
}

export interface BillingState {
  account: BillingAccount;
  ledger: BillingLedger;
  idempotent: boolean;
}

export interface MoneyOperationInput {
  workspaceId: string;
  amountMicros: number;
  currency?: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
  operatorUserId?: number | null;
  usageRecordId?: string | null;
  taskId?: string | null;
  apiKeyId?: string | null;
  requestId?: string | null;
}

export interface DeductWorkspaceInput extends MoneyOperationInput {
  reservationId?: string | null;
}

export interface ReleaseWorkspaceInput {
  workspaceId: string;
  reservationId: string;
  amountMicros?: number | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
  operatorUserId?: number | null;
  usageRecordId?: string | null;
  taskId?: string | null;
  apiKeyId?: string | null;
  requestId?: string | null;
}

export interface SetWorkspaceCreditLimitInput {
  workspaceId: string;
  creditLimitMicros: number;
  currency?: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
  operatorUserId?: number | null;
  requestId?: string | null;
}

export interface RecordUsageInput {
  taskId?: string | null;
  apiKeyId?: string | null;
  workspaceId?: string | null;
  provider?: string | null;
  channelId?: string | null;
  endpointType: string;
  model?: string | null;
  units?: number;
  unit?: string;
  costMicros?: number;
  currency?: string;
  status?: string;
}

export interface ResolvePricingInput {
  workspaceId?: string | null;
  pricingGroup?: string | null;
  endpointType: RelayEndpointType | string;
  provider?: RelayProvider | string | null;
  model?: string | null;
}

export interface ApiTaskChargeInput extends ResolvePricingInput {
  taskId?: string | null;
  apiKeyId?: string | null;
  channelId?: string | null;
  requestId?: string | null;
  units?: number;
  unit?: string;
  costMicros?: number | null;
  currency?: string;
  chargeMode?: ApiTaskChargeMode;
  description?: string | null;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
  operatorUserId?: number | null;
}

export interface ApiTaskChargeResult {
  usage: UsageRecord;
  ledger: BillingLedger | null;
  account: BillingAccount | null;
  pricingRule: PricingRule | null;
  costMicros: number;
  chargeMode: ApiTaskChargeMode;
  idempotent: boolean;
}

export interface ApiTaskReservationSettlementInput {
  workspaceId: string;
  reservationId: string;
  actualCostMicros: number;
  units: number;
  unit?: string;
  provider?: RelayProvider | string | null;
  channelId?: string | null;
  requestId?: string | null;
  idempotencyKey: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
  operatorUserId?: number | null;
  /** Charge authoritative token usage above the initial authorization. */
  allowOverage?: boolean;
  mutationFence?: ApiTaskBillingMutationFence;
  /**
   * Internal-only atomic extension point. The callback runs on the same
   * transaction after the main reservation is demonstrably settled and
   * before commit. Throwing rolls back the complete settlement.
   */
  trustedBeforeCommit?: (
    transaction: Knex.Transaction,
    settlement: ApiTaskReservationSettlementResult,
  ) => Promise<void>;
}

export type UserVideoEnhanceBillingMutationFence =
  | {
      kind: "user_video_enhance_operation/v1";
      phase: "dispatch";
      taskId: string;
      workspaceId: string;
      marker: string;
    }
  | {
      kind: "user_video_enhance_operation/v1";
      phase: "finalize";
      taskId: string;
      workspaceId: string;
      owner: string;
      fence: number;
      leaseExpiresAt: number;
    };

export interface RelayVideoBillingMutationFence {
  kind: "relay_video_operation/v1";
  taskId: string;
  workspaceId: string;
  leaseOwner: string;
  leaseExpiresAt: number;
}

export type ApiTaskBillingMutationFence =
  | UserVideoEnhanceBillingMutationFence
  | RelayVideoBillingMutationFence;

export interface ApiTaskReservationSettlementResult {
  usage: UsageRecord;
  reservation: BillingLedger;
  captureLedger: BillingLedger | null;
  releaseLedger: BillingLedger | null;
  overageLedger: BillingLedger | null;
  account: BillingAccount;
  idempotent: boolean;
}

export interface ApiTaskReservationPendingReconcileResult {
  reservation: BillingLedger;
  usage: UsageRecord;
  reconcileJobId: string;
  reason: string;
  actualCostMicros: number;
}

export interface PricingRule {
  id: string;
  name: string;
  scope: string;
  workspaceId: string | null;
  endpointType: string;
  provider: string | null;
  model: string | null;
  unit: string;
  /** @deprecated 新规则应使用 ruleConfig.pricingExpr 表达式。此字段仅用于旧规则回退。 */
  unitPriceMicros: number;
  currency: string;
  /**
   * 定价规则配置。新规则应使用 pricingExpr 表达式字段。
   *
   * 新字段（推荐）：
   * - `pricingExpr`: string — 定价表达式，如 "p*0.002 + c*0.006"
   * - `groupRatio`: number — 分组倍率（默认 1）
   *
   * @deprecated 旧字段（仅向后兼容）：
   * - `inputPriceMicros` / `outputPriceMicros` / `cacheReadPriceMicros` — 改用 pricingExpr
   * - `multiplier` — 改用 groupRatio 或表达式内乘法
   * - `minimumMicros` — 改用 max(expr, N)
   */
  ruleConfig: Record<string, unknown>;
  disabled: number;
  createTime: number;
  updateTime: number;
}

export interface UpsertBillingPlanInput {
  id?: string | null;
  code: string;
  name: string;
  status?: BillingPlanStatus;
  currency?: string;
  billingPeriod?: string;
  priceMicros?: number;
  includedCreditsMicros?: number;
  creditLimitMicros?: number;
  quotas?: Record<string, unknown>;
  features?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AssignWorkspacePlanInput {
  workspaceId: string;
  planId: string;
  currentPeriodStart?: number | null;
  currentPeriodEnd?: number | null;
  metadata?: Record<string, unknown>;
  grantIncludedCredits?: boolean;
  operatorUserId?: number | null;
}

function table(client: BillingDb, tableName: string): Knex.QueryBuilder {
  return (client as any)(tableName);
}

function now(): number {
  return Date.now();
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BillingError("metadata 必须是可序列化的有限 JSON 值");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new BillingError("metadata 不能包含循环引用");
    seen.add(value);
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) throw new BillingError("metadata 不能包含循环引用");
    seen.add(value);
    const objectValue = value as Record<string, unknown>;
    const result = `{${Object.keys(objectValue)
      .filter((key) => objectValue[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key], seen)}`)
      .join(",")}}`;
    seen.delete(value);
    return result;
  }
  throw new BillingError("metadata 必须是可序列化的 JSON 对象");
}

function walletAllocationRequestDigest(input: {
  ownerUserId: number;
  workspaceId: string;
  amountMicros: number;
  description: string;
  metadata: Record<string, unknown>;
}): string {
  const canonicalRequest = canonicalJson({
    contractVersion: "billing-wallet-allocation.v1",
    ownerUserId: input.ownerUserId,
    workspaceId: input.workspaceId,
    amountMicros: input.amountMicros,
    currency: billingCurrency,
    description: input.description,
    metadata: input.metadata,
  });
  return createHash("sha256").update(canonicalRequest, "utf8").digest("hex");
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * A reservation is a hard ceiling unless immutable creation metadata
 * explicitly authorizes authoritative token-usage overage settlement.
 */
export function reservationAllowsSettlementOverage(
  metadata: unknown,
  unit: unknown,
): boolean {
  const policy = parseJsonObject(parseJsonObject(metadata).settlementPolicy);
  return String(unit || "") === "token"
    && Number(policy.version) === 1
    && policy.mode === "authoritative_token_usage"
    && policy.allowOverage === true
    && policy.unit === "token";
}

function readNumber(value: unknown, fallback = 0): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeCurrency(value?: string | null): string {
  return (value || billingCurrency).trim().toUpperCase() || billingCurrency;
}

export function guMicrosFromYuan(amountYuan: number): number {
  if (!Number.isFinite(amountYuan) || amountYuan < 0) throw new BillingError("amountYuan 必须是非负数字");
  return Math.round(amountYuan * guMicrosPerYuan);
}

export function guFromMicros(value?: number | null): number {
  return Number(value || 0) / guMicrosPerGu;
}

export function yuanFromGuMicros(value?: number | null): number {
  return Number(value || 0) / guMicrosPerYuan;
}

function normalizeWorkspaceId(value: string | null | undefined): string {
  const workspaceId = String(value || "").trim();
  if (!workspaceId) throw new BillingError("workspaceId 不能为空");
  return workspaceId;
}

function assertNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BillingError(`${field} 必须是非负整数`);
  }
  return value;
}

function assertPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BillingError(`${field} 必须是正整数`);
  }
  return value;
}

function formatAccount(row: any): BillingAccount {
  const balanceMicros = Number(row.balanceMicros || 0);
  const creditLimitMicros = Number(row.creditLimitMicros || 0);
  const frozenMicros = Number(row.frozenMicros ?? row.reservedMicros ?? 0);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    currency: normalizeCurrency(row.currency),
    balanceMicros,
    creditLimitMicros,
    frozenMicros,
    availableMicros: balanceMicros - frozenMicros,
    planId: row.planId ?? null,
    status: row.status || "active",
    currentPeriodStart: row.currentPeriodStart ? Number(row.currentPeriodStart) : null,
    currentPeriodEnd: row.currentPeriodEnd ? Number(row.currentPeriodEnd) : null,
    metadata: parseJsonObject(row.metadata),
    createTime: Number(row.createTime ?? row.createdAt ?? 0),
    updateTime: Number(row.updateTime ?? row.updatedAt ?? row.createdAt ?? 0),
  };
}

function formatLedger(row: any): BillingLedger {
  const metadata = parseJsonObject(row.metadata);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    accountId: row.accountId,
    type: row.type,
    status: row.status ?? metadata.status ?? "succeeded",
    amountMicros: Number(row.amountMicros || 0),
    remainingMicros: Number(row.remainingMicros ?? metadata.remainingMicros ?? 0),
    currency: normalizeCurrency(row.currency),
    balanceBeforeMicros: Number(row.balanceBeforeMicros ?? row.balanceBefore ?? 0),
    balanceAfterMicros: Number(row.balanceAfterMicros ?? row.balanceAfter ?? 0),
    frozenBeforeMicros: Number(row.frozenBeforeMicros ?? row.reservedBefore ?? 0),
    frozenAfterMicros: Number(row.frozenAfterMicros ?? row.reservedAfter ?? 0),
    creditLimitMicros: Number(row.creditLimitMicros ?? metadata.creditLimitMicros ?? 0),
    relatedLedgerId: row.relatedLedgerId ?? metadata.relatedLedgerId ?? null,
    usageRecordId: row.usageRecordId ?? row.relatedUsageId ?? metadata.usageRecordId ?? null,
    taskId: row.taskId ?? row.relatedTaskId ?? metadata.taskId ?? null,
    apiKeyId: row.apiKeyId ?? metadata.apiKeyId ?? null,
    requestId: row.requestId ?? metadata.requestId ?? null,
    idempotencyKey: row.idempotencyKey ?? metadata.idempotencyKey ?? null,
    description: row.description ?? null,
    metadata,
    operatorUserId: row.operatorUserId == null && row.createdBy == null ? null : Number(row.operatorUserId ?? row.createdBy),
    createTime: Number(row.createTime ?? row.createdAt ?? 0),
    updateTime: Number(row.updateTime ?? row.updatedAt ?? row.createdAt ?? 0),
  };
}

function formatUsageRecord(row: any): UsageRecord {
  return {
    id: row.id,
    taskId: row.taskId ?? null,
    apiKeyId: row.apiKeyId ?? null,
    workspaceId: row.workspaceId ?? null,
    provider: row.provider ?? null,
    channelId: row.channelId ?? null,
    endpointType: row.endpointType,
    model: row.model ?? null,
    units: Number(row.units || 0),
    unit: row.unit || "task",
    costMicros: Number(row.costMicros || 0),
    currency: normalizeCurrency(row.currency),
    status: row.status || "recorded",
    createTime: Number(row.createTime || 0),
  };
}

function formatPlan(row: any): BillingPlan {
  const metadata = parseJsonObject(row.metadata);
  const quotas = parseJsonObject(row.quotas);
  if (row.apiQuota != null) quotas.apiQuota = Number(row.apiQuota);
  if (row.memberLimit != null) quotas.memberLimit = Number(row.memberLimit);
  if (row.keyLimit != null) quotas.keyLimit = Number(row.keyLimit);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status || "active",
    currency: normalizeCurrency(row.currency),
    billingPeriod: row.billingPeriod || String(metadata.billingPeriod || "month"),
    priceMicros: Number(row.priceMicros ?? row.monthlyFeeMicros ?? 0),
    includedCreditsMicros: Number(row.includedCreditsMicros || 0),
    creditLimitMicros: Number(row.creditLimitMicros ?? metadata.creditLimitMicros ?? 0),
    quotas,
    features: Object.keys(parseJsonObject(row.features)).length ? parseJsonObject(row.features) : parseJsonObject(metadata.features),
    metadata,
    createTime: Number(row.createTime ?? row.createdAt ?? 0),
    updateTime: Number(row.updateTime ?? row.updatedAt ?? row.createdAt ?? 0),
  };
}

function formatSubscription(row: any): WorkspacePlanSubscription {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    planId: row.planId,
    status: row.status || "active",
    currentPeriodStart: row.currentPeriodStart ? Number(row.currentPeriodStart) : null,
    currentPeriodEnd: row.currentPeriodEnd ? Number(row.currentPeriodEnd) : null,
    cancelAt: row.cancelAt ? Number(row.cancelAt) : null,
    metadata: parseJsonObject(row.metadata),
    createTime: Number(row.createTime ?? row.createdAt ?? 0),
    updateTime: Number(row.updateTime ?? row.updatedAt ?? row.createdAt ?? 0),
  };
}

function formatPricingRule(row: any): PricingRule {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope || "platform",
    workspaceId: row.workspaceId ?? null,
    endpointType: row.endpointType,
    provider: row.provider ?? null,
    model: row.model ?? null,
    unit: row.unit || "task",
    unitPriceMicros: Number(row.unitPriceMicros || 0),
    currency: normalizeCurrency(row.currency),
    ruleConfig: parseJsonObject(row.ruleConfig),
    disabled: Number(row.disabled || 0),
    createTime: Number(row.createTime || 0),
    updateTime: Number(row.updateTime || 0),
  };
}

async function readAccount(client: BillingDb, workspaceId: string): Promise<BillingAccount | null> {
  let query = table(client, "o_billing_account").where({ workspaceId });
  if ((client as Knex.Transaction).isTransaction && isPostgresClient(client)) {
    query = query.forUpdate();
  }
  const row = await query.first();
  return row ? formatAccount(row) : null;
}

async function ensureWorkspaceAccount(
  client: BillingDb,
  workspaceId: string,
  currency = billingCurrency,
): Promise<BillingAccount> {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  const existing = await readAccount(client, normalizedWorkspaceId);
  if (existing) {
    if (
      existing.currency !== billingCurrency &&
      existing.balanceMicros === 0 &&
      existing.creditLimitMicros === 0 &&
      existing.frozenMicros === 0
    ) {
      await table(client, "o_billing_account").where({ id: existing.id }).update({
        currency: billingCurrency,
        updatedAt: now(),
      });
      const updated = await readAccount(client, normalizedWorkspaceId);
      if (updated) return updated;
    }
    return existing;
  }

  await ensureWorkspaceBillingAccountRecord(client, {
    workspaceId: normalizedWorkspaceId,
    currency: normalizeCurrency(currency),
  });
  const created = await readAccount(client, normalizedWorkspaceId);
  if (!created) throw new BillingError("计费账户创建失败", 500);
  return created;
}

async function findIdempotentLedger(
  client: BillingDb,
  workspaceId: string,
  type: BillingLedgerType,
  idempotencyKey?: string | null,
): Promise<BillingLedger | null> {
  if (!idempotencyKey) return null;
  const row = await table(client, "o_billing_ledger")
    .where({ workspaceId, type, idempotencyKey })
    .orderBy("createdAt", "desc")
    .first();
  if (row) return formatLedger(row);

  const rows = await table(client, "o_billing_ledger")
    .where({ workspaceId, type })
    .whereNull("idempotencyKey")
    .orderBy("createdAt", "desc")
    .limit(500);
  return rows.map(formatLedger).find((row: BillingLedger) => row.idempotencyKey === idempotencyKey) ?? null;
}

async function readLedger(client: BillingDb, id: string, workspaceId?: string | null): Promise<BillingLedger | null> {
  const query = table(client, "o_billing_ledger").where({ id });
  if (workspaceId) query.andWhere({ workspaceId });
  const row = await query.first();
  return row ? formatLedger(row) : null;
}

async function insertLedger(
  client: BillingDb,
  input: {
    account: BillingAccount;
    type: BillingLedgerType;
    status: BillingLedgerStatus;
    amountMicros: number;
    remainingMicros?: number;
    balanceBeforeMicros: number;
    balanceAfterMicros: number;
    frozenBeforeMicros: number;
    frozenAfterMicros: number;
    relatedLedgerId?: string | null;
    usageRecordId?: string | null;
    taskId?: string | null;
    apiKeyId?: string | null;
    requestId?: string | null;
    idempotencyKey?: string | null;
    description?: string | null;
    metadata?: Record<string, unknown>;
    operatorUserId?: number | null;
  },
): Promise<BillingLedger> {
  const timestamp = now();
  const id = uuid();
  const metadata = {
    ...(input.metadata || {}),
    status: input.status,
    remainingMicros: input.remainingMicros ?? 0,
    creditLimitMicros: input.account.creditLimitMicros,
    relatedLedgerId: input.relatedLedgerId ?? null,
    usageRecordId: input.usageRecordId ?? null,
    taskId: input.taskId ?? null,
    apiKeyId: input.apiKeyId ?? null,
    requestId: input.requestId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
  };
  await table(client, "o_billing_ledger").insert({
    id,
    accountId: input.account.id,
    workspaceId: input.account.workspaceId,
    type: input.type,
    direction: ledgerDirection(input.type),
    amountMicros: input.amountMicros,
    currency: input.account.currency,
    balanceBefore: input.balanceBeforeMicros,
    balanceAfter: input.balanceAfterMicros,
    reservedBefore: input.frozenBeforeMicros,
    reservedAfter: input.frozenAfterMicros,
    relatedTaskId: input.taskId ?? null,
    relatedUsageId: input.usageRecordId ?? null,
    relatedLedgerId: input.relatedLedgerId ?? null,
    apiKeyId: input.apiKeyId ?? null,
    requestId: input.requestId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    status: input.status,
    remainingMicros: input.remainingMicros ?? 0,
    description: input.description ?? null,
    metadata: stringifyJson(metadata),
    createdBy: input.operatorUserId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  const row = await readLedger(client, id);
  if (!row) throw new BillingError("计费流水写入失败", 500);
  return row;
}

function ledgerDirection(type: BillingLedgerType): string {
  if (type === "recharge" || type === "refund") return "credit";
  if (type === "deduct") return "debit";
  if (type === "freeze") return "reserve";
  if (type === "release") return "release";
  return "adjust";
}

async function updateAccountBalances(
  client: BillingDb,
  account: BillingAccount,
  patch: Partial<Pick<BillingAccount, "balanceMicros" | "creditLimitMicros" | "frozenMicros" | "planId" | "currentPeriodStart" | "currentPeriodEnd">>,
): Promise<BillingAccount> {
  const updateData: Record<string, unknown> = { updatedAt: now() };
  if (patch.balanceMicros !== undefined) updateData.balanceMicros = patch.balanceMicros;
  if (patch.creditLimitMicros !== undefined) updateData.creditLimitMicros = patch.creditLimitMicros;
  if (patch.frozenMicros !== undefined) updateData.reservedMicros = patch.frozenMicros;
  if (patch.planId !== undefined) updateData.planId = patch.planId;

  const query = table(client, "o_billing_account")
    .where({ id: account.id })
    .andWhere({ balanceMicros: account.balanceMicros })
    .andWhere({ creditLimitMicros: account.creditLimitMicros })
    .andWhere({ reservedMicros: account.frozenMicros });
  const affected = await query
    .update(updateData);
  if (Number(affected || 0) !== 1) {
    throw new BillingError("计费账户并发更新冲突，请重试", 409);
  }
  const updated = await readAccount(client, account.workspaceId);
  if (!updated) throw new BillingError("计费账户不存在", 404);
  return updated;
}

async function updateLedgerRuntimeState(
  client: BillingDb,
  ledger: BillingLedger,
  status: BillingLedgerStatus,
  remainingMicros: number,
): Promise<BillingLedger> {
  const timestamp = now();
  const affected = await table(client, "o_billing_ledger")
    .where({ id: ledger.id, remainingMicros: ledger.remainingMicros })
    .update({
      status,
      remainingMicros,
      updatedAt: timestamp,
      metadata: stringifyJson({
        ...ledger.metadata,
        status,
        remainingMicros,
      }),
    });
  if (Number(affected || 0) !== 1) {
    throw new BillingError("冻结流水已被其他请求处理，请重试", 409);
  }
  const updated = await readLedger(client, ledger.id, ledger.workspaceId);
  if (!updated) throw new BillingError("冻结流水不存在", 404);
  return updated;
}

function assertAccountReady(account: BillingAccount, currency?: string | null): void {
  if (account.status !== "active") throw new BillingError("计费账户不可用", 403);
  const normalizedCurrency = normalizeCurrency(currency || account.currency);
  if (account.currency !== normalizedCurrency) {
    throw new BillingError(`币种不匹配：账户为 ${account.currency}，请求为 ${normalizedCurrency}`);
  }
}

function assertSpendable(
  account: BillingAccount,
  amountMicros: number,
  effectiveAvailableMicros = account.availableMicros,
): void {
  if (effectiveAvailableMicros < amountMicros) {
    throw insufficientBalanceBillingError(amountMicros, effectiveAvailableMicros);
  }
}

function spendBreakdownFromMetadata(
  metadata: Record<string, unknown>,
  amountMicros: number,
  offsetMicros = 0,
): AccountSpendBreakdownItem[] {
  const raw = Array.isArray(metadata.ownerSpendBreakdown) ? metadata.ownerSpendBreakdown : [];
  let offsetRemaining = assertNonNegativeInteger(offsetMicros, "offsetMicros");
  let remaining = amountMicros;
  const breakdown: AccountSpendBreakdownItem[] = [];
  for (const item of raw as any[]) {
    if (remaining <= 0) break;
    const itemAmount = Number(item?.amountMicros || 0);
    if (itemAmount <= 0) continue;
    if (offsetRemaining >= itemAmount) {
      offsetRemaining -= itemAmount;
      continue;
    }
    const availableAmount = itemAmount - offsetRemaining;
    offsetRemaining = 0;
    const amount = Math.min(remaining, availableAmount);
    if (amount <= 0) continue;
    breakdown.push({
      source: item.source,
      amountMicros: amount,
      grantId: item.grantId || null,
      creditLotId: item.creditLotId || null,
      sellerTenantId: item.sellerTenantId || null,
    });
    remaining -= amount;
  }
  if (offsetRemaining > 0 || remaining > 0) throw new BillingError("冻结来源拆分不足", 500);
  return breakdown;
}

async function workspaceOwnerFundingInfo(client: BillingDb, workspaceId: string): Promise<{
  ownerUserId: number;
  defaultWorkspaceId: string | null;
  currentWorkspaceId: string | null;
} | null> {
  const row = await table(client, "o_workspace as w")
    .leftJoin("o_user as u", "w.ownerUserId", "u.id")
    .where("w.id", workspaceId)
    .select("w.ownerUserId", "u.defaultWorkspaceId", "u.currentWorkspaceId")
    .first();
  if (!row?.ownerUserId) return null;
  return {
    ownerUserId: Number(row.ownerUserId),
    defaultWorkspaceId: row.defaultWorkspaceId || row.currentWorkspaceId || null,
    currentWorkspaceId: row.currentWorkspaceId || null,
  };
}

async function maybeFundDefaultWorkspaceFromAccountWallet(
  client: BillingDb,
  account: BillingAccount,
  amountMicros: number,
  input: {
    idempotencyKey?: string | null;
    requestId?: string | null;
    description?: string | null;
    metadata?: Record<string, unknown>;
    operatorUserId?: number | null;
  },
): Promise<BillingAccount> {
  if (account.availableMicros >= amountMicros) return account;
  if (input.metadata?.skipAccountWalletAutoFund) return account;

  const fundingInfo = await workspaceOwnerFundingInfo(client, account.workspaceId);
  if (!fundingInfo || fundingInfo.defaultWorkspaceId !== account.workspaceId) return account;

  const deficitMicros = amountMicros - account.availableMicros;
  let debitResult: { wallet: AccountWallet; ledger: AccountWalletLedger; idempotent: boolean };
  try {
    debitResult = await applyAccountWalletDebit(client, {
      userId: fundingInfo.ownerUserId,
      amountMicros: deficitMicros,
      currency: account.currency,
      type: "auto_allocate_to_default_workspace",
      workspaceId: account.workspaceId,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey ? `auto-wallet:${input.idempotencyKey}` : null,
      description: "默认工作区自动消耗账号 GU 余额",
      metadata: {
        source: "default_workspace_auto_fund",
        requestedAmountMicros: amountMicros,
        workspaceAvailableMicros: account.availableMicros,
        workspaceBalanceMicros: account.balanceMicros,
        workspaceCreditLimitMicros: account.creditLimitMicros,
        ...(input.metadata || {}),
      },
      operatorUserId: input.operatorUserId,
    });
  } catch {
    throw new BillingError("默认工作区余额不足，账号 GU 余额也不足", 402);
  }

  const recharge = await applyRecharge(client, {
    workspaceId: account.workspaceId,
    amountMicros: deficitMicros,
    currency: account.currency,
    description: "默认工作区自动划拨账号 GU 余额",
    metadata: {
      source: "account_wallet_auto_allocate",
      accountWalletLedgerId: debitResult.ledger.id,
      accountWalletUserId: fundingInfo.ownerUserId,
      requestedAmountMicros: amountMicros,
    },
    idempotencyKey: input.idempotencyKey ? `auto-workspace:${input.idempotencyKey}` : null,
    operatorUserId: input.operatorUserId,
    requestId: input.requestId,
  });
  await linkAccountWalletLedgerToWorkspaceLedger(client, debitResult.ledger.id, recharge.ledger.id);
  return recharge.account;
}

async function applyRecharge(client: BillingDb, input: MoneyOperationInput): Promise<BillingState> {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const existing = await findIdempotentLedger(client, workspaceId, "recharge", input.idempotencyKey);
  if (existing) {
    const account = await ensureWorkspaceAccount(client, workspaceId, existing.currency);
    return { account, ledger: existing, idempotent: true };
  }

  const amountMicros = assertPositiveInteger(input.amountMicros, "amountMicros");
  const account = await ensureWorkspaceAccount(client, workspaceId, input.currency);
  assertAccountReady(account, input.currency);
  const balanceAfterMicros = account.balanceMicros + amountMicros;
  const updated = await updateAccountBalances(client, account, { balanceMicros: balanceAfterMicros });
  const ledger = await insertLedger(client, {
    account,
    type: "recharge",
    status: "succeeded",
    amountMicros,
    balanceBeforeMicros: account.balanceMicros,
    balanceAfterMicros,
    frozenBeforeMicros: account.frozenMicros,
    frozenAfterMicros: account.frozenMicros,
    usageRecordId: input.usageRecordId,
    taskId: input.taskId,
    apiKeyId: input.apiKeyId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    description: input.description,
    metadata: input.metadata,
    operatorUserId: input.operatorUserId,
  });
  return { account: updated, ledger, idempotent: false };
}

export async function applySetCreditLimit(client: BillingDb, input: SetWorkspaceCreditLimitInput): Promise<BillingState> {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const existing = await findIdempotentLedger(client, workspaceId, "credit_set", input.idempotencyKey);
  if (existing) {
    const account = await ensureWorkspaceAccount(client, workspaceId, existing.currency);
    return { account, ledger: existing, idempotent: true };
  }

  const creditLimitMicros = assertNonNegativeInteger(input.creditLimitMicros, "creditLimitMicros");
  const account = await ensureWorkspaceAccount(client, workspaceId, input.currency);
  assertAccountReady(account, input.currency);
  const updated = await updateAccountBalances(client, account, { creditLimitMicros });
  const ledger = await insertLedger(client, {
    account: { ...account, creditLimitMicros },
    type: "credit_set",
    status: "succeeded",
    amountMicros: creditLimitMicros,
    balanceBeforeMicros: account.balanceMicros,
    balanceAfterMicros: account.balanceMicros,
    frozenBeforeMicros: account.frozenMicros,
    frozenAfterMicros: account.frozenMicros,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    description: input.description ?? `creditLimit: ${account.creditLimitMicros} -> ${creditLimitMicros}`,
    metadata: {
      previousCreditLimitMicros: account.creditLimitMicros,
      ...(input.metadata || {}),
    },
    operatorUserId: input.operatorUserId,
  });
  return { account: updated, ledger, idempotent: false };
}

async function reserveOwnerAccountSpendForBilling(
  client: BillingDb,
  input: Parameters<typeof reserveOwnerAccountSpend>[1],
): Promise<Awaited<ReturnType<typeof reserveOwnerAccountSpend>>> {
  try {
    return await reserveOwnerAccountSpend(client, input);
  } catch (error) {
    if (error instanceof AccountWalletInsufficientFundsError) {
      if (error.requiredMicros != null && error.availableMicros != null) {
        throw insufficientBalanceBillingError(error.requiredMicros, error.availableMicros);
      }
      throw new BillingError(error.message, 402);
    }
    throw error;
  }
}

async function applyFreeze(client: BillingDb, input: MoneyOperationInput): Promise<BillingState> {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const existing = await findIdempotentLedger(client, workspaceId, "freeze", input.idempotencyKey);
  if (existing) {
    const account = await ensureWorkspaceAccount(client, workspaceId, existing.currency);
    return { account, ledger: existing, idempotent: true };
  }

  const amountMicros = assertPositiveInteger(input.amountMicros, "amountMicros");
  const account = await ensureWorkspaceAccount(client, workspaceId, input.currency);
  assertAccountReady(account, input.currency);
  assertSpendable(
    account,
    amountMicros,
    await readWorkspaceAvailableMicros(workspaceId, client, input.metadata) ?? account.availableMicros,
  );
  const ownerFundingInfo = await workspaceOwnerFundingInfo(client, workspaceId);
  if (!ownerFundingInfo) throw new BillingError("工作区 owner 不存在", 404);
  const ownerReserve = await reserveOwnerAccountSpendForBilling(client, {
    userId: ownerFundingInfo.ownerUserId,
    amountMicros,
    currency: account.currency,
    workspaceId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey ? `owner:${input.idempotencyKey}` : null,
    description: input.description || "工作区消费额度冻结",
    metadata: input.metadata,
    operatorUserId: input.operatorUserId,
  });

  const frozenAfterMicros = account.frozenMicros + amountMicros;
  const updated = await updateAccountBalances(client, account, { frozenMicros: frozenAfterMicros });
  const ledger = await insertLedger(client, {
    account,
    type: "freeze",
    status: "frozen",
    amountMicros,
    remainingMicros: amountMicros,
    balanceBeforeMicros: account.balanceMicros,
    balanceAfterMicros: account.balanceMicros,
    frozenBeforeMicros: account.frozenMicros,
    frozenAfterMicros,
    usageRecordId: input.usageRecordId,
    taskId: input.taskId,
    apiKeyId: input.apiKeyId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    description: input.description,
    metadata: {
      ...(input.metadata || {}),
      ownerUserId: ownerFundingInfo.ownerUserId,
      ownerWalletLedgerId: ownerReserve.ledger.id,
      ownerSpendBreakdown: ownerReserve.breakdown,
    },
    operatorUserId: input.operatorUserId,
  });
  return { account: updated, ledger, idempotent: false };
}

async function applyDeduct(client: BillingDb, input: DeductWorkspaceInput): Promise<BillingState> {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const existing = await findIdempotentLedger(client, workspaceId, "deduct", input.idempotencyKey);
  if (existing) {
    const account = await ensureWorkspaceAccount(client, workspaceId, existing.currency);
    return { account, ledger: existing, idempotent: true };
  }

  const amountMicros = assertPositiveInteger(input.amountMicros, "amountMicros");
  let account = await ensureWorkspaceAccount(client, workspaceId, input.currency);
  assertAccountReady(account, input.currency);

  const ownerFundingInfo = await workspaceOwnerFundingInfo(client, workspaceId);
  if (!ownerFundingInfo) throw new BillingError("工作区 owner 不存在", 404);
  let relatedLedger: BillingLedger | null = null;
  let frozenAfterMicros = account.frozenMicros;
  let ownerSpendBreakdown: AccountSpendBreakdownItem[] = [];
  let ownerWalletLedgerId: string | null = null;
  if (input.reservationId) {
    relatedLedger = await readLedger(client, input.reservationId, workspaceId);
    if (!relatedLedger || relatedLedger.type !== "freeze") throw new BillingError("冻结流水不存在", 404);
    if (relatedLedger.remainingMicros < amountMicros) throw new BillingError("冻结余额不足");
    frozenAfterMicros = account.frozenMicros - amountMicros;
    if (frozenAfterMicros < 0) throw new BillingError("账户冻结余额异常", 500);
    ownerSpendBreakdown = spendBreakdownFromMetadata(
      relatedLedger.metadata,
      amountMicros,
      relatedLedger.amountMicros - relatedLedger.remainingMicros,
    );

    const remainingMicros = relatedLedger.remainingMicros - amountMicros;
    await updateLedgerRuntimeState(
      client,
      relatedLedger,
      remainingMicros === 0 ? "captured" : "partially_captured",
      remainingMicros,
    );
  } else {
    assertSpendable(
      account,
      amountMicros,
      await readWorkspaceAvailableMicros(workspaceId, client, input.metadata) ?? account.availableMicros,
    );
    const ownerReserve = await reserveOwnerAccountSpendForBilling(client, {
      userId: ownerFundingInfo.ownerUserId,
      amountMicros,
      currency: account.currency,
      workspaceId,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey ? `owner-reserve:${input.idempotencyKey}` : null,
      description: input.description || "工作区消费额度冻结",
      metadata: input.metadata,
      operatorUserId: input.operatorUserId,
    });
    ownerSpendBreakdown = ownerReserve.breakdown;
  }
  const ownerCapture = await captureOwnerAccountSpend(client, {
    userId: ownerFundingInfo.ownerUserId,
    amountMicros,
    currency: account.currency,
    workspaceId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey ? `owner-capture:${input.idempotencyKey}` : null,
    description: input.description || "工作区消费扣费",
    metadata: input.metadata,
    operatorUserId: input.operatorUserId,
    breakdown: ownerSpendBreakdown,
  });
  ownerWalletLedgerId = ownerCapture.ledger.id;

  // 0.1.4 消费分摊（影子账/正式账）：仅在成功 capture 后记录。
  // 失败、取消或 release 不产生实际消费分摊；feature flag 关闭时跳过。
  // R6：active 模式下 allocation 与 settlement accrual 失败必须使 capture 回滚，
  // 绝不吞错；shadow 模式失败行显式报告但不阻断计费。
  if (ownerSpendBreakdown.length && input.idempotencyKey) {
    const allocationOutcome = await recordConsumptionAllocationsInTransaction(client as any, {
      userId: ownerFundingInfo.ownerUserId,
      workspaceId,
      chargedGuMicros: amountMicros,
      breakdown: ownerSpendBreakdown,
      ledgerId: null,
      usageId: input.usageRecordId ? String(input.usageRecordId) : null,
      requestId: input.requestId ?? null,
      taskId: input.taskId ?? null,
      pricingRuleId: (input.metadata?.pricingRuleId as string) ?? null,
      sourceType: (input.metadata?.source as string) ?? null,
      sourceId: (input.metadata?.sourceId as string) ?? null,
      idempotencyKey: `alloc:${workspaceId}:${input.idempotencyKey}`,
      mode: settlementV2Mode() === "active" ? "active" : "shadow",
    });
    if (allocationOutcome.failed.length) {
      console.warn(
        `[settlement-v2] shadow allocation rows failed (savepoint rolled back): ${allocationOutcome.failed.join(",")}`,
      );
    }
  }

  // R7 canonical 计费完成边界：确认计费的用量统一写入估算供应商成本。
  // applyDeduct 是直接扣费与预扣结算（settleApiTaskReservation）的共同汇聚点，
  // 覆盖文本/图片/视频/音频/画质增强与异步任务完成；失败、取消、release 不经过这里。
  if (input.usageRecordId) {
    await recordProviderCostForCapturedUsage(client as any, {
      usageRecordId: String(input.usageRecordId),
      requestId: input.requestId ?? null,
      metadata: (input.metadata as Record<string, unknown> | null) ?? null,
    });
  }

  const balanceAfterMicros = account.balanceMicros - amountMicros;
  const updated = await updateAccountBalances(client, account, {
    balanceMicros: balanceAfterMicros,
    frozenMicros: frozenAfterMicros,
  });
  const ledger = await insertLedger(client, {
    account,
    type: "deduct",
    status: "succeeded",
    amountMicros,
    balanceBeforeMicros: account.balanceMicros,
    balanceAfterMicros,
    frozenBeforeMicros: account.frozenMicros,
    frozenAfterMicros,
    relatedLedgerId: relatedLedger?.id ?? null,
    usageRecordId: input.usageRecordId ?? relatedLedger?.usageRecordId ?? null,
    taskId: input.taskId ?? relatedLedger?.taskId ?? null,
    apiKeyId: input.apiKeyId ?? relatedLedger?.apiKeyId ?? null,
    requestId: input.requestId ?? relatedLedger?.requestId ?? null,
    idempotencyKey: input.idempotencyKey,
    description: input.description,
    metadata: {
      ...(input.metadata || {}),
      ownerUserId: ownerFundingInfo.ownerUserId,
      ownerWalletLedgerId,
      ownerSpendBreakdown,
    },
    operatorUserId: input.operatorUserId,
  });
  return { account: updated, ledger, idempotent: false };
}

async function applyRelease(client: BillingDb, input: ReleaseWorkspaceInput): Promise<BillingState> {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const existing = await findIdempotentLedger(client, workspaceId, "release", input.idempotencyKey);
  if (existing) {
    const account = await ensureWorkspaceAccount(client, workspaceId, existing.currency);
    return { account, ledger: existing, idempotent: true };
  }

  const account = await ensureWorkspaceAccount(client, workspaceId);
  assertAccountReady(account);
  const reservation = await readLedger(client, input.reservationId, workspaceId);
  if (!reservation || reservation.type !== "freeze") throw new BillingError("冻结流水不存在", 404);
  const amountMicros = input.amountMicros == null ? reservation.remainingMicros : assertPositiveInteger(input.amountMicros, "amountMicros");
  if (amountMicros <= 0) throw new BillingError("没有可释放的冻结额度");
  if (reservation.remainingMicros < amountMicros) throw new BillingError("释放金额超过冻结剩余额度");
  if (account.frozenMicros < amountMicros) throw new BillingError("账户冻结余额异常", 500);

  const ownerFundingInfo = await workspaceOwnerFundingInfo(client, workspaceId);
  if (!ownerFundingInfo) throw new BillingError("工作区 owner 不存在", 404);
  const ownerSpendBreakdown = spendBreakdownFromMetadata(
    reservation.metadata,
    amountMicros,
    reservation.amountMicros - reservation.remainingMicros,
  );
  const ownerRelease = await releaseOwnerAccountSpend(client, {
    userId: ownerFundingInfo.ownerUserId,
    amountMicros,
    currency: account.currency,
    workspaceId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey ? `owner-release:${input.idempotencyKey}` : null,
    description: input.description || "工作区冻结额度释放",
    metadata: input.metadata,
    operatorUserId: input.operatorUserId,
    breakdown: ownerSpendBreakdown,
  });
  const remainingMicros = reservation.remainingMicros - amountMicros;
  const frozenAfterMicros = account.frozenMicros - amountMicros;
  await updateLedgerRuntimeState(
    client,
    reservation,
    remainingMicros === 0 ? "released" : "partially_released",
    remainingMicros,
  );
  const updated = await updateAccountBalances(client, account, { frozenMicros: frozenAfterMicros });
  const ledger = await insertLedger(client, {
    account,
    type: "release",
    status: "succeeded",
    amountMicros,
    balanceBeforeMicros: account.balanceMicros,
    balanceAfterMicros: account.balanceMicros,
    frozenBeforeMicros: account.frozenMicros,
    frozenAfterMicros,
    relatedLedgerId: reservation.id,
    usageRecordId: input.usageRecordId ?? reservation.usageRecordId,
    taskId: input.taskId ?? reservation.taskId,
    apiKeyId: input.apiKeyId ?? reservation.apiKeyId,
    requestId: input.requestId ?? reservation.requestId,
    idempotencyKey: input.idempotencyKey,
    description: input.description,
    metadata: {
      ...(input.metadata || {}),
      ownerUserId: ownerFundingInfo.ownerUserId,
      ownerWalletLedgerId: ownerRelease.ledger.id,
      ownerSpendBreakdown,
    },
    operatorUserId: input.operatorUserId,
  });
  return { account: updated, ledger, idempotent: false };
}

async function applyRefund(client: BillingDb, input: MoneyOperationInput & { originalLedgerId?: string | null }): Promise<BillingState> {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const existing = await findIdempotentLedger(client, workspaceId, "refund", input.idempotencyKey);
  if (existing) {
    const account = await ensureWorkspaceAccount(client, workspaceId, existing.currency);
    return { account, ledger: existing, idempotent: true };
  }

  const amountMicros = assertPositiveInteger(input.amountMicros, "amountMicros");
  const account = await ensureWorkspaceAccount(client, workspaceId, input.currency);
  assertAccountReady(account, input.currency);

  // 回滚 owner wallet：读取原 deduct 流水，从中提取 owner 钱包扣费信息
  let ownerRefundLedgerId: string | null = null;
  let ownerSpendBreakdown: AccountSpendBreakdownItem[] = [];
  let originalOwnerWalletLedgerId: string | null = null;
  let originalApiKeyId: string | null = null;
  let ownerUserId: number | null = null;
  if (input.originalLedgerId) {
    const originalLedger = await readLedger(client, input.originalLedgerId, workspaceId);
    if (originalLedger) {
      originalApiKeyId = originalLedger.apiKeyId;
      const meta = originalLedger.metadata || {};
      originalOwnerWalletLedgerId = typeof meta.ownerWalletLedgerId === "string" ? meta.ownerWalletLedgerId : null;
      const rawOwnerUserId = Number(meta.ownerUserId);
      ownerUserId = Number.isFinite(rawOwnerUserId) && rawOwnerUserId > 0 ? rawOwnerUserId : null;
      const previousRefund = await table(client, "o_billing_ledger")
        .where({ workspaceId, type: "refund", relatedLedgerId: originalLedger.id })
        .sum({ total: "amountMicros" })
        .first();
      const refundOffsetMicros = Number((previousRefund as any)?.total || 0);
      ownerSpendBreakdown = spendBreakdownFromMetadata(
        meta,
        amountMicros,
        refundOffsetMicros,
      );
    }
  }
  // 如果原流水没有 ownerWalletLedgerId（可能是旧数据或非 owner wallet 扣费），跳过 owner wallet 回滚
  if (originalOwnerWalletLedgerId && ownerUserId && ownerSpendBreakdown.length > 0) {
    const ownerCredit = await applyAccountWalletCredit(client, {
      userId: ownerUserId,
      amountMicros,
      currency: account.currency,
      workspaceId,
      description: input.description || "工作区退款回滚 owner 钱包",
      metadata: {
        ...(input.metadata || {}),
        refundWorkspaceLedgerOriginalId: input.originalLedgerId ?? null,
        originalOwnerWalletLedgerId,
        ownerSpendBreakdown,
      },
      idempotencyKey: `refund-owner-${input.originalLedgerId}:${input.idempotencyKey || "full"}`,
      operatorUserId: input.operatorUserId,
    });
    await restoreCommercialCreditLots(
      client,
      ownerUserId,
      ownerSpendBreakdown.filter((item) => item.source === "cash"),
    );
    ownerRefundLedgerId = ownerCredit.ledger.id;
  }

  const balanceAfterMicros = account.balanceMicros + amountMicros;
  const updated = await updateAccountBalances(client, account, { balanceMicros: balanceAfterMicros });
  await refundApiKeyGuQuota(client, input.apiKeyId ?? originalApiKeyId, amountMicros);
  if (input.usageRecordId) {
    await table(client, "o_usage_record").where({ id: input.usageRecordId }).update({ status: "refunded" });
  } else if (input.taskId) {
    await table(client, "o_usage_record").where({ taskId: input.taskId }).update({ status: "refunded" });
  }
  const refundMetadata: Record<string, unknown> = { ...(input.metadata || {}) };
  if (ownerRefundLedgerId) {
    refundMetadata.ownerUserId = ownerUserId;
    refundMetadata.ownerWalletLedgerId = ownerRefundLedgerId;
    refundMetadata.ownerSpendBreakdown = ownerSpendBreakdown;
    refundMetadata.originalOwnerWalletLedgerId = originalOwnerWalletLedgerId;
  }
  const ledger = await insertLedger(client, {
    account,
    type: "refund",
    status: "succeeded",
    amountMicros,
    balanceBeforeMicros: account.balanceMicros,
    balanceAfterMicros,
    frozenBeforeMicros: account.frozenMicros,
    frozenAfterMicros: account.frozenMicros,
    relatedLedgerId: input.originalLedgerId ?? null,
    usageRecordId: input.usageRecordId,
    taskId: input.taskId,
    apiKeyId: input.apiKeyId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    description: input.description,
    metadata: refundMetadata,
    operatorUserId: input.operatorUserId,
  });
  return { account: updated, ledger, idempotent: false };
}

async function recordUsage(client: BillingDb, input: RecordUsageInput): Promise<UsageRecord> {
  const timestamp = now();
  const id = uuid();
  await table(client, "o_usage_record").insert({
    id,
    taskId: input.taskId ?? null,
    apiKeyId: input.apiKeyId ?? null,
    workspaceId: input.workspaceId ?? null,
    provider: input.provider ?? null,
    channelId: input.channelId ?? null,
    endpointType: input.endpointType,
    model: input.model ?? null,
    units: assertNonNegativeInteger(input.units ?? 1, "units"),
    unit: input.unit ?? "task",
    costMicros: assertNonNegativeInteger(input.costMicros ?? 0, "costMicros"),
    currency: normalizeCurrency(input.currency),
    status: input.status ?? "recorded",
    createTime: timestamp,
  });

  const row = await table(client, "o_usage_record").where({ id }).first();
  if (!row) throw new BillingError("用量流水写入失败", 500);
  return formatUsageRecord(row);
}

function pricingScopeScore(rule: PricingRule, input: ResolvePricingInput): number {
  let score = 0;
  if (rule.scope === "workspace" && input.workspaceId && rule.workspaceId === input.workspaceId) score += 100;
  if (rule.provider && input.provider && rule.provider === input.provider) score += 20;
  if (!rule.provider) score += 1;
  if (rule.model && input.model && rule.model === input.model) score += 10;
  if (!rule.model) score += 1;
  return score;
}

export async function resolvePricingRule(input: ResolvePricingInput, client: BillingDb = db): Promise<PricingRule | null> {
  input = { ...input, model: internalModelId(input.model) };
  const query = table(client, "o_pricing_rule")
    .where({ endpointType: input.endpointType, disabled: 0 })
    .where((builder: Knex.QueryBuilder) => {
      builder.whereNull("provider");
      if (input.provider) builder.orWhere("provider", input.provider);
    })
    .where((builder: Knex.QueryBuilder) => {
      builder.whereNull("model");
      if (input.model) builder.orWhere("model", input.model);
    })
    .where((builder: Knex.QueryBuilder) => {
      builder.where("scope", "platform");
      if (input.workspaceId) builder.orWhere({ scope: "workspace", workspaceId: input.workspaceId });
    });

  const rows = await query;
  const rules = rows.map(formatPricingRule);
  rules.sort((a: PricingRule, b: PricingRule) => pricingScopeScore(b, input) - pricingScopeScore(a, input) || b.updateTime - a.updateTime);
  const resolution = input.pricingGroup
    ? applyPricingAudienceForGroup(rules[0] ?? null, input.pricingGroup)
    : await applyPricingAudienceForWorkspace(client, input.workspaceId, rules[0] ?? null);
  return resolution.rule;
}

/**
 * Resolve a relay price that is explicitly bound to the selected provider.
 * A provider-neutral rule is useful for estimates and non-relay workloads, but
 * it is not a safe settlement contract for a request that has already selected
 * a concrete upstream channel: different providers can have materially
 * different costs for the same public model name.
 */
export async function resolveProviderSpecificPricingRuleWithAudience(
  input: ResolvePricingInput & { provider: RelayProvider | string },
  client: BillingDb = db,
): Promise<AudiencePricingResolution<PricingRule>> {
  input = { ...input, model: internalModelId(input.model) };
  const provider = String(input.provider || "").trim();
  if (!provider) return { baseRule: null, rule: null, decision: null };

  const query = table(client, "o_pricing_rule")
    .where({ endpointType: input.endpointType, provider, disabled: 0 })
    .where((builder: Knex.QueryBuilder) => {
      builder.whereNull("model");
      if (input.model) builder.orWhere("model", input.model);
    })
    .where((builder: Knex.QueryBuilder) => {
      builder.where("scope", "platform");
      if (input.workspaceId) builder.orWhere({ scope: "workspace", workspaceId: input.workspaceId });
    });

  const rules = (await query).map(formatPricingRule);
  rules.sort((left: PricingRule, right: PricingRule) => {
    const score = (rule: PricingRule) =>
      (rule.scope === "workspace" && input.workspaceId && rule.workspaceId === input.workspaceId ? 100 : 0) +
      (rule.model && input.model && rule.model === input.model ? 10 : !rule.model ? 1 : 0);
    return score(right) - score(left) || right.updateTime - left.updateTime;
  });
  return input.pricingGroup
    ? applyPricingAudienceForGroup(rules[0] ?? null, input.pricingGroup)
    : await applyPricingAudienceForWorkspace(client, input.workspaceId, rules[0] ?? null);
}

export async function resolveProviderSpecificPricingRule(
  input: ResolvePricingInput & { provider: RelayProvider | string },
  client: BillingDb = db,
): Promise<PricingRule | null> {
  return (await resolveProviderSpecificPricingRuleWithAudience(input, client)).rule;
}

function calculateRawPricingCost(
  rule: PricingRule | null,
  units = 1,
  overrideCostMicros?: number | null,
  tokenParams?: Partial<TokenParams>,
  evaluatedAt = Date.now(),
  referenceImageCount?: number,
): number {
  if (overrideCostMicros != null) return assertNonNegativeInteger(overrideCostMicros, "costMicros");
  if (!rule) return 0;

  const timePricing = resolveTimePricing(rule.ruleConfig, evaluatedAt);

  // 表达式模式：有 pricingExpr 且传入 tokenParams 时走表达式
  const pricingExpr = typeof rule.ruleConfig.pricingExpr === "string" && rule.ruleConfig.pricingExpr.trim();
  if (pricingExpr && tokenParams) {
    const result = computeUnifiedPricingCost({
      rule,
      tokenParams,
      units,
      groupRatio: timePricing.multiplier,
      evaluationContext: { evaluatedAt },
    });
    return result.costMicros;
  }

  // @deprecated 以下为旧计费逻辑，仅用于未迁移 pricingExpr 的规则
  const safeUnits = assertNonNegativeInteger(units, "units");
  const baseCost = rule.unitPriceMicros * safeUnits + (rule.unit === "image" && safeUnits > 0 ? additionalImageReferenceCost(rule.ruleConfig, referenceImageCount) : 0);
  const multiplier = (Number(rule.ruleConfig.multiplier ?? 1) || 1) * timePricing.multiplier;
  const adjustedCost = Math.round(baseCost * multiplier);
  const minimumMicros = Number(rule.ruleConfig.minimumMicros || 0);
  return Math.max(adjustedCost, Number.isFinite(minimumMicros) ? minimumMicros : 0);
}

/** Current retail quote, after all price components have been combined. */
export function calculatePricingCost(...args: Parameters<typeof calculateRawPricingCost>): number {
  const cost = calculateRawPricingCost(...args);
  return !args[0] || args[0].currency === "GU" ? ceilGuChargeMicros(cost) : cost;
}

export async function getBillingAccount(workspaceId: string, options: { autoCreate?: boolean; currency?: string } = {}): Promise<BillingAccount | null> {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  if (options.autoCreate === false) return await readAccount(db, normalizedWorkspaceId);
  return await ensureWorkspaceAccount(db, normalizedWorkspaceId, options.currency);
}

/**
 * Pure read of the amount a workspace can spend right now. Unlike the public
 * billing overview this helper never creates an account, expires grants or
 * performs a default-workspace allocation. Candidate preflights use it so a
 * quote cannot mutate the wallet it is supposed to inspect.
 */
async function workspaceWalletAvailable(client: BillingDb, wallet: AccountWallet, workspaceId: string,
  metadata?: Record<string, unknown>, summarizeAllWorkspaceGifts = false) {
  const available = accountWalletAvailable(wallet);
  const grants = await table(client, "o_account_gift_grant").where({ userId: wallet.userId, status: "active" })
    .where(builder => builder.whereNull("expiresAt").orWhere("expiresAt", ">", now()));
  available.giftAvailableMicros = grants.reduce((sum: number, grant: { metadata: unknown; remainingMicros: number | string; reservedMicros: number | string }) => {
    const giftMetadata = parseJsonObject(grant.metadata);
    const restriction = parseJsonObject(giftMetadata.membership);
    const applies = summarizeAllWorkspaceGifts && giftMetadata.membership
      ? restriction.workspaceId === workspaceId && restriction.tenantId === "FANJIN"
      : membershipGrantApplies(giftMetadata, { workspaceId, metadata });
    return sum + (applies ? Math.max(0, Number(grant.remainingMicros) - Number(grant.reservedMicros)) : 0);
  }, 0);
  available.totalAvailableMicros = available.cashAvailableMicros + available.giftAvailableMicros + available.creditAvailableMicros;
  return available;
}

export async function readWorkspaceAvailableMicros(
  workspaceId: string,
  client: BillingDb = db,
  metadata?: Record<string, unknown>,
): Promise<number | null> {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  const account = await readAccount(client, normalizedWorkspaceId);
  if (!account || account.status !== "active") return null;
  const ownerFunding = await workspaceOwnerFundingInfo(client, normalizedWorkspaceId);
  const ownerWallet = ownerFunding?.ownerUserId
    ? await readAccountWalletReadonly(client, ownerFunding.ownerUserId)
    : null;
  const ownerAvailable = ownerWallet ? await workspaceWalletAvailable(client, ownerWallet, normalizedWorkspaceId, metadata) : null;
  const workspaceRemainingMicros = Math.max(
    0,
    account.balanceMicros - account.frozenMicros,
  );
  const availableMicros = ownerAvailable
    ? Math.min(workspaceRemainingMicros, ownerAvailable.totalAvailableMicros)
    : workspaceRemainingMicros;
  return Number.isSafeInteger(availableMicros) && availableMicros >= 0
    ? availableMicros
    : null;
}

async function readWorkspaceBillingSummaryForAccount(
  account: BillingAccount,
  client: BillingDb,
): Promise<{
  account: BillingAccount;
  subscription: WorkspacePlanSubscription | null;
  plan: BillingPlan | null;
}> {
  const hasSubscriptionTable = await client.schema.hasTable("o_workspace_plan_subscription");
  const subscriptionRow = hasSubscriptionTable
    ? await table(client, "o_workspace_plan_subscription")
        .where({ workspaceId: account.workspaceId, status: "active" })
        .orderBy("createdAt", "desc")
        .first()
    : null;
  const subscription = subscriptionRow ? formatSubscription(subscriptionRow) : null;
  const planId = subscription?.planId ?? account.planId;
  const planRow = planId ? await table(client, "o_billing_plan").where({ id: planId }).first() : null;
  return {
    account,
    subscription,
    plan: planRow ? formatPlan(planRow) : null,
  };
}

/**
 * Project an already-persisted workspace billing summary. This function never
 * creates or repairs an account and therefore fails closed when the checkpoint
 * has no billing account for the requested workspace.
 */
export async function readWorkspaceBillingSummary(
  workspaceId: string,
  client: BillingDb = db,
): Promise<{
  account: BillingAccount;
  subscription: WorkspacePlanSubscription | null;
  plan: BillingPlan | null;
}> {
  const account = await readAccount(client, normalizeWorkspaceId(workspaceId));
  if (!account) {
    throw new BillingError("账单证据不完整，恢复候选不会自动创建账户", 503);
  }
  return readWorkspaceBillingSummaryForAccount(account, client);
}

export async function getWorkspaceBillingSummary(
  workspaceId: string,
  client: BillingDb = db,
): Promise<{
  account: BillingAccount;
  subscription: WorkspacePlanSubscription | null;
  plan: BillingPlan | null;
}> {
  if (isRecoveryOnlyMode()) {
    return readWorkspaceBillingSummary(workspaceId, client);
  }
  const account = await ensureWorkspaceAccount(client, workspaceId);
  return readWorkspaceBillingSummaryForAccount(account, client);
}

export async function rechargeWorkspace(input: MoneyOperationInput): Promise<BillingState> {
  return await db.transaction(async (trx) => applyRecharge(trx, input));
}

export async function setWorkspaceCreditLimit(input: SetWorkspaceCreditLimitInput): Promise<BillingState> {
  return await db.transaction(async (trx) => applySetCreditLimit(trx, input));
}

export async function freezeWorkspace(input: MoneyOperationInput): Promise<BillingState> {
  return await db.transaction(async (trx) => applyFreeze(trx, input));
}

export async function deductWorkspace(input: DeductWorkspaceInput): Promise<BillingState> {
  return await db.transaction(async (trx) => applyDeduct(trx, input));
}

export async function releaseWorkspace(input: ReleaseWorkspaceInput): Promise<BillingState> {
  return await db.transaction(async (trx) => applyRelease(trx, input));
}

export async function refundWorkspace(input: MoneyOperationInput & { originalLedgerId?: string | null }): Promise<BillingState> {
  return await db.transaction(async (trx) => applyRefund(trx, input));
}

export async function createUsageRecord(input: RecordUsageInput): Promise<UsageRecord> {
  return await db.transaction(async (trx) => recordUsage(trx, input));
}

type ApiKeyGuQuotaMutation = "reserve" | "charge";

async function applyApiKeyGuQuota(
  client: BillingDb,
  apiKeyId: string | null | undefined,
  amountMicros: number,
  mutation: ApiKeyGuQuotaMutation,
): Promise<void> {
  if (!apiKeyId || amountMicros <= 0) return;
  const key = await table(client, "o_api_key").where({ id: apiKeyId }).first();
  // Historic keys retain request-count quotas until an owner explicitly edits
  // them. New/edited keys are measured in the same GU micros as billing.
  if (!key || String(key.quotaUnit || "") !== API_KEY_QUOTA_UNIT_GU_MICROS) return;
  const targetColumn = mutation === "reserve" ? "quotaReserved" : "quotaUsed";
  const updated = await table(client, "o_api_key")
    .where({ id: apiKeyId, quotaUnit: API_KEY_QUOTA_UNIT_GU_MICROS, disabled: 0 })
    .where((builder: Knex.QueryBuilder) => {
      builder.whereNull("revokedAt").orWhere("revokedAt", 0);
    })
    .where((builder: Knex.QueryBuilder) => {
      builder
        .whereNull("quotaLimit")
        .orWhere("quotaLimit", "<=", 0)
        .orWhereRaw(
          "COALESCE(??, 0) + COALESCE(??, 0) + ? <= ??",
          ["quotaUsed", "quotaReserved", amountMicros, "quotaLimit"],
        );
    })
    .update({
      [targetColumn]: client.raw("COALESCE(??, 0) + ?", [targetColumn, amountMicros]),
      updateTime: now(),
    });
  if (Number(updated || 0) !== 1) throw new BillingError("API Key GU 额度不足", 402);
}

async function settleApiKeyGuQuota(
  client: BillingDb,
  apiKeyId: string | null | undefined,
  reservedMicros: number,
  consumedMicros: number,
): Promise<void> {
  if (!apiKeyId || reservedMicros <= 0) return;
  const key = await table(client, "o_api_key").where({ id: apiKeyId }).first();
  if (!key || String(key.quotaUnit || "") !== API_KEY_QUOTA_UNIT_GU_MICROS) return;
  const updated = await table(client, "o_api_key")
    .where({ id: apiKeyId, quotaUnit: API_KEY_QUOTA_UNIT_GU_MICROS })
    .whereRaw("COALESCE(??, 0) >= ?", ["quotaReserved", reservedMicros])
    .update({
      quotaReserved: client.raw("COALESCE(??, 0) - ?", ["quotaReserved", reservedMicros]),
      quotaUsed: client.raw("COALESCE(??, 0) + ?", ["quotaUsed", consumedMicros]),
      updateTime: now(),
    });
  if (Number(updated || 0) !== 1) throw new BillingError("API Key GU 预扣账实不一致", 409);
}

async function refundApiKeyGuQuota(
  client: BillingDb,
  apiKeyId: string | null | undefined,
  amountMicros: number,
): Promise<void> {
  if (!apiKeyId || amountMicros <= 0) return;
  const key = await table(client, "o_api_key").where({ id: apiKeyId }).first();
  if (!key || String(key.quotaUnit || "") !== API_KEY_QUOTA_UNIT_GU_MICROS) return;
  const updated = await table(client, "o_api_key")
    .where({ id: apiKeyId, quotaUnit: API_KEY_QUOTA_UNIT_GU_MICROS })
    .whereRaw("COALESCE(??, 0) >= ?", ["quotaUsed", amountMicros])
    .update({
      quotaUsed: client.raw("COALESCE(??, 0) - ?", ["quotaUsed", amountMicros]),
      updateTime: now(),
    });
  if (Number(updated || 0) !== 1) throw new BillingError("API Key GU 退款账实不一致", 409);
}

async function replayApiTaskAfterIdempotencyRace(
  input: ApiTaskChargeInput,
  attempts = 6,
): Promise<ApiTaskChargeResult | null> {
  if (!input.workspaceId || !input.idempotencyKey) return null;
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const chargeMode = input.chargeMode ?? "charge";
  const ledgerType: BillingLedgerType = chargeMode === "reserve" ? "freeze" : "deduct";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const ledger = await findIdempotentLedger(db, workspaceId, ledgerType, input.idempotencyKey);
      if (ledger) {
        const usageRow = ledger.usageRecordId
          ? await table(db, "o_usage_record").where({ id: ledger.usageRecordId }).first()
          : null;
        if (!usageRow) throw new BillingError("幂等流水关联的用量记录不存在", 500);
        const pricingRule = await resolvePricingRule(input);
        const units = assertNonNegativeInteger(input.units ?? 1, "units");
        return {
          usage: formatUsageRecord(usageRow),
          ledger,
          account: await ensureWorkspaceAccount(db, workspaceId, ledger.currency),
          pricingRule,
          costMicros: Number(usageRow.costMicros || 0),
          chargeMode,
          idempotent: true,
        };
      }
    } catch (error) {
      if (error instanceof BillingError) throw error;
      // The winning transaction may still hold a SQLite lock. A lookup is safe
      // to retry because no upstream request has been dispatched at this point.
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt));
    }
  }
  return null;
}

/**
 * REVAMP-PLAN 风险 #7 连接注入边界(勿改):billApiTask 及其后的
 * settleApiTaskReservation / releaseApiTaskReservation /
 * markApiTaskReservationDispatched / markApiTaskReservationPendingReconcile
 * 各自管理独立的原子计费事务(内部 db.transaction),架构上不能接受外部
 * 事务连接注入——计费预扣/结算/释放必须独立于调用方事务提交与留存:
 * 调用方(如 Agent Gateway)事务回滚时,预扣必须仍在账上等待核账,
 * 否则上游已计费而冻结流水消失,造成资损。纯读函数(resolvePricingRule /
 * resolveProviderSpecificPricingRule)已支持可选 client 注入。
 */
export async function billApiTask(input: ApiTaskChargeInput): Promise<ApiTaskChargeResult> {
  try {
    return await db.transaction(async (trx) => {
    const chargeMode = input.chargeMode ?? "charge";
    const units = assertNonNegativeInteger(input.units ?? 1, "units");
    const pricingRule = await resolvePricingRule(input, trx);
    const pricingEvaluatedAt = now();
    const calculatedCostMicros = calculateRawPricingCost(pricingRule, units, input.costMicros, undefined, pricingEvaluatedAt);
    const timePricing = pricingRule && input.costMicros == null
      ? resolveTimePricing(pricingRule.ruleConfig, pricingEvaluatedAt)
      : null;
    const currency = normalizeCurrency(input.currency || pricingRule?.currency);
    const workspaceId = input.workspaceId ? normalizeWorkspaceId(input.workspaceId) : null;
    const billable = chargeMode !== "none";
    const costMicros = billable && currency === "GU" ? ceilGuChargeMicros(calculatedCostMicros) : calculatedCostMicros;

    if (billable && !workspaceId) {
      throw new BillingError("计费任务必须提供 workspaceId", 402);
    }
    if (billable && !pricingRule && input.costMicros == null) {
      throw new BillingError("未配置该接口的定价规则", 402);
    }

    const existingLedger =
      workspaceId && input.idempotencyKey
        ? await findIdempotentLedger(trx, workspaceId, chargeMode === "reserve" ? "freeze" : "deduct", input.idempotencyKey)
        : null;
    if (existingLedger) {
      const ledger = existingLedger;
      const account = await ensureWorkspaceAccount(trx, ledger.workspaceId, ledger.currency);
      const usageRow = ledger.usageRecordId
        ? await table(trx, "o_usage_record").where({ id: ledger.usageRecordId }).first()
        : null;
      if (!usageRow) {
        throw new BillingError(
          `幂等命中但关联的 usage_record 不存在 (ledger=${ledger.id}, usageRecordId=${ledger.usageRecordId ?? "null"})`,
          500,
        );
      }
      return {
        usage: formatUsageRecord(usageRow),
        ledger,
        account,
        pricingRule,
        costMicros: Number(usageRow.costMicros || 0),
        chargeMode,
        idempotent: true,
      };
    }

    if (costMicros > 0 && chargeMode !== "none") {
      await applyApiKeyGuQuota(
        trx,
        input.apiKeyId,
        costMicros,
        chargeMode === "reserve" ? "reserve" : "charge",
      );
    }

    const usage = await recordUsage(trx, {
      taskId: input.taskId,
      apiKeyId: input.apiKeyId,
      workspaceId,
      provider: input.provider ?? null,
      channelId: input.channelId ?? null,
      endpointType: input.endpointType,
      model: input.model ?? null,
      units,
      unit: input.unit || pricingRule?.unit || "task",
      costMicros,
      currency,
      status: costMicros === 0 || chargeMode === "none" ? "free" : chargeMode === "reserve" ? "reserved" : "charged",
    });

    if (costMicros === 0 || chargeMode === "none") {
      return {
        usage,
        ledger: null,
        account: workspaceId ? await ensureWorkspaceAccount(trx, workspaceId, currency) : null,
        pricingRule,
        costMicros,
        chargeMode,
        idempotent: false,
      };
    }

    const operationInput = {
      workspaceId: workspaceId || "",
      amountMicros: costMicros,
      currency,
      description: input.description ?? `API task ${input.endpointType}`,
      metadata: {
        ...(timePricing?.configured ? { timePricing } : {}),
        ...(input.metadata || {}),
        model: input.model ?? null,
        ...(currency === "GU" ? { guChargeRounding: guChargeRoundingVersion, calculatedCostMicros, roundingAdjustmentMicros: costMicros - calculatedCostMicros } : {}),
        endpointType: input.endpointType,
        pricingRuleId: pricingRule?.id ?? null,
        channelId: input.channelId ?? null,
        membershipFunding: await resolveMembershipFunding(trx, { model: input.model, endpointType: input.endpointType,
          channelId: input.channelId, pricingRuleId: pricingRule?.id, effectiveRuleConfig: pricingRule?.ruleConfig, resolution: input.metadata?.membershipResolution }),
      },
      idempotencyKey: input.idempotencyKey,
      operatorUserId: input.operatorUserId,
      usageRecordId: usage.id,
      taskId: input.taskId,
      apiKeyId: input.apiKeyId,
      requestId: input.requestId,
    };
    const state =
      chargeMode === "reserve"
        ? await applyFreeze(trx, operationInput)
        : await applyDeduct(trx, operationInput);

    // Synchronous images have no durable Relay queue. Reserve their execution
    // slot atomically with GU: a full workspace rolls both back, leaving the
    // original idempotency key available for the same command's safe retry.
    if (chargeMode === "reserve" && input.endpointType === "image_generation" && state.ledger) {
      await acquireWorkspaceGeneration(trx, { workspaceId: workspaceId!, id: state.ledger.id, endpointType: input.endpointType });
      if (input.idempotencyKey) await releaseWorkspaceGeneration(trx,
        `image-queue:${createHash("sha256").update(JSON.stringify([workspaceId, input.idempotencyKey])).digest("hex")}`, "not_dispatched");
    }

    if (input.taskId) {
      const relayPatch =
        chargeMode === "reserve"
          ? { quotaReserved: costMicros, updateTime: now() }
          : { costMicros, updateTime: now() };
      await table(trx, "o_relay_task").where({ id: input.taskId }).update(relayPatch);
    }

    return {
      usage,
      ledger: state.ledger,
      account: state.account,
      pricingRule,
      costMicros,
      chargeMode,
      idempotent: false,
    };
    });
  } catch (error) {
    if (error instanceof WorkspaceGenerationQueued && input.workspaceId && input.idempotencyKey) {
      await recordWorkspaceGenerationQueue(db, { workspaceId: input.workspaceId, endpointType: input.endpointType,
        id: `image-queue:${createHash("sha256").update(JSON.stringify([input.workspaceId, input.idempotencyKey])).digest("hex")}` });
      throw error;
    }
    const replay = await replayApiTaskAfterIdempotencyRace(input);
    if (replay) return replay;
    throw error;
  }
}

function usageForReservation(client: BillingDb, reservation: BillingLedger) {
  if (!reservation.usageRecordId) throw new BillingError("冻结流水未关联用量记录", 500);
  return table(client, "o_usage_record").where({ id: reservation.usageRecordId }).first();
}

async function assertApiTaskBillingMutationFence(
  client: BillingDb,
  workspaceId: string,
  fence?: ApiTaskBillingMutationFence,
): Promise<void> {
  if (!fence) return;
  if (fence.kind === "relay_video_operation/v1") {
    if (
      fence.workspaceId !== workspaceId
      || !fence.taskId
      || !fence.leaseOwner
      || !Number.isSafeInteger(fence.leaseExpiresAt)
      || fence.leaseExpiresAt <= now()
    ) {
      throw new BillingError("Relay 视频计费写入 lease/fence 无效", 409);
    }
    const relayTaskQuery = table(client, "o_relay_task")
      .where({
        id: fence.taskId,
        workspaceId,
        leaseOwner: fence.leaseOwner,
        leaseExpiresAt: fence.leaseExpiresAt,
      })
      .whereIn("status", ["queued", "running", "enhancing"])
      .andWhere("leaseExpiresAt", ">", now());
    if (isPostgresClient(client)) relayTaskQuery.forUpdate();
    const relayTask = await relayTaskQuery.first();
    if (!relayTask) throw new BillingError("Relay 视频计费写入 fence 已失效或被其他 worker 取代", 409);
    return;
  }
  if (
    fence.kind !== "user_video_enhance_operation/v1"
    || fence.workspaceId !== workspaceId
    || !fence.taskId
  ) {
    throw new BillingError("计费终态写入 fence 无效", 409);
  }
  if (fence.phase === "finalize") {
    if (
      !fence.owner
      || !Number.isSafeInteger(fence.fence)
      || fence.fence <= 0
      || !Number.isSafeInteger(fence.leaseExpiresAt)
      || fence.leaseExpiresAt <= now()
    ) {
      throw new BillingError("视频增强终结 DB claim/fence 无效", 409);
    }
    const taskQuery = table(client, "o_user_video_enhance_task")
      .where({
        id: fence.taskId,
        workspaceId,
        kind: "user_video_enhance",
        status: "reconciling",
        finalizationLeaseOwner: fence.owner,
        finalizationFence: fence.fence,
        finalizationLeaseExpiresAt: fence.leaseExpiresAt,
      })
      .andWhere("finalizationLeaseExpiresAt", ">", now());
    if (isPostgresClient(client)) taskQuery.forUpdate();
    const task = await taskQuery.first();
    if (!task) {
      throw new BillingError(
        "视频增强终结 DB claim/fence 已失效或被其他 worker 取代",
        409,
      );
    }
    return;
  }
  if (!fence.marker.startsWith("INTERNAL_USER_VIDEO_ENHANCE_DISPATCH|")) {
    throw new BillingError("计费终态写入 fence 阶段不匹配", 409);
  }
  const parts = fence.marker
    .slice("INTERNAL_USER_VIDEO_ENHANCE_DISPATCH|".length)
    .split("|");
  const expiresRaw = parts[0];
  const leaseExpiresAt = Number(expiresRaw);
  if (
    parts.length !== 2
    || !Number.isSafeInteger(leaseExpiresAt)
    || leaseExpiresAt <= now()
  ) {
    throw new BillingError("计费终态写入 lease 已失效", 409);
  }
  const taskQuery = table(client, "o_user_video_enhance_task").where({
    id: fence.taskId,
    workspaceId,
    kind: "user_video_enhance",
    status: "enhancing",
    errorMessage: fence.marker,
  });
  if (isPostgresClient(client)) taskQuery.forUpdate();
  const task = await taskQuery.first();
  if (!task) throw new BillingError("计费终态写入 fence 已被其他 worker 取代", 409);
}

async function resolveDispatchWatchdog(
  client: BillingDb,
  reservationId: string,
  decision: "reservation_settled" | "reservation_released",
): Promise<void> {
  const timestamp = now();
  await table(client, "o_billing_reconcile_job")
    .where({
      dedupeKey: `reservation:${reservationId}`,
    })
    .whereIn("status", ["pending", "manual_required"])
    .whereIn("reason", ["dispatch_watchdog", "dispatch_watchdog_expired"])
    .update({
      status: "resolved",
      decision,
      lastError: null,
      resolvedAt: timestamp,
      updateTime: timestamp,
    });
}

async function updateReservationUsage(
  client: BillingDb,
  reservation: BillingLedger,
  input: {
    units: number;
    unit: string;
    costMicros: number;
    status: string;
    provider?: RelayProvider | string | null;
    channelId?: string | null;
  },
): Promise<UsageRecord> {
  const usageRow = await usageForReservation(client, reservation);
  if (!usageRow) throw new BillingError("冻结流水关联的用量记录不存在", 500);
  await table(client, "o_usage_record")
    .where({ id: usageRow.id })
    .update({
      units: assertNonNegativeInteger(input.units, "units"),
      unit: input.unit,
      costMicros: assertNonNegativeInteger(input.costMicros, "costMicros"),
      status: input.status,
      provider: input.provider ?? usageRow.provider ?? null,
      channelId: input.channelId ?? usageRow.channelId ?? null,
    });
  const updated = await table(client, "o_usage_record").where({ id: usageRow.id }).first();
  if (!updated) throw new BillingError("用量记录更新失败", 500);
  return formatUsageRecord(updated);
}

/**
 * Capture the actual cost from a pre-authorized API reservation and release
 * the unused difference in one transaction. The reservation is a hard ceiling
 * by default. Internal token-metered callers may explicitly authorize an
 * overage, which is charged atomically from the remaining available balance.
 */
export async function settleApiTaskReservation(
  input: ApiTaskReservationSettlementInput,
): Promise<ApiTaskReservationSettlementResult> {
  return await db.transaction(async (trx) => {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    await assertApiTaskBillingMutationFence(trx, workspaceId, input.mutationFence);
    const calculatedCostMicros = assertNonNegativeInteger(input.actualCostMicros, "actualCostMicros");
    const units = assertNonNegativeInteger(input.units, "units");
    const reservation = await readLedger(trx, input.reservationId, workspaceId);
    if (!reservation || reservation.type !== "freeze") throw new BillingError("冻结流水不存在", 404);
    const actualCostMicros = applyGuChargeRounding(calculatedCostMicros, reservation.metadata);
    if (reservation.metadata?.customerSettlementFinal === VIDEO_RESERVATION_EXPIRY_POLICY) {
      throw new BillingError("该任务预占已按 24 小时退款规则释放，禁止再次向用户扣款", 409);
    }
    const settlementMetadata = {
      ...(input.metadata || {}),
      guChargeRounding: reservation.metadata?.guChargeRounding ?? null,
      ...(reservation.metadata?.guChargeRounding ? {
        calculatedCostMicros,
        roundingAdjustmentMicros: actualCostMicros - calculatedCostMicros,
      } : {}),
    };
    if (input.requestId && reservation.requestId && input.requestId !== reservation.requestId) {
      throw new BillingError("结算 requestId 与原始冻结不匹配", 409);
    }
    const reservedRequestHash = String(reservation.metadata?.requestHash || "");
    const settlementRequestHash = String(input.metadata?.requestHash || "");
    if (reservedRequestHash && settlementRequestHash && reservedRequestHash !== settlementRequestHash) {
      throw new BillingError("结算请求摘要与原始冻结不匹配", 409);
    }
    const dispatchedProvider = String(reservation.metadata?.dispatchProvider || "");
    if (dispatchedProvider && input.provider && dispatchedProvider !== input.provider) {
      throw new BillingError("结算供应商与已发出的上游请求不匹配", 409);
    }
    const dispatchedChannelId = String(reservation.metadata?.dispatchChannelId || "");
    if (dispatchedChannelId && input.channelId && dispatchedChannelId !== input.channelId) {
      throw new BillingError("结算通道与已发出的上游请求不匹配", 409);
    }
    const settlementUnit = input.unit || "token";
    const overageAuthorized = input.allowOverage === true
      && reservationAllowsSettlementOverage(reservation.metadata, settlementUnit);
    if (actualCostMicros > reservation.amountMicros && !overageAuthorized) {
      throw new BillingError("实际费用超过预扣额度，已转入待核账状态", 500);
    }

    const captureKey = `${input.idempotencyKey}:capture`;
    const releaseKey = `${input.idempotencyKey}:release`;
    const overageKey = `${input.idempotencyKey}:overage`;
    const existingCapture = await findIdempotentLedger(trx, workspaceId, "deduct", captureKey);
    const existingRelease = await findIdempotentLedger(trx, workspaceId, "release", releaseKey);
    const existingOverage = await findIdempotentLedger(trx, workspaceId, "deduct", overageKey);
    if (reservation.remainingMicros === 0) {
      const expectedRelease = actualCostMicros < reservation.amountMicros;
      const expectedCapture = Math.min(actualCostMicros, reservation.amountMicros) > 0;
      const expectedOverage = actualCostMicros > reservation.amountMicros;
      if (
        (expectedCapture && !existingCapture)
        || (expectedRelease && !existingRelease)
        || (expectedOverage && !existingOverage)
      ) {
        throw new BillingError("冻结已由不同的结算幂等键处理", 409);
      }
      const usageRow = await usageForReservation(trx, reservation);
      if (!usageRow) throw new BillingError("冻结流水关联的用量记录不存在", 500);
      const usage = formatUsageRecord(usageRow);
      if (
        usage.costMicros !== actualCostMicros ||
        usage.units !== units ||
        usage.unit !== (input.unit || "token") ||
        !["charged", "free"].includes(usage.status) ||
        (input.provider && usage.provider && usage.provider !== input.provider) ||
        (input.channelId && usage.channelId && usage.channelId !== input.channelId)
      ) {
        throw new BillingError("同一计费幂等键对应的实际用量不一致", 409);
      }
      const account = await ensureWorkspaceAccount(trx, workspaceId, reservation.currency);
      const result: ApiTaskReservationSettlementResult = {
        usage,
        reservation,
        captureLedger: existingCapture,
        releaseLedger: existingRelease,
        overageLedger: existingOverage,
        account,
        idempotent: true,
      };
      await input.trustedBeforeCommit?.(trx, result);
      return result;
    }
    if (reservation.remainingMicros !== reservation.amountMicros) {
      throw new BillingError("冻结流水已被部分处理，需人工核账", 409);
    }

    const usage = await updateReservationUsage(trx, reservation, {
      units,
      unit: input.unit || "token",
      costMicros: actualCostMicros,
      status: actualCostMicros > 0 ? "charged" : "free",
      provider: input.provider,
      channelId: input.channelId,
    });

    const capturedMicros = Math.min(actualCostMicros, reservation.amountMicros);
    const overageMicros = Math.max(0, actualCostMicros - reservation.amountMicros);
    let captureState: BillingState | null = null;
    if (capturedMicros > 0) {
      captureState = await applyDeduct(trx, {
        workspaceId,
        reservationId: reservation.id,
        amountMicros: capturedMicros,
        usageRecordId: usage.id,
        apiKeyId: reservation.apiKeyId,
        requestId: input.requestId ?? reservation.requestId,
        description: input.description || "API 实际用量结算",
        idempotencyKey: captureKey,
        metadata: settlementMetadata,
        operatorUserId: input.operatorUserId,
      });
    }

    let overageState: BillingState | null = null;
    if (overageMicros > 0) {
      overageState = await applyDeduct(trx, {
        workspaceId,
        amountMicros: overageMicros,
        usageRecordId: usage.id,
        apiKeyId: reservation.apiKeyId,
        taskId: reservation.taskId,
        requestId: input.requestId ?? reservation.requestId,
        description: `${input.description || "API 实际用量结算"}（超出预扣部分）`,
        idempotencyKey: overageKey,
        metadata: { ...settlementMetadata, overageMicros },
        operatorUserId: input.operatorUserId,
      });
      await applyApiKeyGuQuota(trx, reservation.apiKeyId, overageMicros, "charge");
    }

    const afterCapture = await readLedger(trx, reservation.id, workspaceId);
    if (!afterCapture) throw new BillingError("冻结流水不存在", 404);
    let releaseState: BillingState | null = null;
    if (afterCapture.remainingMicros > 0) {
      releaseState = await applyRelease(trx, {
        workspaceId,
        reservationId: reservation.id,
        amountMicros: afterCapture.remainingMicros,
        usageRecordId: usage.id,
        apiKeyId: reservation.apiKeyId,
        requestId: input.requestId ?? reservation.requestId,
        description: "释放 API 预扣差额",
        idempotencyKey: releaseKey,
        metadata: input.metadata,
        operatorUserId: input.operatorUserId,
      });
    }

    await settleApiKeyGuQuota(
      trx,
      reservation.apiKeyId,
      reservation.amountMicros,
      capturedMicros,
    );

    const settledReservation = await readLedger(trx, reservation.id, workspaceId);
    if (!settledReservation || settledReservation.remainingMicros !== 0) {
      throw new BillingError("API 预扣结算未完成", 500);
    }
    await resolveDispatchWatchdog(trx, reservation.id, "reservation_settled");
    await releaseWorkspaceGeneration(trx, reservation.id, "settled");
    const account = releaseState?.account
      || overageState?.account
      || captureState?.account
      || (await ensureWorkspaceAccount(trx, workspaceId));
    const result: ApiTaskReservationSettlementResult = {
      usage,
      reservation: settledReservation,
      captureLedger: captureState?.ledger || null,
      releaseLedger: releaseState?.ledger || null,
      overageLedger: overageState?.ledger || null,
      account,
      idempotent: false,
    };
    await input.trustedBeforeCommit?.(trx, result);
    return result;
  });
}

const VIDEO_SUBMIT_HTTP_400_PLAIN_PARSE_ERROR =
  "Error when parsing request";
const VIDEO_SUBMIT_HTTP_400_REQUEST_MIN_BYTES = 15_000_000;
const VIDEO_SUBMIT_HTTP_400_REQUEST_MAX_BYTES = 16_000_000;

/**
 * A one-shot, caller-held expectation fence for the isolated video HTTP-400
 * incident. The ordinary admin reconciliation API never accepts this object.
 * The billing transaction re-derives every value from the current database
 * rows before releasing money, closing the preflight-to-mutation TOCTOU gap.
 */
export type VideoSubmitHttp400PlatformAbsorptionFence = {
  contractVersion:
    "video-submit-http400-platform-absorption-fence.v1";
  jobId: string;
  reservationId: string;
  usageRecordId: string;
  taskId: string;
  requestId: string;
  providerRequestStableJsonSha256: string;
  providerRequestUtf8Bytes: number;
  usageUnits: number;
  reservationAmountMicros: number;
  /**
   * SHA-256 of the in-memory candidate bearer token. It is used only for a
   * transaction-local authority lookup and is never persisted in ledger or
   * reconciliation evidence.
   */
  operatorSessionTokenHash: string;
};

function exactJsonKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function videoSubmitHttp400ProviderRequestProof(
  rawRequest: unknown,
  expectedModel: string,
): Record<string, unknown> {
  const request = parseJsonObject(rawRequest);
  const content = Array.isArray(request.content) ? request.content : [];
  const canonicalRequest = canonicalJson(request);
  const utf8Bytes = Buffer.byteLength(canonicalRequest, "utf8");
  const stableJsonSha256 = createHash("sha256")
    .update(canonicalRequest, "utf8")
    .digest("hex");
  const expectedImageRoles = [
    "subject",
    "style",
    "storyboard",
    "subject",
    "style",
    "storyboard",
    "subject",
  ];
  const expectedVideoRoles = ["subject", "style"];
  let textUtf8Bytes = 0;
  let imageDataUrlUtf8Bytes = 0;
  let httpsVideoUrlUtf8Bytes = 0;
  const textItem = parseJsonObject(content[0]);
  const text = String(textItem.text || "");
  if (
    !exactJsonKeys(
      request,
      [
        "content",
        "duration",
        "generate_audio",
        "model",
        "ratio",
        "resolution",
        "watermark",
      ],
    )
    || request.duration !== 5
    || request.generate_audio !== true
    || String(request.model || "") !== expectedModel
    || String(request.ratio || "") !== "9:16"
    || String(request.resolution || "") !== "720p"
    || request.watermark !== false
    || content.length !== 10
    || !exactJsonKeys(textItem, ["text", "type"])
    || String(textItem.type || "") !== "text"
    || !text
  ) {
    throw new BillingError(
      "视频提交 HTTP 400 的供应商请求结构与事故凭证不一致",
      409,
    );
  }
  textUtf8Bytes = Buffer.byteLength(text, "utf8");
  if (textUtf8Bytes <= 0 || textUtf8Bytes > 4_096) {
    throw new BillingError(
      "视频提交 HTTP 400 的文本内容计数无效",
      409,
    );
  }

  for (let index = 0; index < expectedImageRoles.length; index += 1) {
    const item = parseJsonObject(content[index + 1]);
    const imageUrl = parseJsonObject(item.image_url);
    const url = String(imageUrl.url || "");
    if (
      !exactJsonKeys(
        item,
        ["image_url", "reference_role", "role", "type"],
      )
      || !exactJsonKeys(imageUrl, ["url"])
      || String(item.type || "") !== "image_url"
      || String(item.role || "") !== "reference_image"
      || String(item.reference_role || "") !== expectedImageRoles[index]
      || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)
    ) {
      throw new BillingError(
        "视频提交 HTTP 400 的图片参考内容结构无效",
        409,
      );
    }
    imageDataUrlUtf8Bytes += Buffer.byteLength(url, "utf8");
  }

  for (let index = 0; index < expectedVideoRoles.length; index += 1) {
    const item = parseJsonObject(
      content[1 + expectedImageRoles.length + index],
    );
    const videoUrl = parseJsonObject(item.video_url);
    const url = String(videoUrl.url || "");
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new BillingError(
        "视频提交 HTTP 400 的视频参考 URL 无效",
        409,
      );
    }
    if (
      !exactJsonKeys(
        item,
        ["reference_role", "role", "type", "video_url"],
      )
      || !exactJsonKeys(videoUrl, ["url"])
      || String(item.type || "") !== "video_url"
      || String(item.role || "") !== "reference_video"
      || String(item.reference_role || "") !== expectedVideoRoles[index]
      || parsedUrl.protocol !== "https:"
      || !parsedUrl.hostname
      || parsedUrl.username
      || parsedUrl.password
      || parsedUrl.hash
    ) {
      throw new BillingError(
        "视频提交 HTTP 400 的视频参考内容结构无效",
        409,
      );
    }
    httpsVideoUrlUtf8Bytes += Buffer.byteLength(url, "utf8");
  }

  if (
    utf8Bytes < VIDEO_SUBMIT_HTTP_400_REQUEST_MIN_BYTES
    || utf8Bytes > VIDEO_SUBMIT_HTTP_400_REQUEST_MAX_BYTES
    || imageDataUrlUtf8Bytes < 14_000_000
    || httpsVideoUrlUtf8Bytes <= 0
  ) {
    throw new BillingError(
      "视频提交 HTTP 400 的供应商请求字节计数与事故凭证不一致",
      409,
    );
  }
  return {
    contractVersion: "video-provider-request-proof.v1",
    stableJsonSha256,
    utf8Bytes,
    contentItems: 10,
    textItems: 1,
    imageDataUrlItems: 7,
    httpsVideoUrlItems: 2,
    textUtf8Bytes,
    imageDataUrlUtf8Bytes,
    httpsVideoUrlUtf8Bytes,
    referenceRoleCounts: {
      subject: 4,
      style: 3,
      storyboard: 2,
    },
  };
}

function hasExactVideoSubmitHttp400NoDeliveryResult(
  resultPayload: Record<string, unknown>,
): boolean {
  const internal = parseJsonObject(resultPayload.internal);
  return Boolean(
    exactJsonKeys(resultPayload, ["internal", "message"])
    && String(resultPayload.message || "") === "Bad Request"
    && exactJsonKeys(
      internal,
      [
        "finalResolution",
        "generationResolution",
        "needsTargetProcessing",
        "pipeline",
        "requestedResolution",
      ],
    )
    && String(internal.requestedResolution || "") === "720p"
    && String(internal.generationResolution || "") === "720p"
    && String(internal.finalResolution || "") === "720p"
    && internal.needsTargetProcessing === false
    && String(internal.pipeline || "") === "direct_generation"
  );
}

async function buildVideoSubmitHttp400PlatformAbsorption(input: {
  client: BillingDb;
  workspaceId: string;
  reservation: BillingLedger;
  usage: UsageRecord;
  requestId?: string | null;
  provider?: RelayProvider | string | null;
  channelId?: string | null;
  metadata?: Record<string, unknown>;
  operatorUserId?: number | null;
  incidentFence?: VideoSubmitHttp400PlatformAbsorptionFence;
}): Promise<Record<string, unknown>> {
  const {
    client,
    workspaceId,
    reservation,
    usage,
  } = input;
  const reservationMetadata = reservation.metadata || {};
  const taskId = String(reservation.taskId || "").trim();
  const requestId = String(reservation.requestId || "").trim();
  const provider = String(usage.provider || "").trim();
  const channelId = String(usage.channelId || "").trim();
  const reconcileJobId = String(
    reservationMetadata.reconcileJobId || "",
  ).trim();
  const operatorUserId = Number(input.operatorUserId);
  const actualUnits = Number(reservationMetadata.actualUnits);
  const actualCostMicros = Number(reservationMetadata.actualCostMicros);
  const httpStatus = Number(reservationMetadata.httpStatus);
  const suppliedRequestId = String(input.requestId || "").trim();
  const suppliedProvider = String(input.provider || "").trim();
  const suppliedChannelId = String(input.channelId || "").trim();
  const resolutionMetadata = input.metadata || {};
  const incidentFence = input.incidentFence;
  if (
    !incidentFence
    || incidentFence.contractVersion
      !== "video-submit-http400-platform-absorption-fence.v1"
    || incidentFence.reservationId !== reservation.id
    || incidentFence.usageRecordId !== usage.id
    || incidentFence.taskId !== taskId
    || incidentFence.requestId !== requestId
    || !/^[a-f0-9]{64}$/u.test(
      incidentFence.providerRequestStableJsonSha256,
    )
    || !Number.isSafeInteger(incidentFence.providerRequestUtf8Bytes)
    || incidentFence.providerRequestUtf8Bytes
      < VIDEO_SUBMIT_HTTP_400_REQUEST_MIN_BYTES
    || incidentFence.providerRequestUtf8Bytes
      > VIDEO_SUBMIT_HTTP_400_REQUEST_MAX_BYTES
    || !Number.isSafeInteger(incidentFence.usageUnits)
    || incidentFence.usageUnits <= 0
    || !Number.isSafeInteger(incidentFence.reservationAmountMicros)
    || incidentFence.reservationAmountMicros <= 0
    || !/^[a-f0-9]{64}$/u.test(
      incidentFence.operatorSessionTokenHash,
    )
    || incidentFence.usageUnits !== usage.units
    || incidentFence.reservationAmountMicros !== reservation.amountMicros
    || !Number.isSafeInteger(operatorUserId)
    || operatorUserId <= 0
    || usage.endpointType !== "video_generation"
    || usage.status !== "pending_reconcile"
    || usage.unit !== "token"
    || !Number.isSafeInteger(usage.units)
    || usage.units <= 0
    || usage.costMicros !== reservation.amountMicros
    || reservation.amountMicros <= 0
    || reservation.remainingMicros !== reservation.amountMicros
    || String(reservationMetadata.billingLifecycleState || "")
      !== "pending_reconcile"
    || String(reservationMetadata.reconcileReason || "")
      !== "submit_http_400"
    || httpStatus !== 400
    || reservationMetadata.settlementEvidenceComplete !== false
    || !Number.isSafeInteger(actualUnits)
    || actualUnits !== usage.units
    || !Number.isSafeInteger(actualCostMicros)
    || actualCostMicros !== reservation.amountMicros
    || String(reservationMetadata.settlementUnit || "") !== usage.unit
    || !taskId
    || usage.taskId !== taskId
    || !requestId
    || !provider
    || !channelId
    || Boolean(suppliedRequestId && suppliedRequestId !== requestId)
    || Boolean(suppliedProvider && suppliedProvider !== provider)
    || Boolean(suppliedChannelId && suppliedChannelId !== channelId)
    || String(reservationMetadata.dispatchRequestId || "") !== requestId
    || String(reservationMetadata.dispatchProvider || "") !== provider
    || String(reservationMetadata.dispatchChannelId || "") !== channelId
    || String(resolutionMetadata.source || "")
      !== "manual-billing-reconciliation"
    || String(resolutionMetadata.reconcileJobId || "") !== reconcileJobId
    || !reconcileJobId
  ) {
    throw new BillingError(
      "平台承担释放仅适用于完整冻结、无客户交付的视频提交 HTTP 400 事故",
      409,
    );
  }

  const [
    task,
    job,
    relatedSettlements,
    mediaAssets,
    callbackDeliveries,
    operatorAuthority,
  ] = await Promise.all([
    table(input.client, "o_relay_task")
      .where({
        id: taskId,
        workspaceId,
        endpointType: "video_generation",
      })
      .first(),
    table(input.client, "o_billing_reconcile_job")
      .where({
        id: reconcileJobId,
        workspaceId,
        reservationId: reservation.id,
        usageRecordId: usage.id,
        requestId,
        endpointType: "video_generation",
      })
      .first(),
    table(input.client, "o_billing_ledger")
      .where({
        workspaceId,
        relatedLedgerId: reservation.id,
      })
      .whereIn("type", ["deduct", "release"]),
    table(input.client, "o_media_asset")
      .where({ workspaceId, taskId }),
    table(input.client, "o_relay_callback_delivery")
      .where({ taskId }),
    table(input.client, "o_user_session as operator_session")
      .innerJoin(
        "o_user as operator_user",
        "operator_user.id",
        "operator_session.userId",
      )
      .innerJoin(
        "o_workspace_member as operator_member",
        function joinOperatorMember(this: Knex.JoinClause) {
          this.on(
            "operator_member.userId",
            "=",
            "operator_session.userId",
          ).andOn(
            "operator_member.workspaceId",
            "=",
            "operator_session.workspaceId",
          );
        },
      )
      .innerJoin(
        "o_workspace as operator_workspace",
        "operator_workspace.id",
        "operator_session.workspaceId",
      )
      .where({
        "operator_session.tokenHash":
          incidentFence.operatorSessionTokenHash,
        "operator_session.userId": operatorUserId,
        "operator_session.workspaceId": workspaceId,
        "operator_user.status": "active",
        "operator_member.status": "active",
        "operator_workspace.status": "active",
      })
      .whereNull("operator_session.revokedAt")
      .where("operator_session.expiresAt", ">", now())
      .select(
        "operator_session.userId",
        "operator_user.role as userRole",
        "operator_member.role as memberRole",
        "operator_workspace.ownerUserId as workspaceOwnerUserId",
      )
      .first(),
  ]);
  const providerPayload = parseJsonObject(task?.providerPayload);
  const providerBilling = parseJsonObject(providerPayload.billing);
  const providerIdentity = parseJsonObject(providerPayload.identity);
  const submission = parseJsonObject(providerPayload.submission);
  const response = parseJsonObject(providerPayload.response);
  const resultPayload = parseJsonObject(task?.resultPayload);
  const jobEvidence = parseJsonObject(job?.evidence);
  const submissionKeys = Object.keys(submission).sort().join(",");
  let workerExecutionValid = true;
  if (submission.workerExecution !== undefined) {
    try {
      assertRelayWorkerExecutionAttestation(submission.workerExecution);
    } catch {
      workerExecutionValid = false;
    }
  }
  const providerPayloadKeys = Object.keys(providerPayload).sort().join(",");
  const responseKeys = Object.keys(response).sort().join(",");
  const leaseOwner = String(job?.leaseOwner || "");
  const operatorHasAuthority = Boolean(
    operatorAuthority
    && Number(operatorAuthority.userId) === operatorUserId
    && (
      ["root", "admin", "super_admin"].includes(
        String(operatorAuthority.userRole || ""),
      )
      || (
        Number(operatorAuthority.workspaceOwnerUserId) === operatorUserId
        && String(operatorAuthority.memberRole || "") === "owner"
      )
    ),
  );
  if (
    !task
    || String(task.requestId || "") !== requestId
    || String(task.provider || "") !== provider
    || String(task.channelId || "") !== channelId
    || String(task.model || "") !== String(usage.model || "")
    || String(task.status || "") !== "failed"
    || String(task.errorMessage || "") !== "Bad Request"
    || task.providerTaskId != null
    || Number(task.costMicros || 0) !== 0
    || Number(task.quotaReserved || 0) !== reservation.amountMicros
    || Number(task.apiQuotaReserved || 0) !== 0
    || Number(task.attemptCount || 0) !== 1
    || task.submittedAt == null
    || task.completedAt == null
    || task.leaseOwner != null
    || task.leaseExpiresAt != null
    || !hasExactVideoSubmitHttp400NoDeliveryResult(resultPayload)
    || providerPayloadKeys !== "billing,identity,request,response,submission"
    || !workerExecutionValid
    || ![
      "dispatchStartedAt,reconcileReason,retryAllowed,state,uncertainAt",
      "dispatchStartedAt,reconcileReason,retryAllowed,state,uncertainAt,workerExecution",
    ].includes(submissionKeys)
    || String(submission.state || "") !== "pending_reconcile"
    || String(submission.reconcileReason || "") !== "submit_http_400"
    || submission.retryAllowed !== false
    || !Number.isSafeInteger(Number(submission.dispatchStartedAt))
    || Number(submission.dispatchStartedAt) <= 0
    || !Number.isSafeInteger(Number(submission.uncertainAt))
    || Number(submission.uncertainAt) < Number(submission.dispatchStartedAt)
    || responseKeys !== "raw"
    || String(response.raw || "") !== VIDEO_SUBMIT_HTTP_400_PLAIN_PARSE_ERROR
    || String(providerBilling.reservationId || "") !== reservation.id
    || String(providerBilling.usageRecordId || "") !== usage.id
    || String(providerIdentity.workspaceId || "") !== workspaceId
    || !job
    || incidentFence.jobId !== String(job.id || "")
    || String(job.status || "") !== "leased"
    || String(job.reason || "") !== "submit_http_400"
    || String(job.decision || "")
      !== "insufficient_authoritative_evidence"
    || !leaseOwner.startsWith("manual-billing-reconcile-")
    || !Number.isSafeInteger(Number(job.leaseExpiresAt))
    || Number(job.leaseExpiresAt) <= now()
    || String(job.provider || "") !== provider
    || String(job.channelId || "") !== channelId
    || String(jobEvidence.reconcileJobId || "") !== reconcileJobId
    || String(jobEvidence.taskId || "") !== taskId
    || String(jobEvidence.requestId || "") !== requestId
    || String(jobEvidence.reconcileReason || "") !== "submit_http_400"
    || String(jobEvidence.billingLifecycleState || "")
      !== "pending_reconcile"
    || Number(jobEvidence.httpStatus) !== 400
    || jobEvidence.settlementEvidenceComplete !== false
    || Number(jobEvidence.actualUnits) !== usage.units
    || Number(jobEvidence.actualCostMicros) !== reservation.amountMicros
    || String(jobEvidence.settlementUnit || "") !== usage.unit
    || relatedSettlements.length !== 0
    || mediaAssets.length !== 0
    || callbackDeliveries.length !== 0
    || !operatorHasAuthority
  ) {
    throw new BillingError(
      "平台承担释放缺少视频提交 HTTP 400、无上游任务且无交付的完整证明",
      409,
    );
  }

  const providerRequestProof = videoSubmitHttp400ProviderRequestProof(
    providerPayload.request,
    String(task.model || ""),
  );
  if (
    providerRequestProof.stableJsonSha256
      !== incidentFence.providerRequestStableJsonSha256
    || providerRequestProof.utf8Bytes
      !== incidentFence.providerRequestUtf8Bytes
  ) {
    throw new BillingError(
      "视频提交 HTTP 400 的事务内请求证明与一次性事故围栏不一致",
      409,
    );
  }
  const reservedUnitPriceMicros =
    reservation.amountMicros / usage.units;
  if (!Number.isSafeInteger(reservedUnitPriceMicros)) {
    throw new BillingError(
      "视频提交 HTTP 400 冻结金额无法形成精确的单位价格证明",
      409,
    );
  }
  return {
    contractVersion: "billing-platform-absorption.v2",
    incidentContract:
      "video-submit-http-400-no-provider-task-no-delivery.v1",
    reason: "submit_http_400",
    customerDeliveryStatus: "none",
    customerChargeMicros: 0,
    providerBillingStatus: "possible_not_confirmed",
    requestedUnits: usage.units,
    observedReturnedUnits: null,
    observedValidUnits: null,
    reservedUnitPriceMicros,
    estimatedPlatformLossMicros: reservation.amountMicros,
    maximumProviderExposureMicros: reservation.amountMicros,
    customerReleaseMicros: reservation.amountMicros,
    estimateBasis:
      "maximum_reserved_exposure_due_to_unconfirmed_http_400",
    providerRequestProof,
  };
}

export async function releaseApiTaskReservation(input: {
  workspaceId: string;
  reservationId: string;
  requestId?: string | null;
  idempotencyKey: string;
  provider?: RelayProvider | string | null;
  channelId?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
  releaseProof?:
    | "not_dispatched"
    | "definitive_not_billable"
    | "customer_not_delivered_timeout"
    | "customer_not_delivered_platform_absorbed";
  /** Internal reconciler lease, validated with the task and deadline in the transaction. */
  videoExpiryContext?: { jobId: string; workerId: string };
  operatorUserId?: number | null;
  mutationFence?: ApiTaskBillingMutationFence;
  scriptAssetCommandId?: string;
  videoSubmitHttp400AbsorptionFence?:
    VideoSubmitHttp400PlatformAbsorptionFence;
  /**
   * Internal-only atomic extension point. Throwing rolls back the release,
   * usage mutation and watchdog resolution together.
   */
  trustedBeforeCommit?: (
    transaction: Knex.Transaction,
    release: BillingState,
  ) => Promise<void>;
}): Promise<BillingState | null> {
  return await db.transaction(async (trx) => {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    await assertApiTaskBillingMutationFence(trx, workspaceId, input.mutationFence);
    const reservation = await readLedger(trx, input.reservationId, workspaceId);
    if (!reservation || reservation.type !== "freeze") throw new BillingError("冻结流水不存在", 404);
    const releaseKey = `${input.idempotencyKey}:release`;
    const existing = await findIdempotentLedger(trx, workspaceId, "release", releaseKey);
    if (reservation.remainingMicros === 0) {
      if (!existing) return null;
      const existingPlatformAbsorption = parseJsonObject(
        existing.metadata?.platformAbsorption,
      );
      if (input.releaseProof === "customer_not_delivered_timeout"
        && existingPlatformAbsorption.contractVersion !== VIDEO_RESERVATION_EXPIRY_POLICY) {
        throw new BillingError("冻结已由不同的释放规则处理", 409);
      }
      const existingIncidentReason = String(
        reservation.metadata?.reconcileReason || "",
      );
      const existingEndpointType = String(
        reservation.metadata?.endpointType || "",
      );
      const hasExpectedImageAbsorptionV1 =
        existingEndpointType === "image_generation"
        && [
          "image_upstream_count_mismatch",
          "image_upstream_outcome_unknown",
        ].includes(existingIncidentReason)
        && existingPlatformAbsorption.contractVersion
          === "billing-platform-absorption.v1"
        && String(existingPlatformAbsorption.reason || "")
          === existingIncidentReason;
      const hasExpectedVideoAbsorptionV2 =
        existingEndpointType === "video_generation"
        && existingIncidentReason === "submit_http_400"
        && existingPlatformAbsorption.contractVersion
          === "billing-platform-absorption.v2"
        && existingPlatformAbsorption.incidentContract
          === "video-submit-http-400-no-provider-task-no-delivery.v1"
        && existingPlatformAbsorption.reason === "submit_http_400";
      const hasExpectedScriptAbsorption = existingEndpointType === "text"
        && existingIncidentReason === "chat_upstream_outcome_unknown"
        && existingPlatformAbsorption.contractVersion === SCRIPT_ASSET_ABSORPTION_CONTRACT
        && existingPlatformAbsorption.commandId === input.scriptAssetCommandId;
      if (
        input.releaseProof === "customer_not_delivered_platform_absorbed"
        && !hasExpectedImageAbsorptionV1
        && !hasExpectedVideoAbsorptionV2
        && !hasExpectedScriptAbsorption
      ) {
        throw new BillingError("冻结已由不同的释放证明处理", 409);
      }
      await resolveDispatchWatchdog(trx, reservation.id, "reservation_released");
      if (input.releaseProof === "customer_not_delivered_timeout") await releaseWorkspaceGeneration(trx, reservation.id, "settled");
      else if (input.releaseProof !== "customer_not_delivered_platform_absorbed") await releaseWorkspaceGeneration(trx, reservation.id, input.releaseProof || "not_dispatched");
      else if (hasExpectedImageAbsorptionV1 && Number.isSafeInteger(existingPlatformAbsorption.observedReturnedUnits))
        await releaseWorkspaceGeneration(trx, reservation.id, "settled");
      const released: BillingState = {
        account: await ensureWorkspaceAccount(trx, workspaceId, reservation.currency),
        ledger: existing,
        idempotent: true,
      };
      await input.trustedBeforeCommit?.(trx, released);
      return released;
    }
    if (reservation.remainingMicros !== reservation.amountMicros) {
      throw new BillingError("冻结流水已被部分处理，不能自动释放，需人工核账", 409);
    }
    const postDispatchReleaseAllowed =
      input.releaseProof === "definitive_not_billable"
      || input.releaseProof === "customer_not_delivered_timeout"
      || input.releaseProof === "customer_not_delivered_platform_absorbed";
    if (
      reservation.metadata?.billingLifecycleState === "dispatch_started" &&
      !postDispatchReleaseAllowed
    ) {
      throw new BillingError("上游请求已发出且缺少明确拒绝证据，不能自动释放", 409);
    }
    const usageRow = await usageForReservation(trx, reservation);
    if (!usageRow) throw new BillingError("冻结流水关联的用量记录不存在", 500);
    const requestedCount = Number(reservation.metadata?.requestedCount);
    const validReturnedCount = Number(reservation.metadata?.validReturnedCount);
    const reconcileReason = String(
      reservation.metadata?.reconcileReason || "",
    );
    const hasObservedPartialImageResult =
      String(usageRow.endpointType || "") === "image_generation"
      && String(usageRow.status || "") === "pending_reconcile"
      && reconcileReason === "image_upstream_count_mismatch"
      && Number.isSafeInteger(requestedCount)
      && Number.isSafeInteger(validReturnedCount)
      && validReturnedCount > 0
      && validReturnedCount < requestedCount;
    const hasUnknownImageOutcome =
      String(usageRow.endpointType || "") === "image_generation"
      && String(usageRow.status || "") === "pending_reconcile"
      && reconcileReason === "image_upstream_outcome_unknown";
    const hasUnknownTextOutcome = String(usageRow.endpointType) === "text"
      && String(usageRow.status) === "pending_reconcile"
      && reconcileReason === "chat_upstream_outcome_unknown";
    const hasUnconfirmedVideoSubmitHttp400 =
      String(usageRow.endpointType || "") === "video_generation"
      && String(usageRow.status || "") === "pending_reconcile"
      && reconcileReason === "submit_http_400";
    let provenVideoRejection = false;
    if (hasUnconfirmedVideoSubmitHttp400 && input.releaseProof === "definitive_not_billable" && usageRow.taskId) {
      const rejectedTask = await trx("o_relay_task").where({ id: usageRow.taskId, workspaceId, endpointType: "video_generation" }).first();
      const payload = parseJsonObject(rejectedTask?.providerPayload);
      const submission = parseJsonObject(payload.submission);
      provenVideoRejection = isDefinitiveVideoRejection({
        provider: rejectedTask?.provider,
        providerTaskId: rejectedTask?.providerTaskId,
        httpStatus: submission.httpStatus ?? (submission.reconcileReason === "submit_http_400" ? 400 : null),
        response: payload.response,
      });
    }
    if (
      (
        hasObservedPartialImageResult
        || hasUnknownImageOutcome
        || hasUnknownTextOutcome
        || (hasUnconfirmedVideoSubmitHttp400 && !provenVideoRejection)
      )
      && input.releaseProof === "definitive_not_billable"
    ) {
      throw new BillingError(
        "上游可能已经计费，不能声明供应商明确未计费；只能走平台承担释放",
        409,
      );
    }
    if (
      String(usageRow.status || "") === "pending_reconcile" &&
      !postDispatchReleaseAllowed
    ) {
      throw new BillingError("待核账预扣不能自动释放", 409);
    }
    let releaseMetadata = input.metadata;
    if (input.releaseProof === "customer_not_delivered_timeout") {
      releaseMetadata = { ...(input.metadata || {}), releaseProof: input.releaseProof,
        platformAbsorption: await buildVideoExpiryAbsorption({ transaction: trx, reservation, usage: formatUsageRecord(usageRow),
          jobId: input.videoExpiryContext?.jobId || "", workerId: input.videoExpiryContext?.workerId || "",
          fail: (message, status) => new BillingError(message, status) }) };
    }
    if (input.releaseProof === "customer_not_delivered_platform_absorbed") {
      if (hasUnknownTextOutcome) {
        releaseMetadata = {
          ...(input.metadata || {}),
          releaseProof: "customer_not_delivered_platform_absorbed",
          platformAbsorption: await buildScriptAssetPlatformAbsorption({
            transaction: trx, reservation, usage: usageRow,
            commandId: input.scriptAssetCommandId, operatorUserId: input.operatorUserId,
            reconcileJobId: String(input.metadata?.reconcileJobId || ""),
            fail: (message, status) => new BillingError(message, status),
          }),
        };
      } else if (hasUnconfirmedVideoSubmitHttp400) {
        releaseMetadata = {
          ...(input.metadata || {}),
          releaseProof: "customer_not_delivered_platform_absorbed",
          platformAbsorption:
            await buildVideoSubmitHttp400PlatformAbsorption({
              client: trx,
              workspaceId,
              reservation,
              usage: usageRow,
              requestId: input.requestId,
              provider: input.provider,
              channelId: input.channelId,
              metadata: input.metadata,
              operatorUserId: input.operatorUserId,
              incidentFence:
                input.videoSubmitHttp400AbsorptionFence,
            }),
        };
      } else {
      // This is not a generic "operator accepts the loss" escape hatch. The
      // immutable billing evidence and the terminal workbench command must
      // independently prove this one partial-image/no-delivery incident shape.
      const operatorUserId = Number(input.operatorUserId);
      const metadata = reservation.metadata || {};
      const rawReturnedCount = metadata.returnedCount;
      const rawValidReturnedCount = metadata.validReturnedCount;
      const returnedCount = Number(metadata.returnedCount);
      const actualCostMicros = Number(metadata.actualCostMicros);
      const incidentReason = String(metadata.reconcileReason || "");
      const hasCountMismatchEvidence =
        incidentReason === "image_upstream_count_mismatch"
        && Number.isSafeInteger(requestedCount)
        && requestedCount >= 2
        && Number.isSafeInteger(returnedCount)
        && Number.isSafeInteger(validReturnedCount)
        && returnedCount > 0
        && returnedCount < requestedCount
        && validReturnedCount === returnedCount;
      const hasUnknownOutcomeEvidence =
        incidentReason === "image_upstream_outcome_unknown"
        && Number.isSafeInteger(requestedCount)
        && requestedCount >= 1
        && rawReturnedCount == null
        && rawValidReturnedCount == null;
      const reservedRequestId = String(reservation.requestId || "").trim();
      const suppliedRequestId = String(input.requestId || "").trim();
      const requestId = reservedRequestId;
      const durableCommandIdentity = parseJsonObject(
        metadata.durableCommandIdentity,
      );
      const durableCommandId = String(
        durableCommandIdentity.commandId || "",
      ).trim();
      const durableCommandWorkspaceId = String(
        durableCommandIdentity.workspaceId || "",
      ).trim();
      const durableCommandActorUserId = Number(
        durableCommandIdentity.actorUserId,
      );
      const durableCommandScopeKey = String(
        durableCommandIdentity.scopeKey || "",
      ).trim();
      const durableCommandIdempotencyKey = String(
        durableCommandIdentity.idempotencyKey || "",
      ).trim();
      const durableCommandRequestHash = String(
        durableCommandIdentity.requestHash || "",
      ).trim();
      if (
        !Number.isSafeInteger(operatorUserId)
        || operatorUserId <= 0
        || String(usageRow.endpointType || "") !== "image_generation"
        || String(usageRow.status || "") !== "pending_reconcile"
        || String(usageRow.unit || "") !== "image"
        || Number(usageRow.costMicros || 0) !== 0
        || !Number.isSafeInteger(requestedCount)
        || (!hasCountMismatchEvidence && !hasUnknownOutcomeEvidence)
        || Number(usageRow.units || 0) !== requestedCount
        || String(metadata.billingLifecycleState || "") !== "pending_reconcile"
        || !Number.isSafeInteger(actualCostMicros)
        || actualCostMicros !== 0
        || reservation.taskId != null
        || usageRow.taskId != null
        || !requestId
        || Boolean(suppliedRequestId && suppliedRequestId !== requestId)
        || reservation.amountMicros % requestedCount !== 0
        || String(durableCommandIdentity.contractVersion || "")
          !== "workbench-generation-command.v1"
        || !durableCommandId
        || durableCommandWorkspaceId !== workspaceId
        || !Number.isSafeInteger(durableCommandActorUserId)
        || durableCommandActorUserId <= 0
        || durableCommandScopeKey
          !== `workbench:create:images:${workspaceId}:${durableCommandActorUserId}`
        || !durableCommandIdempotencyKey
        || !durableCommandRequestHash
      ) {
        throw new BillingError(
          "平台承担释放仅适用于无业务任务绑定、无客户交付的图片数量不一致事故",
          409,
        );
      }

      const command = await table(trx, "o_agent_idempotency")
        .where({
          id: durableCommandId,
          workspaceId,
          resourceType: "workbench_generation_command",
        })
        .select(
          "actorUserId",
          "scopeKey",
          "idempotencyKey",
          "requestHash",
          "status",
          "responseStatus",
          "responseBody",
          "resourceId",
        )
        .first();
      const commandResponse = parseJsonObject(command?.responseBody);
      const reconcileJobId = String(metadata.reconcileJobId || "").trim();
      const commandIdentityMatches = Boolean(
        command
        && Number(command.actorUserId) === durableCommandActorUserId
        && String(command.scopeKey || "") === durableCommandScopeKey
        && String(command.idempotencyKey || "")
          === durableCommandIdempotencyKey
        && String(command.requestHash || "") === durableCommandRequestHash
        && command.resourceId == null,
      );
      const hasCompletedNoDeliveryProof = Boolean(
        commandIdentityMatches
        && String(command.status || "") === "completed"
        && Number(command.responseStatus || 0) === 409
        && String(commandResponse.code || "") === "image_task_pending_reconcile"
        && !("assets" in commandResponse)
        && !("url" in commandResponse)
        && !("data" in commandResponse),
      );
      const checkpointDispatchStartedAt = Number(
        commandResponse.dispatchStartedAt,
      );
      const checkpointDispatchWatchdogAt = Number(
        commandResponse.dispatchWatchdogAt,
      );
      const hasCheckpointedUnknownNoDeliveryProof = Boolean(
        hasUnknownOutcomeEvidence
        && commandIdentityMatches
        && String(command.status || "") === "checkpointed"
        && command.responseStatus == null
        && String(commandResponse.version || "")
          === "quick-create-image-dispatch.v1"
        && String(commandResponse.reservationId || "") === reservation.id
        && String(commandResponse.requestId || "") === requestId
        && String(commandResponse.provider || "")
          === String(input.provider || usageRow.provider || "")
        && String(commandResponse.channelId || "")
          === String(input.channelId || usageRow.channelId || "")
        && reconcileJobId
        && String(commandResponse.reconcileJobId || "") === reconcileJobId
        && Number.isSafeInteger(checkpointDispatchStartedAt)
        && checkpointDispatchStartedAt > 0
        && Number.isSafeInteger(checkpointDispatchWatchdogAt)
        && checkpointDispatchWatchdogAt > checkpointDispatchStartedAt,
      );
      if (
        !hasCompletedNoDeliveryProof
        && !hasCheckpointedUnknownNoDeliveryProof
      ) {
        throw new BillingError(
          "平台承担释放缺少无客户资产交付的终态命令证明",
          409,
        );
      }
      if (hasCheckpointedUnknownNoDeliveryProof) {
        const pendingBody = {
          message:
            "图片请求状态无法确认，已由人工核账关闭；系统不会自动重发或重复扣费",
          code: "image_task_pending_reconcile",
          deliveryTraceVersion: "quick-create-image-no-delivery.v1",
        };
        const completedAt = now();
        const commandCompleted = await table(trx, "o_agent_idempotency")
          .where({
            id: durableCommandId,
            workspaceId,
            resourceType: "workbench_generation_command",
            status: "checkpointed",
            responseStatus: null,
          })
          .update({
            status: "completed",
            responseStatus: 409,
            responseBody: JSON.stringify(pendingBody),
            expiresAt: completedAt + 24 * 60 * 60 * 1_000,
            updatedAt: completedAt,
          });
        if (Number(commandCompleted || 0) !== 1) {
          throw new BillingError(
            "图片生成命令核账终态写入发生竞态",
            409,
          );
        }
      }

      const reservedUnitPriceMicros = reservation.amountMicros / requestedCount;
      const estimatedPlatformLossMicros =
        hasUnknownOutcomeEvidence
          ? reservation.amountMicros
          : reservedUnitPriceMicros * validReturnedCount;
      releaseMetadata = {
        ...(input.metadata || {}),
        releaseProof: "customer_not_delivered_platform_absorbed",
        platformAbsorption: {
          contractVersion: "billing-platform-absorption.v1",
          reason: incidentReason,
          customerDeliveryStatus: "none",
          customerChargeMicros: 0,
          providerBillingStatus: "possible_not_confirmed",
          requestedUnits: requestedCount,
          observedReturnedUnits:
            hasUnknownOutcomeEvidence ? null : returnedCount,
          observedValidUnits:
            hasUnknownOutcomeEvidence ? null : validReturnedCount,
          reservedUnitPriceMicros,
          estimatedPlatformLossMicros,
          maximumProviderExposureMicros: reservation.amountMicros,
          customerReleaseMicros: reservation.amountMicros,
          estimateBasis: hasUnknownOutcomeEvidence
            ? "maximum_reserved_exposure_due_to_unknown_outcome"
            : "reserved_unit_price_x_observed_valid_units",
        },
      };
      }
    }
    await updateReservationUsage(trx, reservation, {
      // Keep the reserved estimate for auditability. A released request has
      // zero cost, but erasing its unit/estimate makes reconciliation and
      // protocol-specific reporting impossible.
      units: Number(usageRow.units || 0),
      unit: String(usageRow.unit || "task"),
      costMicros: 0,
      status: "released",
      provider: input.provider,
      channelId: input.channelId,
    });
    const released = await applyRelease(trx, {
      workspaceId,
      reservationId: reservation.id,
      amountMicros: reservation.remainingMicros,
      usageRecordId: reservation.usageRecordId,
      apiKeyId: reservation.apiKeyId,
      requestId: input.requestId ?? reservation.requestId,
      description: input.description || "上游调用失败，释放 API 预扣",
      idempotencyKey: releaseKey,
      metadata: releaseMetadata,
      operatorUserId: input.operatorUserId,
    });
    await settleApiKeyGuQuota(
      trx,
      reservation.apiKeyId,
      reservation.amountMicros,
      0,
    );
    await resolveDispatchWatchdog(trx, reservation.id, "reservation_released");
    if (input.releaseProof === "customer_not_delivered_timeout") await releaseWorkspaceGeneration(trx, reservation.id, "settled");
    else if (input.releaseProof !== "customer_not_delivered_platform_absorbed") await releaseWorkspaceGeneration(trx, reservation.id, input.releaseProof || "not_dispatched");
    else if (usageRow.endpointType === "image_generation" && Number.isSafeInteger((releaseMetadata?.platformAbsorption as any)?.observedReturnedUnits))
      await releaseWorkspaceGeneration(trx, reservation.id, "settled");
    await input.trustedBeforeCommit?.(trx, released);
    return released;
  });
}

/**
 * Persist the point after which an upstream charge may exist. A reconciler
 * must never auto-release a reservation carrying this evidence merely because
 * the API process crashed before it could persist a response.
 */
export interface ApiTaskDispatchBoundary {
  workspaceId: string;
  reservationId: string;
  usageRecordId: string;
  requestId: string | null;
  provider: string | null;
  channelId: string | null;
  reconcileJobId: string;
  dispatchStartedAt: number;
  dispatchWatchdogAt: number;
}

export async function markApiTaskReservationDispatched(input: {
  workspaceId: string;
  reservationId: string;
  provider?: RelayProvider | string | null;
  channelId?: string | null;
  requestId?: string | null;
  /**
   * Maximum time the request may remain at the post-dispatch/pre-settlement
   * boundary before operator reconciliation is required. The watchdog never
   * releases or charges funds automatically because the upstream outcome is
   * unknown after a hard process crash.
   */
  watchdogAfterMs?: number;
  mutationFence?: ApiTaskBillingMutationFence;
  /**
   * Trusted internal durability hook. It runs after the ledger marker and
   * watchdog have been written but before their transaction commits. Throwing
   * rolls the whole boundary back, and the caller must not dispatch upstream.
   */
  trustedBeforeCommit?: (
    transaction: Knex.Transaction,
    boundary: ApiTaskDispatchBoundary,
  ) => Promise<void>;
  /**
   * Optional caller-owned transaction. This is used only when the Relay task
   * dispatch marker must commit atomically with billing/budget dispatch. The
   * caller remains responsible for commit/rollback.
   */
  transaction?: Knex.Transaction;
}): Promise<ApiTaskDispatchBoundary> {
  const persist = async (trx: Knex.Transaction): Promise<ApiTaskDispatchBoundary> => {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    await assertApiTaskBillingMutationFence(trx, workspaceId, input.mutationFence);
    const reservationQuery = table(trx, "o_billing_ledger").where({
      id: input.reservationId,
      workspaceId,
    });
    // PostgreSQL allows multiple workers to claim the same relay task at
    // nearly the same time. Serialize the no-return billing boundary on the
    // reservation row; SQLite already serializes writers at the database
    // level, so FOR UPDATE is only emitted for PostgreSQL.
    if (isPostgresClient(trx)) reservationQuery.forUpdate();
    const reservationRow = await reservationQuery.first();
    const reservation = reservationRow ? formatLedger(reservationRow) : null;
    if (!reservation || reservation.type !== "freeze") throw new BillingError("冻结流水不存在", 404);
    if (reservation.remainingMicros <= 0) {
      throw new BillingError("冻结流水已结束，禁止再次发起上游请求", 409);
    }
    const lifecycleState = String(reservation.metadata?.billingLifecycleState || "");
    if (lifecycleState === "dispatch_started") {
      throw new BillingError("冻结流水已标记上游派发，禁止重复发起请求", 409);
    }
    if (lifecycleState === "pending_reconcile") {
      throw new BillingError("冻结流水已进入待核账状态，禁止再次发起上游请求", 409);
    }
    const usage = await usageForReservation(trx, reservation);
    if (!usage) throw new BillingError("冻结流水关联的用量记录不存在", 500);
    await acquireWorkspaceGeneration(trx, { workspaceId, id: reservation.id, endpointType: usage.endpointType });
    const configuredWatchdogMs = Number(
      input.watchdogAfterMs ?? process.env.FANJIN_BILLING_DISPATCH_WATCHDOG_MS ?? 30 * 60_000,
    );
    const watchdogAfterMs = Number.isFinite(configuredWatchdogMs) && configuredWatchdogMs >= 1_000
      ? Math.floor(configuredWatchdogMs)
      : 30 * 60_000;
    const timestamp = Math.max(now(), reservation.updateTime + 1);
    const reconcileJobId = `billing-reconcile-${reservation.id}`;
    const watchdogDedupeKey = `reservation:${reservation.id}`;
    const existingWatchdog = await table(trx, "o_billing_reconcile_job")
      .where({ dedupeKey: watchdogDedupeKey })
      .first();
    if (existingWatchdog) {
      throw new BillingError("冻结流水已有派发或核账记录，禁止重复发起上游请求", 409);
    }
    const dispatchMetadata = {
      ...reservation.metadata,
      billingLifecycleState: "dispatch_started",
      dispatchStartedAt: timestamp,
      dispatchProvider: input.provider ?? reservation.metadata?.dispatchProvider ?? null,
      dispatchChannelId: input.channelId ?? reservation.metadata?.dispatchChannelId ?? null,
      dispatchRequestId: input.requestId ?? reservation.requestId ?? null,
      dispatchWatchdogAt: timestamp + watchdogAfterMs,
      reconcileJobId,
    };
    const dispatchBoundary: ApiTaskDispatchBoundary = {
      workspaceId,
      reservationId: reservation.id,
      usageRecordId: usage.id,
      requestId: input.requestId ?? reservation.requestId ?? null,
      provider: input.provider == null ? usage.provider ?? null : String(input.provider),
      channelId: input.channelId ?? usage.channelId ?? null,
      reconcileJobId,
      dispatchStartedAt: timestamp,
      dispatchWatchdogAt: timestamp + watchdogAfterMs,
    };
    const affected = await table(trx, "o_billing_ledger")
      .where({ id: reservation.id, workspaceId })
      .where({ updatedAt: reservation.updateTime })
      .where("remainingMicros", ">", 0)
      .update({
        metadata: stringifyJson(dispatchMetadata),
        updatedAt: timestamp,
      });
    if (Number(affected || 0) !== 1) {
      throw new BillingError("冻结流水状态已变化，禁止发起上游请求", 409);
    }
    // The dispatch marker and watchdog are one atomic durability boundary. If
    // the process is killed immediately after this transaction commits, the
    // reconciler can still surface the open freeze for an operator decision.
    await table(trx, "o_billing_reconcile_job")
      .insert({
        id: reconcileJobId,
        dedupeKey: watchdogDedupeKey,
        workspaceId,
        reservationId: reservation.id,
        usageRecordId: usage.id,
        requestId: input.requestId ?? reservation.requestId ?? null,
        endpointType: usage.endpointType,
        provider: input.provider ?? usage.provider ?? null,
        channelId: input.channelId ?? usage.channelId ?? null,
        status: "pending",
        reason: "dispatch_watchdog",
        evidence: stringifyJson(dispatchMetadata),
        decision: null,
        attempts: 0,
        nextAttemptAt: timestamp + watchdogAfterMs,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        resolvedAt: null,
        createTime: timestamp,
        updateTime: timestamp,
      });
    await markWorkspaceGenerationDispatched(trx, reservation.id);
    if (input.trustedBeforeCommit) {
      await input.trustedBeforeCommit(trx, dispatchBoundary);
    }
    return dispatchBoundary;
  };
  try {
    return input.transaction ? await persist(input.transaction) : await db.transaction(persist);
  } catch (error) {
    if (!input.transaction && error instanceof WorkspaceGenerationQueued) {
      const ledger = await readLedger(db, input.reservationId, input.workspaceId);
      if (ledger) {
        const usage = await usageForReservation(db, ledger);
        if (usage) await recordWorkspaceGenerationQueue(db, { id: input.reservationId, workspaceId: input.workspaceId, endpointType: usage.endpointType });
      }
    }
    throw error;
  }
}

export async function markApiTaskReservationPendingReconcile(input: {
  workspaceId: string;
  reservationId: string;
  units: number;
  unit?: string;
  actualCostMicros: number;
  provider?: RelayProvider | string | null;
  channelId?: string | null;
  reason: string;
  metadata?: Record<string, unknown>;
  mutationFence?: ApiTaskBillingMutationFence;
  /** Internal-only hook committed atomically with the pending-reconcile row. */
  trustedBeforeCommit?: (
    transaction: Knex.Transaction,
    pending: ApiTaskReservationPendingReconcileResult,
  ) => Promise<void>;
}): Promise<void> {
  await db.transaction(async (trx) => {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    await assertApiTaskBillingMutationFence(trx, workspaceId, input.mutationFence);
    const reservation = await readLedger(trx, input.reservationId, workspaceId);
    if (!reservation || reservation.type !== "freeze") throw new BillingError("冻结流水不存在", 404);
    // Another idempotent settlement may have completed between the caller's
    // error and this reconciliation marker. Never downgrade a closed usage.
    if (reservation.remainingMicros <= 0) return;
    const reconcileJobId = `billing-reconcile-${reservation.id}`;
    const actualCostMicros = applyGuChargeRounding(assertNonNegativeInteger(input.actualCostMicros, "actualCostMicros"), reservation.metadata);
    const settlementPolicy = reservation.metadata?.settlementPolicy;
    const reconcileEvidence = {
      ...reservation.metadata,
      ...(input.metadata || {}),
      // Creation-time settlement authority is immutable. Reconciliation
      // callers may add evidence but cannot grant or weaken overage policy.
      ...(settlementPolicy ? { settlementPolicy } : {}),
      guChargeRounding: reservation.metadata?.guChargeRounding ?? null,
      billingLifecycleState: "pending_reconcile",
      reconcileReason: input.reason,
      actualCostMicros,
      actualUnits: input.units,
      reconcileEvidenceVersion: 1,
      reconcileJobId,
    };
    const affected = await table(trx, "o_billing_ledger")
      .where({ id: reservation.id, workspaceId })
      .where("remainingMicros", ">", 0)
      .update({
        metadata: stringifyJson(reconcileEvidence),
        updatedAt: now(),
      });
    if (Number(affected || 0) !== 1) return;
    const usage = await updateReservationUsage(trx, reservation, {
      units: input.units,
      unit: input.unit || "token",
      costMicros: actualCostMicros,
      status: "pending_reconcile",
      provider: input.provider,
      channelId: input.channelId,
    });
    const timestamp = now();
    await table(trx, "o_billing_reconcile_job")
      .insert({
        id: reconcileJobId,
        dedupeKey: `reservation:${reservation.id}`,
        workspaceId,
        reservationId: reservation.id,
        usageRecordId: usage.id,
        requestId: reservation.requestId,
        endpointType: usage.endpointType,
        provider: input.provider ?? usage.provider,
        channelId: input.channelId ?? usage.channelId,
        status: "pending",
        reason: input.reason,
        evidence: stringifyJson(reconcileEvidence),
        decision: null,
        attempts: 0,
        nextAttemptAt: timestamp,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        resolvedAt: null,
        createTime: timestamp,
        updateTime: timestamp,
      })
      .onConflict("dedupeKey")
      .merge({
        usageRecordId: usage.id,
        requestId: reservation.requestId,
        endpointType: usage.endpointType,
        provider: input.provider ?? usage.provider,
        channelId: input.channelId ?? usage.channelId,
        status: "pending",
        reason: input.reason,
        evidence: stringifyJson(reconcileEvidence),
        decision: null,
        nextAttemptAt: timestamp,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        resolvedAt: null,
        updateTime: timestamp,
      });
    await input.trustedBeforeCommit?.(trx, {
      reservation,
      usage,
      reconcileJobId,
      reason: input.reason,
      actualCostMicros,
    });
  });
}

async function billingLedgerWithModels(client: BillingDb, workspaceId: string, items: BillingLedger[]): Promise<BillingLedger[]> {
  const usageIds = [...new Set(items.flatMap((item) => item.usageRecordId ? [item.usageRecordId] : []))];
  if (!usageIds.length) return items;
  const usage = await table(client, "o_usage_record").where({ workspaceId }).whereIn("id", usageIds).select("id", "model");
  const models = new Map<string, string>(usage.map((row: any) => [String(row.id), String(row.model || "")]));
  return items.map((item) => ({ ...item, model: models.get(String(item.usageRecordId)) || null }));
}

export async function listBillingLedger(input: {
  workspaceId: string;
  type?: BillingLedgerType | null;
  status?: BillingLedgerStatus | null;
  taskId?: string | null;
  pageNum?: number;
  pageSize?: number;
}, client: BillingDb = db): Promise<{ items: BillingLedger[]; total: number; pageNum: number; pageSize: number }> {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const pageNum = Math.max(1, Math.min(Number(input.pageNum || 1), 500));
  const pageSize = Math.max(1, Math.min(Number(input.pageSize || 20), 500));
  const query = table(client, "o_billing_ledger").where({ workspaceId });
  if (input.type) query.andWhere({ type: input.type });
  if (input.taskId) query.andWhere({ relatedTaskId: input.taskId });

  if (input.status) {
    const rows = await query.clone().orderBy("createdAt", "desc");
    const items = rows.map(formatLedger).filter((row: BillingLedger) => row.status === input.status);
    return {
      items: await billingLedgerWithModels(client, workspaceId, items.slice((pageNum - 1) * pageSize, pageNum * pageSize)),
      total: items.length,
      pageNum,
      pageSize,
    };
  }

  const countRow = await query.clone().count<{ total: number }[]>({ total: "*" }).first();
  const rows = await query
    .clone()
    .orderBy("createdAt", "desc")
    .limit(pageSize)
    .offset((pageNum - 1) * pageSize);
  return {
    items: await billingLedgerWithModels(client, workspaceId, rows.map(formatLedger)),
    total: Number((countRow as any)?.total || 0),
    pageNum,
    pageSize,
  };
}

export async function listUsageLedger(input: {
  workspaceId?: string | null;
  apiKeyId?: string | null;
  taskId?: string | null;
  endpointType?: string | null;
  status?: string | null;
  pageNum?: number;
  pageSize?: number;
}, client: BillingDb = db): Promise<{ items: UsageRecord[]; total: number; pageNum: number; pageSize: number }> {
  const pageNum = Math.max(1, Math.min(Number(input.pageNum || 1), 500));
  const pageSize = Math.max(1, Math.min(Number(input.pageSize || 20), 500));
  const query = table(client, "o_usage_record");
  if (input.workspaceId) query.where({ workspaceId: input.workspaceId });
  if (input.apiKeyId) query.where({ apiKeyId: input.apiKeyId });
  if (input.taskId) query.where({ taskId: input.taskId });
  if (input.endpointType) query.where({ endpointType: input.endpointType });
  if (input.status) query.where({ status: input.status });

  const countRow = await query.clone().count<{ total: number }[]>({ total: "*" }).first();
  const rows = await query
    .clone()
    .orderBy("createTime", "desc")
    .limit(pageSize)
    .offset((pageNum - 1) * pageSize);
  return {
    items: rows.map(formatUsageRecord),
    total: Number((countRow as any)?.total || 0),
    pageNum,
    pageSize,
  };
}

export async function upsertBillingPlan(input: UpsertBillingPlanInput): Promise<BillingPlan> {
  const code = input.code.trim();
  if (!code) throw new BillingError("套餐 code 不能为空");
  if (!input.name.trim()) throw new BillingError("套餐名称不能为空");
  const timestamp = now();
  const existing = input.id
    ? await table(db, "o_billing_plan").where({ id: input.id }).first()
    : await table(db, "o_billing_plan").where({ code }).first();
  const quotas = input.quotas || {};
  const quotaNumber = (key: string): number | null => {
    const value = quotas[key];
    return value == null ? null : assertNonNegativeInteger(Number(value), key);
  };
  const metadata = {
    ...(input.metadata || {}),
    billingPeriod: input.billingPeriod ?? "month",
    creditLimitMicros: assertNonNegativeInteger(input.creditLimitMicros ?? 0, "creditLimitMicros"),
    quotas,
    features: input.features || {},
  };
  const row = {
    code,
    name: input.name.trim(),
    status: input.status ?? "active",
    currency: normalizeCurrency(input.currency),
    monthlyFeeMicros: assertNonNegativeInteger(input.priceMicros ?? 0, "priceMicros"),
    includedCreditsMicros: assertNonNegativeInteger(input.includedCreditsMicros ?? 0, "includedCreditsMicros"),
    apiQuota: quotaNumber("apiQuota"),
    memberLimit: quotaNumber("memberLimit"),
    keyLimit: quotaNumber("keyLimit"),
    metadata: stringifyJson(metadata),
    updatedAt: timestamp,
  };

  if (existing) {
    await table(db, "o_billing_plan").where({ id: existing.id }).update(row);
    const updated = await table(db, "o_billing_plan").where({ id: existing.id }).first();
    return formatPlan(updated);
  }

  const id = input.id || uuid();
  await table(db, "o_billing_plan").insert({
    id,
    ...row,
    createdAt: timestamp,
  });
  const created = await table(db, "o_billing_plan").where({ id }).first();
  return formatPlan(created);
}

export async function listBillingPlans(input: { includeArchived?: boolean } = {}): Promise<BillingPlan[]> {
  const query = table(db, "o_billing_plan").orderBy("createdAt", "asc");
  if (!input.includeArchived) query.where({ status: "active" });
  const rows = await query;
  return rows.map(formatPlan);
}

export function microsFromYuan(amountYuan: number): number {
  return guMicrosFromYuan(amountYuan);
}

export async function creditBillingAccount(input: {
  workspaceId: string;
  amountMicros: number;
  type?: string;
  description?: string | null;
  createdBy?: number | null;
  idempotencyKey?: string | null;
}): Promise<BillingState> {
  return await rechargeWorkspace({
    workspaceId: input.workspaceId,
    amountMicros: input.amountMicros,
    description: input.description ?? input.type ?? "账户入账",
    metadata: { legacyType: input.type ?? "credit" },
    idempotencyKey: input.idempotencyKey,
    operatorUserId: input.createdBy ?? null,
  });
}

export async function allocateAccountWalletToWorkspace(input: {
  userId: number;
  workspaceId: string;
  amountMicros: number;
  description?: string | null;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
  operatorUserId?: number | null;
}): Promise<{
  accountWallet: AccountWallet;
  accountWalletLedger: AccountWalletLedger | null;
  workspaceAccount: BillingAccount;
  workspaceLedger: BillingLedger;
}> {
  return await db.transaction((trx) => allocateAccountWalletToWorkspaceInTransaction(trx, input));
}

export async function allocateAccountWalletToWorkspaceInTransaction(client: BillingDb, input: {
  userId: number;
  workspaceId: string;
  amountMicros: number;
  description?: string | null;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
  operatorUserId?: number | null;
}): Promise<{
  accountWallet: AccountWallet;
  accountWalletLedger: AccountWalletLedger | null;
  workspaceAccount: BillingAccount;
  workspaceLedger: BillingLedger;
}> {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const ownerUserId = Number(input.userId || 0);
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1) {
    throw new BillingError("账号钱包所有者无效", 400);
  }
  const amountMicros = assertPositiveInteger(input.amountMicros, "amountMicros");
  const description = String(input.description || "分配工作区消费额度");
  const rawIdempotencyKey = String(input.idempotencyKey || "").trim();
  const rechargeIdempotencyKey = rawIdempotencyKey
    ? `workspace:${rawIdempotencyKey}`
    : null;
  const protectedMetadata = {
    source: "workspace_quota_allocation",
    ...(input.metadata || {}),
    accountWalletUserId: ownerUserId,
    allocationDoesNotDebitOwnerWallet: true,
    allocationOwnerUserId: ownerUserId,
  };
  const allocationRequestDigest = walletAllocationRequestDigest({
    ownerUserId,
    workspaceId,
    amountMicros,
    description,
    metadata: protectedMetadata,
  });
  const allocationMetadata = {
    ...protectedMetadata,
    allocationRequestDigest,
  };
  const existing = await findIdempotentLedger(client, workspaceId, "recharge", rechargeIdempotencyKey);
  if (existing) {
    const existingOwnerUserId = Number(
      existing.metadata.allocationOwnerUserId
        ?? existing.metadata.accountWalletUserId
        ?? 0,
    );
    const existingRequestDigest = String(
      existing.metadata.allocationRequestDigest || "",
    );
    if (
      existing.amountMicros !== amountMicros
      || existing.currency !== billingCurrency
      || existingOwnerUserId !== ownerUserId
      || existingRequestDigest !== allocationRequestDigest
    ) {
      throw new BillingError("工作区分配幂等键已被不同请求使用", 409);
    }
    return {
      accountWallet: await ensureAccountWallet(client, ownerUserId, billingCurrency),
      accountWalletLedger: null,
      workspaceAccount: await ensureWorkspaceAccount(client, workspaceId, billingCurrency),
      workspaceLedger: existing,
    };
  }

  const wallet = await ensureAccountWallet(client, ownerUserId, billingCurrency);
  const available = accountWalletAvailable(wallet);
  if (available.totalAvailableMicros < amountMicros) throw new BillingError("账号可支付额度不足，无法分配工作区消费额度", 402);
  const recharge = await applyRecharge(client, {
    workspaceId,
    amountMicros,
    currency: billingCurrency,
    description,
    metadata: allocationMetadata,
    idempotencyKey: rechargeIdempotencyKey,
    operatorUserId: input.operatorUserId,
  });
  return {
    accountWallet: wallet,
    accountWalletLedger: null,
    workspaceAccount: recharge.account,
    workspaceLedger: recharge.ledger,
  };
}

async function readBillingOverviewProjection(workspaceId: string, client: BillingDb): Promise<{
  account: BillingAccount & {
    reservedMicros: number;
    balanceGu: number;
    creditLimitGu: number;
    reservedGu: number;
    availableGu: number;
    balanceYuan: number;
    creditLimitYuan: number;
    reservedYuan: number;
    availableYuan: number;
    balanceYuanEquivalent: number;
    creditLimitYuanEquivalent: number;
    reservedYuanEquivalent: number;
    availableYuanEquivalent: number;
  };
  accountWallet: (AccountWallet & {
    cashAvailableMicros: number;
    giftAvailableMicros: number;
    creditAvailableMicros: number;
    totalAvailableMicros: number;
    balanceGu: number;
    giftBalanceGu: number;
    creditLimitGu: number;
    totalAvailableGu: number;
    balanceYuanEquivalent: number;
    ownerUserId: number;
    defaultWorkspaceId: string | null;
    isDefaultWorkspace: boolean;
  }) | null;
  plan: (BillingPlan & {
    apiQuota?: number;
    memberLimit?: number;
    keyLimit?: number;
  }) | null;
  subscription: WorkspacePlanSubscription | null;
  ledger: { items: BillingLedger[]; total: number; pageNum: number; pageSize: number };
  latestRecharge: BillingLedger | null;
  usage: {
    items: UsageRecord[];
    total: number;
    pageNum: number;
    pageSize: number;
    chargedCalls: number;
    reservedCalls: number;
    totalCostMicros: number;
    totalCostGu: number;
    totalCostYuan: number;
    totalCostYuanEquivalent: number;
    reservedCostMicros: number;
    reservedCostGu: number;
    reservedCostYuan: number;
    reservedCostYuanEquivalent: number;
  };
  recentLedger: Array<BillingLedger & { amountGu: number; amountYuan: number; amountYuanEquivalent: number; createdAt: number }>;
}> {
  const summary = await readWorkspaceBillingSummary(workspaceId, client);
  const ownerFundingInfo = await workspaceOwnerFundingInfo(client, workspaceId);
  const ownerWallet = ownerFundingInfo?.ownerUserId
    ? await readAccountWalletReadonly(client, ownerFundingInfo.ownerUserId)
    : null;
  const ledger = await listBillingLedger({ workspaceId, pageNum: 1, pageSize: 20 }, client);
  const latestRechargeLedger = await listBillingLedger({
    workspaceId,
    type: "recharge",
    pageNum: 1,
    pageSize: 1,
  }, client);
  const usage = await listUsageLedger({ workspaceId, pageNum: 1, pageSize: 20 }, client);
  const chargedCalls = usage.items.filter((item) => item.status === "charged").length;
  const reservedCalls = usage.items.filter((item) => item.status === "reserved").length;
  const totalCostMicros = usage.items.reduce((total, item) => {
    return item.status === "charged" ? total + item.costMicros : total;
  }, 0);
  const reservedCostMicros = usage.items.reduce((total, item) => {
    return ["reserved", "pending_reconcile"].includes(item.status)
      ? total + item.costMicros
      : total;
  }, 0);
  const ownerAvailable = ownerWallet ? await workspaceWalletAvailable(client, ownerWallet, workspaceId, undefined, true) : null;
  const workspaceRemainingQuotaMicros = Math.max(0, summary.account.balanceMicros - summary.account.frozenMicros);
  const workspaceAvailableMicros = ownerAvailable ? Math.min(workspaceRemainingQuotaMicros, ownerAvailable.totalAvailableMicros) : workspaceRemainingQuotaMicros;
  const balanceYuanEquivalent = yuanFromGuMicros(summary.account.balanceMicros);
  const creditLimitYuanEquivalent = yuanFromGuMicros(ownerWallet?.creditLimitMicros || 0);
  const reservedYuanEquivalent = yuanFromGuMicros(summary.account.frozenMicros);
  const availableYuanEquivalent = yuanFromGuMicros(workspaceAvailableMicros);
  const account = {
    ...summary.account,
    creditLimitMicros: ownerWallet?.creditLimitMicros || 0,
    reservedMicros: summary.account.frozenMicros,
    allocatedQuotaMicros: summary.account.balanceMicros,
    reservedQuotaMicros: summary.account.frozenMicros,
    remainingQuotaMicros: workspaceRemainingQuotaMicros,
    ownerSpendableMicros: ownerAvailable?.totalAvailableMicros || 0,
    availableMicros: workspaceAvailableMicros,
    balanceGu: guFromMicros(summary.account.balanceMicros),
    creditLimitGu: guFromMicros(ownerWallet?.creditLimitMicros || 0),
    reservedGu: guFromMicros(summary.account.frozenMicros),
    availableGu: guFromMicros(workspaceAvailableMicros),
    balanceYuan: balanceYuanEquivalent,
    creditLimitYuan: creditLimitYuanEquivalent,
    reservedYuan: reservedYuanEquivalent,
    availableYuan: availableYuanEquivalent,
    balanceYuanEquivalent,
    creditLimitYuanEquivalent,
    reservedYuanEquivalent,
    availableYuanEquivalent,
  };
  const plan = summary.plan
    ? {
        ...summary.plan,
        apiQuota: Number(summary.plan.quotas.apiQuota || 0),
        memberLimit: Number(summary.plan.quotas.memberLimit || 0),
        keyLimit: Number(summary.plan.quotas.keyLimit || 0),
      }
    : null;
  return {
    account,
    accountWallet: ownerWallet && ownerFundingInfo
      ? {
          ...ownerWallet,
          cashAvailableMicros: ownerAvailable?.cashAvailableMicros || 0,
          giftAvailableMicros: ownerAvailable?.giftAvailableMicros || 0,
          creditAvailableMicros: ownerAvailable?.creditAvailableMicros || 0,
          totalAvailableMicros: ownerAvailable?.totalAvailableMicros || 0,
          balanceGu: guFromMicros(ownerWallet.balanceMicros),
          giftBalanceGu: guFromMicros(ownerWallet.giftBalanceMicros),
          creditLimitGu: guFromMicros(ownerWallet.creditLimitMicros),
          totalAvailableGu: guFromMicros(ownerAvailable?.totalAvailableMicros || 0),
          balanceYuanEquivalent: yuanFromGuMicros(ownerWallet.balanceMicros),
          ownerUserId: ownerFundingInfo.ownerUserId,
          defaultWorkspaceId: ownerFundingInfo.defaultWorkspaceId,
          isDefaultWorkspace: ownerFundingInfo.defaultWorkspaceId === workspaceId,
        }
      : null,
    plan,
    subscription: summary.subscription,
    ledger,
    latestRecharge: latestRechargeLedger.items[0] ?? null,
    usage: {
      ...usage,
      chargedCalls,
      reservedCalls,
      totalCostMicros,
      totalCostGu: guFromMicros(totalCostMicros),
      totalCostYuan: yuanFromGuMicros(totalCostMicros),
      totalCostYuanEquivalent: yuanFromGuMicros(totalCostMicros),
      reservedCostMicros,
      reservedCostGu: guFromMicros(reservedCostMicros),
      reservedCostYuan: yuanFromGuMicros(reservedCostMicros),
      reservedCostYuanEquivalent: yuanFromGuMicros(reservedCostMicros),
    },
    recentLedger: ledger.items.map((item) => ({
      ...item,
      amountGu: guFromMicros(item.amountMicros),
      amountYuan: yuanFromGuMicros(item.amountMicros),
      amountYuanEquivalent: yuanFromGuMicros(item.amountMicros),
      createdAt: item.createTime,
    })),
  };
}

export type BillingOverview = Awaited<ReturnType<typeof readBillingOverviewProjection>>;

/**
 * Ordinary product overview. Outside recovery mode it retains the historical
 * account-creation and expired-gift maintenance behavior.
 */
export async function getBillingOverview(
  workspaceId: string,
  client: BillingDb = db,
): Promise<BillingOverview> {
  if (client === db) {
    const funding = await workspaceOwnerFundingInfo(db, workspaceId);
    if (funding?.ownerUserId && !isRecoveryOnlyMode()) {
      await expireAccountGiftGrants({ userId: funding.ownerUserId });
    }
    // Ordinary product reads may lazily provision a missing historical billing
    // account inside this transaction.  It therefore cannot be READ ONLY on
    // PostgreSQL.  Formal candidate capture uses the dedicated, strictly
    // read-only projection below.
    const transactionConfig = isPostgresClient(db)
      ? { isolationLevel: "repeatable read" as const }
      : undefined;
    return db.transaction(
      (trx) => getBillingOverview(workspaceId, trx),
      transactionConfig,
    );
  }

  if (!isRecoveryOnlyMode()) {
    await ensureWorkspaceAccount(client, workspaceId);
  }
  return readBillingOverviewProjection(workspaceId, client);
}

/**
 * Dedicated projection for formal candidate readonly capture. Its complete
 * database call graph is SELECT/schema inspection only: it never expires gift
 * grants, creates/repairs billing or wallet rows, or writes an outbox. Missing
 * checkpoint state is a 503 rather than an implicit materialization.
 */
export async function getCandidateReadonlyBillingOverviewProjection(
  workspaceId: string,
  client: BillingDb = db,
): Promise<BillingOverview> {
  if (!(client as Knex.Transaction).isTransaction) {
    const transactionConfig = isPostgresClient(client as Knex)
      ? { isolationLevel: "repeatable read" as const, readOnly: true }
      : undefined;
    return (client as Knex).transaction(
      (trx) => readBillingOverviewProjection(workspaceId, trx),
      transactionConfig,
    );
  }
  return readBillingOverviewProjection(workspaceId, client);
}

function isMissingBillingTableError(err: unknown): boolean {
  const message = String((err as any)?.message || err || "");
  return /no such table: o_billing_|no such table: o_workspace_plan_subscription|no such table: o_account_wallet/.test(message);
}

export async function reserveRelayBilling(input: ApiTaskChargeInput & { taskId: string }): Promise<{
  reserved: boolean;
  quotaReserved: number;
  usage?: UsageRecord;
  ledger?: BillingLedger | null;
}> {
  try {
    if (!input.workspaceId) return { reserved: false, quotaReserved: 0 };
    const result = await billApiTask({
      ...input,
      chargeMode: "reserve",
      idempotencyKey: input.idempotencyKey ?? `relay:${input.taskId}:reserve`,
    });
    return {
      reserved: Boolean(result.ledger),
      quotaReserved: result.costMicros,
      usage: result.usage,
      ledger: result.ledger,
    };
  } catch (err) {
    if (isMissingBillingTableError(err)) return { reserved: false, quotaReserved: 0 };
    throw err;
  }
}

export async function completeRelayBilling(taskId: string, status: string): Promise<BillingState | null> {
  try {
    const task = await table(db, "o_relay_task").where({ id: taskId }).first();
    if (!task?.workspaceId) return null;

    const ledgerRows = await table(db, "o_billing_ledger")
      .where({ workspaceId: task.workspaceId, type: "freeze", relatedTaskId: taskId })
      .orderBy("createdAt", "desc");
    const reservation = ledgerRows.map(formatLedger).find((ledger: BillingLedger) => ledger.remainingMicros > 0);
    if (!reservation) return null;

    const succeeded = isRelayBillingSuccess(status);
    // 把「usage_record 状态更新」与「扣费/释放」放入同一事务，保证过账成功才改 usage 状态，
    // 避免出现 usage 已标记 charged/released 但冻结额度未实际扣减/释放的账目不一致。
    if (succeeded) {
      return await db.transaction(async (trx) => {
        await table(trx, "o_usage_record").where({ id: reservation.usageRecordId }).update({ status: "charged" });
        const captured = await applyDeduct(trx, {
          workspaceId: task.workspaceId,
          reservationId: reservation.id,
          amountMicros: reservation.remainingMicros,
          taskId,
          apiKeyId: task.apiKeyId ?? reservation.apiKeyId,
          requestId: task.requestId ?? reservation.requestId,
          usageRecordId: reservation.usageRecordId,
          description: `relay task captured: ${taskId}`,
          idempotencyKey: `relay:${taskId}:capture`,
        });
        if (!captured.idempotent) {
          await settleApiKeyGuQuota(
            trx,
            task.apiKeyId ?? reservation.apiKeyId,
            reservation.amountMicros,
            reservation.remainingMicros,
          );
        }
        return captured;
      });
    }

    return await db.transaction(async (trx) => {
      await table(trx, "o_usage_record").where({ id: reservation.usageRecordId }).update({ status: "released" });
      const released = await applyRelease(trx, {
        workspaceId: task.workspaceId,
        reservationId: reservation.id,
        amountMicros: reservation.remainingMicros,
        taskId,
        apiKeyId: task.apiKeyId ?? reservation.apiKeyId,
        requestId: task.requestId ?? reservation.requestId,
        usageRecordId: reservation.usageRecordId,
        description: `relay task released: ${taskId}`,
        idempotencyKey: `relay:${taskId}:release`,
      });
      if (!released.idempotent) {
        await settleApiKeyGuQuota(
          trx,
          task.apiKeyId ?? reservation.apiKeyId,
          reservation.amountMicros,
          0,
        );
      }
      return released;
    });
  } catch (err) {
    if (err instanceof BillingError && err.status === 409) return null;
    if (isMissingBillingTableError(err)) return null;
    throw err;
  }
}

export async function assignWorkspacePlan(input: AssignWorkspacePlanInput): Promise<{
  account: BillingAccount;
  subscription: WorkspacePlanSubscription;
  plan: BillingPlan;
  includedCreditLedger: BillingLedger | null;
}> {
  return await db.transaction(async (trx) => {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const planRow = await table(trx, "o_billing_plan").where({ id: input.planId }).first();
    if (!planRow) throw new BillingError("套餐不存在", 404);
    const plan = formatPlan(planRow);
    const account = await ensureWorkspaceAccount(trx, workspaceId, plan.currency);
    assertAccountReady(account, plan.currency);
    const timestamp = now();

    await table(trx, "o_workspace_plan_subscription")
      .where({ workspaceId, status: "active" })
      .update({ status: "cancelled", cancelAt: timestamp, updatedAt: timestamp });

    const subscriptionId = uuid();
    await table(trx, "o_workspace_plan_subscription").insert({
      id: subscriptionId,
      workspaceId,
      planId: plan.id,
      status: "active",
      currentPeriodStart: input.currentPeriodStart ?? timestamp,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      cancelAt: null,
      metadata: stringifyJson(input.metadata),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const updatedAccount = await updateAccountBalances(trx, account, {
      planId: plan.id,
      creditLimitMicros: plan.creditLimitMicros,
      currentPeriodStart: input.currentPeriodStart ?? timestamp,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
    });
    const subscriptionRow = await table(trx, "o_workspace_plan_subscription").where({ id: subscriptionId }).first();
    let includedCreditLedger: BillingLedger | null = null;
    let finalAccount = updatedAccount;
    if (input.grantIncludedCredits && plan.includedCreditsMicros > 0) {
      const state = await applyRecharge(trx, {
        workspaceId,
        amountMicros: plan.includedCreditsMicros,
        currency: plan.currency,
        description: `plan included credits: ${plan.code}`,
        metadata: { planId: plan.id, subscriptionId },
        idempotencyKey: `plan:${subscriptionId}:included_credits`,
        operatorUserId: input.operatorUserId,
      });
      includedCreditLedger = state.ledger;
      finalAccount = state.account;
    }

    return {
      account: finalAccount,
      subscription: formatSubscription(subscriptionRow),
      plan,
      includedCreditLedger,
    };
  });
}
