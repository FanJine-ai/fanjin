import crypto from "node:crypto";
import type { Knex } from "knex";
import { v5 as uuidv5 } from "uuid";
import u from "@/utils";
import { writeAuditLog } from "@/lib/audit";
import { reserveRelayBilling, markApiTaskReservationDispatched } from "@/lib/billing";
import { withChannelApiKeyForDispatch } from "@/lib/relayChannelCredential";
import { acquireModelRouteCertificationAdvisoryFence } from "@/lib/modelRouteCertificationMutationFence";
import { modelRouteCertificationPricingSnapshotHash, modelRouteCertificationRouteSnapshotHash } from "@/lib/modelRouteCertification";
import { executeModelRouteCertificationBatch, MODEL_ROUTE_CERTIFICATION_BATCH_FORMAT, parseModelRouteCertificationBatch } from "@/lib/modelRouteCertificationBatch";
import { AUTODL_H3_BASE_URL, AUTODL_H3_CHANNEL_ID, AUTODL_H3_DOCUMENTATION, AUTODL_H3_MODEL, AUTODL_H3_WORKFLOW } from "@/lib/autodlH3Manifest";
import { prepareAutoDLH3Configuration } from "../../scripts/prepare-autodl-h3";
import { lockRelayConfigTablesForMutation } from "@/lib/relayConfigValidation";
import { guMicrosPerGu } from "@/lib/billingUnits";
import { autoDLH3OutputPrice, AUTODL_H3_RETAIL_MICROS_PER_SECOND, AUTODL_H3_RETAIL_GU_PER_SECOND } from "@/lib/autodlH3Pricing";
import { projectVideoRelayProviderRequest, videoRelayProviderSubmitUrl, videoRelayProviderTaskId } from "@/lib/videoRelayProviderAdapter";

const ROUTE = "fanjin-autodl-h3-route";
const PRICE = "fanjin-autodl-h3-pricing";
const NAMESPACE = "7bbba2d1-bc18-48c4-8b38-4651d6cec4cc";
export const H3_FAST_PROBE_MAX_MICROS = AUTODL_H3_RETAIL_MICROS_PER_SECOND; // Exactly 0.6 GU (CNY 0.06).
const PREVIOUS_RETAIL_MICROS_PER_SECOND = 100_000_000; // CAS-only migration from the previously approved 1 GU rate.
export const H3_FAST_PROBE_PROMPT = "一只蓝色纸船在平静的水面缓慢漂动，固定镜头，柔和日光，无人物，无文字。";
export type H3FastProbeInput = {
  probeId: string; actorUserId: number; projectId: number; assetVersionId: number;
  referenceSha256: string; releaseId: string; sourceCommit: string; artifactSha256: string;
  createdAt: number; expiresAt: number;
  priceSourceDigest: string; priceCheckedAt: number; validUntil: number;
  minimumDurationSeconds: number; upstreamEstimatedCny: number; expectedConfigurationSha256: string;
};
type Row = Record<string, any>;
const parse = (value: any): Row => typeof value === "string" ? JSON.parse(value) : value || {};
const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code: string): never { throw new Error(`H3_FAST_${code}`); }
export const h3FastProbeTaskId = (input: H3FastProbeInput) => uuidv5(`h3-fast:${input.probeId}`, NAMESPACE);
const requestId = (input: H3FastProbeInput) => `h3-fast-certification:${input.probeId}`;

export function assertH3FastProbeInput(input: H3FastProbeInput, now: number, submitting = false): void {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(input.probeId)
    || ![input.actorUserId, input.projectId, input.assetVersionId].every(v => Number.isSafeInteger(v) && v > 0)
    || ![input.referenceSha256, input.artifactSha256, input.priceSourceDigest, input.expectedConfigurationSha256].every(v => /^[a-f0-9]{64}$/u.test(v))
    || !/^[a-f0-9]{40}$/u.test(input.sourceCommit)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.releaseId)
    || ![input.createdAt, input.expiresAt, input.priceCheckedAt, input.validUntil].every(v => Number.isSafeInteger(v) && v > 0)
    || input.createdAt > now || input.expiresAt <= input.createdAt || input.expiresAt - input.createdAt > 30 * 60_000
    || input.priceCheckedAt > now || now - input.priceCheckedAt > 7 * 86400_000
    || input.validUntil <= now || input.validUntil > input.priceCheckedAt + 30 * 86400_000
    || input.minimumDurationSeconds !== 1 || input.upstreamEstimatedCny !== 0.05
    || (submitting && input.expiresAt <= now)) fail("INPUT_INVALID");
}

