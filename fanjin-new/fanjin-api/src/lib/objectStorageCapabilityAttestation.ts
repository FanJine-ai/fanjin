import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  type ObjectStorageAdapter,
  type ObjectStorageConditionalDeleteReceipt,
  type ObjectStorageGenerationSnapshot,
  type ObjectStorageWriteReceipt,
} from "@/lib/objectStorage";
import {
  inspectObjectStorageConfiguration,
  resolveObjectStorageConfiguration,
  type ObjectStorageConfiguration,
} from "@/lib/objectStorageConfig";
import { getReleaseIdentity, type ReleaseIdentity } from "@/lib/releaseIdentity";
import { inspectSubjectRuntimeCapabilityReceipt, usesSubjectRuntimeCapabilityReceipt } from "./subjectRuntimeCapabilityReceipt";

export const OBJECT_STORAGE_CAPABILITY_ATTESTATION_FORMAT =
  "fanjin-object-storage-capability-attestation/v1" as const;
export const OBJECT_STORAGE_CAPABILITY_ATTESTATION_VERSION = 1 as const;
export const DEFAULT_OBJECT_STORAGE_ATTESTATION_MAX_AGE_MS = 15 * 60_000;
export const MAX_OBJECT_STORAGE_ATTESTATION_MAX_AGE_MS = 24 * 60 * 60_000;
export const OBJECT_STORAGE_ATTESTATION_FUTURE_SKEW_MS = 60_000;

const MAX_ATTESTATION_BYTES = 128 * 1024;
const MAX_CANARY_GENERATIONS = 100;
const CANARY_PROJECT_PREFIX = "fanjin-storage-capability-canary";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REQUEST_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const VERSION_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,1024}$/u;
const ETAG_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/u;

type RemoteObjectStorageConfiguration = ObjectStorageConfiguration & {
  provider: "s3" | "tos";
  bucket: string;
  region: string;
  endpoint: string;
};

export interface ObjectStorageCapabilityIdentity {
  provider: "s3" | "tos";
  bucket: string;
  region: string;
  endpoint: string;
  keyPrefix: string;
  forcePathStyle: boolean;
}

export interface ObjectStorageCapabilityGenerationEvidence {
  versionId: string;
  etag: string | null;
  requestId: string;
}

export interface ObjectStorageCapabilityWriteEvidence
  extends ObjectStorageCapabilityGenerationEvidence {
  etag: string;
  size: number;
  sha256: string;
}

export interface ObjectStorageCapabilityAttestation {
  format: typeof OBJECT_STORAGE_CAPABILITY_ATTESTATION_FORMAT;
  version: typeof OBJECT_STORAGE_CAPABILITY_ATTESTATION_VERSION;
  capability: "versioned-exact-list-conditional-delete-v1";
  observedAt: string;
  releaseSha: string;
  storageIdentity: ObjectStorageCapabilityIdentity;
  canary: {
    logicalKey: string;
    writes: {
      v1: ObjectStorageCapabilityWriteEvidence;
      v2: ObjectStorageCapabilityWriteEvidence;
    };
    deleteMarker: ObjectStorageCapabilityGenerationEvidence & {
      etag: null;
      observedRequestIds: string[];
    };
    exactListing: {
      requestIds: string[];
      observedVersionIds: string[];
      observedDeleteMarkerVersionIds: string[];
    };
    conditionalDeleteOldVersion: {
      versionId: string;
      etag: string;
      requestId: string;
      outcome: "deleted";
    };
    cleanup: {
      requestIds: string[];
      deletedVersionIds: string[];
      verifiedAbsentRequestIds: string[];
      remainingGenerations: 0;
    };
  };
}

export type ObjectStorageCapabilityAttestationReason =
  | "ready"
  | "configuration_invalid"
  | "remote_storage_required"
  | "release_sha_missing"
  | "attestation_path_missing"
  | "attestation_file_missing"
  | "attestation_file_unsafe"
  | "attestation_file_too_large"
  | "attestation_json_invalid"
  | "attestation_shape_invalid"
  | "attestation_stale"
  | "attestation_from_future"
  | "attestation_identity_mismatch"
  | "attestation_release_mismatch"
  | "attestation_max_age_invalid"
  | "attestation_clock_invalid"
  | "subject_receipt_invalid";

export interface ObjectStorageCapabilityAttestationInspection {
  ready: boolean;
  reason: ObjectStorageCapabilityAttestationReason;
  observedAt: string | null;
  ageMs: number | null;
  maximumAgeMs: number | null;
  storageIdentityMatches: boolean;
  releaseShaMatches: boolean;
  authority?: "subject-signed-config";
  errorCode?: string;
  configSha?: string;
  configRevision?: number;
  capabilityReceiptSha?: string;
  centralPreparationReceiptSha?: string;
}

interface RunObjectStorageCapabilityCanaryInput {
  storage: ObjectStorageAdapter;
  configuration: ObjectStorageConfiguration;
  releaseSha: string;
  now?: () => Date;
  nonce?: string;
}

