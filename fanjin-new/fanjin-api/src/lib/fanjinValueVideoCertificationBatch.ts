import type { Knex } from "knex";

import {
  FANJIN_VALUE_VIDEO_GENERATION_CHANNEL_ID,
  FANJIN_VALUE_VIDEO_OFFERS,
  fanjinValueVideoPricingRuleId,
  fanjinValueVideoRouteId,
} from "@/lib/fanjinValueVideoOffers";
import {
  evaluateModelRouteCertification,
  fanjinValueVideoGenerationCostEvidence,
  formatModelRouteCertificationRecord,
  MODEL_ROUTE_BASE_OPERATION,
  ModelRouteCertificationError,
  type ModelRouteCertificationRecord,
} from "@/lib/modelRouteCertification";
import {
  evaluateModelRouteCertificationReleaseBatchProof,
  executeModelRouteCertificationBatch,
  MODEL_ROUTE_CERTIFICATION_BATCH_FORMAT,
  parseModelRouteCertificationBatch,
  type ModelRouteCertificationBatch,
  type ModelRouteCertificationBatchReceipt,
} from "@/lib/modelRouteCertificationBatch";
import { parseFanjinValueVideoPricingContract } from "@/lib/fanjinValueVideoPricing";
import { MODEL_ROUTE_CERTIFICATION_TABLE } from "@/lib/migrations/modelRouteCertification";

export const FANJIN_VALUE_VIDEO_CERTIFICATION_BATCH_VERSION =
  "fanjin-value-video-certification-batch/v1" as const;

const EXACT_PUBLIC_MODELS = Object.freeze([
  "fanjin-seedance-2-5-value-720p",
  "fanjin-seedance-2-0-value-720p",
  "fanjin-seedance-2-0-mini-value-720p",
  "fanjin-seedance-2-0-fast-value-720p",
] as const);

type DatabaseRow = Record<string, any>;

export interface FanjinValueVideoCertificationSource {
  publicModel: string;
  upstreamModel: string;
  logicalRouteId: string;
  logicalPricingRuleId: string;
  sourceRouteId: string;
  sourcePricingRuleId: string;
  sourceCertificationId: string;
  taskEvidenceId: string;
  usageEvidenceId: string;
  generationCostEvidenceSha256: string;
  validUntil: number;
}

export interface PreparedFanjinValueVideoCertificationBatch {
  version: typeof FANJIN_VALUE_VIDEO_CERTIFICATION_BATCH_VERSION;
  batch: ModelRouteCertificationBatch;
  sources: FanjinValueVideoCertificationSource[];
  paidRequestsMade: 0;
}

