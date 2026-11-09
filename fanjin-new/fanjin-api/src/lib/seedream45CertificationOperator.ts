import type { Knex } from "knex";
import { v5 as uuidv5 } from "uuid";

import { writeAuditLog } from "@/lib/audit";
import { calculatePricingCost } from "@/lib/billing";
import {
  executeModelRouteCertificationBatch,
  MODEL_ROUTE_CERTIFICATION_BATCH_FORMAT,
  type ModelRouteCertificationBatch,
  type ModelRouteCertificationBatchReceipt,
} from "@/lib/modelRouteCertificationBatch";
import {
  evaluateModelRouteCertification,
  modelRouteCertificationPricingSnapshotHash,
  modelRouteCertificationRouteSnapshotHash,
  modelRouteOperationForRequest,
} from "@/lib/modelRouteCertification";
import { acquireModelRouteCertificationAdvisoryFence } from "@/lib/modelRouteCertificationMutationFence";
import {
  SEEDREAM45_CERTIFICATION_FIXED_PROMPT,
  SEEDREAM45_CERTIFICATION_MAX_TOTAL_GU_MICROS,
  SEEDREAM45_CERTIFICATION_MODEL,
  SEEDREAM45_CERTIFICATION_PRICING_RULE_ID,
  SEEDREAM45_CERTIFICATION_PROBE_VERSION,
  SEEDREAM45_CERTIFICATION_ROUTE_ID,
  SEEDREAM45_CERTIFICATION_WORKSPACE_NAME,
  seedream45CertificationProbeRequest,
  type Seedream45CertificationProbePermit,
  type Seedream45CertificationQuality,
} from "@/lib/seedream45CertificationProbe";
import { processQuickCreateImageTask } from "@/lib/quickCreateImageTask";
import type { RelayTask } from "@/lib/relay";

const TASK_NAMESPACE = "84a08f78-109f-4b95-a0dc-c1b7f4abf01a";
const QUALITIES = ["2K", "4K"] as const;

type Row = Record<string, any>;

export interface Seedream45CertificationCommercialEvidence {
  priceSourceUrl: string;
  priceSourceDigest: string;
  priceCheckedAt: number;
  upstreamCurrency: string;
  upstreamUnitPriceMicros: number;
  validUntil: number;
}

export interface Seedream45CertificationOperatorInput {
  probeId: string;
  projectId: number;
  adminUserId: number;
  createdAt: number;
  expiresAt: number;
  releaseId: string;
  sourceCommit: string;
  artifactSha256: string;
  commercialEvidence: Seedream45CertificationCommercialEvidence;
}

export interface Seedream45CertificationArmReceipt {
  format: "seedream-4.5-quality-certification-arm/v1";
  mode: "validate" | "apply";
  probeId: string;
  taskIds: Record<Seedream45CertificationQuality, string>;
  state: "planned" | "armed" | "already_armed";
  maxTotalGuMicros: number;
  estimatedTotalGuMicros: number;
  completedAt: number;
}

export interface Seedream45CertificationOperatorReceipt {
  format: "seedream-4.5-quality-certification-operator/v1";
  probeId: string;
  state: "certified";
  taskEvidence: Array<{
    quality: Seedream45CertificationQuality;
    taskId: string;
    usageId: string;
    status: "succeeded";
    usageStatus: "charged";
  }>;
  certification: ModelRouteCertificationBatchReceipt;
  completedAt: number;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function parseJson(value: unknown): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stableJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]));
    }
    return current;
  };
  return JSON.stringify(normalize(value));
}

function fail(code: string): never {
  const error: any = new Error(code);
  error.code = code;
  throw error;
}

