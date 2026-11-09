import { v4 as uuid } from "uuid";

import {
  CONSUMPTION_ALLOCATION_TABLE,
  PROVIDER_COST_LEDGER_TABLE,
  isConsumptionAllocationRecordingEnabled,
  readUserAttribution,
  settlementV2Mode,
} from "@/lib/tenantAttribution";
import { DEFAULT_COMMERCIAL_TENANT_ID } from "@/lib/commercialTenant";
import { estimateVolcengineProviderCostMicros } from "@/lib/volcengineProviderCostCatalog";

const SETTLEMENT_ACCOUNT_TABLE = "o_tenant_settlement_account";
const SETTLEMENT_LEDGER_TABLE = "o_tenant_settlement_ledger";

export type AllocationDb = { (table: string): any };

export type ConsumptionAllocationRecord = {
  id: string;
  usageId: string | null;
  requestId: string | null;
  taskId: string | null;
  ledgerId: string | null;
  userId: number;
  workspaceId: string | null;
  spendSource: "gift" | "cash" | "credit";
  creditLotId: string | null;
  collectorTenantId: string | null;
  registeredTenantIdSnapshot: string;
  ownerTenantIdSnapshot: string;
  chargedGuMicros: number;
  retailPortionMicros: number;
  wholesaleAccrualMicros: number;
  wholesaleRatePpm: number;
  pricingRuleId: string | null;
  pricingRuleRevision: number | null;
  settlementMode: "shadow" | "active";
  capturedAt: number;
  sourceType: string | null;
  sourceId: string | null;
  idempotencyKey: string;
};