export interface FanjinValueVideoCertificationBatchResult {
  version: typeof FANJIN_VALUE_VIDEO_CERTIFICATION_BATCH_VERSION;
  mode: "validate" | "apply";
  receipt: ModelRouteCertificationBatchReceipt;
  sources: FanjinValueVideoCertificationSource[];
  models: Array<{
    publicModel: string;
    routeId: string;
    certificationId: string | null;
    certificationValid: boolean | null;
    releaseBatchProofValid: boolean | null;
  }>;
  paidRequestsMade: 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function fail(message: string): never {
  throw new ModelRouteCertificationError(message);
}

function assertExactValueOfferInventory(): void {
  const configured = FANJIN_VALUE_VIDEO_OFFERS.map(({ publicModel }) => publicModel).sort();
  const expected = [...EXACT_PUBLIC_MODELS].sort();
  if (
    configured.length !== expected.length
    || new Set(configured).size !== expected.length
    || configured.some((publicModel, index) => publicModel !== expected[index])
  ) {
    fail("繁境特价版认证操作器只允许既定的四个 Seedance 逻辑 SKU");
  }
}

export function fanjinValueVideoCertificationBatchId(
  releaseId: string,
  sourceCommit: string,
): string {
  return `fanjin-value-video:${releaseId}:${sourceCommit}`;
}

function assertLogicalRoute(input: {
  route: DatabaseRow | null | undefined;
  pricingRule: DatabaseRow | null | undefined;
  publicModel: string;
  upstreamModel: string;
}): void {
  const route = input.route;
  const pricingRule = input.pricingRule;
  const routeConfig = object(route?.routeConfig);
  const fulfillment = object(routeConfig.fulfillment);
  if (
    !route
    || text(route.id) !== fanjinValueVideoRouteId(input.publicModel)
    || text(route.scope) !== "platform"
    || text(route.workspaceId)
    || text(route.endpointType) !== "video_generation"
    || text(route.model) !== input.publicModel
    || text(route.provider) !== "volcano"
    || text(route.channelId) !== FANJIN_VALUE_VIDEO_GENERATION_CHANNEL_ID
    || Number(route.disabled || 0) !== 0
    || text(routeConfig.capabilityStatus) !== "verified"
    || text(routeConfig.upstreamModel) !== input.upstreamModel
    || text(fulfillment.pipeline) !== "generate_then_enhance"
    || text(fulfillment.generationResolution).toLowerCase() !== "480p"
    || text(fulfillment.targetResolution).toLowerCase() !== "720p"
    || Number(fulfillment.markupBps) !== parseFanjinValueVideoPricingContract({
      publicModel: input.publicModel,
      ruleConfig: pricingRule?.ruleConfig,
    })?.markupBps
  ) {
    fail(`繁境特价版逻辑路由身份无效: ${input.publicModel}`);
  }
  if (
    !pricingRule
    || text(pricingRule.id) !== fanjinValueVideoPricingRuleId(input.publicModel)
    || text(pricingRule.scope) !== "platform"
    || text(pricingRule.workspaceId)
    || text(pricingRule.endpointType) !== "video_generation"
    || text(pricingRule.provider) !== "volcano"
    || text(pricingRule.model) !== input.publicModel
    || text(pricingRule.unit) !== "token"
    || text(pricingRule.currency).toUpperCase() !== "GU"
    || !Number.isSafeInteger(Number(pricingRule.unitPriceMicros))
    || Number(pricingRule.unitPriceMicros) <= 0
    || Number(pricingRule.disabled || 0) !== 0
  ) {
    fail(`繁境特价版组合定价身份无效: ${input.publicModel}`);
  }
}

async function sourceMatches(input: {
  database: Knex | Knex.Transaction;
  publicModel: string;
  upstreamModel: string;
  expectedGenerationCostEvidenceSha256: string;
  certification: ModelRouteCertificationRecord;
  now: number;
}): Promise<{
  route: DatabaseRow;
  pricingRule: DatabaseRow;
  task: DatabaseRow;
  usage: DatabaseRow;
  evidenceSha256: string;
} | null> {
  const [route, pricingRule, task, usage] = await Promise.all([
    input.database("o_model_route").where({ id: input.certification.routeId }).first(),
    input.database("o_pricing_rule").where({ id: input.certification.pricingRuleId }).first(),
    input.database("o_relay_task").where({ id: input.certification.taskEvidenceId }).first(),
    input.database("o_usage_record").where({ id: input.certification.usageEvidenceId }).first(),
  ]);
  if (
    !route
    || !pricingRule
    || !task
    || !usage
    || text(route.model) !== input.upstreamModel
    || text(route.endpointType) !== "video_generation"
    || text(route.provider) !== "volcano"
    || Number(route.disabled || 0) !== 0
    || text(pricingRule.model) !== input.upstreamModel
    || text(pricingRule.endpointType) !== "video_generation"
    || text(pricingRule.provider) !== "volcano"
    || text(pricingRule.unit) !== "token"
    || text(pricingRule.currency).toUpperCase() !== "GU"
    || Number(pricingRule.disabled || 0) !== 0
  ) return null;
  const readiness = await evaluateModelRouteCertification({
    database: input.database,
    route,
    pricingRule,
    now: input.now,
  });
  const base = readiness.operations.find(
    (operation) => operation.operationKey === MODEL_ROUTE_BASE_OPERATION,
  );
  if (!readiness.valid || !base?.valid || base.certification?.id !== input.certification.id) {
    return null;
  }
  try {
    const evidenceSha256 = fanjinValueVideoGenerationCostEvidence({
      publicModel: input.publicModel,
      upstreamModel: input.upstreamModel,
      route,
      pricingRule,
      certification: input.certification,
      task,
      usage,
    }).sha256;
    return evidenceSha256 === input.expectedGenerationCostEvidenceSha256
      ? { route, pricingRule, task, usage, evidenceSha256 }
      : null;
  } catch {
    return null;
  }
}

/**
 * Reconstructs the exact four logical certifications exclusively from
 * persisted, already charged source tasks and the current composite pricing
 * contracts. It never calls a provider and never trusts caller-supplied task,
 * usage, price or source-certification identifiers.
 */
export async function prepareFanjinValueVideoCertificationBatch(input: {
  database: Knex | Knex.Transaction;
  releaseId: string;
  sourceCommit: string;
  actorUserId: number;
  now?: number;
}): Promise<PreparedFanjinValueVideoCertificationBatch> {
  assertExactValueOfferInventory();
  const now = input.now ?? Date.now();
  const entries: ModelRouteCertificationBatch["entries"] = [];
  const sources: FanjinValueVideoCertificationSource[] = [];
  const candidateRows = await input.database(MODEL_ROUTE_CERTIFICATION_TABLE)
    .where({ operationKey: MODEL_ROUTE_BASE_OPERATION })
    .whereNull("revokedAt")
    .orderBy("certifiedAt", "desc")
    .orderBy("id", "desc");

  for (const definition of FANJIN_VALUE_VIDEO_OFFERS) {
    const logicalRouteId = fanjinValueVideoRouteId(definition.publicModel);
    const logicalPricingRuleId = fanjinValueVideoPricingRuleId(definition.publicModel);
    const [logicalRoute, logicalPricingRule] = await Promise.all([
      input.database("o_model_route").where({ id: logicalRouteId }).first(),
      input.database("o_pricing_rule").where({ id: logicalPricingRuleId }).first(),
    ]);
    assertLogicalRoute({
      route: logicalRoute,
      pricingRule: logicalPricingRule,
      publicModel: definition.publicModel,
      upstreamModel: definition.upstreamModel,
    });
    const contract = parseFanjinValueVideoPricingContract({
      publicModel: definition.publicModel,
      ruleConfig: logicalPricingRule.ruleConfig,
    });
    if (!contract || contract.upstreamModel !== definition.upstreamModel) {
      fail(`繁境特价版组合定价契约无效: ${definition.publicModel}`);
    }

    const matches: Array<{
      certification: ModelRouteCertificationRecord;
      route: DatabaseRow;
      pricingRule: DatabaseRow;
      evidenceSha256: string;
    }> = [];
    for (const row of candidateRows) {
      const certification = formatModelRouteCertificationRecord(row);
      if (certification.validUntil <= now) continue;
      const source = await sourceMatches({
        database: input.database,
        publicModel: definition.publicModel,
        upstreamModel: definition.upstreamModel,
        expectedGenerationCostEvidenceSha256: contract.generationCostEvidenceSha256,
        certification,
        now,
      });
      if (source) matches.push({ certification, ...source });
    }
    if (matches.length !== 1) {
      fail(
        `繁境特价版必须且只能匹配一条有效原生生成认证: ${definition.publicModel} (${matches.length})`,
      );
    }
    const source = matches[0];
    entries.push({
      routeId: logicalRouteId,
      pricingRuleId: logicalPricingRuleId,
      operationKey: MODEL_ROUTE_BASE_OPERATION,
      priceSourceUrl: source.certification.priceSourceUrl,
      priceSourceDigest: source.certification.priceSourceDigest,
      priceCheckedAt: source.certification.priceCheckedAt,
      upstreamCurrency: source.certification.upstreamCurrency,
      upstreamUnitPriceMicros: source.certification.upstreamUnitPriceMicros,
      billingCurrency: source.certification.billingCurrency,
      billingDimension: source.certification.billingDimension,
      taskEvidenceId: source.certification.taskEvidenceId,
      usageEvidenceId: source.certification.usageEvidenceId,
      validUntil: source.certification.validUntil,
    });
    sources.push({
      publicModel: definition.publicModel,
      upstreamModel: definition.upstreamModel,
      logicalRouteId,
      logicalPricingRuleId,
      sourceRouteId: source.route.id,
      sourcePricingRuleId: source.pricingRule.id,
      sourceCertificationId: source.certification.id,
      taskEvidenceId: source.certification.taskEvidenceId,
      usageEvidenceId: source.certification.usageEvidenceId,
      generationCostEvidenceSha256: source.evidenceSha256,
      validUntil: source.certification.validUntil,
    });
  }

  const batch = parseModelRouteCertificationBatch({
    format: MODEL_ROUTE_CERTIFICATION_BATCH_FORMAT,
    batchId: fanjinValueVideoCertificationBatchId(
      text(input.releaseId),
      text(input.sourceCommit).toLowerCase(),
    ),
    releaseId: text(input.releaseId),
    sourceCommit: text(input.sourceCommit).toLowerCase(),
    actorUserId: input.actorUserId,
    entries,
  });
  if (batch.entries.length !== EXACT_PUBLIC_MODELS.length) {
    fail("繁境特价版认证批次必须恰好包含四条认证");
  }
  return {
    version: FANJIN_VALUE_VIDEO_CERTIFICATION_BATCH_VERSION,
    batch,
    sources,
    paidRequestsMade: 0,
  };
}

export async function executeFanjinValueVideoCertificationBatch(input: {
  database: Knex;
  releaseId: string;
  sourceCommit: string;
  actorUserId: number;
  mode?: "validate" | "apply";
  now?: number;
}): Promise<FanjinValueVideoCertificationBatchResult> {
  const mode = input.mode ?? "validate";
  const prepared = await prepareFanjinValueVideoCertificationBatch(input);
  const receipt = await executeModelRouteCertificationBatch({
    database: input.database,
    batch: prepared.batch,
    mode,
    now: input.now,
  });
  const models: FanjinValueVideoCertificationBatchResult["models"] = [];
  if (mode === "apply") {
    for (const definition of FANJIN_VALUE_VIDEO_OFFERS) {
      const routeId = fanjinValueVideoRouteId(definition.publicModel);
      const pricingRuleId = fanjinValueVideoPricingRuleId(definition.publicModel);
      const [route, pricingRule] = await Promise.all([
        input.database("o_model_route").where({ id: routeId }).first(),
        input.database("o_pricing_rule").where({ id: pricingRuleId }).first(),
      ]);
      const readiness = await evaluateModelRouteCertification({
        database: input.database,
        route,
        pricingRule,
        now: input.now,
      });
      const proof = await evaluateModelRouteCertificationReleaseBatchProof({
        database: input.database,
        readiness,
        expectedReleaseId: prepared.batch.releaseId,
        expectedSourceCommit: prepared.batch.sourceCommit,
      });
      const certification = readiness.operations.find(
        (operation) => operation.operationKey === MODEL_ROUTE_BASE_OPERATION,
      )?.certification ?? null;
      if (!readiness.valid || readiness.hiddenFromUserCatalog || !proof.valid) {
        fail(`繁境特价版认证落库后读回失败: ${definition.publicModel}`);
      }
      models.push({
        publicModel: definition.publicModel,
        routeId,
        certificationId: certification?.id ?? null,
        certificationValid: true,
        releaseBatchProofValid: true,
      });
    }
  } else {
    for (const definition of FANJIN_VALUE_VIDEO_OFFERS) {
      models.push({
        publicModel: definition.publicModel,
        routeId: fanjinValueVideoRouteId(definition.publicModel),
        certificationId: null,
        certificationValid: null,
        releaseBatchProofValid: null,
      });
    }
  }
  return {
    version: FANJIN_VALUE_VIDEO_CERTIFICATION_BATCH_VERSION,
    mode,
    receipt,
    sources: prepared.sources,
    models,
    paidRequestsMade: 0,
  };
}