interface InspectObjectStorageCapabilityAttestationInput {
  environment?: Record<string, string | undefined>;
  now?: number;
  filePath?: string;
  maximumAgeMs?: number;
  releaseIdentity?: ReleaseIdentity;
  configuration?: ObjectStorageConfiguration;
}

function nonEmptyString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    return null;
  }
  return value;
}

function requireRemoteConfiguration(
  configuration: ObjectStorageConfiguration,
): RemoteObjectStorageConfiguration {
  if (
    !["s3", "tos"].includes(configuration.provider)
    || !configuration.bucket
    || !configuration.region
    || !configuration.endpoint
  ) {
    throw new Error("OBJECT_STORAGE_CAPABILITY_REMOTE_STORAGE_REQUIRED");
  }
  return configuration as RemoteObjectStorageConfiguration;
}

function identityFromConfiguration(
  configuration: RemoteObjectStorageConfiguration,
): ObjectStorageCapabilityIdentity {
  return {
    provider: configuration.provider,
    bucket: configuration.bucket,
    region: configuration.region,
    endpoint: configuration.endpoint,
    keyPrefix: configuration.keyPrefix,
    forcePathStyle: configuration.forcePathStyle,
  };
}

function sameIdentity(
  left: ObjectStorageCapabilityIdentity,
  right: ObjectStorageCapabilityIdentity,
): boolean {
  return left.provider === right.provider
    && left.bucket === right.bucket
    && left.region === right.region
    && left.endpoint === right.endpoint
    && left.keyPrefix === right.keyPrefix
    && left.forcePathStyle === right.forcePathStyle;
}

function assertRequestId(value: unknown, code = "OBJECT_STORAGE_CAPABILITY_REQUEST_ID_MISSING"): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!REQUEST_ID_PATTERN.test(normalized)) throw new Error(code);
  return normalized;
}

function assertVersionId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!VERSION_ID_PATTERN.test(normalized) || normalized.toLowerCase() === "null") {
    throw new Error("OBJECT_STORAGE_CAPABILITY_VERSIONING_REQUIRED");
  }
  return normalized;
}

function assertEtag(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!ETAG_PATTERN.test(normalized)) {
    throw new Error("OBJECT_STORAGE_CAPABILITY_ETAG_REQUIRED");
  }
  return normalized;
}

function assertWriteReceipt(
  receipt: ObjectStorageWriteReceipt,
  input: {
    identity: ObjectStorageCapabilityIdentity;
    logicalKey: string;
    payload: Uint8Array;
  },
): ObjectStorageCapabilityWriteEvidence {
  const receiptIdentity: ObjectStorageCapabilityIdentity = {
    provider: receipt.provider,
    bucket: receipt.bucket,
    region: receipt.region,
    endpoint: receipt.endpoint,
    keyPrefix: receipt.keyPrefix,
    forcePathStyle: receipt.forcePathStyle,
  };
  if (!sameIdentity(receiptIdentity, input.identity) || receipt.key !== input.logicalKey) {
    throw new Error("OBJECT_STORAGE_CAPABILITY_WRITE_IDENTITY_MISMATCH");
  }
  const expectedSha256 = createHash("sha256").update(input.payload).digest("hex");
  if (
    receipt.size !== input.payload.byteLength
    || receipt.sha256 !== expectedSha256
  ) {
    throw new Error("OBJECT_STORAGE_CAPABILITY_WRITE_CONTENT_MISMATCH");
  }
  return {
    versionId: assertVersionId(receipt.versionId),
    etag: assertEtag(receipt.etag),
    requestId: assertRequestId(receipt.requestId),
    size: receipt.size,
    sha256: receipt.sha256,
  };
}

function trackWriteReceiptForCleanup(
  known: Map<string, ObjectStorageGenerationSnapshot>,
  receipt: ObjectStorageWriteReceipt,
  identity: ObjectStorageCapabilityIdentity,
  logicalKey: string,
): void {
  if (receipt.key !== logicalKey) return;
  try {
    const versionId = assertVersionId(receipt.versionId);
    const etag = assertEtag(receipt.etag);
    const requestId = assertRequestId(receipt.requestId);
    known.set(generationKey({ versionId, deleteMarker: false }), {
      provider: identity.provider,
      bucket: identity.bucket,
      key: logicalKey,
      exists: true,
      deleteMarker: false,
      etag,
      versionId,
      size: null,
      lastModified: null,
      requestId,
    });
  } catch {
    // A receipt without a stable generation identity cannot be used for a
    // precise conditional cleanup. The exact listing in `finally` remains
    // authoritative and any inability to prove cleanup is surfaced.
  }
}

