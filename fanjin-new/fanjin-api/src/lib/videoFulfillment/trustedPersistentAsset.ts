import fs from "node:fs";
import path from "node:path";
import type { Knex } from "knex";

import { OBJECT_WRITE_INTENT_TABLE } from "@/lib/migrations/objectWriteIntent";
import { normalizeObjectKey } from "@/lib/objectStorage";
import {
  getObjectWriteIntent,
  parseObjectWriteReceiptEvidence,
  parseObjectWriteReferenceEvidence,
  type ObjectWriteIntentRecord,
  type ObjectWriteIntentPurpose,
  type ObjectWriteReceiptEvidence,
  type ObjectWriteReferenceEvidence,
} from "@/lib/objectWriteIntent";
import {
  probeVideoFile,
  resolveOwnedVideoStorageKeyLocalPath,
  sha256VideoFile,
} from "@/lib/videoFulfillment/safeVideoMirror";

export interface TrustedPersistentVideoIdentity {
  width: number;
  height: number;
  durationMs: number;
  mimeType: string;
  contentSha256: string;
}

export interface TrustedPersistentVideoAsset {
  mode: "local" | "remote";
  intentId: string;
  provider: "local" | "s3" | "tos";
  storageKey: string;
  size: number;
  contentSha256: string;
  localPath: string | null;
}