export type ProviderCostRecord = {
  id: string;
  usageId: string | null;
  requestId: string | null;
  provider: string;
  channel: string | null;
  model: string | null;
  estimatedCostMicros: number;
  officialCostMicros: number | null;
  currency: string;
  providerPriceRevision: number | null;
  invoiceId: string | null;
  billingPeriod: string | null;
  state: "estimated" | "confirmed" | "adjusted" | "disputed";
  differenceMicros: number | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

/**
 * 计算某次消费在某现金批次上的结算应计（纯函数，便于回放与对账复算）。
 * - retailPortionMicros: 该批次被消费部分对应的用户实付金额
 * - wholesaleAccrualMicros: 按批次批发率计算的租户结算应计
 */
export function settlementAccrualForLot(lot: {
  amountMicros: number;
  retailAmountMicros: number;
  wholesaleAmountMicros: number;
  wholesaleRatePpm: number;
}, chargedGuMicros: number): { retailPortionMicros: number; wholesaleAccrualMicros: number } {
  const amount = Math.max(1, Number(lot.amountMicros || 0));
  const charged = Math.max(0, Math.floor(chargedGuMicros));
  const ratio = Math.min(1, charged / amount);
  const retailPortionMicros = Math.round(Number(lot.retailAmountMicros || 0) * ratio);
  const wholesaleAccrualMicros = Math.round(Number(lot.wholesaleAmountMicros || 0) * ratio);
  return { retailPortionMicros, wholesaleAccrualMicros };
}

/**
 * 记录一次计费 capture 的消费分摊（R6 三模式确定语义）：
 * - 只记录成功 capture 的消费；失败、取消、release 不调用本函数。
 * - 每个现金批次一条不可变分摊；赠送/授信消费各记一条（collectorTenantId=NULL）。
 * - 幂等：按 idempotencyKey 查重，已存在直接返回。
 * - shadow 模式：每行写入包在 savepoint 内，失败只回滚该行并显式返回失败键，
 *   绝不静默吞错，也不阻断主计费事务；不写正式结算应计。
 * - active 模式：allocation 与 settlement accrual 与现金批次扣减同事务原子；
 *   任一失败直接抛出（capture 回滚），不能完成扣费却丢失对账事实。
 */
export async function recordConsumptionAllocationsInTransaction(
  trx: AllocationDb,
  input: {
    userId: number;
    workspaceId?: string | null;
    chargedGuMicros: number;
    breakdown: Array<{
      source: "gift" | "cash" | "credit";
      amountMicros: number;
      creditLotId?: string | null;
      sellerTenantId?: string | null;
      grantId?: string | null;
    }>;
    ledgerId?: string | null;
    usageId?: string | null;
    requestId?: string | null;
    taskId?: string | null;
    pricingRuleId?: string | null;
    pricingRuleRevision?: number | null;
    sourceType?: string | null;
    sourceId?: string | null;
    idempotencyKey: string;
    capturedAt?: number;
    mode?: "shadow" | "active";
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ recorded: number; skipped: boolean; failed: string[] }> {
  if (!isConsumptionAllocationRecordingEnabled(input.env)) return { recorded: 0, skipped: true, failed: [] };
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  if (!idempotencyKey) return { recorded: 0, skipped: true, failed: [] };
  if (!await safeHasTable(trx, CONSUMPTION_ALLOCATION_TABLE)) return { recorded: 0, skipped: true, failed: [] };

  const existing = await trx(CONSUMPTION_ALLOCATION_TABLE).where({ idempotencyKey }).first();
  if (existing) return { recorded: 0, skipped: true, failed: [] };

  const attribution = await readUserAttribution(trx as any, input.userId);
  const mode = input.mode ?? "shadow";
  const capturedAt = input.capturedAt ?? Date.now();

  const rows: Array<Record<string, unknown>> = [];
  for (const item of input.breakdown) {
    if (!Number.isSafeInteger(item.amountMicros) || item.amountMicros <= 0) continue;
    let collectorTenantId: string | null = null;
    let retailPortionMicros = 0;
    let wholesaleAccrualMicros = 0;
    let wholesaleRatePpm = 0;
    let creditLotId: string | null = null;

    if (item.source === "cash" && item.creditLotId) {
      creditLotId = String(item.creditLotId);
      const lot = await trx("o_commercial_credit_lot").where({ id: creditLotId }).first();
      if (lot) {
        // 收款租户以批次真实收款方为准，不从入口或所属租户推断。
        collectorTenantId = String(lot.collectorTenantId || lot.sellerTenantId || DEFAULT_COMMERCIAL_TENANT_ID);
        const accrual = settlementAccrualForLot(lot, item.amountMicros);
        retailPortionMicros = accrual.retailPortionMicros;
        wholesaleAccrualMicros = accrual.wholesaleAccrualMicros;
        wholesaleRatePpm = Number(lot.wholesaleRatePpm || 0);
      } else {
        collectorTenantId = String(item.sellerTenantId || DEFAULT_COMMERCIAL_TENANT_ID);
      }
    }

    rows.push({
      id: uuid(),
      usageId: input.usageId ?? null,
      requestId: input.requestId ?? null,
      taskId: input.taskId ?? null,
      ledgerId: input.ledgerId ?? null,
      userId: Number(input.userId),
      workspaceId: input.workspaceId ?? null,
      spendSource: item.source,
      creditLotId,
      collectorTenantId,
      registeredTenantIdSnapshot: attribution.registeredTenantId,
      ownerTenantIdSnapshot: attribution.ownerTenantId,
      chargedGuMicros: Math.floor(item.amountMicros),
      retailPortionMicros,
      wholesaleAccrualMicros,
      wholesaleRatePpm,
      pricingRuleId: input.pricingRuleId ?? null,
      pricingRuleRevision: input.pricingRuleRevision ?? null,
      settlementMode: mode,
      capturedAt,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      idempotencyKey: item.creditLotId
        ? `${idempotencyKey}:${item.creditLotId}`
        : item.source === "gift" && item.grantId
          ? `${idempotencyKey}:gift:${item.grantId}`
          : `${idempotencyKey}:${item.source}`,
      createdAt: capturedAt,
    });
  }

  if (!rows.length) return { recorded: 0, skipped: true, failed: [] };
  // 外层幂等键不直接落库（行级键为 `${idempotencyKey}:${lotId|source}`）；
  // 全部行键已存在时视为重放，保持 exactly-once 财务结果。
  {
    const rowKeys = rows.map((row) => String(row.idempotencyKey));
    const existingRows = await trx(CONSUMPTION_ALLOCATION_TABLE)
      .whereIn("idempotencyKey", rowKeys)
      .select("idempotencyKey");
    if (existingRows.length === rowKeys.length) {
      return { recorded: 0, skipped: true, failed: [] };
    }
  }
  let recorded = 0;
  const failed: string[] = [];
  for (const row of rows) {
    const rowIdempotencyKey = String(row.idempotencyKey);
    if (mode === "active") {
      // active：allocation + settlement accrual 同事务原子；失败抛出（capture 回滚）。
      const preExisting = await trx(CONSUMPTION_ALLOCATION_TABLE)
        .where({ idempotencyKey: rowIdempotencyKey })
        .first();
      if (!preExisting) {
        await trx(CONSUMPTION_ALLOCATION_TABLE).insert(row);
        recorded += 1;
      }
      if (row.spendSource === "cash" && row.collectorTenantId) {
        await insertSettlementAccrual(trx, {
          tenantId: String(row.collectorTenantId),
          amountMicros: Number(row.wholesaleAccrualMicros || 0),
          creditLotId: row.creditLotId ? String(row.creditLotId) : null,
          allocationIdempotencyKey: rowIdempotencyKey,
          sourceType: input.sourceType ?? "consumption_capture",
          sourceId: input.sourceId ?? null,
          capturedAt,
        });
      }
      continue;
    }
    // shadow：savepoint 隔离；失败行显式报告，绝不静默吞错。
    const inserted = await withSavepoint(trx, async (sp) => {
      const preExisting = await sp(CONSUMPTION_ALLOCATION_TABLE)
        .where({ idempotencyKey: rowIdempotencyKey })
        .first();
      if (preExisting) return false;
      await sp(CONSUMPTION_ALLOCATION_TABLE).insert(row);
      return true;
    });
    if (inserted === null) {
      failed.push(rowIdempotencyKey);
    } else if (inserted) {
      recorded += 1;
    }
  }
  return { recorded, skipped: false, failed };
}

/**
 * active 模式消费应计：向收款租户结算账本写入不可变应计流水。
 * 应计不要求余额充足（应付事实），账期关账时统一结算。
 * 幂等：accrual:{allocationIdempotencyKey}。
 */
async function insertSettlementAccrual(
  trx: AllocationDb,
  input: {
    tenantId: string;
    amountMicros: number;
    creditLotId: string | null;
    allocationIdempotencyKey: string;
    sourceType: string | null;
    sourceId: string | null;
    capturedAt: number;
  },
): Promise<void> {
  const amount = Math.floor(Number(input.amountMicros || 0));
  if (amount <= 0) return;
  const idempotencyKey = `accrual:${input.allocationIdempotencyKey}`;
  const existing = await trx(SETTLEMENT_LEDGER_TABLE).where({ idempotencyKey }).first();
  if (existing) return;
  const account = await ensureSettlementAccountRow(trx, input.tenantId);
  const balance = Number(account?.balanceMicros || 0);
  const timestamp = Date.now();
  await trx(SETTLEMENT_LEDGER_TABLE).insert({
    id: uuid(),
    tenantId: input.tenantId,
    type: "consumption_accrual",
    direction: "debit",
    amountMicros: amount,
    currency: "CNY",
    // 应计不立即变动结算余额；balanceBefore/After 记录应计时点余额。
    balanceBeforeMicros: balance,
    balanceAfterMicros: balance,
    creditLotId: input.creditLotId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    idempotencyKey,
    description: "消费 capture 应计（active 结算）",
    metadata: JSON.stringify({ allocationIdempotencyKey: input.allocationIdempotencyKey }),
    operatorUserId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

async function ensureSettlementAccountRow(
  trx: AllocationDb,
  tenantId: string,
): Promise<Record<string, unknown> | null> {
  const existing = await trx(SETTLEMENT_ACCOUNT_TABLE).where({ tenantId }).first();
  if (existing) return existing;
  const timestamp = Date.now();
  try {
    await trx(SETTLEMENT_ACCOUNT_TABLE).insert({
      tenantId,
      balanceMicros: 0,
      currency: "CNY",
      status: "active",
      metadata: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  } catch {
    // 并发创建时复用既有行。
  }
  return await trx(SETTLEMENT_ACCOUNT_TABLE).where({ tenantId }).first();
}

async function safeHasTable(trx: AllocationDb, table: string): Promise<boolean> {
  try {
    return await (trx as any).schema.hasTable(table);
  } catch {
    return false;
  }
}

/**
 * savepoint 包裹（仅 shadow 模式使用）：PG 中嵌套事务为 SAVEPOINT，失败只回滚
 * 保存点，不影响外层计费事务。失败返回 null 并由调用方显式收集为失败键。
 * active 模式不使用本函数——失败必须使整个 capture 回滚。
 */
async function withSavepoint<T>(
  trx: AllocationDb,
  action: (sp: AllocationDb) => Promise<T>,
): Promise<T | null> {
  const asTrx = trx as any;
  if (typeof asTrx.transaction === "function") {
    try {
      return await asTrx.transaction(async (sp: any) => await action(sp));
    } catch {
      return null;
    }
  }
  try {
    return await action(trx);
  } catch {
    return null;
  }
}

/**
 * 记录一次上游调用的估算官方成本。
 * 幂等：usageId+provider 已存在则跳过（估算只记一次，后续由账单导入覆盖为正式成本）。
 */
export async function recordProviderCostEstimateInTransaction(
  trx: AllocationDb,
  input: {
    usageId?: string | null;
    requestId?: string | null;
    provider: string;
    channel?: string | null;
    model?: string | null;
    estimatedCostMicros: number;
    currency?: string;
    providerPriceRevision?: number | null;
    metadata?: Record<string, unknown>;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ recorded: boolean }> {
  // 供应商成本是平台自身的成本事实，不属于租户结算 V2 开关；即使租户
  // 分摊仍为 off，也必须尝试留存。滚动升级期间旧 schema 尚无表时安全跳过。
  if (!await safeHasTable(trx, PROVIDER_COST_LEDGER_TABLE)) return { recorded: false };
  const estimatedCostMicros = Math.max(0, Math.floor(Number(input.estimatedCostMicros || 0)));
  if (estimatedCostMicros <= 0) return { recorded: false };
  const provider = String(input.provider || "").trim();
  if (!provider) return { recorded: false };
  const usageId = input.usageId ? String(input.usageId) : null;
  if (usageId) {
    const existing = await trx(PROVIDER_COST_LEDGER_TABLE).where({ usageId, provider }).first();
    if (existing) return { recorded: false };
  }
  const timestamp = Date.now();
  try {
    await trx(PROVIDER_COST_LEDGER_TABLE).insert({
      id: uuid(),
      usageId,
      requestId: input.requestId ? String(input.requestId) : null,
      provider,
      channel: input.channel ? String(input.channel) : null,
      model: input.model ? String(input.model) : null,
      estimatedCostMicros,
      officialCostMicros: null,
      currency: String(input.currency || "CNY"),
      providerPriceRevision: input.providerPriceRevision ?? null,
      invoiceId: null,
      billingPeriod: null,
      state: "estimated",
      differenceMicros: null,
      metadata: JSON.stringify(input.metadata || {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return { recorded: true };
  } catch (error) {
    const message = String((error as any)?.message || "");
    if (/duplicate|unique/i.test(message)) return { recorded: false };
    throw error;
  }
}

/**
 * 导入官方账单：把估算成本确认为正式成本，产生差异调整。
 * 差异不覆盖原记录：officialCostMicros + differenceMicros + state=confirmed/adjusted。
 */
export async function confirmProviderCostWithOfficialBill(
  database: AllocationDb,
  input: {
    usageId: string;
    provider: string;
    officialCostMicros: number;
    invoiceId?: string | null;
    billingPeriod?: string | null;
    currency?: string;
    operatorUserId?: number | null;
  },
): Promise<{ updated: number; differenceMicros: number }> {
  const usageId = String(input.usageId || "").trim();
  const provider = String(input.provider || "").trim();
  const officialCostMicros = Math.max(0, Math.floor(Number(input.officialCostMicros || 0)));
  if (!usageId || !provider) {
    throw new Error("usageId 与 provider 必填");
  }
  const rows = await database(PROVIDER_COST_LEDGER_TABLE).where({ usageId, provider });
  if (!rows.length) return { updated: 0, differenceMicros: 0 };
  const timestamp = Date.now();
  let updated = 0;
  let totalDifference = 0;
  for (const row of rows) {
    if (String(row.state) === "confirmed" || String(row.state) === "adjusted") continue;
    const estimated = Number(row.estimatedCostMicros || 0);
    const difference = officialCostMicros - estimated;
    const affected = await database(PROVIDER_COST_LEDGER_TABLE)
      .where({ id: row.id, state: "estimated" })
      .update({
        officialCostMicros,
        differenceMicros: difference,
        invoiceId: input.invoiceId ?? null,
        billingPeriod: input.billingPeriod ?? null,
        currency: String(input.currency || row.currency || "CNY"),
        state: difference === 0 ? "confirmed" : "adjusted",
        updatedAt: timestamp,
      });
    if (Number(affected || 0) === 1) {
      updated += 1;
      totalDifference += difference;
    }
  }
  return { updated, differenceMicros: totalDifference };
}

/**
 * R7 canonical 计费完成边界钩子：确认计费（capture/deduct 成功）的用量
 * 统一写入估算供应商成本。
 * - 估算来源：metadata.providerCostMicros（调用方掌握真实拆分时显式提供）
 *   或官方参考价目表（可由 units 唯一决定的模型，如按张计费的图片模型）。
 * - 绝不用零售 GU 价格冒充供应商成本；无法可靠估算时不写行（不制造假事实）。
 * - 失败语义：active 模式抛出（capture 回滚，fail closed）；shadow 模式
 *   显式告警（不静默忽略）。上游失败、取消、未 capture 的调用不会进入本函数。
 */
export async function recordProviderCostForCapturedUsage(
  trx: AllocationDb,
  input: {
    usageRecordId: string;
    requestId?: string | null;
    metadata?: Record<string, unknown> | null;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ recorded: boolean; reason: string | null }> {
  const usageRow = await trx("o_usage_record").where({ id: String(input.usageRecordId) }).first();
  if (!usageRow) return { recorded: false, reason: "usage_record_missing" };
  const provider = String(usageRow.provider || "").trim();
  if (!provider) return { recorded: false, reason: "usage_without_provider" };
  const model = usageRow.model ? String(usageRow.model) : "";
  const units = Number(usageRow.units || 0);
  const unit = String(usageRow.unit || "task");
  const captureMetadata = input.metadata && typeof input.metadata === "object"
    ? input.metadata
    : {};
  const priceSnapshot = captureMetadata.priceSnapshot
    && typeof captureMetadata.priceSnapshot === "object"
    && !Array.isArray(captureMetadata.priceSnapshot)
    ? captureMetadata.priceSnapshot as Record<string, unknown>
    : {};

  let estimatedCostMicros = 0;
  let providerPriceRevision: number | null = null;
  const explicitCost = Number(captureMetadata.providerCostMicros);
  if (Number.isFinite(explicitCost) && explicitCost > 0) {
    estimatedCostMicros = Math.floor(explicitCost);
    const explicitRevision = Number(
      captureMetadata.providerPriceRevision,
    );
    providerPriceRevision = Number.isSafeInteger(explicitRevision) && explicitRevision > 0
      ? explicitRevision
      : null;
  } else {
    const reference = estimateVolcengineProviderCostMicros({
      model,
      units,
      unit,
      resolution: String(captureMetadata.resolution ?? priceSnapshot.resolution ?? ""),
      referenceImageCount: captureMetadata.referenceImageCount == null ? null : Number(captureMetadata.referenceImageCount),
      textTokens: captureMetadata.textTokens == null ? null : Number(captureMetadata.textTokens),
      mediaTokens: captureMetadata.mediaTokens == null ? null : Number(captureMetadata.mediaTokens),
      inputTokens: Number(captureMetadata.inputTokens),
      outputTokens: Number(captureMetadata.outputTokens ?? captureMetadata.completionTokens),
      cachedTokens: Number(captureMetadata.cacheTokens ?? captureMetadata.cachedTokens ?? 0),
      videoInputPricingTier: (
        captureMetadata.videoInputPricingTier
        ?? priceSnapshot.videoInputPricingTier
        ?? null
      ) as "with_video_input" | "without_video_input" | null,
      pricedAt: Number(usageRow.createTime || Date.now()),
    });
    if (reference) {
      estimatedCostMicros = reference.estimatedCostMicros;
      providerPriceRevision = Number(
        reference.providerPriceRevision.replace(/-/g, "").slice(0, 8),
      ) || null;
    }
  }
  if (estimatedCostMicros <= 0) {
    return { recorded: false, reason: "estimate_unavailable" };
  }

  try {
    const outcome = await recordProviderCostEstimateInTransaction(trx, {
      usageId: String(usageRow.id),
      requestId: input.requestId ?? (usageRow.taskId ? String(usageRow.taskId) : null),
      provider,
      channel: usageRow.channelId ? String(usageRow.channelId) : null,
      model: model || null,
      estimatedCostMicros,
      providerPriceRevision,
      metadata: {
        unit,
        units,
        endpointType: String(usageRow.endpointType || ""),
        estimateSource: providerPriceRevision === 20260909 ? "official-list-price-times-contract-0.85" : "provider-cost-reference",
        officialInvoiceVerified: false,
        inputTokens: captureMetadata.inputTokens ?? null,
        outputTokens: captureMetadata.outputTokens ?? captureMetadata.completionTokens ?? null,
        cacheTokens: captureMetadata.cacheTokens ?? captureMetadata.cachedTokens ?? null,
        videoInputPricingTier: captureMetadata.videoInputPricingTier
          ?? priceSnapshot.videoInputPricingTier
          ?? null,
      },
      env: input.env,
    });
    return { recorded: outcome.recorded, reason: outcome.recorded ? null : "duplicate" };
  } catch (error) {
    if (settlementV2Mode(input.env) === "active") {
      // active：成本事实丢失 fail closed（capture 回滚）。
      throw error;
    }
    // shadow：显式告警，不静默忽略，也不阻断计费。
    console.warn(
      `[provider-cost] shadow estimate write failed for usage ${usageRow.id}: ${String((error as Error)?.message || error)}`,
    );
    return { recorded: false, reason: "write_failed" };
  }
}