function assertSnapshotIdentity(
  snapshot: ObjectStorageGenerationSnapshot,
  identity: ObjectStorageCapabilityIdentity,
  logicalKey: string,
): void {
  if (
    snapshot.provider !== identity.provider
    || snapshot.bucket !== identity.bucket
    || snapshot.key !== logicalKey
  ) {
    throw new Error("OBJECT_STORAGE_CAPABILITY_LIST_IDENTITY_MISMATCH");
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function generationKey(snapshot: {
  versionId: string | null;
  deleteMarker: boolean;
}): string {
  return `${snapshot.versionId ?? ""}\0${snapshot.deleteMarker ? "marker" : "object"}`;
}

async function exactList(
  storage: ObjectStorageAdapter,
  logicalKey: string,
  identity: ObjectStorageCapabilityIdentity,
): Promise<ObjectStorageGenerationSnapshot[]> {
  const snapshots = await storage.listGenerationSnapshots(logicalKey, {
    exactKey: true,
    maximumObjects: MAX_CANARY_GENERATIONS,
  });
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    assertSnapshotIdentity(snapshot, identity, logicalKey);
    assertRequestId(snapshot.requestId);
    const versionId = assertVersionId(snapshot.versionId);
    const key = generationKey({ ...snapshot, versionId });
    if (seen.has(key)) {
      throw new Error("OBJECT_STORAGE_CAPABILITY_DUPLICATE_GENERATION");
    }
    seen.add(key);
    if (!snapshot.exists) {
      throw new Error("OBJECT_STORAGE_CAPABILITY_LISTED_GENERATION_ABSENT");
    }
    if (snapshot.deleteMarker) {
      if (snapshot.etag !== null) {
        throw new Error("OBJECT_STORAGE_CAPABILITY_DELETE_MARKER_INVALID");
      }
    } else {
      assertEtag(snapshot.etag);
    }
  }
  return snapshots;
}

function requireDeletedReceipt(
  receipt: ObjectStorageConditionalDeleteReceipt,
): { requestId: string; outcome: "deleted" } {
  if (receipt.outcome !== "deleted") {
    throw new Error("OBJECT_STORAGE_CAPABILITY_CONDITIONAL_DELETE_NOT_PROVEN");
  }
  return {
    outcome: "deleted",
    requestId: assertRequestId(receipt.requestId),
  };
}

async function cleanupCanaryGenerations(input: {
  storage: ObjectStorageAdapter;
  identity: ObjectStorageCapabilityIdentity;
  logicalKey: string;
  known: Map<string, ObjectStorageGenerationSnapshot>;
}): Promise<{
  requestIds: string[];
  deletedVersionIds: string[];
  verifiedAbsentRequestIds: string[];
  remainingGenerations: 0;
}> {
  const errors: unknown[] = [];
  const cleanupRequestIds: string[] = [];
  const deletedVersionIds: string[] = [];
  const verifiedAbsentRequestIds: string[] = [];
  try {
    for (const snapshot of await exactList(input.storage, input.logicalKey, input.identity)) {
      input.known.set(generationKey(snapshot), snapshot);
    }
  } catch (error) {
    errors.push(error);
  }

  for (const snapshot of input.known.values()) {
    if (!snapshot.versionId) {
      errors.push(new Error("OBJECT_STORAGE_CAPABILITY_CLEANUP_VERSION_ID_MISSING"));
      continue;
    }
    try {
      const receipt = await input.storage.deleteGenerationIfMatch(
        input.logicalKey,
        snapshot.deleteMarker
          ? {
              etag: null,
              versionId: snapshot.versionId,
              deleteMarker: true,
            }
          : {
              etag: assertEtag(snapshot.etag),
              versionId: snapshot.versionId,
              deleteMarker: false,
            },
      );
      cleanupRequestIds.push(assertRequestId(receipt.requestId));
      deletedVersionIds.push(snapshot.versionId);
    } catch (error) {
      errors.push(error);
    }
  }

  let remaining: ObjectStorageGenerationSnapshot[] | null = null;
  try {
    remaining = await exactList(input.storage, input.logicalKey, input.identity);
    if (remaining.length > 0) {
      errors.push(new Error("OBJECT_STORAGE_CAPABILITY_CLEANUP_INCOMPLETE"));
    }
  } catch (error) {
    errors.push(error);
  }

  for (const snapshot of input.known.values()) {
    if (!snapshot.versionId) continue;
    try {
      const absent = await input.storage.inspectGeneration(input.logicalKey, {
        versionId: snapshot.versionId,
      });
      assertSnapshotIdentity(absent, input.identity, input.logicalKey);
      verifiedAbsentRequestIds.push(assertRequestId(absent.requestId));
      if (absent.exists) {
        errors.push(new Error("OBJECT_STORAGE_CAPABILITY_CLEANUP_GENERATION_REMAINS"));
      }
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0 || remaining === null || remaining.length > 0) {
    throw new AggregateError(
      errors.length > 0 ? errors : [new Error("OBJECT_STORAGE_CAPABILITY_CLEANUP_UNPROVEN")],
      "OBJECT_STORAGE_CAPABILITY_CLEANUP_FAILED",
    );
  }
  return {
    requestIds: uniqueStrings(cleanupRequestIds),
    deletedVersionIds: uniqueStrings(deletedVersionIds),
    verifiedAbsentRequestIds: uniqueStrings(verifiedAbsentRequestIds),
    remainingGenerations: 0,
  };
}

function mergePrimaryAndCleanupError(primary: unknown, cleanup: unknown): never {
  if (primary !== null) {
    throw new AggregateError(
      [primary, cleanup],
      "OBJECT_STORAGE_CAPABILITY_CANARY_AND_CLEANUP_FAILED",
    );
  }
  throw cleanup;
}

export async function runObjectStorageCapabilityCanary(
  input: RunObjectStorageCapabilityCanaryInput,
): Promise<ObjectStorageCapabilityAttestation> {
  const configuration = requireRemoteConfiguration(input.configuration);
  const identity = identityFromConfiguration(configuration);
  const releaseSha = String(input.releaseSha || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(releaseSha)) {
    throw new Error("OBJECT_STORAGE_CAPABILITY_RELEASE_SHA_INVALID");
  }
  const nonce = String(input.nonce || randomBytes(16).toString("hex")).trim().toLowerCase();
  if (!/^[a-f0-9]{16,64}$/u.test(nonce)) {
    throw new Error("OBJECT_STORAGE_CAPABILITY_NONCE_INVALID");
  }
  const logicalKey = `${CANARY_PROJECT_PREFIX}/${releaseSha}/${nonce}/generation.bin`;
  const known = new Map<string, ObjectStorageGenerationSnapshot>();
  let primaryError: unknown = null;
  let proof: Omit<ObjectStorageCapabilityAttestation["canary"], "cleanup"> | null = null;
  let cleanup: ObjectStorageCapabilityAttestation["canary"]["cleanup"] | null = null;

  try {
    const v1Payload = Buffer.from(
      `fanjin-storage-capability-v1:${releaseSha}:${nonce}`,
      "utf8",
    );
    const v1Receipt = await input.storage.put(
      logicalKey,
      v1Payload,
      "application/octet-stream",
    );
    trackWriteReceiptForCleanup(known, v1Receipt, identity, logicalKey);
    const v1 = assertWriteReceipt(v1Receipt, {
      identity,
      logicalKey,
      payload: v1Payload,
    });

    const v2Payload = Buffer.from(
      `fanjin-storage-capability-v2:${releaseSha}:${nonce}`,
      "utf8",
    );
    const v2Receipt = await input.storage.put(
      logicalKey,
      v2Payload,
      "application/octet-stream",
    );
    trackWriteReceiptForCleanup(known, v2Receipt, identity, logicalKey);
    const v2 = assertWriteReceipt(v2Receipt, {
      identity,
      logicalKey,
      payload: v2Payload,
    });
    if (v1.versionId === v2.versionId) {
      throw new Error("OBJECT_STORAGE_CAPABILITY_VERSION_ID_NOT_UNIQUE");
    }
    // The current adapter intentionally returns no mutation receipt for this
    // unversioned DELETE. We therefore record only request IDs from the exact
    // listing that independently observes the resulting delete marker.
    await input.storage.delete(logicalKey);
    const listed = await exactList(input.storage, logicalKey, identity);
    for (const snapshot of listed) known.set(generationKey(snapshot), snapshot);
    const versions = listed.filter((snapshot) => !snapshot.deleteMarker);
    const markers = listed.filter((snapshot) => snapshot.deleteMarker);
    const observedVersionIds = uniqueStrings(
      versions.map((snapshot) => assertVersionId(snapshot.versionId)),
    );
    if (
      listed.length !== 3
      || markers.length !== 1
      || observedVersionIds.length !== 2
      || !observedVersionIds.includes(v1.versionId)
      || !observedVersionIds.includes(v2.versionId)
    ) {
      throw new Error("OBJECT_STORAGE_CAPABILITY_EXACT_LIST_PROOF_INVALID");
    }
    const marker = markers[0];
    const markerVersionId = assertVersionId(marker.versionId);
    const markerRequestId = assertRequestId(marker.requestId);

    const oldDeleteReceipt = requireDeletedReceipt(
      await input.storage.deleteGenerationIfMatch(logicalKey, {
        etag: v1.etag,
        versionId: v1.versionId,
        deleteMarker: false,
      }),
    );
    known.delete(generationKey({ versionId: v1.versionId, deleteMarker: false }));
    const afterOldDelete = await exactList(input.storage, logicalKey, identity);
    for (const snapshot of afterOldDelete) known.set(generationKey(snapshot), snapshot);
    if (
      afterOldDelete.length !== 2
      || afterOldDelete.some((snapshot) => snapshot.versionId === v1.versionId)
      || !afterOldDelete.some((snapshot) => snapshot.versionId === v2.versionId && !snapshot.deleteMarker)
      || !afterOldDelete.some((snapshot) => (
        snapshot.versionId === markerVersionId && snapshot.deleteMarker
      ))
    ) {
      throw new Error("OBJECT_STORAGE_CAPABILITY_CONDITIONAL_DELETE_PROOF_INVALID");
    }

    proof = {
      logicalKey,
      writes: { v1, v2 },
      deleteMarker: {
        versionId: markerVersionId,
        etag: null,
        requestId: markerRequestId,
        observedRequestIds: uniqueStrings(
          [...listed, ...afterOldDelete]
            .filter((snapshot) => snapshot.versionId === markerVersionId)
            .map((snapshot) => assertRequestId(snapshot.requestId)),
        ),
      },
      exactListing: {
        requestIds: uniqueStrings(listed.map((snapshot) => assertRequestId(snapshot.requestId))),
        observedVersionIds,
        observedDeleteMarkerVersionIds: [markerVersionId],
      },
      conditionalDeleteOldVersion: {
        versionId: v1.versionId,
        etag: v1.etag,
        requestId: oldDeleteReceipt.requestId,
        outcome: "deleted",
      },
    };
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      cleanup = await cleanupCanaryGenerations({
        storage: input.storage,
        identity,
        logicalKey,
        known,
      });
    } catch (cleanupError) {
      mergePrimaryAndCleanupError(primaryError, cleanupError);
    }
  }

  if (primaryError !== null) throw primaryError;
  if (!proof || !cleanup) {
    throw new Error("OBJECT_STORAGE_CAPABILITY_PROOF_INCOMPLETE");
  }
  return {
    format: OBJECT_STORAGE_CAPABILITY_ATTESTATION_FORMAT,
    version: OBJECT_STORAGE_CAPABILITY_ATTESTATION_VERSION,
    capability: "versioned-exact-list-conditional-delete-v1",
    observedAt: (input.now ?? (() => new Date()))().toISOString(),
    releaseSha,
    storageIdentity: identity,
    canary: {
      ...proof,
      cleanup,
    },
  };
}

function isStringArray(value: unknown, pattern: RegExp, maximum = 200): value is string[] {
  return Array.isArray(value)
    && value.length <= maximum
    && value.every((entry) => typeof entry === "string" && pattern.test(entry));
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function parseGenerationEvidence(
  value: unknown,
  requireEtag: boolean,
): ObjectStorageCapabilityGenerationEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const versionId = nonEmptyString(record.versionId, 1024);
  const requestId = nonEmptyString(record.requestId, 512);
  const etag = record.etag === null ? null : nonEmptyString(record.etag, 512);
  if (
    !versionId
    || versionId.toLowerCase() === "null"
    || !requestId
    || !REQUEST_ID_PATTERN.test(requestId)
    || (requireEtag && (!etag || !ETAG_PATTERN.test(etag)))
    || (!requireEtag && etag !== null)
  ) {
    return null;
  }
  return { versionId, requestId, etag };
}

export function parseObjectStorageCapabilityAttestation(
  value: unknown,
): ObjectStorageCapabilityAttestation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const storageIdentity = root.storageIdentity;
  const canary = root.canary;
  if (
    !hasOnlyKeys(root, [
      "format",
      "version",
      "capability",
      "observedAt",
      "releaseSha",
      "storageIdentity",
      "canary",
    ])
    || root.format !== OBJECT_STORAGE_CAPABILITY_ATTESTATION_FORMAT
    || root.version !== OBJECT_STORAGE_CAPABILITY_ATTESTATION_VERSION
    || root.capability !== "versioned-exact-list-conditional-delete-v1"
    || typeof root.observedAt !== "string"
    || Number.isNaN(Date.parse(root.observedAt))
    || new Date(Date.parse(root.observedAt)).toISOString() !== root.observedAt
    || typeof root.releaseSha !== "string"
    || !SHA256_PATTERN.test(root.releaseSha)
    || !storageIdentity
    || typeof storageIdentity !== "object"
    || Array.isArray(storageIdentity)
    || !canary
    || typeof canary !== "object"
    || Array.isArray(canary)
  ) {
    return null;
  }
  const identityRecord = storageIdentity as Record<string, unknown>;
  const identity: ObjectStorageCapabilityIdentity = {
    provider: identityRecord.provider as "s3" | "tos",
    bucket: nonEmptyString(identityRecord.bucket, 255) ?? "",
    region: nonEmptyString(identityRecord.region, 128) ?? "",
    endpoint: nonEmptyString(identityRecord.endpoint, 2048) ?? "",
    keyPrefix: nonEmptyString(identityRecord.keyPrefix, 1024) ?? "",
    forcePathStyle: identityRecord.forcePathStyle as boolean,
  };
  if (
    !hasOnlyKeys(identityRecord, [
      "provider",
      "bucket",
      "region",
      "endpoint",
      "keyPrefix",
      "forcePathStyle",
    ])
    || !["s3", "tos"].includes(identity.provider)
    || !identity.bucket
    || !identity.region
    || !identity.endpoint
    || !identity.keyPrefix
    || typeof identity.forcePathStyle !== "boolean"
  ) {
    return null;
  }

  const canaryRecord = canary as Record<string, unknown>;
  const writes = canaryRecord.writes as Record<string, unknown> | undefined;
  const markerRecord = canaryRecord.deleteMarker as Record<string, unknown> | undefined;
  const listing = canaryRecord.exactListing as Record<string, unknown> | undefined;
  const oldDelete = canaryRecord.conditionalDeleteOldVersion as Record<string, unknown> | undefined;
  const cleanup = canaryRecord.cleanup as Record<string, unknown> | undefined;
  const v1Record = writes?.v1 as Record<string, unknown> | undefined;
  const v2Record = writes?.v2 as Record<string, unknown> | undefined;
  const v1 = parseGenerationEvidence(writes?.v1, true);
  const v2 = parseGenerationEvidence(writes?.v2, true);
  const marker = parseGenerationEvidence(markerRecord, false);
  const logicalKey = nonEmptyString(canaryRecord.logicalKey, 1024);
  if (
    !hasOnlyKeys(canaryRecord, [
      "logicalKey",
      "writes",
      "deleteMarker",
      "exactListing",
      "conditionalDeleteOldVersion",
      "cleanup",
    ])
    || !writes
    || Array.isArray(writes)
    || !hasOnlyKeys(writes, ["v1", "v2"])
    || !v1Record
    || Array.isArray(v1Record)
    || !hasOnlyKeys(v1Record, [
      "versionId",
      "etag",
      "requestId",
      "size",
      "sha256",
    ])
    || !v2Record
    || Array.isArray(v2Record)
    || !hasOnlyKeys(v2Record, [
      "versionId",
      "etag",
      "requestId",
      "size",
      "sha256",
    ])
    || !markerRecord
    || Array.isArray(markerRecord)
    || !hasOnlyKeys(markerRecord, [
      "versionId",
      "etag",
      "requestId",
      "observedRequestIds",
    ])
    || !listing
    || Array.isArray(listing)
    || !hasOnlyKeys(listing, [
      "requestIds",
      "observedVersionIds",
      "observedDeleteMarkerVersionIds",
    ])
    || !oldDelete
    || Array.isArray(oldDelete)
    || !hasOnlyKeys(oldDelete, [
      "versionId",
      "etag",
      "requestId",
      "outcome",
    ])
    || !cleanup
    || Array.isArray(cleanup)
    || !hasOnlyKeys(cleanup, [
      "requestIds",
      "deletedVersionIds",
      "verifiedAbsentRequestIds",
      "remainingGenerations",
    ])
    || !v1
    || !v2
    || !marker
    || !logicalKey
    || !new RegExp(
      `^${CANARY_PROJECT_PREFIX}/${root.releaseSha}/[a-f0-9]{16,64}/generation\\.bin$`,
      "u",
    ).test(logicalKey)
    || v1.versionId === v2.versionId
    || !Number.isSafeInteger(v1Record.size)
    || Number(v1Record.size) < 1
    || !Number.isSafeInteger(v2Record.size)
    || Number(v2Record.size) < 1
    || typeof v1Record.sha256 !== "string"
    || !SHA256_PATTERN.test(v1Record.sha256)
    || typeof v2Record.sha256 !== "string"
    || !SHA256_PATTERN.test(v2Record.sha256)
    || v1Record.sha256 === v2Record.sha256
    || marker.versionId === v1.versionId
    || marker.versionId === v2.versionId
    || !listing
    || !oldDelete
    || !cleanup
    || !isStringArray(markerRecord?.observedRequestIds, REQUEST_ID_PATTERN)
    || markerRecord.observedRequestIds.length < 1
    || new Set(markerRecord.observedRequestIds).size
      !== markerRecord.observedRequestIds.length
    || !markerRecord.observedRequestIds.includes(marker.requestId)
    || !isStringArray(listing.requestIds, REQUEST_ID_PATTERN)
    || listing.requestIds.length < 1
    || new Set(listing.requestIds).size !== listing.requestIds.length
    || !isStringArray(listing.observedVersionIds, VERSION_ID_PATTERN)
    || !isStringArray(listing.observedDeleteMarkerVersionIds, VERSION_ID_PATTERN)
    || listing.observedVersionIds.length !== 2
    || !listing.observedVersionIds.includes(v1.versionId)
    || !listing.observedVersionIds.includes(v2.versionId)
    || listing.observedDeleteMarkerVersionIds.length !== 1
    || listing.observedDeleteMarkerVersionIds[0] !== marker.versionId
    || oldDelete.versionId !== v1.versionId
    || oldDelete.etag !== v1.etag
    || oldDelete.outcome !== "deleted"
    || !nonEmptyString(oldDelete.requestId, 512)
    || !REQUEST_ID_PATTERN.test(String(oldDelete.requestId))
    || cleanup.remainingGenerations !== 0
    || !isStringArray(cleanup.requestIds, REQUEST_ID_PATTERN)
    || cleanup.requestIds.length < 2
    || new Set(cleanup.requestIds).size !== cleanup.requestIds.length
    || !isStringArray(cleanup.deletedVersionIds, VERSION_ID_PATTERN)
    || cleanup.deletedVersionIds.length !== 2
    || new Set(cleanup.deletedVersionIds).size !== 2
    || !isStringArray(cleanup.verifiedAbsentRequestIds, REQUEST_ID_PATTERN)
    || !cleanup.deletedVersionIds.includes(v2.versionId)
    || !cleanup.deletedVersionIds.includes(marker.versionId)
    || cleanup.verifiedAbsentRequestIds.length < 2
    || new Set(cleanup.verifiedAbsentRequestIds).size
      !== cleanup.verifiedAbsentRequestIds.length
  ) {
    return null;
  }
  return value as ObjectStorageCapabilityAttestation;
}