function sameFileSnapshot(left: fs.Stats, right: fs.Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function validIdentity(identity: TrustedPersistentVideoIdentity): boolean {
  return Number.isSafeInteger(identity.width)
    && identity.width > 0
    && Number.isSafeInteger(identity.height)
    && identity.height > 0
    && Number.isSafeInteger(identity.durationMs)
    && identity.durationMs > 0
    && /^video\/[a-z0-9.+-]+$/u.test(identity.mimeType)
    && /^[a-f0-9]{64}$/u.test(identity.contentSha256);
}

function relativeLocalPathMatchesStorageKey(
  localPath: unknown,
  storageKey: string,
): boolean {
  const declared = String(localPath || "").trim();
  if (!declared) return true;
  if (path.isAbsolute(declared)) return false;
  try {
    return normalizeObjectKey(declared) === storageKey;
  } catch {
    return false;
  }
}

export function validateTrustedPersistentAssetIntent(input: {
  intent: ObjectWriteIntentRecord;
  purpose: Extract<ObjectWriteIntentPurpose, "relay_final" | "video_enhance">;
  workspaceId: string;
  projectId: number;
  assetId: string;
  storageKey: string;
  assetUrl: string;
  contentSha256: string;
}): {
  receipt: ObjectWriteReceiptEvidence;
  reference: ObjectWriteReferenceEvidence;
} | null {
  try {
    const { intent } = input;
    if (
      intent.status !== "committed"
      || intent.purpose !== input.purpose
      || intent.workspaceId !== input.workspaceId
      || intent.projectId !== input.projectId
      || intent.objectKey !== input.storageKey
      || intent.expectedSize <= 0
      || intent.expectedSha256 !== input.contentSha256
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
    ) {
      return null;
    }
    const receipt = parseObjectWriteReceiptEvidence(intent);
    const reference = parseObjectWriteReferenceEvidence(intent);
    if (
      !receipt
      || !reference
      || reference.table !== "o_media_asset"
      || reference.rowId !== input.assetId
      || reference.workspaceId !== input.workspaceId
      || reference.projectId !== input.projectId
      || reference.storageKey !== input.storageKey
      || (
        reference.version === "object-write-reference.v2"
        && reference.publicUrl !== input.assetUrl
      )
      || (
        intent.provider !== "local"
        && reference.version !== "object-write-reference.v2"
      )
    ) {
      return null;
    }
    return { receipt, reference };
  } catch {
    return null;
  }
}

/**
 * Validate the only two persistent video authorities accepted for billing:
 *
 * 1. a committed local durable write whose canonical owned file still matches
 *    the exact size, digest and ffprobe identity; or
 * 2. a committed remote durable write whose hashed receipt and hashed final
 *    o_media_asset reference bind the exact provider/domain/key/bytes.
 *
 * A media row, URL, localPath or storageKey is never sufficient by itself.
 * All malformed or incomplete evidence fails closed as null.
 */
export async function validateTrustedPersistentVideoAsset(input: {
  client: Knex | Knex.Transaction;
  asset: Record<string, unknown>;
  purpose: Extract<ObjectWriteIntentPurpose, "relay_final" | "video_enhance">;
  workspaceId: string;
  projectId: number;
  taskId: string;
  identity: TrustedPersistentVideoIdentity;
}): Promise<TrustedPersistentVideoAsset | null> {
  try {
    const expectedSource = input.purpose;
    const assetId = String(input.asset.id || "").trim();
    const storageKey = normalizeObjectKey(String(input.asset.storageKey || ""));
    if (
      !assetId
      || !validIdentity(input.identity)
      || String(input.asset.workspaceId || "") !== input.workspaceId
      || Number(input.asset.projectId) !== input.projectId
      || String(input.asset.taskId || "") !== input.taskId
      || String(input.asset.source || "") !== expectedSource
      || String(input.asset.assetType || "") !== "video"
      || String(input.asset.deletionState || "") !== "active"
      || !String(input.asset.url || "").trim()
      || Number(input.asset.width) !== input.identity.width
      || Number(input.asset.height) !== input.identity.height
      || Number(input.asset.durationMs) !== input.identity.durationMs
      || String(input.asset.mimeType || "") !== input.identity.mimeType
      || !storageKey.startsWith(`${input.projectId}/`)
    ) {
      return null;
    }

    // Object keys contain the durable intent id and are collision-free. Any
    // ambiguity is treated as hostile evidence instead of selecting a row.
    const candidates = await input.client(OBJECT_WRITE_INTENT_TABLE)
      .where({ objectKey: storageKey })
      .select("id");
    if (candidates.length !== 1) return null;
    const intent = await getObjectWriteIntent(String(candidates[0].id), {
      database: input.client as Knex,
    });
    if (!intent) return null;
    const trustedIntent = validateTrustedPersistentAssetIntent({
      intent,
      purpose: input.purpose,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      assetId,
      storageKey,
      assetUrl: String(input.asset.url || ""),
      contentSha256: input.identity.contentSha256,
    });
    if (!trustedIntent) return null;
    const { receipt } = trustedIntent;

    if (intent.provider !== "local") {
      if (
        receipt.mode !== "remote"
        || !relativeLocalPathMatchesStorageKey(input.asset.localPath, storageKey)
      ) {
        return null;
      }
      return {
        mode: "remote",
        intentId: intent.id,
        provider: intent.provider,
        storageKey,
        size: intent.expectedSize,
        contentSha256: intent.expectedSha256,
        localPath: null,
      };
    }
    if (receipt.mode !== "local") return null;
    const localPath = resolveOwnedVideoStorageKeyLocalPath(
      String(input.asset.url || ""),
      storageKey,
      String(input.asset.localPath || ""),
    );
    if (!localPath) return null;
    const before = await fs.promises.stat(localPath);
    if (!before.isFile() || before.size !== intent.expectedSize) return null;
    const [actualProbe, actualSha256] = await Promise.all([
      probeVideoFile(localPath),
      sha256VideoFile(localPath),
    ]);
    const after = await fs.promises.stat(localPath);
    if (
      !sameFileSnapshot(before, after)
      || after.size !== intent.expectedSize
      || actualProbe.width !== input.identity.width
      || actualProbe.height !== input.identity.height
      || actualProbe.durationMs !== input.identity.durationMs
      || actualSha256 !== input.identity.contentSha256
    ) {
      return null;
    }
    return {
      mode: "local",
      intentId: intent.id,
      provider: intent.provider,
      storageKey,
      size: intent.expectedSize,
      contentSha256: intent.expectedSha256,
      localPath,
    };
  } catch {
    return null;
  }
}
