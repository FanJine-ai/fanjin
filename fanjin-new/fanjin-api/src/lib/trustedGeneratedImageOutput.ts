import crypto from "node:crypto";
import type { Knex } from "knex";

import { TRUSTED_GENERATED_IMAGE_COMMAND_RETENTION_MS } from "@/lib/durableCommandIdempotency";
import { OBJECT_WRITE_INTENT_TABLE } from "@/lib/migrations/objectWriteIntent";
import {
  getObjectWriteIntent,
  parseObjectWriteReceiptEvidence,
  parseObjectWriteReferenceEvidence,
  type ObjectWriteIntentPurpose,
} from "@/lib/objectWriteIntent";
import {
  readVolcanoProviderAccountEvidence,
  resolveVolcanoProviderChannelAccount,
} from "@/lib/volcanoProviderAccount";

export const TRUSTED_GENERATED_OUTPUT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const WORKBENCH_IMAGE_SCOPE = "workbench:create:images";
const WORKBENCH_IMAGE_RESOURCE = "workbench_generation_command";

export type TrustedGeneratedImageOutputEvidence = Readonly<{
  sourceChannelId: string;
  sourceProviderAccountBinding: string;
  sourceTaskId: string;
  sourceSha256: string;
  model: string;
  completedAt: number;
  evidenceHash: string;
  evidenceId: string;
}>;

export type TrustedGeneratedImageOutputVerification =
  | Readonly<{ kind: "trusted"; evidence: TrustedGeneratedImageOutputEvidence }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "expired" }>;

type CommandIdentity = Readonly<{
  id: string;
  workspaceId: string;
  actorUserId: number;
  scopeKey: string;
  idempotencyKey: string;
  requestHash: string;
  createdAt: number;
  completedAt: number;
}>;