function resolveMaximumAgeMs(
  raw: unknown,
): number | null {
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value)
    || value < 1_000
    || value > MAX_OBJECT_STORAGE_ATTESTATION_MAX_AGE_MS
  ) {
    return null;
  }
  return value;
}

export function resolveObjectStorageCapabilityAttestationPath(
  environment: Record<string, string | undefined> = process.env,
): string | null {
  const configured = String(
    environment.FANJIN_OBJECT_STORAGE_CAPABILITY_ATTESTATION_FILE || "",
  ).trim();
  if (configured) return path.resolve(configured);
  const dataDir = String(environment.FANJIN_DATA_DIR || "").trim();
  return dataDir
    ? path.resolve(dataDir, "readiness", "object-storage-capability-attestation.json")
    : null;
}

function failedInspection(
  reason: ObjectStorageCapabilityAttestationReason,
  maximumAgeMs: number | null,
  patch: Partial<ObjectStorageCapabilityAttestationInspection> = {},
): ObjectStorageCapabilityAttestationInspection {
  return {
    ready: false,
    reason,
    observedAt: null,
    ageMs: null,
    maximumAgeMs,
    storageIdentityMatches: false,
    releaseShaMatches: false,
    ...patch,
  };
}

function isTrustedAttestationPathEntry(
  stat: fs.Stats,
  expected: "file" | "directory",
): boolean {
  const correctType = expected === "file"
    ? stat.isFile()
    : stat.isDirectory();
  if (!correctType) return false;
  if (process.platform === "win32") return true;
  const currentUid = process.getuid?.();
  return (stat.mode & 0o022) === 0
    && (
      currentUid === undefined
      || stat.uid === currentUid
      || stat.uid === 0
    );
}