async function rows(database: Knex | Knex.Transaction, input: H3FastProbeInput) {
  const [channel, route, price, actor, project, image] = await Promise.all([
    database("o_provider_channel").where({ id: AUTODL_H3_CHANNEL_ID }).first(),
    database("o_model_route").where({ id: ROUTE }).first(),
    database("o_pricing_rule").where({ id: PRICE }).first(),
    database("o_user").where({ id: input.actorUserId, status: "active", role: "root" }).first(),
    database("o_project").where({ id: input.projectId, deletionState: "active" }).first(),
    database("o_image").where({ id: input.assetVersionId }).first(),
  ]);
  const workspace = project && await database("o_workspace").where({ id: project.workspaceId, name: "Release Smoke Workspace", status: "active", ownerUserId: input.actorUserId }).first();
  const asset = image && await database("o_assets").where({ id: image.assetsId, projectId: input.projectId, deletionState: "active" }).first();
  if (!channel || !route || !price || !actor || !project || !workspace || !asset || image.type !== "image"
    || image.deletionState !== "active" || !image.filePath || /^[a-z][a-z0-9+.-]*:/iu.test(image.filePath)
    || channel.provider !== "autodl" || channel.baseUrl !== AUTODL_H3_BASE_URL
    || parse(channel.configJson).workflow !== AUTODL_H3_WORKFLOW || Number(channel.disabled) !== 0
    || route.channelId !== channel.id || route.model !== AUTODL_H3_MODEL
    || price.model !== AUTODL_H3_MODEL || price.provider !== "autodl" || price.currency !== "GU" || price.unit !== "video"
    || [channel, route, price].some(row => row.scope !== "platform" || row.workspaceId || row.endpointType !== "video_generation")
    || parse(route.routeConfig).source !== "autodl-h3-fast-2026-10-23"
    || parse(route.routeConfig).inputSlots?.[0]?.min !== 1
    || JSON.stringify(parse(route.routeConfig).nativeResolutions) !== '["768p"]'
    || autoDLH3OutputPrice(parse(price.ruleConfig).autodlH3Pricing, { resolution: "768p", duration: 1 }) !== H3_FAST_PROBE_MAX_MICROS) fail("RESOURCE_MISMATCH");
  return { channel, route, price, actor, project, workspace, image };
}
function snapshot(current: Awaited<ReturnType<typeof rows>>) {
  return {
    route: modelRouteCertificationRouteSnapshotHash({ ...current.route, disabled: 0, updateTime: 0 }),
    pricing: modelRouteCertificationPricingSnapshotHash({ ...current.price, disabled: 0, updateTime: 0 }),
    // Includes encrypted credential identity without returning any credential material.
    channel: digest(Object.fromEntries(["id", "provider", "endpointType", "scope", "workspaceId", "baseUrl", "credentialRef", "configJson", "modelNames", "timeoutMs", "concurrencyLimit"].map(key => [key, current.channel[key]]))),
  };
}
async function audit(database: Knex.Transaction, input: H3FastProbeInput, action: string, metadata: Row) {
  await writeAuditLog({ actor: { actorKind: "user", actorUserId: input.actorUserId } }, {
    action: `operator.h3_fast.${action}`, resourceType: "relay_task", resourceId: h3FastProbeTaskId(input), required: true,
    metadata: { probeId: input.probeId, workflow: AUTODL_H3_WORKFLOW, sourceCommit: input.sourceCommit, releaseId: input.releaseId, ...metadata },
  }, database);
}
export type H3FastProbePorts = {
  readImage: (filePath: string) => Promise<Buffer>;
  imageUrl: (filePath: string) => Promise<string>;
  reserve: typeof reserveRelayBilling;
  markDispatched: typeof markApiTaskReservationDispatched;
  dispatch: (channel: Row, request: Row) => Promise<{ status: number; ok: boolean; body: Record<string, unknown> }>;
};
export const H3_FAST_RUNTIME_PORTS: H3FastProbePorts = {
  readImage: filePath => u.oss.getFile(filePath), imageUrl: filePath => u.oss.getFileUrl(filePath),
  reserve: reserveRelayBilling, markDispatched: markApiTaskReservationDispatched,
  dispatch: async (channel, request) => {
    const dispatch = withChannelApiKeyForDispatch({ ...channel, config: parse(channel.configJson) }, {
      channelId: channel.id, provider: "autodl", endpointType: "video_generation", model: AUTODL_H3_MODEL,
    }, key => ({ promise: fetch(videoRelayProviderSubmitUrl("autodl", channel.baseUrl), {
      method: "POST", headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(30_000),
    }) }));
    const response = await dispatch.promise;
    return { status: response.status, ok: response.ok, body: await response.json() as Record<string, unknown> };
  },
};