function assertInput(input: Seedream45CertificationOperatorInput, now: number): void {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(input.probeId)
    || !Number.isSafeInteger(input.projectId)
    || input.projectId <= 0
    || !Number.isSafeInteger(input.adminUserId)
    || input.adminUserId <= 0
    || !Number.isSafeInteger(input.createdAt)
    || !Number.isSafeInteger(input.expiresAt)
    || input.createdAt > now
    || input.expiresAt <= now
    || input.expiresAt - input.createdAt > 30 * 60_000
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.releaseId)
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(input.sourceCommit)
    || !/^[a-f0-9]{64}$/u.test(input.artifactSha256)
    || !/^https:\/\//u.test(input.commercialEvidence.priceSourceUrl)
    || /[?#].*(?:key|token|secret|signature|credential)=/iu.test(input.commercialEvidence.priceSourceUrl)
    || !/^[a-f0-9]{64}$/u.test(input.commercialEvidence.priceSourceDigest)
    || !Number.isSafeInteger(input.commercialEvidence.priceCheckedAt)
    || input.commercialEvidence.priceCheckedAt <= 0
    || !/^[A-Z]{3}$/u.test(input.commercialEvidence.upstreamCurrency)
    || !Number.isSafeInteger(input.commercialEvidence.upstreamUnitPriceMicros)
    || input.commercialEvidence.upstreamUnitPriceMicros <= 0
    || !Number.isSafeInteger(input.commercialEvidence.validUntil)
    || input.commercialEvidence.validUntil <= now
  ) fail("SEEDREAM45_CERTIFICATION_OPERATOR_INPUT_INVALID");
}

function taskId(probeId: string, quality: Seedream45CertificationQuality): string {
  return uuidv5(`${probeId}:${quality}`, TASK_NAMESPACE);
}

function taskRequestId(probeId: string, quality: Seedream45CertificationQuality): string {
  return `seedream45-certification:${probeId}:${quality.toLowerCase()}`;
}

async function assertNoAmbiguousPriorProbe(
  database: Knex | Knex.Transaction,
  currentTaskIds: readonly string[],
): Promise<void> {
  const prior = await database("o_relay_task")
    .select("id", "status", "providerTaskId")
    .where({
      endpointType: "image_generation",
      model: SEEDREAM45_CERTIFICATION_MODEL,
    })
    .where("requestId", "like", "seedream45-certification:%")
    .whereNotIn("id", currentTaskIds);
  if (prior.length === 0) return;

  const usage = await database("o_usage_record")
    .select("taskId", "status")
    .whereIn("taskId", prior.map((row) => text(row.id)));
  const hasAmbiguousPrior = prior.some((row) => {
    const status = text(row.status).toLowerCase();
    if (status !== "failed" || text(row.providerTaskId)) return true;
    return usage.some((entry) =>
      text(entry.taskId) === text(row.id)
      && !["released", "refunded"].includes(text(entry.status).toLowerCase())
    );
  });
  if (hasAmbiguousPrior) {
    // A provider dispatch boundary is durable before the synchronous POST.
    // Never create a fresh paid probe while an older probe may have reached
    // the provider. Operators must reconcile or finish the original probe.
    fail("SEEDREAM45_CERTIFICATION_PRIOR_PROBE_REQUIRES_RECONCILIATION");
  }
}

async function resolvePlanRows(database: Knex | Knex.Transaction, input: Seedream45CertificationOperatorInput) {
  const workspaceRows = await database("o_workspace")
    .where({ name: SEEDREAM45_CERTIFICATION_WORKSPACE_NAME, status: "active" });
  if (workspaceRows.length !== 1) fail("SEEDREAM45_CERTIFICATION_WORKSPACE_NOT_UNIQUE");
  const workspace = workspaceRows[0];
  const [route, pricing, actor, project] = await Promise.all([
    database("o_model_route").where({ id: SEEDREAM45_CERTIFICATION_ROUTE_ID }).first(),
    database("o_pricing_rule").where({ id: SEEDREAM45_CERTIFICATION_PRICING_RULE_ID }).first(),
    database("o_user").where({ id: input.adminUserId }).first(),
    database("o_project").where({ id: input.projectId, workspaceId: workspace.id }).first(),
  ]);
  const exactChannel = route?.channelId
    ? await database("o_provider_channel").where({ id: route.channelId }).first()
    : null;
  if (
    !route
    || text(route.endpointType) !== "image_generation"
    || text(route.model) !== SEEDREAM45_CERTIFICATION_MODEL
    || text(route.provider) !== "volcano"
    || !text(route.channelId)
    || Number(route.disabled || 0) !== 0
    || !pricing
    || text(pricing.endpointType) !== "image_generation"
    || text(pricing.provider) !== "volcano"
    || text(pricing.model) !== SEEDREAM45_CERTIFICATION_MODEL
    || text(pricing.unit) !== "image"
    || text(pricing.currency).toUpperCase() !== "GU"
    || Number(pricing.disabled || 0) !== 0
    || !exactChannel
    || text(exactChannel.id) !== text(route.channelId)
    || text(exactChannel.endpointType) !== "image_generation"
    || text(exactChannel.provider) !== "volcano"
    || Number(exactChannel.disabled || 0) !== 0
    || text(exactChannel.healthStatus).toLowerCase() !== "ok"
    || !actor
    || text(actor.status).toLowerCase() !== "active"
    || !["root", "admin", "super_admin"].includes(text(actor.role).toLowerCase())
    || !project
    || text(project.deletionState).toLowerCase() !== "active"
  ) fail("SEEDREAM45_CERTIFICATION_OPERATOR_RESOURCE_MISMATCH");
  const baseReadiness = await evaluateModelRouteCertification({ database, route, pricingRule: pricing });
  const base = baseReadiness.operations.find((operation) => operation.operationKey === "route");
  if (!base?.valid) fail("SEEDREAM45_CERTIFICATION_BASE_ROUTE_NOT_VALID");
  const perImage = calculatePricingCost(pricing, 1);
  if (!Number.isSafeInteger(perImage) || perImage <= 0 || perImage * 2 > SEEDREAM45_CERTIFICATION_MAX_TOTAL_GU_MICROS) {
    fail("SEEDREAM45_CERTIFICATION_TOTAL_GU_CAP_EXCEEDED");
  }
  return { workspace, route, pricing, channel: exactChannel, actor, project, perImage };
}

