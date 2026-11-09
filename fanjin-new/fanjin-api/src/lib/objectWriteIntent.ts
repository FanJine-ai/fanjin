import crypto from "node:crypto";
import type { Knex } from "knex";
import { reserveWorkspaceStorage, commitWorkspaceStorage, releaseWorkspaceStorage } from "./workspaceResources";

import { isPostgresClient } from "@/lib/dbDialect";
import {
  OBJECT_WRITE_INTENT_TABLE,
} from "@/lib/migrations/objectWriteIntent";
import {
  normalizeObjectKey,
  type ObjectStorageWriteReceipt,
} from "@/lib/objectStorage";
import {
  resolveObjectStorageConfiguration,
  type ObjectStorageConfiguration,
} from "@/lib/objectStorageConfig";
import {
  resolveStableObjectDelivery,
  validateStableObjectDeliveryEvidence,
  type StableObjectDeliveryMode,
} from "@/lib/stableObjectDelivery";

export type ObjectWriteIntentPurpose =
  | "relay_final"
  | "video_enhance"
  | "agent_generation"
  | "direct_upload";

export type ObjectWriteIntentStatus =
  | "prepared"
  | "stored"
  | "committed"
  | "compensation_pending"
  | "compensating"
  | "compensated"
  | "dead";

export interface ObjectWriteIntentClaim {
  id: string;
  owner: string;
  fence: number;
}

export interface ObjectWriteIntentRecord {
  id: string;
  requestHash: string;
  purpose: ObjectWriteIntentPurpose;
  workspaceId: string;
  projectId: number;
  provider: ObjectStorageConfiguration["provider"];
  providerFingerprint: string;
  bucket: string;
  region: string;
  endpoint: string;
  keyPrefix: string;
  forcePathStyle: boolean;
  objectKey: string;
  expectedSize: number;
  expectedSha256: string;
  status: ObjectWriteIntentStatus;
  writeReceiptJson: string | null;
  writeReceiptHash: string | null;
  referenceJson: string | null;
  referenceHash: string | null;
  compensationEvidenceJson: string | null;
  compensationEvidenceHash: string | null;
  errorCode: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  leaseFence: number;
  retryCount: number;
  maxRetries: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  putCompletedAt: number | null;
  committedAt: number | null;
  compensatedAt: number | null;
}

export type ClaimedObjectWriteIntent = ObjectWriteIntentRecord & {
  status: "compensating";
  leaseOwner: string;
  leaseExpiresAt: number;
};

export type ObjectWriteReceiptEvidence =
  | {
      version: "object-write-receipt.v1";
      mode: "local";
      objectKey: string;
      size: number;
      sha256: string;
    }
  | {
      version: "object-write-receipt.v1";
      mode: "remote";
      receipt: ObjectStorageWriteReceipt;
    }
  | {
      version: "object-write-reconciliation.v1";
      mode: "remote_reconciled_absent";
      objectKey: string;
      size: number;
      sha256: string;
      providerFingerprint: string;
    };

export interface ObjectWriteReferenceEvidenceV1 {
  version: "object-write-reference.v1";
  table: string;
  rowId: string;
  workspaceId: string;
  projectId: number;
  storageKey: string;
}

export interface ObjectWriteReferenceEvidenceV2 {
  version: "object-write-reference.v2";
  table: "o_media_asset";
  rowId: string;
  workspaceId: string;
  projectId: number;
  storageKey: string;
  publicUrl: string;
  deliveryMode: StableObjectDeliveryMode;
  cdnBaseUrl: string | null;
}

export type ObjectWriteReferenceEvidence =
  | ObjectWriteReferenceEvidenceV1
  | ObjectWriteReferenceEvidenceV2;

export interface ObjectWriteIntentRuntime {
  database?: Knex;
  clock?: () => number;
  configuration?: ObjectStorageConfiguration;
}

export class ObjectWriteIntentError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ObjectWriteIntentError";
    this.code = code;
  }
}

const PURPOSES = new Set<ObjectWriteIntentPurpose>([
  "relay_final",
  "video_enhance",
  "agent_generation",
  "direct_upload",
]);

function isEphemeralPortraitSample(record: Readonly<{
  purpose: ObjectWriteIntentPurpose;
  projectId: number;
  objectKey: string;
}>): boolean {
  const match = /^(\d+)\/portrait-detector\/video-samples\/[a-f0-9]{64}\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jpg$/u
    .exec(record.objectKey);
  return record.purpose === "direct_upload"
    && match !== null
    && Number(match[1]) === record.projectId;
}

export function isEphemeralPortraitSampleIntent(record: Readonly<{
  purpose: ObjectWriteIntentPurpose;
  projectId: number;
  objectKey: string;
}>): boolean {
  return isEphemeralPortraitSample(record);
}
const STATUSES = new Set<ObjectWriteIntentStatus>([
  "prepared",
  "stored",
  "committed",
  "compensation_pending",
  "compensating",
  "compensated",
  "dead",
]);

function fail(code: string): never {
  throw new ObjectWriteIntentError(code);
}

export function createObjectWriteMediaReferenceEvidence(input: {
  rowId: string;
  workspaceId: string;
  projectId: number;
  storageKey: string;
  publicUrl: string;
}, configuration: ObjectStorageConfiguration =
  resolveObjectStorageConfiguration()): ObjectWriteReferenceEvidenceV2 {
  const storageKey = normalizeObjectKey(input.storageKey);
  const delivery = resolveStableObjectDelivery({
    configuration,
    objectKey: storageKey,
    candidateUrl: input.publicUrl,
  });
  if (!delivery) fail("OBJECT_WRITE_REFERENCE_DELIVERY_URL_INVALID");
  return {
    version: "object-write-reference.v2",
    table: "o_media_asset",
    rowId: text(input.rowId, "OBJECT_WRITE_REFERENCE_INVALID"),
    workspaceId: text(
      input.workspaceId,
      "OBJECT_WRITE_REFERENCE_INVALID",
    ),
    projectId: safeInteger(
      input.projectId,
      "OBJECT_WRITE_REFERENCE_INVALID",
      1,
    ),
    storageKey,
    publicUrl: delivery.publicUrl,
    deliveryMode: delivery.mode,
    cdnBaseUrl: delivery.cdnBaseUrl,
  };
}

function defaultDatabase(): Knex {
  const databaseModule = require("@/utils/db") as typeof import("@/utils/db");
  return databaseModule.db as unknown as Knex;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function text(value: unknown, code: string, maximum = 255): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(code);
  }
  return value;
}

function safeInteger(
  value: unknown,
  code: string,
  minimum = 0,
): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) fail(code);
  return number;
}

function nullableInteger(value: unknown, code: string): number | null {
  if (value === null || value === undefined) return null;
  return safeInteger(value, code);
}

function optionalText(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, code, 65_535);
}

function hash(value: unknown, code: string): string {
  const normalized = text(value, code, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) fail(code);
  return normalized;
}

function now(runtime: ObjectWriteIntentRuntime): number {
  return safeInteger(
    (runtime.clock ?? (() => Date.now()))(),
    "OBJECT_WRITE_INTENT_CLOCK_INVALID",
  );
}

function database(runtime: ObjectWriteIntentRuntime): Knex {
  return runtime.database ?? defaultDatabase();
}

