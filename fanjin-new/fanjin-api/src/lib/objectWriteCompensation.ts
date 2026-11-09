import type { Knex } from "knex";

import {
  completeObjectWriteCompensation,
  completePortraitSampleCompensation,
  completeReceiptlessPortraitSampleCompensation,
  deferUnsettledObjectWriteCompensation,
  failObjectWriteCompensation,
  isEphemeralPortraitSampleIntent,
  objectWriteProviderIdentity,
  parseObjectWriteReceiptEvidence,
  type ClaimedObjectWriteIntent,
  type ObjectWriteIntentRuntime,
  type ObjectWriteReceiptEvidence,
} from "@/lib/objectWriteIntent";
import {
  createRemoteObjectStorageAdapter,
  normalizeObjectKey,
  type ObjectStorageAdapter,
  type ObjectStorageGenerationSnapshot,
} from "@/lib/objectStorage";
import {
  resolveObjectStorageConfiguration,
  type ObjectStorageConfiguration,
} from "@/lib/objectStorageConfig";
import oss from "@/utils/oss";

export interface ObjectWriteCompensationRuntime {
  database?: Knex;
  clock?: () => number;
  configuration?: ObjectStorageConfiguration;
  storage?: ObjectStorageAdapter;
  deleteLocal?: (key: string) => Promise<void>;
  signal?: AbortSignal;
  maximumGenerations?: number;
  beforeClaimCommit?: (
    claim: ClaimedObjectWriteIntent,
  ) => Promise<void>;
}

function compensationError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function repositoryRuntime(
  runtime: ObjectWriteCompensationRuntime,
): ObjectWriteIntentRuntime {
  return {
    ...(runtime.database ? { database: runtime.database } : {}),
    ...(runtime.clock ? { clock: runtime.clock } : {}),
    ...(runtime.configuration
      ? { configuration: runtime.configuration }
      : {}),
  };
}

function assertCurrentProviderIdentity(
  claim: ClaimedObjectWriteIntent,
  configuration: ObjectStorageConfiguration,
): void {
  const current = objectWriteProviderIdentity(configuration);
  if (
    claim.provider !== current.provider
    || claim.providerFingerprint !== current.providerFingerprint
    || claim.bucket !== current.bucket
    || claim.region !== current.region
    || claim.endpoint !== current.endpoint
    || claim.keyPrefix !== current.keyPrefix
    || claim.forcePathStyle !== current.forcePathStyle
  ) {
    throw compensationError("OBJECT_WRITE_COMPENSATION_PROVIDER_MISMATCH");
  }
}

function assertSnapshot(
  claim: ClaimedObjectWriteIntent,
  snapshot: ObjectStorageGenerationSnapshot,
): void {
  if (
    snapshot.provider !== claim.provider
    || snapshot.bucket !== claim.bucket
    || normalizeObjectKey(snapshot.key) !== claim.objectKey
    || !snapshot.exists
    || !snapshot.versionId
    || snapshot.versionId === "null"
    || (
      snapshot.deleteMarker
        ? snapshot.etag !== null
        : !snapshot.etag
    )
  ) {
    throw compensationError(
      "OBJECT_WRITE_COMPENSATION_GENERATION_INVALID",
    );
  }
}

function assertReceiptBoundToClaim(
  claim: ClaimedObjectWriteIntent,
): ObjectWriteReceiptEvidence | null {
  const evidence = parseObjectWriteReceiptEvidence(claim);
  if (!evidence) return null;
  if (evidence.mode === "remote_reconciled_absent") {
    if (
      !isEphemeralPortraitSampleIntent(claim)
      || evidence.objectKey !== claim.objectKey
      || evidence.size !== claim.expectedSize
      || evidence.sha256 !== claim.expectedSha256
      || evidence.providerFingerprint !== claim.providerFingerprint
    ) {
      throw compensationError("OBJECT_WRITE_RECEIPT_EVIDENCE_INVALID");
    }
    return evidence;
  }
  if (claim.provider === "local") {
    if (
      evidence.mode !== "local"
      || evidence.objectKey !== claim.objectKey
      || evidence.size !== claim.expectedSize
      || evidence.sha256 !== claim.expectedSha256
    ) {
      throw compensationError("OBJECT_WRITE_RECEIPT_EVIDENCE_INVALID");
    }
    return evidence;
  }
  if (
    evidence.mode !== "remote"
    || evidence.receipt.provider !== claim.provider
    || evidence.receipt.bucket !== claim.bucket
    || evidence.receipt.region !== claim.region
    || evidence.receipt.endpoint !== claim.endpoint
    || evidence.receipt.keyPrefix !== claim.keyPrefix
    || evidence.receipt.forcePathStyle !== claim.forcePathStyle
    || normalizeObjectKey(evidence.receipt.key) !== claim.objectKey
    || evidence.receipt.size !== claim.expectedSize
    || evidence.receipt.sha256 !== claim.expectedSha256
  ) {
    throw compensationError("OBJECT_WRITE_RECEIPT_EVIDENCE_INVALID");
  }
  return evidence;
}

async function deleteLocalIntentObject(
  claim: ClaimedObjectWriteIntent,
  runtime: ObjectWriteCompensationRuntime,
): Promise<{ outcome: "deleted" | "target_already_absent" }> {
  const deleteLocal = runtime.deleteLocal
    ?? (async (key: string) => oss.deleteFile(key));
  try {
    await deleteLocal(claim.objectKey);
    return { outcome: "deleted" };
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && String((error as { code?: unknown }).code || "") === "ENOENT"
    ) {
      return { outcome: "target_already_absent" };
    }
    throw error;
  }
}