function buildPermit(input: Seedream45CertificationOperatorInput, rows: Awaited<ReturnType<typeof resolvePlanRows>>): Seedream45CertificationProbePermit {
  return {
    version: SEEDREAM45_CERTIFICATION_PROBE_VERSION,
    probeId: input.probeId,
    workspaceId: text(rows.workspace.id),
    projectId: input.projectId,
    adminUserId: input.adminUserId,
    routeId: SEEDREAM45_CERTIFICATION_ROUTE_ID,
    channelId: text(rows.channel.id),
    pricingRuleId: SEEDREAM45_CERTIFICATION_PRICING_RULE_ID,
    model: SEEDREAM45_CERTIFICATION_MODEL,
    provider: "volcano",
    taskIds: {
      "2K": taskId(input.probeId, "2K"),
      "4K": taskId(input.probeId, "4K"),
    },
    routeSnapshotHash: modelRouteCertificationRouteSnapshotHash(rows.route),
    pricingSnapshotHash: modelRouteCertificationPricingSnapshotHash(rows.pricing),
    maxTotalGuMicros: SEEDREAM45_CERTIFICATION_MAX_TOTAL_GU_MICROS,
    releaseId: input.releaseId,
    sourceCommit: input.sourceCommit,
    artifactSha256: input.artifactSha256,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
}

function taskRow(input: {
  permit: Seedream45CertificationProbePermit;
  quality: Seedream45CertificationQuality;
  now: number;
}): Row {
  const generation = seedream45CertificationProbeRequest(input.quality);
  return {
    id: input.permit.taskIds[input.quality],
    apiKeyId: null,
    workspaceId: input.permit.workspaceId,
    projectId: input.permit.projectId,
    requestId: taskRequestId(input.permit.probeId, input.quality),
    endpointType: "image_generation",
    provider: null,
    channelId: null,
    model: SEEDREAM45_CERTIFICATION_MODEL,
    status: "queued",
    requestPayload: JSON.stringify({
      generation,
      quickCreate: {
        projectId: input.permit.projectId,
        prompt: SEEDREAM45_CERTIFICATION_FIXED_PROMPT,
        finalPrompt: SEEDREAM45_CERTIFICATION_FIXED_PROMPT,
        model: SEEDREAM45_CERTIFICATION_MODEL,
        ratio: "1:1",
        quality: input.quality,
        subjects: [],
        skills: [],
        seedream45CertificationProbe: { permit: input.permit, quality: input.quality },
      },
    }),
    providerPayload: JSON.stringify({
      identity: {
        subject: `seedream45-certification-admin:${input.permit.adminUserId}`,
        principalId: `seedream45-certification-admin:${input.permit.adminUserId}`,
        workspaceId: input.permit.workspaceId,
      },
      execution: { mode: "worker", state: "queued" },
    }),
    providerTaskId: null,
    resultPayload: JSON.stringify({ assets: [] }),
    errorMessage: null,
    quotaReserved: 0,
    apiQuotaReserved: 0,
    costMicros: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    heartbeatAt: null,
    createTime: input.now,
    updateTime: input.now,
    submittedAt: null,
    completedAt: null,
  };
}

function assertExistingTaskMatches(expected: Row, actual: Row | undefined): void {
  if (!actual) fail("SEEDREAM45_CERTIFICATION_TASK_IDENTITY_CONFLICT");
  for (const field of [
    "id", "workspaceId", "projectId", "requestId", "endpointType", "model",
  ]) {
    if (text(actual[field]) !== text(expected[field])) fail("SEEDREAM45_CERTIFICATION_TASK_IDENTITY_CONFLICT");
  }
  if (
    stableJson(parseJson(actual.requestPayload)) !== stableJson(parseJson(expected.requestPayload))
    || stableJson(parseJson(actual.providerPayload).identity)
      !== stableJson(parseJson(expected.providerPayload).identity)
  ) fail("SEEDREAM45_CERTIFICATION_TASK_PAYLOAD_CONFLICT");
}

function relayTaskFromRow(row: Row): RelayTask {
  return {
    id: text(row.id),
    apiKeyId: row.apiKeyId == null ? null : text(row.apiKeyId),
    workspaceId: row.workspaceId == null ? null : text(row.workspaceId),
    projectId: row.projectId == null ? null : Number(row.projectId),
    requestId: row.requestId == null ? null : text(row.requestId),
    endpointType: text(row.endpointType) as RelayTask["endpointType"],
    provider: row.provider == null ? null : text(row.provider) as RelayTask["provider"],
    channelId: row.channelId == null ? null : text(row.channelId),
    model: row.model == null ? null : text(row.model),
    status: text(row.status) as RelayTask["status"],
    requestPayload: parseJson(row.requestPayload),
    providerPayload: parseJson(row.providerPayload),
    providerTaskId: row.providerTaskId == null ? null : text(row.providerTaskId),
    resultPayload: parseJson(row.resultPayload),
    errorMessage: row.errorMessage == null ? null : text(row.errorMessage),
    quotaReserved: Number(row.quotaReserved || 0),
    apiQuotaReserved: Number(row.apiQuotaReserved || 0),
    costMicros: Number(row.costMicros || 0),
    leaseOwner: row.leaseOwner == null ? null : text(row.leaseOwner),
    leaseExpiresAt: row.leaseExpiresAt == null ? null : Number(row.leaseExpiresAt),
    attemptCount: Number(row.attemptCount || 0),
    heartbeatAt: row.heartbeatAt == null ? null : Number(row.heartbeatAt),
    createTime: Number(row.createTime || 0),
    updateTime: Number(row.updateTime || 0),
    submittedAt: row.submittedAt == null ? null : Number(row.submittedAt),
    completedAt: row.completedAt == null ? null : Number(row.completedAt),
  };
}

export async function armSeedream45CertificationProbe(input: {
  database: Knex;
  operator: Seedream45CertificationOperatorInput;
  mode: "validate" | "apply";
  now?: number;
}): Promise<Seedream45CertificationArmReceipt> {
  const now = Number(input.now ?? Date.now());
  assertInput(input.operator, now);
  const rows = await resolvePlanRows(input.database, input.operator);
  const permit = buildPermit(input.operator, rows);
  await assertNoAmbiguousPriorProbe(
    input.database,
    [permit.taskIds["2K"], permit.taskIds["4K"]],
  );
  const expected = QUALITIES.map((quality) => taskRow({ permit, quality, now }));
  if (input.mode === "validate") {
    return {
      format: "seedream-4.5-quality-certification-arm/v1",
      mode: "validate",
      probeId: permit.probeId,
      taskIds: permit.taskIds,
      state: "planned",
      maxTotalGuMicros: permit.maxTotalGuMicros,
      estimatedTotalGuMicros: rows.perImage * 2,
      completedAt: now,
    };
  }
  let state: "armed" | "already_armed" = "armed";
  await input.database.transaction(async (transaction) => {
    await acquireModelRouteCertificationAdvisoryFence(transaction);
    const currentRows = await resolvePlanRows(transaction, input.operator);
    const currentPermit = buildPermit(input.operator, currentRows);
    if (stableJson(currentPermit) !== stableJson(permit)) fail("SEEDREAM45_CERTIFICATION_ROUTE_SNAPSHOT_CHANGED");
    // Re-evaluate under the global certification mutation fence. The outer
    // check makes dry-run useful, but cannot close the two-probe TOCTOU race.
    await assertNoAmbiguousPriorProbe(
      transaction,
      [currentPermit.taskIds["2K"], currentPermit.taskIds["4K"]],
    );
    const existing = await transaction("o_relay_task")
      .whereIn("id", expected.map((row) => row.id));
    if (existing.length === 0) {
      await transaction("o_relay_task").insert(expected);
      await writeAuditLog(
        { actor: { actorUserId: input.operator.adminUserId, actorKind: "user" } },
        {
          action: "operator.seedream45_certification_probe.arm",
          resourceType: "model_route_certification_probe",
          resourceId: permit.probeId,
          required: true,
          metadata: {
            routeId: permit.routeId,
            channelId: permit.channelId,
            pricingRuleId: permit.pricingRuleId,
            taskIds: permit.taskIds,
            releaseId: permit.releaseId,
            sourceCommit: permit.sourceCommit,
            maxTotalGuMicros: permit.maxTotalGuMicros,
          },
        },
        transaction,
      );
    } else {
      if (existing.length !== expected.length) fail("SEEDREAM45_CERTIFICATION_PARTIAL_TASK_SET");
      for (const row of expected) {
        assertExistingTaskMatches(row, existing.find((candidate) => text(candidate.id) === row.id));
      }
      state = "already_armed";
    }
  });
  return {
    format: "seedream-4.5-quality-certification-arm/v1",
    mode: "apply",
    probeId: permit.probeId,
    taskIds: permit.taskIds,
    state,
    maxTotalGuMicros: permit.maxTotalGuMicros,
    estimatedTotalGuMicros: rows.perImage * 2,
    completedAt: now,
  };
}

/**
 * Execute the two already-armed tasks through the ordinary quick-create image
 * provider and billing path.  A queued -> running CAS is the single-worker
 * fence: a concurrent or resumed operator may observe the task, but cannot
 * issue a second paid provider request.
 */
export async function executeSeedream45CertificationProbeTasks(input: {
  database: Knex;
  operator: Seedream45CertificationOperatorInput;
  now?: () => number;
}): Promise<Array<{ quality: Seedream45CertificationQuality; taskId: string; status: string }>> {
  const clock = input.now ?? Date.now;
  const startedAt = Number(clock());
  assertInput(input.operator, startedAt);
  const rows = await resolvePlanRows(input.database, input.operator);
  const permit = buildPermit(input.operator, rows);
  const outcomes: Array<{
    quality: Seedream45CertificationQuality;
    taskId: string;
    status: string;
  }> = [];

  for (const quality of QUALITIES) {
    const expected = taskRow({ permit, quality, now: input.operator.createdAt });
    let claimed: Row | null = null;
    await input.database.transaction(async (transaction) => {
      await acquireModelRouteCertificationAdvisoryFence(transaction);
      const current = await transaction("o_relay_task")
        .where({ id: permit.taskIds[quality] })
        .first();
      assertExistingTaskMatches(expected, current);
      const status = text(current.status);
      if (status === "succeeded") return;
      if (status !== "queued") {
        fail(`SEEDREAM45_CERTIFICATION_${quality}_TASK_NOT_CLAIMABLE`);
      }
      const claimTime = Number(clock());
      const affected = await transaction("o_relay_task")
        .where({ id: current.id, status: "queued" })
        .update({
          status: "running",
          submittedAt: current.submittedAt || claimTime,
          heartbeatAt: claimTime,
          updateTime: claimTime,
        });
      if (Number(affected) !== 1) {
        fail(`SEEDREAM45_CERTIFICATION_${quality}_TASK_CLAIM_LOST`);
      }
      claimed = { ...current, status: "running", updateTime: claimTime };
    });

    if (claimed) {
      await processQuickCreateImageTask(relayTaskFromRow(claimed));
    }
    const completed = await input.database("o_relay_task")
      .where({ id: permit.taskIds[quality] })
      .first();
    if (!completed || text(completed.status) !== "succeeded") {
      fail(`SEEDREAM45_CERTIFICATION_${quality}_TASK_NOT_SUCCEEDED`);
    }
    outcomes.push({ quality, taskId: permit.taskIds[quality], status: "succeeded" });
  }
  return outcomes;
}

export async function finalizeSeedream45CertificationProbe(input: {
  database: Knex;
  operator: Seedream45CertificationOperatorInput;
  now?: number;
}): Promise<Seedream45CertificationOperatorReceipt> {
  const now = Number(input.now ?? Date.now());
  assertInput(input.operator, now);
  const rows = await resolvePlanRows(input.database, input.operator);
  const permit = buildPermit(input.operator, rows);
  const taskEvidence: Seedream45CertificationOperatorReceipt["taskEvidence"] = [];
  const usageByQuality = new Map<Seedream45CertificationQuality, Row>();
  for (const quality of QUALITIES) {
    const task = await input.database("o_relay_task").where({ id: permit.taskIds[quality] }).first();
    if (
      !task
      || text(task.status) !== "succeeded"
      || !text(task.providerTaskId)
      || !Number(task.completedAt)
      || text(task.endpointType) !== "image_generation"
      || text(task.model) !== SEEDREAM45_CERTIFICATION_MODEL
      || text(task.provider) !== "volcano"
      || text(task.channelId) !== permit.channelId
      || modelRouteOperationForRequest("image_generation", task.requestPayload) !== `quality:${quality}`
    ) fail(`SEEDREAM45_CERTIFICATION_${quality}_TASK_NOT_SUCCEEDED`);
    const usages = await input.database("o_usage_record").where({
      taskId: task.id,
      endpointType: "image_generation",
      model: SEEDREAM45_CERTIFICATION_MODEL,
      provider: "volcano",
      channelId: permit.channelId,
      status: "charged",
    }).where("units", ">", 0).where("costMicros", ">", 0);
    if (usages.length !== 1) fail(`SEEDREAM45_CERTIFICATION_${quality}_CHARGED_USAGE_NOT_UNIQUE`);
    const usage = usages[0];
    if (text(usage.unit) !== text(rows.pricing.unit) || text(usage.currency).toUpperCase() !== "GU") {
      fail(`SEEDREAM45_CERTIFICATION_${quality}_USAGE_DIMENSION_MISMATCH`);
    }
    usageByQuality.set(quality, usage);
    taskEvidence.push({
      quality,
      taskId: text(task.id),
      usageId: text(usage.id),
      status: "succeeded",
      usageStatus: "charged",
    });
  }
  const evidence = input.operator.commercialEvidence;
  const common = {
    routeId: permit.routeId,
    pricingRuleId: permit.pricingRuleId,
    priceSourceUrl: evidence.priceSourceUrl,
    priceSourceDigest: evidence.priceSourceDigest,
    priceCheckedAt: evidence.priceCheckedAt,
    upstreamCurrency: evidence.upstreamCurrency,
    upstreamUnitPriceMicros: evidence.upstreamUnitPriceMicros,
    billingCurrency: "GU",
    billingDimension: text(rows.pricing.unit),
    validUntil: evidence.validUntil,
  };
  const batch: ModelRouteCertificationBatch = {
    format: MODEL_ROUTE_CERTIFICATION_BATCH_FORMAT,
    batchId: `seedream45-certification:${permit.probeId}`,
    releaseId: permit.releaseId,
    sourceCommit: permit.sourceCommit,
    actorUserId: permit.adminUserId,
    entries: [
      {
        ...common,
        operationKey: "route",
        taskEvidenceId: permit.taskIds["2K"],
        usageEvidenceId: text(usageByQuality.get("2K")?.id),
      },
      ...QUALITIES.map((quality) => ({
        ...common,
        operationKey: `quality:${quality}`,
        taskEvidenceId: permit.taskIds[quality],
        usageEvidenceId: text(usageByQuality.get(quality)?.id),
      })),
    ],
  };
  const certification = await executeModelRouteCertificationBatch({
    database: input.database,
    batch,
    mode: "apply",
    now,
  });
  return {
    format: "seedream-4.5-quality-certification-operator/v1",
    probeId: permit.probeId,
    state: "certified",
    taskEvidence,
    certification,
    completedAt: now,
  };
}