export function objectWriteProviderIdentity(
  configuration: ObjectStorageConfiguration,
): {
  provider: ObjectStorageConfiguration["provider"];
  providerFingerprint: string;
  bucket: string;
  region: string;
  endpoint: string;
  keyPrefix: string;
  forcePathStyle: boolean;
} {
  const identity = {
    provider: configuration.provider,
    bucket: String(configuration.bucket || ""),
    region: String(configuration.region || ""),
    endpoint: String(configuration.endpoint || ""),
    keyPrefix: String(configuration.keyPrefix || ""),
    forcePathStyle: configuration.forcePathStyle === true,
  };
  return {
    ...identity,
    providerFingerprint: sha256(stableJson(identity)),
  };
}

function mapRecord(row: Record<string, unknown>): ObjectWriteIntentRecord {
  const purpose = String(row.purpose || "") as ObjectWriteIntentPurpose;
  const status = String(row.status || "") as ObjectWriteIntentStatus;
  const provider = String(
    row.provider || "",
  ) as ObjectStorageConfiguration["provider"];
  const record: ObjectWriteIntentRecord = {
    id: text(row.id, "OBJECT_WRITE_INTENT_ROW_INVALID"),
    requestHash: hash(
      row.requestHash,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    purpose,
    workspaceId: text(
      row.workspaceId,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    projectId: safeInteger(
      row.projectId,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
      1,
    ),
    provider,
    providerFingerprint: hash(
      row.providerFingerprint,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    bucket: String(row.bucket ?? ""),
    region: String(row.region ?? ""),
    endpoint: String(row.endpoint ?? ""),
    keyPrefix: String(row.keyPrefix ?? ""),
    forcePathStyle:
      row.forcePathStyle === true || Number(row.forcePathStyle) === 1,
    objectKey: normalizeObjectKey(String(row.objectKey || "")),
    expectedSize: safeInteger(
      row.expectedSize,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    expectedSha256: hash(
      row.expectedSha256,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    status,
    writeReceiptJson: optionalText(
      row.writeReceiptJson,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    writeReceiptHash: row.writeReceiptHash === null
      || row.writeReceiptHash === undefined
      ? null
      : hash(row.writeReceiptHash, "OBJECT_WRITE_INTENT_ROW_INVALID"),
    referenceJson: optionalText(
      row.referenceJson,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    referenceHash: row.referenceHash === null
      || row.referenceHash === undefined
      ? null
      : hash(row.referenceHash, "OBJECT_WRITE_INTENT_ROW_INVALID"),
    compensationEvidenceJson: optionalText(
      row.compensationEvidenceJson,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    compensationEvidenceHash:
      row.compensationEvidenceHash === null
        || row.compensationEvidenceHash === undefined
        ? null
        : hash(
          row.compensationEvidenceHash,
          "OBJECT_WRITE_INTENT_ROW_INVALID",
        ),
    errorCode: optionalText(
      row.errorCode,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    leaseOwner: optionalText(
      row.leaseOwner,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    leaseExpiresAt: nullableInteger(
      row.leaseExpiresAt,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    leaseFence: safeInteger(
      row.leaseFence,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
      1,
    ),
    retryCount: safeInteger(
      row.retryCount,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    maxRetries: safeInteger(
      row.maxRetries,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    nextAttemptAt: safeInteger(
      row.nextAttemptAt,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    createdAt: safeInteger(
      row.createdAt,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    updatedAt: safeInteger(
      row.updatedAt,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    putCompletedAt: nullableInteger(
      row.putCompletedAt,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    committedAt: nullableInteger(
      row.committedAt,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
    compensatedAt: nullableInteger(
      row.compensatedAt,
      "OBJECT_WRITE_INTENT_ROW_INVALID",
    ),
  };
  if (
    !PURPOSES.has(purpose)
    || !STATUSES.has(status)
    || !["local", "s3", "tos"].includes(provider)
    || record.providerFingerprint !== sha256(stableJson({
      provider: record.provider,
      bucket: record.bucket,
      region: record.region,
      endpoint: record.endpoint,
      keyPrefix: record.keyPrefix,
      forcePathStyle: record.forcePathStyle,
    }))
    || (record.leaseOwner === null) !== (record.leaseExpiresAt === null)
    || (record.writeReceiptJson === null)
      !== (record.writeReceiptHash === null)
    || (record.referenceJson === null) !== (record.referenceHash === null)
    || (record.compensationEvidenceJson === null)
      !== (record.compensationEvidenceHash === null)
  ) {
    fail("OBJECT_WRITE_INTENT_ROW_INVALID");
  }
  return record;
}

function claimWhere(
  query: Knex.QueryBuilder,
  claim: ObjectWriteIntentClaim,
): Knex.QueryBuilder {
  return query.where({
    id: claim.id,
    leaseOwner: claim.owner,
    leaseFence: claim.fence,
  });
}

function assertActiveProducerClaim(
  record: ObjectWriteIntentRecord,
  claim: ObjectWriteIntentClaim,
  currentTime: number,
): void {
  if (
    record.id !== claim.id
    || record.leaseOwner !== claim.owner
    || record.leaseFence !== claim.fence
    || record.leaseExpiresAt === null
    || record.leaseExpiresAt <= currentTime
    || !["prepared", "stored"].includes(record.status)
  ) {
    fail("OBJECT_WRITE_INTENT_LEASE_LOST");
  }
}

async function readRecord(
  client: Knex | Knex.Transaction,
  id: string,
): Promise<ObjectWriteIntentRecord | null> {
  const row = await client(OBJECT_WRITE_INTENT_TABLE).where({ id }).first();
  return row ? mapRecord(row) : null;
}

export async function getObjectWriteIntent(
  id: string,
  runtime: ObjectWriteIntentRuntime = {},
): Promise<ObjectWriteIntentRecord | null> {
  return readRecord(
    database(runtime),
    text(id, "OBJECT_WRITE_INTENT_ID_INVALID"),
  );
}

export async function prepareObjectWriteIntent(
  input: {
    id: string;
    purpose: ObjectWriteIntentPurpose;
    workspaceId: string;
    projectId: number;
    objectKey: string;
    expectedSize: number;
    expectedSha256: string;
    writerId: string;
    leaseMs?: number;
    recoveryGraceMs?: number;
    maxRetries?: number;
    /** Trusted caller: local compositions still require space before PUT. */
    acceptedGeneration?: boolean;
  },
  runtime: ObjectWriteIntentRuntime = {},
): Promise<{
  record: ObjectWriteIntentRecord;
  claim: ObjectWriteIntentClaim;
  idempotent: boolean;
}> {
  const id = text(input.id, "OBJECT_WRITE_INTENT_ID_INVALID");
  if (!PURPOSES.has(input.purpose)) {
    fail("OBJECT_WRITE_INTENT_PURPOSE_INVALID");
  }
  const workspaceId = text(
    input.workspaceId,
    "OBJECT_WRITE_INTENT_WORKSPACE_INVALID",
  );
  const projectId = safeInteger(
    input.projectId,
    "OBJECT_WRITE_INTENT_PROJECT_INVALID",
    1,
  );
  const objectKey = normalizeObjectKey(input.objectKey);
  if (!objectKey.startsWith(`${projectId}/`)) {
    // Project deletion is deliberately bounded to one authoritative object
    // prefix. Durable writers must never create a project-owned generation
    // outside that prefix, otherwise a tombstoned project could leave an
    // undiscoverable object behind.
    fail("OBJECT_WRITE_INTENT_KEY_NOT_PROJECT_SCOPED");
  }
  if (!objectKey.split("/").some((segment) =>
    segment === id || segment.startsWith(`${id}.`))) {
    // A prepared row can outlive a crash before a PUT response is received.
    // Its key therefore has to be exclusive to this intent so recovery may
    // enumerate and remove every generation without touching another writer.
    fail("OBJECT_WRITE_INTENT_KEY_NOT_EXCLUSIVE");
  }
  const expectedSize = safeInteger(
    input.expectedSize,
    "OBJECT_WRITE_INTENT_SIZE_INVALID",
  );
  const expectedSha256 = hash(
    input.expectedSha256,
    "OBJECT_WRITE_INTENT_HASH_INVALID",
  );
  const writerId = text(
    input.writerId,
    "OBJECT_WRITE_INTENT_WRITER_INVALID",
  );
  const leaseMs = safeInteger(
    input.leaseMs ?? 15 * 60_000,
    "OBJECT_WRITE_INTENT_LEASE_INVALID",
    1,
  );
  const recoveryGraceMs = safeInteger(
    input.recoveryGraceMs ?? 0,
    "OBJECT_WRITE_INTENT_RECOVERY_GRACE_INVALID",
  );
  const maxRetries = safeInteger(
    input.maxRetries ?? 10,
    "OBJECT_WRITE_INTENT_RETRY_INVALID",
  );
  if (
    leaseMs > 24 * 60 * 60_000
    || recoveryGraceMs > 24 * 60 * 60_000
    || maxRetries > 100
  ) {
    fail("OBJECT_WRITE_INTENT_INPUT_INVALID");
  }
  const createdAt = now(runtime);
  const leaseExpiresAt = createdAt + leaseMs;
  const nextAttemptAt = leaseExpiresAt + recoveryGraceMs;
  if (
    !Number.isSafeInteger(leaseExpiresAt)
    || !Number.isSafeInteger(nextAttemptAt)
  ) {
    fail("OBJECT_WRITE_INTENT_CLOCK_INVALID");
  }
  const identity = objectWriteProviderIdentity(
    runtime.configuration ?? resolveObjectStorageConfiguration(),
  );
  const requestHash = sha256(stableJson({
    version: "object-write-intent-request.v1",
    id,
    purpose: input.purpose,
    workspaceId,
    projectId,
    ...identity,
    objectKey,
    expectedSize,
    expectedSha256,
    recoveryGraceMs,
  }));
  const client = database(runtime);
  return client.transaction(async (transaction) => {
    const project = await transaction("o_project")
      .where({ id: projectId })
      .select("id", "workspaceId", "deletionState")
      .forUpdate()
      .first();
    if (
      !project
      || String(project.workspaceId || "") !== workspaceId
      || String(project.deletionState || "active") !== "active"
    ) {
      fail("OBJECT_WRITE_INTENT_PROJECT_NOT_ACTIVE");
    }
    const existing = await transaction(OBJECT_WRITE_INTENT_TABLE)
      .where({ requestHash })
      .first();
    if (existing) {
      const record = mapRecord(existing);
      if (
        record.id !== id
        || record.status !== "prepared"
        || record.leaseOwner !== writerId
        || record.leaseExpiresAt === null
        || record.leaseExpiresAt <= createdAt
      ) {
        fail("OBJECT_WRITE_INTENT_REPLAY_CONFLICT");
      }
      return {
        record,
        claim: {
          id: record.id,
          owner: writerId,
          fence: record.leaseFence,
        },
        idempotent: true,
      };
    }
    await reserveWorkspaceStorage(transaction, { id: `intent:${id}`, workspaceId, objectKey,
      providerFingerprint: identity.providerFingerprint, bytes: expectedSize,
      temporary: isEphemeralPortraitSample({ purpose: input.purpose, projectId, objectKey }),
      acceptedGeneration: input.acceptedGeneration ?? input.purpose !== "direct_upload" });
    await transaction(OBJECT_WRITE_INTENT_TABLE).insert({
      id,
      requestHash,
      purpose: input.purpose,
      workspaceId,
      projectId,
      ...identity,
      objectKey,
      expectedSize,
      expectedSha256,
      status: "prepared",
      writeReceiptJson: null,
      writeReceiptHash: null,
      referenceJson: null,
      referenceHash: null,
      compensationEvidenceJson: null,
      compensationEvidenceHash: null,
      errorCode: null,
      leaseOwner: writerId,
      leaseExpiresAt,
      leaseFence: 1,
      retryCount: 0,
      maxRetries,
      nextAttemptAt,
      createdAt,
      updatedAt: createdAt,
      putCompletedAt: null,
      committedAt: null,
      compensatedAt: null,
    });
    const record = await readRecord(transaction, id);
    if (!record) fail("OBJECT_WRITE_INTENT_ROW_INVALID");
    return {
      record,
      claim: { id, owner: writerId, fence: 1 },
      idempotent: false,
    };
  });
}

function receiptEvidence(
  record: ObjectWriteIntentRecord,
  receipt: ObjectStorageWriteReceipt | null,
): ObjectWriteReceiptEvidence {
  if (record.provider === "local") {
    if (receipt !== null) fail("OBJECT_WRITE_RECEIPT_PROVIDER_MISMATCH");
    return {
      version: "object-write-receipt.v1",
      mode: "local",
      objectKey: record.objectKey,
      size: record.expectedSize,
      sha256: record.expectedSha256,
    };
  }
  if (
    !receipt
    || receipt.provider !== record.provider
    || receipt.bucket !== record.bucket
    || receipt.region !== record.region
    || receipt.endpoint !== record.endpoint
    || receipt.keyPrefix !== record.keyPrefix
    || receipt.forcePathStyle !== record.forcePathStyle
    || normalizeObjectKey(receipt.key) !== record.objectKey
    || typeof receipt.etag !== "string"
    || !receipt.etag
    || typeof receipt.versionId !== "string"
    || !receipt.versionId
    || receipt.versionId.toLowerCase() === "null"
    || typeof receipt.requestId !== "string"
    || !receipt.requestId
    || receipt.size !== record.expectedSize
    || receipt.sha256 !== record.expectedSha256
  ) {
    fail("OBJECT_WRITE_RECEIPT_PROVIDER_MISMATCH");
  }
  return {
    version: "object-write-receipt.v1",
    mode: "remote",
    receipt,
  };
}

export async function recordObjectWriteReceipt(
  claim: ObjectWriteIntentClaim,
  receipt: ObjectStorageWriteReceipt | null,
  runtime: ObjectWriteIntentRuntime = {},
): Promise<ObjectWriteIntentRecord> {
  const client = database(runtime);
  const completedAt = now(runtime);
  return client.transaction(async (transaction) => {
    const row = await transaction(OBJECT_WRITE_INTENT_TABLE)
      .where({ id: claim.id })
      .forUpdate()
      .first();
    if (!row) fail("OBJECT_WRITE_INTENT_NOT_FOUND");
    const record = mapRecord(row);
    assertActiveProducerClaim(record, claim, completedAt);
    if (record.status !== "prepared") {
      fail("OBJECT_WRITE_INTENT_STATE_CONFLICT");
    }
    const evidence = receiptEvidence(record, receipt);
    const writeReceiptJson = stableJson(evidence);
    const affected = await claimWhere(
      transaction(OBJECT_WRITE_INTENT_TABLE),
      claim,
    )
      .where({ status: "prepared" })
      .andWhere("leaseExpiresAt", ">", completedAt)
      .update({
        status: "stored",
        writeReceiptJson,
        writeReceiptHash: sha256(writeReceiptJson),
        putCompletedAt: completedAt,
        updatedAt: completedAt,
      });
    if (Number(affected) !== 1) fail("OBJECT_WRITE_INTENT_LEASE_LOST");
    const stored = await readRecord(transaction, claim.id);
    if (!stored) fail("OBJECT_WRITE_INTENT_ROW_INVALID");
    await commitWorkspaceStorage(transaction, `intent:${claim.id}`, receipt?.size ?? record.expectedSize,
      { ...evidence, versionId: receipt?.versionId ?? null });
    return stored;
  });
}

export async function handoffLateObjectWriteReceipt(
  claim: ObjectWriteIntentClaim,
  receipt: ObjectStorageWriteReceipt | null,
  runtime: ObjectWriteIntentRuntime = {},
): Promise<ObjectWriteIntentRecord> {
  const handedOffAt = now(runtime);
  const client = database(runtime);
  return client.transaction(async (transaction) => {
    const row = await transaction(OBJECT_WRITE_INTENT_TABLE)
      .where({ id: claim.id })
      .forUpdate()
      .first();
    if (!row) fail("OBJECT_WRITE_INTENT_NOT_FOUND");
    const record = mapRecord(row);
    if (
      ["committed", "compensated", "dead"].includes(record.status)
      || record.referenceJson !== null
      || record.leaseFence >= Number.MAX_SAFE_INTEGER
    ) {
      fail("OBJECT_WRITE_LATE_RECEIPT_STATE_CONFLICT");
    }
    const evidence = receiptEvidence(record, receipt);
    const writeReceiptJson = stableJson(evidence);
    const writeReceiptHash = sha256(writeReceiptJson);
    if (
      record.writeReceiptJson !== null
      && (
        record.writeReceiptJson !== writeReceiptJson
        || record.writeReceiptHash !== writeReceiptHash
      )
    ) {
      fail("OBJECT_WRITE_LATE_RECEIPT_CONFLICT");
    }
    const nextFence = record.leaseFence + 1;
    const affected = await transaction(OBJECT_WRITE_INTENT_TABLE)
      .where({
        id: record.id,
        status: record.status,
        leaseFence: record.leaseFence,
      })
      .update({
        status: "compensation_pending",
        writeReceiptJson,
        writeReceiptHash,
        putCompletedAt: record.putCompletedAt ?? handedOffAt,
        errorCode: "OBJECT_WRITE_LATE_RECEIPT",
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseFence: nextFence,
        nextAttemptAt: handedOffAt,
        updatedAt: handedOffAt,
      });
    if (Number(affected) !== 1) {
      fail("OBJECT_WRITE_INTENT_LEASE_LOST");
    }
    const pending = await readRecord(transaction, record.id);
    if (!pending) fail("OBJECT_WRITE_INTENT_ROW_INVALID");
    await commitWorkspaceStorage(transaction, `intent:${record.id}`, receipt?.size ?? record.expectedSize,
      { ...evidence, versionId: receipt?.versionId ?? null });
    return pending;
  });
}

export async function renewObjectWriteIntentClaim(
  claim: ObjectWriteIntentClaim,
  leaseMs: number,
  runtime: ObjectWriteIntentRuntime = {},
): Promise<ObjectWriteIntentRecord> {
  const currentTime = now(runtime);
  const duration = safeInteger(
    leaseMs,
    "OBJECT_WRITE_INTENT_LEASE_INVALID",
    1,
  );
  if (duration > 24 * 60 * 60_000) {
    fail("OBJECT_WRITE_INTENT_LEASE_INVALID");
  }
  const client = database(runtime);
  return client.transaction(async (transaction) => {
    const row = await transaction(OBJECT_WRITE_INTENT_TABLE)
      .where({ id: claim.id })
      .forUpdate()
      .first();
    if (!row) fail("OBJECT_WRITE_INTENT_NOT_FOUND");
    const record = mapRecord(row);
    assertActiveProducerClaim(record, claim, currentTime);
    const recoveryGraceMs = Math.max(
      0,
      record.nextAttemptAt - (record.leaseExpiresAt ?? currentTime),
    );
    const leaseExpiresAt = currentTime + duration;
    const nextAttemptAt = leaseExpiresAt + recoveryGraceMs;
    if (
      !Number.isSafeInteger(leaseExpiresAt)
      || !Number.isSafeInteger(nextAttemptAt)
    ) {
      fail("OBJECT_WRITE_INTENT_CLOCK_INVALID");
    }
    const affected = await claimWhere(
      transaction(OBJECT_WRITE_INTENT_TABLE),
      claim,
    )
      .whereIn("status", ["prepared", "stored"])
      .andWhere("leaseExpiresAt", ">", currentTime)
      .update({
        leaseExpiresAt,
        nextAttemptAt,
        updatedAt: currentTime,
      });
    if (Number(affected) !== 1) {
      fail("OBJECT_WRITE_INTENT_LEASE_LOST");
    }
    const renewed = await readRecord(transaction, claim.id);
    if (!renewed) fail("OBJECT_WRITE_INTENT_ROW_INVALID");
    return renewed;
  });
}

export async function renewObjectWriteCompensationClaim(
  claim: ObjectWriteIntentClaim,
  leaseMs: number,
  runtime: ObjectWriteIntentRuntime = {},
): Promise<ClaimedObjectWriteIntent> {
  const currentTime = now(runtime);
  const duration = safeInteger(
    leaseMs,
    "OBJECT_WRITE_INTENT_LEASE_INVALID",
    1,
  );
  if (duration > 24 * 60 * 60_000) {
    fail("OBJECT_WRITE_INTENT_LEASE_INVALID");
  }
  const leaseExpiresAt = currentTime + duration;
  if (!Number.isSafeInteger(leaseExpiresAt)) {
    fail("OBJECT_WRITE_INTENT_CLOCK_INVALID");
  }
  const affected = claimWhere(
    database(runtime)(OBJECT_WRITE_INTENT_TABLE),
    claim,
  )
    .where({ status: "compensating" })
    .andWhere("leaseExpiresAt", ">", currentTime)
    .update({
      leaseExpiresAt,
      updatedAt: currentTime,
    });
  if (Number(await affected) !== 1) {
    fail("OBJECT_WRITE_INTENT_LEASE_LOST");
  }
  const renewed = await readRecord(database(runtime), claim.id);
  if (
    !renewed
    || renewed.status !== "compensating"
    || renewed.leaseOwner !== claim.owner
    || renewed.leaseFence !== claim.fence
    || renewed.leaseExpiresAt !== leaseExpiresAt
  ) {
    fail("OBJECT_WRITE_INTENT_ROW_INVALID");
  }
  return renewed as ClaimedObjectWriteIntent;
}

export async function commitObjectWriteIntentInTransaction(
  transaction: Knex.Transaction,
  claim: ObjectWriteIntentClaim,
  reference: ObjectWriteReferenceEvidence,
  runtime: Omit<ObjectWriteIntentRuntime, "database"> = {},
): Promise<ObjectWriteIntentRecord> {
  const committedAt = now(runtime);
  const row = await transaction(OBJECT_WRITE_INTENT_TABLE)
    .where({ id: claim.id })
    .forUpdate()
    .first();
  if (!row) fail("OBJECT_WRITE_INTENT_NOT_FOUND");
  const record = mapRecord(row);
  assertActiveProducerClaim(record, claim, committedAt);
  const project = await transaction("o_project")
    .where({
      id: record.projectId,
      workspaceId: record.workspaceId,
      deletionState: "active",
    })
    .select("id")
    .forUpdate()
    .first();
  if (!project) {
    fail("OBJECT_WRITE_INTENT_PROJECT_NOT_ACTIVE");
  }
  const referenceV2 = reference.version === "object-write-reference.v2";
  const exactReferenceFields = [
    "version",
    "table",
    "rowId",
    "workspaceId",
    "projectId",
    "storageKey",
    ...(referenceV2
      ? ["publicUrl", "deliveryMode", "cdnBaseUrl"]
      : []),
  ].sort();
  if (
    record.status !== "stored"
    || ![
      "object-write-reference.v1",
      "object-write-reference.v2",
    ].includes(reference.version)
    || Object.keys(reference).sort().join("\u0000")
      !== exactReferenceFields.join("\u0000")
    || text(reference.table, "OBJECT_WRITE_REFERENCE_INVALID") === ""
    || text(reference.rowId, "OBJECT_WRITE_REFERENCE_INVALID") === ""
    || reference.workspaceId !== record.workspaceId
    || reference.projectId !== record.projectId
    || normalizeObjectKey(reference.storageKey) !== record.objectKey
  ) {
    fail("OBJECT_WRITE_REFERENCE_INVALID");
  }
  if (
    (record.purpose === "relay_final" || record.purpose === "video_enhance")
    && !referenceV2
  ) {
    fail("OBJECT_WRITE_REFERENCE_V2_REQUIRED");
  }
  if (!["o_media_asset", "o_tasks", "o_image"].includes(reference.table)) {
    fail("OBJECT_WRITE_REFERENCE_TABLE_UNSUPPORTED");
  }
  if (referenceV2) {
    if (reference.table !== "o_media_asset") {
      fail("OBJECT_WRITE_REFERENCE_TABLE_UNSUPPORTED");
    }
    const configuration = runtime.configuration
      ?? resolveObjectStorageConfiguration();
    const identity = objectWriteProviderIdentity(configuration);
    const delivery = resolveStableObjectDelivery({
      configuration,
      objectKey: record.objectKey,
      candidateUrl: reference.publicUrl,
    });
    if (
      identity.provider !== record.provider
      || identity.providerFingerprint !== record.providerFingerprint
      || identity.bucket !== record.bucket
      || identity.region !== record.region
      || identity.endpoint !== record.endpoint
      || identity.keyPrefix !== record.keyPrefix
      || identity.forcePathStyle !== record.forcePathStyle
      || !delivery
      || delivery.mode !== reference.deliveryMode
      || delivery.publicUrl !== reference.publicUrl
      || delivery.cdnBaseUrl !== reference.cdnBaseUrl
    ) {
      fail("OBJECT_WRITE_REFERENCE_DELIVERY_URL_INVALID");
    }
  }
  let referencedRow: Record<string, unknown> | undefined;
  if (reference.table === "o_media_asset") {
    referencedRow = await transaction("o_media_asset")
      .where({
        id: reference.rowId,
        workspaceId: record.workspaceId,
        projectId: record.projectId,
        storageKey: record.objectKey,
      })
      .select("*")
      .first();
  } else if (reference.table === "o_tasks") {
    referencedRow = await transaction("o_tasks")
      .where({
        id: reference.rowId,
        projectId: record.projectId,
      })
      .select("id", "relatedObjects")
      .first();
  } else {
    referencedRow = await transaction("o_image as image")
      .innerJoin("o_assets as asset", "asset.id", "image.assetsId")
      .where({
        "image.id": reference.rowId,
        "image.storageKey": record.objectKey,
        "asset.projectId": record.projectId,
      })
      .select("image.id")
      .first();
  }
  if (!referencedRow) {
    fail("OBJECT_WRITE_REFERENCE_NOT_FOUND");
  }
  if (
    referenceV2
    && String(referencedRow.url || "") !== reference.publicUrl
  ) {
    fail("OBJECT_WRITE_REFERENCE_NOT_FOUND");
  }
  if (reference.table === "o_tasks") {
    let relatedObjects: unknown;
    try {
      relatedObjects = JSON.parse(String(referencedRow.relatedObjects || ""));
    } catch {
      fail("OBJECT_WRITE_REFERENCE_NOT_FOUND");
    }
    if (
      !relatedObjects
      || typeof relatedObjects !== "object"
      || Array.isArray(relatedObjects)
      || normalizeObjectKey(String(
        (relatedObjects as Record<string, unknown>).outputStorageKey || "",
      )) !== record.objectKey
    ) {
      fail("OBJECT_WRITE_REFERENCE_NOT_FOUND");
    }
  }
  const referenceJson = stableJson(reference);
  const affected = await claimWhere(
    transaction(OBJECT_WRITE_INTENT_TABLE),
    claim,
  )
    .where({ status: "stored" })
    .andWhere("leaseExpiresAt", ">", committedAt)
    .update({
      status: "committed",
      referenceJson,
      referenceHash: sha256(referenceJson),
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: null,
      committedAt,
      nextAttemptAt: committedAt,
      updatedAt: committedAt,
    });
  if (Number(affected) !== 1) fail("OBJECT_WRITE_INTENT_LEASE_LOST");
  const committed = await readRecord(transaction, claim.id);
  if (!committed) fail("OBJECT_WRITE_INTENT_ROW_INVALID");
  return committed;
}

function errorCode(error: unknown): string {
  const candidate = error && typeof error === "object"
    ? String((error as { code?: unknown }).code || "")
    : "";
  return /^[A-Z0-9_]{1,255}$/u.test(candidate)
    ? candidate
    : "OBJECT_WRITE_REFERENCE_FAILED";
}

export async function markObjectWriteCompensationPending(
  claim: ObjectWriteIntentClaim,
  error: unknown,
  runtime: ObjectWriteIntentRuntime = {},
): Promise<ObjectWriteIntentRecord> {
  const failedAt = now(runtime);
  const client = database(runtime);
  return client.transaction(async (transaction) => {
    const row = await transaction(OBJECT_WRITE_INTENT_TABLE)
      .where({ id: claim.id })
      .forUpdate()
      .first();
    if (!row) fail("OBJECT_WRITE_INTENT_NOT_FOUND");
    const record = mapRecord(row);
    assertActiveProducerClaim(record, claim, failedAt);
    const nextAttemptAt = record.writeReceiptJson
      ? failedAt
      : Math.max(failedAt, record.nextAttemptAt);
    const affected = await claimWhere(
      transaction(OBJECT_WRITE_INTENT_TABLE),
      claim,
    )
      .whereIn("status", ["prepared", "stored"])
      .andWhere("leaseExpiresAt", ">", failedAt)
      .update({
        status: "compensation_pending",
        errorCode: errorCode(error),
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt,
        updatedAt: failedAt,
      });
    if (Number(affected) !== 1) {
      fail("OBJECT_WRITE_INTENT_LEASE_LOST");
    }
    const pending = await readRecord(transaction, claim.id);
    if (!pending) fail("OBJECT_WRITE_INTENT_ROW_INVALID");
    return pending;
  });
}

function applyCompensationEligibility(
  query: Knex.QueryBuilder,
  currentTime: number,
): Knex.QueryBuilder {
  return query
    .where("nextAttemptAt", "<=", currentTime)
    .andWhere((eligible) => {
      eligible
        .where((abandoned) => {
          abandoned
            .where({ status: "compensation_pending" })
            .whereNull("leaseOwner")
            .whereNull("leaseExpiresAt");
        })
        .orWhere((expiredWriter) => {
          expiredWriter
            .whereIn("status", ["prepared", "stored"])
            .whereNotNull("leaseOwner")
            .whereNotNull("leaseExpiresAt")
            .andWhere("leaseExpiresAt", "<=", currentTime);
        })
        .orWhere((expiredCompensator) => {
          expiredCompensator
            .where({ status: "compensating" })
            .whereNotNull("leaseOwner")
            .whereNotNull("leaseExpiresAt")
            .andWhere("leaseExpiresAt", "<=", currentTime);
        });
    });
}

export async function claimDueObjectWriteCompensations(
  input: {
    workerId: string;
    leaseMs?: number;
    limit?: number;
  },
  runtime: ObjectWriteIntentRuntime = {},
): Promise<ClaimedObjectWriteIntent[]> {
  const workerId = text(
    input.workerId,
    "OBJECT_WRITE_INTENT_WORKER_INVALID",
  );
  const leaseMs = safeInteger(
    input.leaseMs ?? 5 * 60_000,
    "OBJECT_WRITE_INTENT_LEASE_INVALID",
    1,
  );
  const limit = safeInteger(
    input.limit ?? 20,
    "OBJECT_WRITE_INTENT_LIMIT_INVALID",
    1,
  );
  if (leaseMs > 24 * 60 * 60_000 || limit > 100) {
    fail("OBJECT_WRITE_INTENT_INPUT_INVALID");
  }
  const claimedAt = now(runtime);
  const leaseExpiresAt = claimedAt + leaseMs;
  if (!Number.isSafeInteger(leaseExpiresAt)) {
    fail("OBJECT_WRITE_INTENT_CLOCK_INVALID");
  }
  const client = database(runtime);
  return client.transaction(async (transaction) => {
    let query = applyCompensationEligibility(
      transaction(OBJECT_WRITE_INTENT_TABLE),
      claimedAt,
    )
      .orderBy("nextAttemptAt", "asc")
      .orderBy("createdAt", "asc")
      .limit(limit);
    if (isPostgresClient(client)) query = query.forUpdate().skipLocked();
    const rows = await query;
    const claims: ClaimedObjectWriteIntent[] = [];
    for (const raw of rows) {
      const record = mapRecord(raw);
      if (record.leaseFence >= Number.MAX_SAFE_INTEGER) {
        const blocked = await transaction(OBJECT_WRITE_INTENT_TABLE)
          .where({
            id: record.id,
            status: record.status,
            leaseFence: record.leaseFence,
          })
          .update({
            status: "dead",
            errorCode: "OBJECT_WRITE_INTENT_FENCE_EXHAUSTED",
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: claimedAt,
          });
        if (Number(blocked) !== 1) {
          fail("OBJECT_WRITE_INTENT_ROW_INVALID");
        }
        continue;
      }
      const nextFence = record.leaseFence + 1;
      let update = transaction(OBJECT_WRITE_INTENT_TABLE)
        .where({
          id: record.id,
          status: record.status,
          leaseFence: record.leaseFence,
        });
      update = applyCompensationEligibility(update, claimedAt);
      const affected = await update.update({
        status: "compensating",
        leaseOwner: workerId,
        leaseExpiresAt,
        leaseFence: nextFence,
        updatedAt: claimedAt,
      });
      if (Number(affected) !== 1) continue;
      const claimed = await readRecord(transaction, record.id);
      if (
        !claimed
        || claimed.status !== "compensating"
        || claimed.leaseOwner !== workerId
        || claimed.leaseExpiresAt !== leaseExpiresAt
        || claimed.leaseFence !== nextFence
      ) {
        fail("OBJECT_WRITE_INTENT_ROW_INVALID");
      }
      claims.push(claimed as ClaimedObjectWriteIntent);
    }
    return claims;
  });
}

/** Claim one known intent without consuming unrelated cleanup work. */
export async function claimObjectWriteCompensationById(
  input: {
    id: string;
    workerId: string;
    leaseMs?: number;
  },
  runtime: ObjectWriteIntentRuntime = {},
): Promise<ClaimedObjectWriteIntent | null> {
  const id = text(input.id, "OBJECT_WRITE_INTENT_ID_INVALID");
  const workerId = text(
    input.workerId,
    "OBJECT_WRITE_INTENT_WORKER_INVALID",
  );
  const leaseMs = safeInteger(
    input.leaseMs ?? 5 * 60_000,
    "OBJECT_WRITE_INTENT_LEASE_INVALID",
    1,
  );
  if (leaseMs > 24 * 60 * 60_000) {
    fail("OBJECT_WRITE_INTENT_INPUT_INVALID");
  }
  const claimedAt = now(runtime);
  const leaseExpiresAt = claimedAt + leaseMs;
  if (!Number.isSafeInteger(leaseExpiresAt)) {
    fail("OBJECT_WRITE_INTENT_CLOCK_INVALID");
  }
  const client = database(runtime);
  return client.transaction(async (transaction) => {
    let query = applyCompensationEligibility(
      transaction(OBJECT_WRITE_INTENT_TABLE).where({ id }),
      claimedAt,
    );
    if (isPostgresClient(client)) query = query.forUpdate().skipLocked();
    const raw = await query.first();
    if (!raw) return null;
    const record = mapRecord(raw);
    if (record.leaseFence >= Number.MAX_SAFE_INTEGER) {
      fail("OBJECT_WRITE_INTENT_FENCE_EXHAUSTED");
    }
    const nextFence = record.leaseFence + 1;
    let update = transaction(OBJECT_WRITE_INTENT_TABLE).where({
      id,
      status: record.status,
      leaseFence: record.leaseFence,
    });
    update = applyCompensationEligibility(update, claimedAt);
    const affected = await update.update({
      status: "compensating",
      leaseOwner: workerId,
      leaseExpiresAt,
      leaseFence: nextFence,
      updatedAt: claimedAt,
    });
    if (Number(affected) !== 1) return null;
    const claimed = await readRecord(transaction, id);
    if (
      !claimed
      || claimed.status !== "compensating"
      || claimed.leaseOwner !== workerId
      || claimed.leaseExpiresAt !== leaseExpiresAt
      || claimed.leaseFence !== nextFence
    ) {
      fail("OBJECT_WRITE_INTENT_ROW_INVALID");
    }
    return claimed as ClaimedObjectWriteIntent;
  });
}

export async function deferUnsettledObjectWriteCompensation(
  claim: ObjectWriteIntentClaim,
  input: { retryDelayMs?: number } = {},
  runtime: ObjectWriteIntentRuntime = {},
): Promise<ObjectWriteIntentRecord> {
  const deferredAt = now(runtime);
  const retryDelayMs = safeInteger(
    input.retryDelayMs ?? 60_000,
    "OBJECT_WRITE_INTENT_RETRY_DELAY_INVALID",
    1,
  );
  if (retryDelayMs > 24 * 60 * 60_000) {
    fail("OBJECT_WRITE_INTENT_RETRY_DELAY_INVALID");
  }
  const nextAttemptAt = deferredAt + retryDelayMs;
  if (!Number.isSafeInteger(nextAttemptAt)) {
    fail("OBJECT_WRITE_INTENT_CLOCK_INVALID");
  }
  const affected = await claimWhere(
    database(runtime)(OBJECT_WRITE_INTENT_TABLE),
    claim,
  )
    .where({ status: "compensating" })
    .whereNull("writeReceiptHash")
    .andWhere("leaseExpiresAt", ">", deferredAt)
    .update({
      status: "compensation_pending",
      errorCode: "OBJECT_WRITE_PUT_OUTCOME_UNCERTAIN",
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt,
      updatedAt: deferredAt,
    });
  if (Number(affected) !== 1) fail("OBJECT_WRITE_INTENT_LEASE_LOST");
  const pending = await readRecord(database(runtime), claim.id);
  if (!pending) fail("OBJECT_WRITE_INTENT_ROW_INVALID");
  return pending;
}

/**
 * A receiptless PUT is still conclusively compensatable when the storage
 * adapter has exhaustively listed the intent-exclusive key, removed every
 * observed version/delete-marker, and listed it empty again. This terminal
 * transition is deliberately limited to ephemeral portrait samples; durable
 * user assets retain the stronger receipt-before-terminal invariant.
 */
export async function completeReceiptlessPortraitSampleCompensation(
  claim: ObjectWriteIntentClaim,
  evidence: Record<string, unknown>,
  runtime: ObjectWriteIntentRuntime = {},
): Promise<ObjectWriteIntentRecord> {
  const completedAt = now(runtime);
  const client = database(runtime);
  return client.transaction(async (transaction) => {
    const raw = await transaction(OBJECT_WRITE_INTENT_TABLE)
      .where({ id: claim.id })
      .forUpdate()
      .first();
    if (!raw) fail("OBJECT_WRITE_INTENT_NOT_FOUND");
    const current = mapRecord(raw);
    if (
      !isEphemeralPortraitSample(current)
      || current.status !== "compensating"
      || current.referenceJson !== null
      || current.referenceHash !== null
      || current.writeReceiptJson !== null
      || current.writeReceiptHash !== null
      || current.putCompletedAt !== null
    ) {
      fail("OBJECT_WRITE_INTENT_ROW_INVALID");
    }
    const reconciliation: ObjectWriteReceiptEvidence = {
      version: "object-write-reconciliation.v1",
      mode: "remote_reconciled_absent",
      objectKey: current.objectKey,
      size: current.expectedSize,
      sha256: current.expectedSha256,
      providerFingerprint: current.providerFingerprint,
    };
    const writeReceiptJson = stableJson(reconciliation);
    const normalizedEvidence = {
      ...evidence,
      version: "object-write-compensation.v1",
      intentId: claim.id,
      compensatedAt: completedAt,
    };
    const compensationEvidenceJson = stableJson(normalizedEvidence);
    const affected = await claimWhere(
      transaction(OBJECT_WRITE_INTENT_TABLE),
      claim,
    )
      .where({ status: "compensating", purpose: "direct_upload" })
      .whereNull("writeReceiptJson")
      .whereNull("writeReceiptHash")
      .whereNull("putCompletedAt")
      .andWhere("leaseExpiresAt", ">", completedAt)
      .update({
        status: "compensated",
        writeReceiptJson,
        writeReceiptHash: sha256(writeReceiptJson),
        putCompletedAt: completedAt,
        compensationEvidenceJson,
        compensationEvidenceHash: sha256(compensationEvidenceJson),
        errorCode: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        compensatedAt: completedAt,
        nextAttemptAt: completedAt,
        updatedAt: completedAt,
      });
    if (Number(affected) !== 1) fail("OBJECT_WRITE_INTENT_LEASE_LOST");
    const compensated = await readRecord(transaction, claim.id);
    if (!compensated || !isEphemeralPortraitSample(compensated)) {
      fail("OBJECT_WRITE_INTENT_ROW_INVALID");
    }
    await releaseWorkspaceStorage(transaction, `intent:${claim.id}`, normalizedEvidence);
    return compensated;
  });
}

/**
 * A known receipt may also be terminalized after an exhaustive exact-key
 * reconciliation. Keeping this separate from normal asset compensation makes
 * the exception impossible to use for a referenced/persistent object.
 */
export async function completePortraitSampleCompensation(
  claim: ObjectWriteIntentClaim & { writeReceiptHash: string },
  evidence: Record<string, unknown>,
  runtime: ObjectWriteIntentRuntime = {},
): Promise<ObjectWriteIntentRecord> {
  const current = await readRecord(database(runtime), claim.id);
  if (
    !current
    || !isEphemeralPortraitSample(current)
    || current.referenceJson !== null
    || current.referenceHash !== null
  ) {
    fail("OBJECT_WRITE_INTENT_ROW_INVALID");
  }
  return completeObjectWriteCompensation(claim, evidence, runtime);
}

export async function completeObjectWriteCompensation(
  claim: ObjectWriteIntentClaim & { writeReceiptHash: string },
  evidence: Record<string, unknown>,
  runtime: ObjectWriteIntentRuntime = {},
): Promise<ObjectWriteIntentRecord> {
  return database(runtime).transaction(async transaction => {
    const completedAt = now(runtime);
    const normalizedEvidence = {
      ...evidence,
      version: "object-write-compensation.v1",
      intentId: claim.id,
      compensatedAt: completedAt,
    };
    const compensationEvidenceJson = stableJson(normalizedEvidence);
    const affected = await claimWhere(
      transaction(OBJECT_WRITE_INTENT_TABLE),
      claim,
    )
      .where({ status: "compensating" })
      .andWhere({ writeReceiptHash: claim.writeReceiptHash })
      .whereNotNull("writeReceiptJson")
      .andWhere("leaseExpiresAt", ">", completedAt)
      .update({
        status: "compensated",
        compensationEvidenceJson,
        compensationEvidenceHash: sha256(compensationEvidenceJson),
        errorCode: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        compensatedAt: completedAt,
        nextAttemptAt: completedAt,
        updatedAt: completedAt,
      });
    if (Number(affected) !== 1) fail("OBJECT_WRITE_INTENT_LEASE_LOST");
    const compensated = await readRecord(transaction, claim.id);
    if (!compensated) fail("OBJECT_WRITE_INTENT_ROW_INVALID");
    await releaseWorkspaceStorage(transaction, `intent:${claim.id}`, normalizedEvidence);
    return compensated;
  });
}

export async function failObjectWriteCompensation(
  claim: ObjectWriteIntentClaim,
  error: unknown,
  runtime: ObjectWriteIntentRuntime = {},
): Promise<ObjectWriteIntentRecord> {
  const failedAt = now(runtime);
  const client = database(runtime);
  return client.transaction(async (transaction) => {
    const row = await transaction(OBJECT_WRITE_INTENT_TABLE)
      .where({ id: claim.id })
      .forUpdate()
      .first();
    if (!row) fail("OBJECT_WRITE_INTENT_NOT_FOUND");
    const record = mapRecord(row);
    if (
      record.status !== "compensating"
      || record.leaseOwner !== claim.owner
      || record.leaseFence !== claim.fence
      || record.leaseExpiresAt === null
      || record.leaseExpiresAt <= failedAt
    ) {
      fail("OBJECT_WRITE_INTENT_LEASE_LOST");
    }
    const retryCount = record.writeReceiptHash === null
      && isEphemeralPortraitSample(record)
      ? Math.min(record.maxRetries, record.retryCount + 1)
      : record.retryCount + 1;
    if (record.writeReceiptHash === null && !isEphemeralPortraitSample(record)) {
      const nextAttemptAt = failedAt + 60_000;
      if (!Number.isSafeInteger(nextAttemptAt)) {
        fail("OBJECT_WRITE_INTENT_CLOCK_INVALID");
      }
      const affected = await claimWhere(
        transaction(OBJECT_WRITE_INTENT_TABLE),
        claim,
      )
        .where({ status: "compensating" })
        .whereNull("writeReceiptHash")
        .andWhere("leaseExpiresAt", ">", failedAt)
        .update({
          status: "compensation_pending",
          errorCode: "OBJECT_WRITE_PUT_OUTCOME_UNCERTAIN",
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt,
          updatedAt: failedAt,
        });
      if (Number(affected) !== 1) {
        fail("OBJECT_WRITE_INTENT_LEASE_LOST");
      }
      const pending = await readRecord(transaction, claim.id);
      if (!pending) fail("OBJECT_WRITE_INTENT_ROW_INVALID");
      return pending;
    }
    // An unknown portrait PUT stays durably retryable until exact-key
    // enumeration proves absence. Marking it dead would violate the schema48
    // receipt invariant and could strand a private frame permanently.
    const terminal = record.writeReceiptHash !== null
      && retryCount > record.maxRetries;
    const retryDelay = Math.min(
      6 * 60 * 60_000,
      1_000 * 2 ** Math.min(20, Math.max(0, retryCount - 1)),
    );
    const affected = await claimWhere(
      transaction(OBJECT_WRITE_INTENT_TABLE),
      claim,
    )
      .where({ status: "compensating" })
      .andWhere("leaseExpiresAt", ">", failedAt)
      .update({
        status: terminal ? "dead" : "compensation_pending",
        errorCode: errorCode(error),
        retryCount,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: terminal ? failedAt : failedAt + retryDelay,
        updatedAt: failedAt,
      });
    if (Number(affected) !== 1) fail("OBJECT_WRITE_INTENT_LEASE_LOST");
    const failed = await readRecord(transaction, claim.id);
    if (!failed) fail("OBJECT_WRITE_INTENT_ROW_INVALID");
    return failed;
  });
}

function evidenceRecord(
  value: unknown,
  keys: readonly string[],
  code: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (
    Object.keys(record).length !== allowed.size
    || Object.keys(record).some((key) => !allowed.has(key))
  ) {
    fail(code);
  }
  return record;
}

function parseHashedEvidence(
  json: string | null,
  evidenceHash: string | null,
  code: string,
): unknown | null {
  if (!json && !evidenceHash) return null;
  if (!json || !evidenceHash || sha256(json) !== evidenceHash) fail(code);
  try {
    return JSON.parse(json) as unknown;
  } catch {
    fail(code);
  }
}

function evidenceText(
  value: unknown,
  maximum: number,
  code: string,
): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(code);
  }
  return value;
}

export function parseObjectWriteReceiptEvidence(
  record: Pick<
    ObjectWriteIntentRecord,
    | "writeReceiptJson"
    | "writeReceiptHash"
    | "purpose"
    | "projectId"
    | "provider"
    | "providerFingerprint"
    | "bucket"
    | "region"
    | "endpoint"
    | "keyPrefix"
    | "forcePathStyle"
    | "objectKey"
    | "expectedSize"
    | "expectedSha256"
  >,
): ObjectWriteReceiptEvidence | null {
  const code = "OBJECT_WRITE_RECEIPT_EVIDENCE_INVALID";
  const parsed = parseHashedEvidence(
    record.writeReceiptJson,
    record.writeReceiptHash,
    code,
  );
  if (parsed === null) return null;
  if (
    parsed
    && typeof parsed === "object"
    && !Array.isArray(parsed)
    && (parsed as Record<string, unknown>).version
      === "object-write-reconciliation.v1"
  ) {
    const reconciliation = evidenceRecord(parsed, [
      "version",
      "mode",
      "objectKey",
      "size",
      "sha256",
      "providerFingerprint",
    ], code);
    if (
      reconciliation.mode !== "remote_reconciled_absent"
      || record.provider === "local"
      || !isEphemeralPortraitSample(record)
      || normalizeObjectKey(String(reconciliation.objectKey || ""))
        !== record.objectKey
      || Number(reconciliation.size) !== record.expectedSize
      || reconciliation.sha256 !== record.expectedSha256
      || reconciliation.providerFingerprint !== record.providerFingerprint
    ) {
      fail(code);
    }
    return reconciliation as unknown as ObjectWriteReceiptEvidence;
  }
  const evidence = evidenceRecord(parsed, [
    "version",
    "mode",
    record.provider === "local" ? "objectKey" : "receipt",
    ...(record.provider === "local" ? ["size", "sha256"] : []),
  ], code);
  if (evidence.version !== "object-write-receipt.v1") fail(code);
  if (record.provider === "local") {
    if (
      evidence.mode !== "local"
      || normalizeObjectKey(String(evidence.objectKey || ""))
        !== record.objectKey
      || Number(evidence.size) !== record.expectedSize
      || evidence.sha256 !== record.expectedSha256
    ) {
      fail(code);
    }
    return evidence as unknown as ObjectWriteReceiptEvidence;
  }
  if (evidence.mode !== "remote") fail(code);
  const receipt = evidenceRecord(evidence.receipt, [
    "provider",
    "bucket",
    "region",
    "endpoint",
    "keyPrefix",
    "forcePathStyle",
    "key",
    "etag",
    "versionId",
    "requestId",
    "size",
    "sha256",
  ], code);
  const etag = evidenceText(receipt.etag, 512, code);
  const versionId = evidenceText(receipt.versionId, 1024, code);
  const requestId = evidenceText(receipt.requestId, 512, code);
  if (
    versionId.toLowerCase() === "null"
    || receipt.provider !== record.provider
    || receipt.bucket !== record.bucket
    || receipt.region !== record.region
    || receipt.endpoint !== record.endpoint
    || receipt.keyPrefix !== record.keyPrefix
    || receipt.forcePathStyle !== record.forcePathStyle
    || normalizeObjectKey(String(receipt.key || "")) !== record.objectKey
    || Number(receipt.size) !== record.expectedSize
    || receipt.sha256 !== record.expectedSha256
    || !etag
    || !requestId
  ) {
    fail(code);
  }
  return evidence as unknown as ObjectWriteReceiptEvidence;
}

export function parseObjectWriteReferenceEvidence(
  record: Pick<
    ObjectWriteIntentRecord,
    | "referenceJson"
    | "referenceHash"
    | "workspaceId"
    | "projectId"
    | "provider"
    | "keyPrefix"
    | "objectKey"
  >,
): ObjectWriteReferenceEvidence | null {
  const code = "OBJECT_WRITE_REFERENCE_EVIDENCE_INVALID";
  const parsed = parseHashedEvidence(
    record.referenceJson,
    record.referenceHash,
    code,
  );
  if (parsed === null) return null;
  const parsedRecord = parsed && typeof parsed === "object"
    && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const version = parsedRecord.version;
  if (
    version !== "object-write-reference.v1"
    && version !== "object-write-reference.v2"
  ) {
    fail(code);
  }
  const evidence = evidenceRecord(parsed, [
    "version",
    "table",
    "rowId",
    "workspaceId",
    "projectId",
    "storageKey",
    ...(version === "object-write-reference.v2"
      ? ["publicUrl", "deliveryMode", "cdnBaseUrl"]
      : []),
  ], code);
  const table = evidenceText(evidence.table, 255, code);
  const rowId = evidenceText(evidence.rowId, 255, code);
  if (
    !table
    || !rowId
    || evidence.workspaceId !== record.workspaceId
    || Number(evidence.projectId) !== record.projectId
    || normalizeObjectKey(String(evidence.storageKey || ""))
      !== record.objectKey
  ) {
    fail(code);
  }
  if (version === "object-write-reference.v2") {
    const publicUrl = evidenceText(evidence.publicUrl, 4096, code);
    const delivery = validateStableObjectDeliveryEvidence({
      provider: record.provider,
      keyPrefix: record.keyPrefix,
      objectKey: record.objectKey,
      mode: evidence.deliveryMode,
      publicUrl,
      cdnBaseUrl: evidence.cdnBaseUrl,
    });
    if (!delivery || table !== "o_media_asset") fail(code);
  }
  return evidence as unknown as ObjectWriteReferenceEvidence;
}