async function deleteRemoteIntentGenerations(
  claim: ClaimedObjectWriteIntent,
  storage: ObjectStorageAdapter,
  runtime: ObjectWriteCompensationRuntime,
): Promise<{
  outcome: "deleted" | "target_already_absent";
  deletedGenerations: number;
  providerRequestIds: string[];
}> {
  const maximumGenerations = runtime.maximumGenerations ?? 100;
  if (
    !Number.isSafeInteger(maximumGenerations)
    || maximumGenerations < 1
    || maximumGenerations > 1_000
  ) {
    throw compensationError(
      "OBJECT_WRITE_COMPENSATION_GENERATION_LIMIT_INVALID",
    );
  }
  const snapshots = await storage.listGenerationSnapshots(
    claim.objectKey,
    {
      maximumObjects: maximumGenerations,
      exactKey: true,
      signal: runtime.signal,
    },
  );
  const identities = new Set<string>();
  for (const snapshot of snapshots) {
    assertSnapshot(claim, snapshot);
    const identity = `${snapshot.key}\0${snapshot.versionId}`;
    if (identities.has(identity)) {
      throw compensationError(
        "OBJECT_WRITE_COMPENSATION_GENERATION_DUPLICATE",
      );
    }
    identities.add(identity);
  }
  const providerRequestIds: string[] = [];
  for (const snapshot of snapshots) {
    if (runtime.signal?.aborted) {
      throw compensationError("OBJECT_WRITE_COMPENSATION_ABORTED");
    }
    const receipt = await storage.deleteGenerationIfMatch(
      claim.objectKey,
      {
        etag: snapshot.etag,
        versionId: snapshot.versionId,
        deleteMarker: snapshot.deleteMarker,
        signal: runtime.signal,
      },
    );
    providerRequestIds.push(receipt.requestId);
  }
  const residual = await storage.listGenerationSnapshots(
    claim.objectKey,
    {
      maximumObjects: maximumGenerations,
      exactKey: true,
      signal: runtime.signal,
    },
  );
  if (residual.length) {
    throw compensationError("OBJECT_WRITE_COMPENSATION_INCOMPLETE");
  }
  return {
    outcome: snapshots.length ? "deleted" : "target_already_absent",
    deletedGenerations: snapshots.length,
    providerRequestIds,
  };
}

export async function processClaimedObjectWriteCompensation(
  claim: ClaimedObjectWriteIntent,
  runtime: ObjectWriteCompensationRuntime = {},
): Promise<"compensated" | "deferred"> {
  const repository = repositoryRuntime(runtime);
  const receiptKnown = claim.writeReceiptHash !== null;
  let claimCommitStarted = false;
  const enterClaimCommit = async () => {
    if (claimCommitStarted) return;
    await runtime.beforeClaimCommit?.(claim);
    claimCommitStarted = true;
  };
  let configuration: ObjectStorageConfiguration;
  let result:
    | Awaited<ReturnType<typeof deleteLocalIntentObject>>
    | Awaited<ReturnType<typeof deleteRemoteIntentGenerations>>;
  try {
    if (
      claim.status !== "compensating"
      || !claim.leaseOwner
      || claim.leaseExpiresAt === null
    ) {
      throw compensationError("OBJECT_WRITE_COMPENSATION_CLAIM_INVALID");
    }
    configuration =
      runtime.configuration ?? resolveObjectStorageConfiguration();
    assertCurrentProviderIdentity(claim, configuration);
    assertReceiptBoundToClaim(claim);
    result = configuration.provider === "local"
      ? await deleteLocalIntentObject(claim, runtime)
      : await deleteRemoteIntentGenerations(
        claim,
        runtime.storage
          ?? createRemoteObjectStorageAdapter(configuration),
        runtime,
      );
  } catch (error) {
    await enterClaimCommit();
    if (receiptKnown || isEphemeralPortraitSampleIntent(claim)) {
      await failObjectWriteCompensation({
        id: claim.id,
        owner: claim.leaseOwner,
        fence: claim.leaseFence,
      }, error, repository);
    } else {
      await deferUnsettledObjectWriteCompensation(
        {
          id: claim.id,
          owner: claim.leaseOwner,
          fence: claim.leaseFence,
        },
        {},
        repository,
      );
    }
    throw error;
  }
  await enterClaimCommit();
  if (!receiptKnown) {
    if (isEphemeralPortraitSampleIntent(claim)) {
      await completeReceiptlessPortraitSampleCompensation({
        id: claim.id,
        owner: claim.leaseOwner,
        fence: claim.leaseFence,
      }, {
        provider: configuration.provider,
        objectKey: claim.objectKey,
        ...result,
      }, repository);
      return "compensated";
    }
    await deferUnsettledObjectWriteCompensation({
      id: claim.id,
      owner: claim.leaseOwner,
      fence: claim.leaseFence,
    }, {}, repository);
    return "deferred";
  }
  const complete = isEphemeralPortraitSampleIntent(claim)
    ? completePortraitSampleCompensation
    : completeObjectWriteCompensation;
  await complete({
    id: claim.id,
    owner: claim.leaseOwner,
    fence: claim.leaseFence,
    writeReceiptHash: claim.writeReceiptHash!,
  }, {
    provider: configuration.provider,
    objectKey: claim.objectKey,
    ...result,
  }, repository);
  return "compensated";
}