/** No ordinary route is opened and no existing certificate is changed here. */
export async function submitH3FastProbe(database: Knex, input: H3FastProbeInput, mode: "validate" | "submit", io = H3_FAST_RUNTIME_PORTS, now = Date.now()) {
  assertH3FastProbeInput(input, now, mode === "submit");
  const current = await rows(database, input);
  if (Number(current.route.disabled) !== 1) fail("ROUTE_MUST_REMAIN_DISABLED");
  const imageBytes = await io.readImage(current.image.filePath);
  if (crypto.createHash("sha256").update(imageBytes).digest("hex") !== input.referenceSha256) fail("REFERENCE_DIGEST_MISMATCH");
  const referenceUrl = await io.imageUrl(current.image.filePath);
  const imageUrl = new URL(referenceUrl);
  if (imageUrl.protocol !== "https:" || imageUrl.username || imageUrl.password) fail("PUBLIC_REFERENCE_REQUIRED");
  const body = { model: AUTODL_H3_MODEL, content: [{ type: "text", text: H3_FAST_PROBE_PROMPT },
    { type: "image_url", role: "reference_image", image_url: { url: referenceUrl } }], duration: 1, resolution: "768p", ratio: "16:9", seed: 20261024 };
  const request = projectVideoRelayProviderRequest("autodl", body);
  const taskId = h3FastProbeTaskId(input), identityDigest = digest(input), config = snapshot(current);
  const receipt = { taskId, workflow: AUTODL_H3_WORKFLOW, requestDigest: digest(request), config, maxReserveGu: AUTODL_H3_RETAIL_GU_PER_SECOND, upstreamEstimatedCny: 0.05 };
  if (mode === "validate") return { ...receipt, state: "planned" };
  const claimed = await database.transaction(async trx => {
    await acquireModelRouteCertificationAdvisoryFence(trx);
    const latest = await rows(trx, input);
    if (JSON.stringify(snapshot(latest)) !== JSON.stringify(config)) fail("CONFIG_CHANGED");
    const existing = await trx("o_relay_task").where({ id: taskId }).first();
    if (existing) {
      if (parse(existing.providerPayload).operator?.identityDigest !== identityDigest) fail("INTENT_CONFLICT");
      return false; // Never resume an uncertain POST or reservation by submitting again.
    }
    const prior = await trx("o_relay_task").where({ model: AUTODL_H3_MODEL }).where("requestId", "like", "h3-fast-certification:%");
    for (const old of prior) {
      const oldUsage = await trx("o_usage_record").where({ taskId: old.id }).first();
      const oldInput = parse(old.providerPayload).operator?.input;
      const succeeded = old.status === "succeeded" && oldUsage?.status === "charged";
      const failedWithoutDispatch = old.status === "failed" && !old.providerTaskId && oldUsage?.status === "released"
        && !parse(old.providerPayload).submission?.dispatchStartedAt;
      if (!succeeded && !failedWithoutDispatch) fail("PRIOR_PROBE_REQUIRES_RECONCILIATION");
      // A later release/expired certification cycle may legitimately need fresh evidence.
      if (succeeded && oldInput?.releaseId === input.releaseId && oldInput?.validUntil >= now) fail("PROBE_ALREADY_COMPLETED_THIS_CYCLE");
    }
    await trx("o_relay_task").insert({ id: taskId, workspaceId: current.workspace.id, projectId: input.projectId, apiKeyId: null,
      requestId: requestId(input), endpointType: "video_generation", provider: "autodl", channelId: current.channel.id, model: AUTODL_H3_MODEL,
      status: "processing", requestPayload: JSON.stringify(body), providerPayload: JSON.stringify({ request,
        identity: { principalId: `user:${input.actorUserId}`, subject: `user:${input.actorUserId}`, workspaceId: current.workspace.id },
        operator: { ...receipt, identityDigest, input, state: "intent_persisted" },
        submission: { state: "dispatch_started", dispatchStartedAt: now } }),
      resultPayload: JSON.stringify({ internal: { requestedResolution: "768p", generationResolution: "768p", finalResolution: "768p", needsTargetProcessing: false,
        pipeline: "direct_generation", providerNativeDeliveryAuthorization: { version: "relay-provider-native-delivery-authorization/v1", provider: "autodl", model: AUTODL_H3_MODEL, channelId: current.channel.id, resolution: "768p" } } }),
      providerTaskId: null, quotaReserved: 0, apiQuotaReserved: 0, costMicros: 0, leaseOwner: requestId(input), leaseExpiresAt: now + 20 * 60_000,
      attemptCount: 1, heartbeatAt: now, createTime: now, updateTime: now });
    await audit(trx, input, "intent", { ...receipt, identityDigest, referenceSha256: input.referenceSha256 });
    return true;
  });
  if (!claimed) return { ...receipt, state: "already_recorded_query_only" };
  const billingKey = `relay-video:${taskId}`;
  const priceSnapshot = { pricingRuleId: PRICE, pricingRuleUpdatedAt: current.price.updateTime, endpointType: "video_generation", provider: "autodl",
    model: AUTODL_H3_MODEL, unit: "video", unitPriceMicros: H3_FAST_PROBE_MAX_MICROS, multiplier: 1, minimumMicros: 0,
    reservationUnits: 1, costMicros: H3_FAST_PROBE_MAX_MICROS, currency: "GU", resolution: "768p" };
  const reserved = await io.reserve({ taskId, workspaceId: current.workspace.id, endpointType: "video_generation", provider: "autodl", channelId: current.channel.id,
    model: AUTODL_H3_MODEL, requestId: requestId(input), units: 1, unit: "video", currency: "GU", costMicros: H3_FAST_PROBE_MAX_MICROS,
    operatorUserId: input.actorUserId, idempotencyKey: `${billingKey}:reserve`, metadata: { billingKey, priceSnapshot, source: requestId(input) } });
  if (!reserved.ledger || !reserved.reserved || reserved.quotaReserved !== H3_FAST_PROBE_MAX_MICROS) fail("EXACT_RESERVATION_REQUIRED");
  const task = await database("o_relay_task").where({ id: taskId }).first();
  const payload = { ...parse(task.providerPayload), billing: { reservationId: reserved.ledger.id, usageRecordId: reserved.usage?.id, billingKey, priceSnapshot },
    submission: { state: "dispatch_started", dispatchStartedAt: Date.now() } };
  await database("o_relay_task").where({ id: taskId }).update({ providerPayload: JSON.stringify(payload), updateTime: Date.now() });
  await io.markDispatched({ workspaceId: current.workspace.id, reservationId: reserved.ledger.id, provider: "autodl", channelId: current.channel.id, requestId: requestId(input) });
  // This is the only provider POST; errors keep the durable intent for readback/reconciliation.
  if (input.expiresAt <= Date.now()) fail("PERMIT_EXPIRED_BEFORE_DISPATCH");
  if (JSON.stringify(snapshot(await rows(database, input))) !== JSON.stringify(config)) fail("CONFIG_CHANGED_BEFORE_DISPATCH");
  const response = await io.dispatch(current.channel, request);
  const upstreamId = videoRelayProviderTaskId("autodl", response.body);
  if (!response.ok || typeof upstreamId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(upstreamId)) fail("SUBMIT_UNCERTAIN_NO_RETRY");
  await database.transaction(async trx => {
    await trx("o_relay_task").where({ id: taskId, status: "processing" }).update({ status: "running", providerTaskId: upstreamId,
      providerPayload: JSON.stringify({ ...payload, response: response.body, submission: { ...payload.submission, state: "accepted", acceptedAt: Date.now() } }),
      submittedAt: Date.now(), updateTime: Date.now(), leaseOwner: null, leaseExpiresAt: null });
    await audit(trx, input, "accepted", { providerTaskId: upstreamId, requestDigest: receipt.requestDigest });
  });
  return { ...receipt, state: "accepted_worker_owns_completion", providerTaskId: upstreamId };
}