export function inspectObjectStorageCapabilityAttestation(
  input: InspectObjectStorageCapabilityAttestationInput = {},
): ObjectStorageCapabilityAttestationInspection {
  const environment = input.environment ?? process.env;
  if (!usesSubjectRuntimeCapabilityReceipt(environment)) return inspectNativeObjectStorageCapabilityAttestation(input);
  try {
    return inspectSubjectRuntimeCapabilityReceipt({
      environment, now: input.now ?? Date.now(),
      configuration: input.configuration ?? resolveObjectStorageConfiguration(environment),
    });
  } catch {
    return failedInspection("subject_receipt_invalid", null, { authority: "subject-signed-config", errorCode: "CONFIG_RUNTIME_STORAGE_INVALID" });
  }
}

/** Explicit one-shot prepare checks still require a fresh native canary before a central receipt exists. */
export function inspectNativeObjectStorageCapabilityAttestation(
  input: InspectObjectStorageCapabilityAttestationInput = {},
): ObjectStorageCapabilityAttestationInspection {
  const environment = input.environment ?? process.env;
  const maximumAgeMs = resolveMaximumAgeMs(
    input.maximumAgeMs
      ?? environment.FANJIN_OBJECT_STORAGE_CAPABILITY_ATTESTATION_MAX_AGE_MS
      ?? DEFAULT_OBJECT_STORAGE_ATTESTATION_MAX_AGE_MS,
  );
  if (maximumAgeMs === null) {
    return failedInspection("attestation_max_age_invalid", null);
  }
  let configuration: ObjectStorageConfiguration;
  if (input.configuration) {
    configuration = input.configuration;
  } else {
    const configurationInspection = inspectObjectStorageConfiguration(environment);
    if (!configurationInspection.supported) {
      return failedInspection("configuration_invalid", maximumAgeMs);
    }
    configuration = resolveObjectStorageConfiguration(environment);
  }
  let remote: RemoteObjectStorageConfiguration;
  try {
    remote = requireRemoteConfiguration(configuration);
  } catch {
    return failedInspection("remote_storage_required", maximumAgeMs);
  }
  const releaseIdentity = input.releaseIdentity ?? getReleaseIdentity(environment);
  const releaseSha = releaseIdentity.artifactSha256;
  if (!releaseSha || !SHA256_PATTERN.test(releaseSha)) {
    return failedInspection("release_sha_missing", maximumAgeMs);
  }
  const filePath = input.filePath
    ? path.resolve(input.filePath)
    : resolveObjectStorageCapabilityAttestationPath(environment);
  if (!filePath) {
    return failedInspection("attestation_path_missing", maximumAgeMs);
  }
  let raw: string | null = null;
  let fileFailureReason:
    | "attestation_file_missing"
    | "attestation_file_unsafe"
    | "attestation_file_too_large"
    | null = null;
  let descriptor: number | null = null;
  try {
    const parent = fs.lstatSync(path.dirname(filePath));
    if (!isTrustedAttestationPathEntry(parent, "directory")) {
      throw new Error("OBJECT_STORAGE_CAPABILITY_ATTESTATION_PARENT_UNSAFE");
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stat = fs.fstatSync(descriptor);
    if (!isTrustedAttestationPathEntry(stat, "file")) {
      fileFailureReason = "attestation_file_unsafe";
    } else if (stat.size < 2 || stat.size > MAX_ATTESTATION_BYTES) {
      fileFailureReason = "attestation_file_too_large";
    } else {
      raw = fs.readFileSync(descriptor, "utf8");
    }
  } catch (error) {
    fileFailureReason = (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "attestation_file_missing"
      : "attestation_file_unsafe";
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        fileFailureReason = "attestation_file_unsafe";
      }
    }
  }
  if (fileFailureReason || raw === null) {
    return failedInspection(
      fileFailureReason ?? "attestation_file_unsafe",
      maximumAgeMs,
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return failedInspection("attestation_json_invalid", maximumAgeMs);
  }
  const attestation = parseObjectStorageCapabilityAttestation(parsedJson);
  if (!attestation) {
    return failedInspection("attestation_shape_invalid", maximumAgeMs);
  }
  const expectedIdentity = identityFromConfiguration(remote);
  const storageIdentityMatches = sameIdentity(
    attestation.storageIdentity,
    expectedIdentity,
  );
  const releaseShaMatches = attestation.releaseSha === releaseSha;
  const observedAtMs = Date.parse(attestation.observedAt);
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    return failedInspection("attestation_clock_invalid", maximumAgeMs, {
      observedAt: attestation.observedAt,
      storageIdentityMatches,
      releaseShaMatches,
    });
  }
  const ageMs = now - observedAtMs;
  const evidence = {
    observedAt: attestation.observedAt,
    ageMs,
    storageIdentityMatches,
    releaseShaMatches,
  };
  if (!storageIdentityMatches) {
    return failedInspection("attestation_identity_mismatch", maximumAgeMs, evidence);
  }
  if (!releaseShaMatches) {
    return failedInspection("attestation_release_mismatch", maximumAgeMs, evidence);
  }
  if (ageMs < -OBJECT_STORAGE_ATTESTATION_FUTURE_SKEW_MS) {
    return failedInspection("attestation_from_future", maximumAgeMs, evidence);
  }
  if (ageMs > maximumAgeMs) {
    return failedInspection("attestation_stale", maximumAgeMs, evidence);
  }
  return {
    ready: true,
    reason: "ready",
    observedAt: attestation.observedAt,
    ageMs,
    maximumAgeMs,
    storageIdentityMatches: true,
    releaseShaMatches: true,
  };
}