type PublicGeneratedImage = Readonly<{
  id: string;
  mediaAssetId: string;
  assetId: number;
  assetVersionId: number;
  taskId: string;
  url: string;
  contentSha256: string;
  assetType: "image";
  model: string;
  prompt: string;
  createdAt: number;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  const direct = record(value);
  if (direct) return direct;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function cleanText(value: unknown, maximum = 4096): string | null {
  if (typeof value !== "string") return null;
  const parsed = value.trim();
  return parsed
    && parsed.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(parsed)
    ? parsed
    : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(row[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(
    typeof value === "string" ? value : stableJson(value),
  ).digest("hex");
}

function publicGeneratedImage(value: unknown): PublicGeneratedImage | null {
  const row = record(value);
  if (!row || !exactKeys(row, [
    "id",
    "mediaAssetId",
    "assetId",
    "assetVersionId",
    "taskId",
    "url",
    "contentSha256",
    "assetType",
    "model",
    "prompt",
    "createdAt",
  ])) return null;
  const mediaAssetId = cleanText(row.mediaAssetId, 256);
  const assetId = positiveInteger(row.assetId);
  const assetVersionId = positiveInteger(row.assetVersionId);
  const taskId = cleanText(row.taskId, 256);
  const url = cleanText(row.url, 4096);
  const contentSha256 = cleanText(row.contentSha256, 64);
  const model = cleanText(row.model, 256);
  const prompt = cleanText(row.prompt, 20_000);
  const createdAt = positiveInteger(row.createdAt);
  if (
    !mediaAssetId
    || row.id !== mediaAssetId
    || !assetId
    || !assetVersionId
    || !taskId
    || !url
    || !contentSha256
    || !SHA256.test(contentSha256)
    || row.assetType !== "image"
    || !model
    || !prompt
    || !createdAt
  ) return null;
  return Object.freeze({
    id: mediaAssetId,
    mediaAssetId,
    assetId,
    assetVersionId,
    taskId,
    url,
    contentSha256,
    assetType: "image",
    model,
    prompt,
    createdAt,
  });
}

export async function verifyCommittedMediaObjectWriteIntent(input: {
  database: Knex | Knex.Transaction;
  purpose: Extract<ObjectWriteIntentPurpose, "agent_generation" | "relay_final">;
  workspaceId: string;
  projectId: number;
  mediaAssetId: string;
  storageKey: string;
  publicUrl: string;
  contentSha256: string;
  referenceVersion: "object-write-reference.v1" | "object-write-reference.v2";
}): Promise<Readonly<{ intentId: string; committedAt: number }> | null> {
  try {
    if (!input.storageKey || !SHA256.test(input.contentSha256)) return null;
    const candidates = await input.database(OBJECT_WRITE_INTENT_TABLE)
      .where({ objectKey: input.storageKey })
      .select("id")
      .limit(2);
    if (candidates.length !== 1) return null;
    const intent = await getObjectWriteIntent(String(candidates[0].id || ""), {
      database: input.database as Knex,
    });
    if (
      !intent
      || intent.status !== "committed"
      || intent.purpose !== input.purpose
      || intent.workspaceId !== input.workspaceId
      || intent.projectId !== input.projectId
      || intent.objectKey !== input.storageKey
      || intent.expectedSize <= 0
      || intent.expectedSha256 !== input.contentSha256
      || !SHA256.test(intent.requestHash)
      || !SHA256.test(intent.providerFingerprint)
      || intent.putCompletedAt === null
      || intent.committedAt === null
      || intent.createdAt > intent.putCompletedAt
      || intent.putCompletedAt > intent.committedAt
      || intent.updatedAt !== intent.committedAt
      || intent.nextAttemptAt !== intent.committedAt
      || intent.leaseOwner !== null
      || intent.leaseExpiresAt !== null
      || intent.errorCode !== null
      || intent.compensationEvidenceJson !== null
      || intent.compensationEvidenceHash !== null
      || intent.compensatedAt !== null
    ) return null;
    const receipt = parseObjectWriteReceiptEvidence(intent);
    const reference = parseObjectWriteReferenceEvidence(intent);
    if (
      !receipt
      || !reference
      || reference.version !== input.referenceVersion
      || reference.table !== "o_media_asset"
      || reference.rowId !== input.mediaAssetId
      || reference.workspaceId !== input.workspaceId
      || reference.projectId !== input.projectId
      || reference.storageKey !== input.storageKey
      || (
        reference.version === "object-write-reference.v2"
        && reference.publicUrl !== input.publicUrl
      )
    ) return null;
    return Object.freeze({
      intentId: intent.id,
      committedAt: intent.committedAt,
    });
  } catch {
    return null;
  }
}

async function verifyClosedWorkbenchImageSettlement(input: {
  database: Knex | Knex.Transaction;
  command: CommandIdentity;
  model: string;
  returnedCount: number;
}): Promise<Readonly<{
  reservationId: string;
  captureId: string;
  usageRecordId: string;
  providerRequestHash: string;
  sourceChannelId: string;
  sourceProviderAccountBinding: string;
}> | null> {
  const { command } = input;
  if (!UUID.test(command.id)) return null;
  const candidates = await input.database("o_billing_ledger")
    .where({ workspaceId: command.workspaceId, type: "freeze" })
    .andWhere("metadata", "like", `%${command.id}%`)
    .select("*")
    .limit(3);
  const exactReservations = candidates.filter((candidate) => {
    const metadata = jsonRecord(candidate.metadata);
    const identity = jsonRecord(metadata?.durableCommandIdentity);
    return metadata
      && identity
      && exactKeys(identity, [
        "contractVersion",
        "commandId",
        "workspaceId",
        "actorUserId",
        "scopeKey",
        "idempotencyKey",
        "requestHash",
      ])
      && identity.contractVersion === "workbench-generation-command.v1"
      && identity.commandId === command.id
      && identity.workspaceId === command.workspaceId
      && Number(identity.actorUserId) === command.actorUserId
      && identity.scopeKey === command.scopeKey
      && identity.idempotencyKey === command.idempotencyKey
      && identity.requestHash === command.requestHash;
  });
  if (exactReservations.length !== 1) return null;
  const reservation = exactReservations[0];
  const reservationId = cleanText(reservation.id, 256);
  const usageRecordId = cleanText(reservation.relatedUsageId, 256);
  const requestId = cleanText(reservation.requestId, 256);
  const reservationIdempotencyKey = cleanText(reservation.idempotencyKey, 512);
  const amountMicros = positiveInteger(reservation.amountMicros);
  const metadata = jsonRecord(reservation.metadata);
  const providerRequestHash = cleanText(metadata?.requestHash, 64);
  const pricingRuleId = cleanText(metadata?.pricingRuleId, 256);
  const sourceChannelId = cleanText(metadata?.dispatchChannelId, 256);
  const accountEvidence = readVolcanoProviderAccountEvidence(
    metadata?.trustedOutputProviderAccount,
  );
  if (
    !reservationId
    || !usageRecordId
    || !requestId
    || !reservationIdempotencyKey
    || !reservationIdempotencyKey.endsWith(":reserve")
    || !amountMicros
    || Number(reservation.remainingMicros) !== 0
    || String(reservation.status || "") !== "captured"
    || String(reservation.currency || "") !== "GU"
    || !metadata
    || metadata.source !== "relay-image"
    || !providerRequestHash
    || !SHA256.test(providerRequestHash)
    || !pricingRuleId
    || Number(metadata.reservedCostMicros) !== amountMicros
    || Number(metadata.reservedUnits) !== input.returnedCount
    || Number(metadata.requestedCount) !== input.returnedCount
    || metadata.dispatchProvider !== "volcano"
    || !sourceChannelId
    || metadata.dispatchRequestId !== requestId
    || !accountEvidence
  ) return null;
  const sourceChannel = await resolveVolcanoProviderChannelAccount({
    database: input.database,
    workspaceId: command.workspaceId,
    channelId: sourceChannelId,
    endpointType: "image_generation",
  });
  if (!sourceChannel || sourceChannel.binding !== accountEvidence.binding) return null;

  const [usageRows, relatedLedgers, usageLedgers] = await Promise.all([
    input.database("o_usage_record")
      .where({ id: usageRecordId, workspaceId: command.workspaceId })
      .select("*")
      .limit(2),
    input.database("o_billing_ledger")
      .where({ workspaceId: command.workspaceId, relatedLedgerId: reservationId })
      .select("*"),
    input.database("o_billing_ledger")
      .where({ workspaceId: command.workspaceId, relatedUsageId: usageRecordId })
      .select("*"),
  ]);
  if (
    usageRows.length !== 1
    || relatedLedgers.length !== 1
    || usageLedgers.length !== 2
  ) return null;
  const usage = usageRows[0];
  const capture = relatedLedgers[0];
  const captureId = cleanText(capture.id, 256);
  const captureMetadata = jsonRecord(capture.metadata);
  const billingKey = reservationIdempotencyKey.slice(0, -":reserve".length);
  const usageLedgerIds = new Set(usageLedgers.map((row) => String(row.id || "")));
  if (
    !captureId
    || String(capture.type || "") !== "deduct"
    || String(capture.status || "") !== "succeeded"
    || String(capture.currency || "") !== "GU"
    || String(capture.accountId || "") !== String(reservation.accountId || "")
    || String(capture.requestId || "") !== requestId
    || String(capture.relatedUsageId || "") !== usageRecordId
    || Number(capture.amountMicros) !== amountMicros
    || String(capture.idempotencyKey || "") !== `${billingKey}:capture`
    || !captureMetadata
    || captureMetadata.source !== "relay-image"
    || captureMetadata.requestHash !== providerRequestHash
    || captureMetadata.pricingRuleId !== pricingRuleId
    || String(usage.endpointType || "") !== "image_generation"
    || String(usage.model || "") !== input.model
    || String(usage.provider || "") !== "volcano"
    || String(usage.channelId || "") !== sourceChannel.channelId
    || Number(usage.units) !== input.returnedCount
    || String(usage.unit || "") !== "image"
    || Number(usage.costMicros) !== amountMicros
    || String(usage.currency || "") !== "GU"
    || String(usage.status || "") !== "charged"
    || usageLedgerIds.size !== 2
    || !usageLedgerIds.has(reservationId)
    || !usageLedgerIds.has(captureId)
  ) return null;

  const evidenceTimes = [
    positiveInteger(reservation.createdAt),
    positiveInteger(capture.createdAt),
    positiveInteger(usage.createTime),
  ];
  if (evidenceTimes.some((value) => (
    value === null
    || value < command.createdAt
    || value > command.completedAt
  ))) return null;
  return Object.freeze({
    reservationId,
    captureId,
    usageRecordId,
    providerRequestHash,
    sourceChannelId: sourceChannel.channelId,
    sourceProviderAccountBinding: sourceChannel.binding,
  });
}

/**
 * Verify the only image shape eligible for trusted portrait admission: a
 * project-bound synchronous Workbench image whose asset graph, immutable
 * object receipt, durable 200 response, closed GU settlement and Volcano
 * account snapshot all bind to the same command. Other producers fail closed.
 */
export async function verifyTrustedGeneratedImageOutput(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
  assetVersionId: number;
  sourceTaskId: string | null;
  sourceSha256: string | null;
  now: number;
}): Promise<TrustedGeneratedImageOutputVerification> {
  const sourceSha256 = String(input.sourceSha256 || "").trim().toLowerCase();
  if (!SHA256.test(sourceSha256)) return { kind: "invalid" };

  const versions = await input.database("o_image as version")
    .innerJoin("o_assets as asset", "asset.id", "version.assetsId")
    .innerJoin("o_project as project", "project.id", "asset.projectId")
    .where({
      "version.id": input.assetVersionId,
      "version.type": "image",
      "version.deletionState": "active",
      "asset.projectId": input.projectId,
      "asset.deletionState": "active",
      "project.workspaceId": input.workspaceId,
      "project.deletionState": "active",
    })
    .select({
      assetId: "asset.id",
      assetType: "asset.type",
      assetImageId: "asset.imageId",
      assetPrompt: "asset.prompt",
      filePath: "version.filePath",
      storageKey: "version.storageKey",
      model: "version.model",
      resolution: "version.resolution",
      state: "version.state",
    })
    .limit(2);
  if (versions.length !== 1) return { kind: "invalid" };
  const version = versions[0];
  const assetId = positiveInteger(version.assetId);
  const storageKey = cleanText(version.storageKey, 4096);
  if (
    !assetId
    || !storageKey
    || String(version.filePath || "") !== storageKey
    || Number(version.assetImageId) !== input.assetVersionId
    || !["image", "role", "scene", "tool"].includes(String(version.assetType || ""))
    || String(version.state || "") !== "已完成"
    || !storageKey.startsWith(`${input.projectId}/generated/quick-image/`)
  ) return { kind: "invalid" };

  const mediaRows = await input.database("o_media_asset")
    .where({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      source: "quick-create",
      assetType: "image",
      storageKey,
      deletionState: "active",
    })
    .select("*")
    .limit(2);
  if (mediaRows.length !== 1) return { kind: "invalid" };
  const media = mediaRows[0];
  const mediaAssetId = cleanText(media.id, 256);
  const mediaTaskId = cleanText(media.taskId, 256);
  const mediaUrl = cleanText(media.url, 4096);
  const metadata = jsonRecord(media.metadata);
  if (
    !mediaAssetId
    || !mediaTaskId
    || !mediaTaskId.startsWith("quick-image:")
    || !mediaUrl
    || !metadata
    || String(media.localPath || "") !== storageKey
    || metadata.version !== "generated-project-image.v1"
    || metadata.controlledStorage !== true
    || metadata.contentSha256 !== sourceSha256
    || Number(metadata.assetId) !== assetId
    || Number(metadata.assetVersionId) !== input.assetVersionId
    || metadata.model !== version.model
    || metadata.resolution !== version.resolution
    || metadata.prompt !== version.assetPrompt
    || nonNegativeInteger(metadata.index) === null
  ) return { kind: "invalid" };

  const commandId = cleanText(metadata.generationCommandId, 256);
  const commandRequestHash = cleanText(metadata.generationRequestHash, 64);
  const commandIdempotencyKey = cleanText(metadata.generationIdempotencyKey, 200);
  if (
    !commandId
    || !UUID.test(commandId)
    || !commandRequestHash
    || !SHA256.test(commandRequestHash)
    || !commandIdempotencyKey
    || (input.sourceTaskId !== null && input.sourceTaskId !== commandId)
  ) return { kind: "invalid" };

  const commandRows = await input.database("o_agent_idempotency")
    .where({
      id: commandId,
      workspaceId: input.workspaceId,
      requestHash: commandRequestHash,
      idempotencyKey: commandIdempotencyKey,
      resourceType: WORKBENCH_IMAGE_RESOURCE,
      status: "completed",
      responseStatus: 200,
    })
    .whereNull("resourceId")
    .select("*")
    .limit(2);
  if (commandRows.length !== 1) return { kind: "invalid" };
  const commandRow = commandRows[0];
  const actorUserId = positiveInteger(commandRow.actorUserId);
  const createdAt = positiveInteger(commandRow.createdAt);
  const completedAt = positiveInteger(commandRow.updatedAt);
  const expiresAt = positiveInteger(commandRow.expiresAt);
  const scopeKey = actorUserId
    ? `${WORKBENCH_IMAGE_SCOPE}:${input.workspaceId}:${actorUserId}`
    : "";
  if (
    !actorUserId
    || !createdAt
    || !completedAt
    || !expiresAt
    || commandRow.scopeKey !== scopeKey
    || createdAt > completedAt
    || completedAt > input.now
    || input.now - completedAt > TRUSTED_GENERATED_OUTPUT_MAX_AGE_MS
    || expiresAt <= input.now
    || expiresAt - completedAt < TRUSTED_GENERATED_IMAGE_COMMAND_RETENTION_MS
  ) {
    return completedAt
      && completedAt <= input.now
      && input.now - completedAt > TRUSTED_GENERATED_OUTPUT_MAX_AGE_MS
      ? { kind: "expired" }
      : { kind: "invalid" };
  }

  const response = jsonRecord(commandRow.responseBody);
  if (
    !response
    || !exactKeys(response, ["model", "count", "assets"])
    || response.model !== version.model
    || !Array.isArray(response.assets)
    || positiveInteger(response.count) !== response.assets.length
  ) return { kind: "invalid" };
  const responseAssets = response.assets.map(publicGeneratedImage);
  if (responseAssets.some((asset) => asset === null)) return { kind: "invalid" };
  const exactAssets = (responseAssets as PublicGeneratedImage[])
    .map((asset, index) => ({ asset, index }))
    .filter(({ asset }) => (
      asset.mediaAssetId === mediaAssetId
      && asset.assetId === assetId
      && asset.assetVersionId === input.assetVersionId
    ));
  if (exactAssets.length !== 1) return { kind: "invalid" };
  const target = exactAssets[0];
  if (
    target.index !== Number(metadata.index)
    || target.asset.taskId !== mediaTaskId
    || target.asset.url !== mediaUrl
    || target.asset.contentSha256 !== sourceSha256
    || target.asset.model !== version.model
    || target.asset.prompt !== version.assetPrompt
    || target.asset.createdAt !== Number(media.createTime)
    || target.asset.createdAt < createdAt
    || target.asset.createdAt > completedAt
  ) return { kind: "invalid" };

  const objectIntent = await verifyCommittedMediaObjectWriteIntent({
    database: input.database,
    purpose: "agent_generation",
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    mediaAssetId,
    storageKey,
    publicUrl: mediaUrl,
    contentSha256: sourceSha256,
    referenceVersion: "object-write-reference.v1",
  });
  if (
    !objectIntent
    || objectIntent.committedAt < createdAt
    || objectIntent.committedAt > completedAt
  ) return { kind: "invalid" };

  const command: CommandIdentity = Object.freeze({
    id: commandId,
    workspaceId: input.workspaceId,
    actorUserId,
    scopeKey,
    idempotencyKey: commandIdempotencyKey,
    requestHash: commandRequestHash,
    createdAt,
    completedAt,
  });
  const settlement = await verifyClosedWorkbenchImageSettlement({
    database: input.database,
    command,
    model: String(version.model || ""),
    returnedCount: responseAssets.length,
  });
  if (!settlement) return { kind: "invalid" };

  const evidenceCore = {
    version: "trusted-generated-image-output/v1",
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    assetId,
    assetVersionId: input.assetVersionId,
    mediaAssetId,
    objectWriteIntentId: objectIntent.intentId,
    commandId,
    commandRequestHash,
    billingReservationId: settlement.reservationId,
    billingCaptureId: settlement.captureId,
    usageRecordId: settlement.usageRecordId,
    providerRequestHash: settlement.providerRequestHash,
    sourceChannelId: settlement.sourceChannelId,
    sourceProviderAccountBinding: settlement.sourceProviderAccountBinding,
    sourceSha256,
    model: String(version.model || ""),
    completedAt,
  };
  const evidenceHash = sha256(evidenceCore);
  return {
    kind: "trusted",
    evidence: Object.freeze({
      sourceChannelId: settlement.sourceChannelId,
      sourceProviderAccountBinding: settlement.sourceProviderAccountBinding,
      sourceTaskId: commandId,
      sourceSha256,
      model: String(version.model || ""),
      completedAt,
      evidenceHash,
      evidenceId: `trusted-image-${evidenceHash.slice(0, 32)}`,
    }),
  };
}