/** Export only; generic certify-model-routes validates and applies the immutable batch. */
export async function h3FastCertificationBatch(database: Knex, input: H3FastProbeInput, now = Date.now()) {
  assertH3FastProbeInput(input, now);
  const current = await rows(database, input), taskId = h3FastProbeTaskId(input);
  const task = await database("o_relay_task").where({ id: taskId }).first();
  const operator = parse(task?.providerPayload).operator;
  if (!task || task.status !== "succeeded" || !task.providerTaskId || operator?.workflow !== AUTODL_H3_WORKFLOW
    || operator.identityDigest !== digest(input) || operator.requestDigest !== digest(parse(task.providerPayload).request)
    || JSON.stringify(operator.config) !== JSON.stringify(snapshot(current))) fail("FAST_DELIVERY_EVIDENCE_REQUIRED");
  const usage = await database("o_usage_record").where({ taskId, status: "charged" }).first();
  const asset = await database("o_media_asset").where({ taskId, source: "relay_final" }).first();
  if (!usage || Number(usage.costMicros) !== H3_FAST_PROBE_MAX_MICROS || !asset || !asset.url
    || Number(asset.height) !== 768 || asset.workspaceId !== task.workspaceId || Number(asset.projectId) !== input.projectId) fail("DELIVERY_AND_CHARGE_REQUIRED");
  return parseModelRouteCertificationBatch({ format: MODEL_ROUTE_CERTIFICATION_BATCH_FORMAT,
    batchId: requestId(input), releaseId: input.releaseId, sourceCommit: input.sourceCommit, actorUserId: input.actorUserId,
    entries: [{ routeId: ROUTE, pricingRuleId: PRICE, operationKey: "route", priceSourceUrl: AUTODL_H3_DOCUMENTATION,
      priceSourceDigest: input.priceSourceDigest, priceCheckedAt: input.priceCheckedAt, upstreamCurrency: "CNY", upstreamUnitPriceMicros: 50_000,
      billingCurrency: "GU", billingDimension: "video", taskEvidenceId: taskId, usageEvidenceId: usage.id, validUntil: input.validUntil }] });
}