export async function writeObjectStorageCapabilityAttestationAtomic(
  filePath: string,
  attestation: ObjectStorageCapabilityAttestation,
): Promise<void> {
  if (!parseObjectStorageCapabilityAttestation(attestation)) {
    throw new Error("OBJECT_STORAGE_CAPABILITY_ATTESTATION_INVALID");
  }
  const destination = path.resolve(filePath);
  const directory = path.dirname(destination);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.promises.lstat(directory);
  if (!isTrustedAttestationPathEntry(directoryStat, "directory")) {
    throw new Error("OBJECT_STORAGE_CAPABILITY_ATTESTATION_PARENT_UNSAFE");
  }
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle: fs.promises.FileHandle | null = null;
  let directoryHandle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(attestation, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, destination);
    if (process.platform !== "win32") {
      directoryHandle = await fs.promises.open(directory, "r");
      await directoryHandle.sync();
      await directoryHandle.close();
      directoryHandle = null;
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (directoryHandle) {
      try {
        await directoryHandle.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    try {
      await fs.promises.unlink(temporary);
    } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException)?.code !== "ENOENT") {
        cleanupErrors.push(unlinkError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "OBJECT_STORAGE_CAPABILITY_ATTESTATION_ATOMIC_WRITE_FAILED",
      );
    }
    throw error;
  }
}