/** Channel credentials and operational tuning are intentionally not replaced by staging. */
export async function stageH3FastConfiguration(database: Knex, input: H3FastProbeInput, mode: "validate" | "apply", now = Date.now()) {
  assertH3FastProbeInput(input, now, true);
  return database.transaction(async trx => {
    await lockRelayConfigTablesForMutation(trx);
    await acquireModelRouteCertificationAdvisoryFence(trx);
    const [channel, route, price, actor] = await Promise.all([
      trx("o_provider_channel").where({ id: AUTODL_H3_CHANNEL_ID }).first(),
      trx("o_model_route").where({ id: ROUTE }).first(), trx("o_pricing_rule").where({ id: PRICE }).first(),
      trx("o_user").where({ id: input.actorUserId, status: "active", role: "root" }).first(),
    ]);
    if (!channel || !route || !price || !actor || channel.baseUrl !== AUTODL_H3_BASE_URL || channel.provider !== "autodl"
      || route.channelId !== channel.id || route.model !== AUTODL_H3_MODEL || price.model !== AUTODL_H3_MODEL
      || price.provider !== "autodl" || price.currency !== "GU" || price.unit !== "video"
      || [channel, route, price].some(row => row.scope !== "platform" || row.workspaceId || row.endpointType !== "video_generation")
      || ![PREVIOUS_RETAIL_MICROS_PER_SECOND, H3_FAST_PROBE_MAX_MICROS].includes(autoDLH3OutputPrice(parse(price.ruleConfig).autodlH3Pricing, { resolution: "768p", duration: 1 }))) fail("STAGE_RESOURCE_MISMATCH");
    const beforeDigest = digest({ channel, route, price });
    if (beforeDigest !== input.expectedConfigurationSha256) fail("STAGE_CAS_MISMATCH");
    const prepared = prepareAutoDLH3Configuration(10, now);
    const channelConfig = { ...parse(channel.configJson), source: "autodl-h3-fast-2026-10-23", workflow: AUTODL_H3_WORKFLOW };
    const routeConfig = { ...parse(route.routeConfig), ...parse(prepared.route.routeConfig) };
    const previousRetailGuPerSecond = autoDLH3OutputPrice(parse(price.ruleConfig).autodlH3Pricing, { resolution: "768p", duration: 1 }) / guMicrosPerGu;
    const priceConfig = { ...parse(price.ruleConfig), ...parse(prepared.pricing.ruleConfig) };
    if (mode === "validate") return { mode, beforeDigest, routeWillRemainDisabled: true, credentialsPreserved: true, previousRetailGuPerSecond, retailGuPerSecond: AUTODL_H3_RETAIL_GU_PER_SECOND };
    const affected = [
      await trx("o_model_route").where({ id: ROUTE, updateTime: route.updateTime }).update({ disabled: 1, routeConfig: JSON.stringify(routeConfig), updateTime: now }),
      await trx("o_provider_channel").where({ id: channel.id, updateTime: channel.updateTime }).update({ configJson: JSON.stringify(channelConfig), updateTime: now }),
      await trx("o_pricing_rule").where({ id: PRICE, updateTime: price.updateTime }).update({ unitPriceMicros: prepared.pricing.unitPriceMicros, ruleConfig: JSON.stringify(priceConfig), updateTime: now }),
    ];
    if (affected.some(count => Number(count) !== 1)) fail("STAGE_CAS_MISMATCH");
    await audit(trx, input, "stage", { beforeDigest, previousRetailGuPerSecond, retailGuPerSecond: AUTODL_H3_RETAIL_GU_PER_SECOND, routeDisabled: true, credentialsPreserved: true });
    return { mode, beforeDigest, routeDisabled: true, previousRetailGuPerSecond, retailGuPerSecond: AUTODL_H3_RETAIL_GU_PER_SECOND };
  });
}

class ActivationValidationRollback extends Error { constructor(readonly receipt: unknown) { super("H3_FAST_ACTIVATION_VALIDATE"); } }
/** Activate and issue a batch certificate atomically; failure restores the closed route. */
export async function activateH3FastConfiguration(database: Knex, input: H3FastProbeInput, mode: "validate" | "apply", now = Date.now()) {
  try {
    return await database.transaction(async trx => {
      await lockRelayConfigTablesForMutation(trx);
      await acquireModelRouteCertificationAdvisoryFence(trx);
      const current = await rows(trx, input);
      if (Number(current.route.disabled) !== 0) await trx("o_model_route").where({ id: ROUTE }).update({ disabled: 0, updateTime: now });
      const batch = await h3FastCertificationBatch(trx, input, now);
      const receipt = await executeModelRouteCertificationBatch({ database: trx, batch, mode: "apply", now });
      if (mode === "validate") throw new ActivationValidationRollback(receipt);
      await audit(trx, input, "activate", { batchId: batch.batchId, certificationIds: receipt.certifications.map(c => c.certificationId), retailGuPerSecond: AUTODL_H3_RETAIL_GU_PER_SECOND });
      return receipt;
    });
  } catch (error) {
    if (error instanceof ActivationValidationRollback) return { mode: "validate", rolledBack: true, receipt: error.receipt };
    throw error;
  }
}

export async function h3FastConfigurationDigest(database: Knex) {
  const [channel, route, price] = await Promise.all([
    database("o_provider_channel").where({ id: AUTODL_H3_CHANNEL_ID }).first(),
    database("o_model_route").where({ id: ROUTE }).first(), database("o_pricing_rule").where({ id: PRICE }).first(),
  ]);
  if (!channel || !route || !price) fail("CONFIGURATION_MISSING");
  return digest({ channel, route, price });
}
