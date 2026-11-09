import crypto from "node:crypto";
import type { Knex } from "knex";

import {
  queueDurableObjectWriteCompensation,
  writeObjectWithDurableIntent,
  type DurableObjectWriter,
} from "@/lib/durableObjectWrite";
import { commitObjectWriteIntentInTransaction } from "@/lib/objectWriteIntent";
import { normalizeObjectKey } from "@/lib/objectStorage";
import {
  downloadPublicRemoteImage,
  downloadPublicRemoteVideo,
} from "@/lib/safeRemoteVideoDownload";
import u from "@/utils";

const DEFAULT_BATCH_LIMIT = 100;
const DEFAULT_MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const MIGRATABLE_ASSET_TYPES = ["image", "video"] as const;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/mpeg": "mpeg",
};

type BackfillAsset = {
  id: string;
  workspaceId: string | null;
  projectId: number | null;
  assetType: string;
  url: string | null;
  metadata: unknown;
};

type DownloadedMedia = {
  body: Buffer;
  mimeType: string;
};

export interface MediaAssetStorageBackfillReport {
  apply: boolean;
  examined: number;
  migrated: number;
  reconciled: number;
  failed: number;
  migratableRemaining: number;
  unsupportedRemaining: number;
  unsupportedByType: MediaAssetControlledStorageInspection["unsupportedByType"];
  remaining: number;
  ready: boolean;
  failures: Array<{ assetId: string; code: string }>;
}

export interface MediaAssetControlledStorageInspection {
  /** Active image/video rows which this migration can safely download. */
  migratableRemaining: number;
  /** Active unmanaged rows outside the image/video migration contract. */
  unsupportedRemaining: number;
  unsupportedByType: {
    audio: number;
    file: number;
    unknown: number;
  };
  /** Total active unmanaged rows across both classes. */
  remaining: number;
  migratableReady: boolean;
  unsupportedReady: boolean;
  ready: boolean;
}

export interface MediaAssetStorageBackfillRuntime {
  database: Knex;
  durableDatabase?: Knex;
  writer?: DurableObjectWriter & {
    fileExists?: (storageKey: string) => Promise<boolean>;
  };
  download?: (asset: BackfillAsset) => Promise<DownloadedMedia>;
  idFactory?: () => string;
  clock?: () => number;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseMetadata(value: unknown): Record<string, unknown> {
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

function localManagedStorageKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean.startsWith("/oss/")) return null;
  try {
    const url = new URL(clean, "http://fanjin.local");
    if (url.search || url.hash) return null;
    const encoded = url.pathname.slice("/oss/".length);
    const decoded = encoded
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/");
    return normalizeObjectKey(decoded);
  } catch {
    return null;
  }
}

export async function defaultDownload(asset: BackfillAsset): Promise<DownloadedMedia> {
  const url = String(asset.url || "").trim();
  if (asset.assetType === "image") {
    const downloaded = await downloadPublicRemoteImage({
      url,
      maximumBytes: Number(
        process.env.FANJIN_RELAY_IMAGE_MAX_BYTES || DEFAULT_MAX_IMAGE_BYTES,
      ),
      timeoutMs: Number(
        process.env.FANJIN_RELAY_MEDIA_DOWNLOAD_TIMEOUT_MS || 600_000,
      ),
      maximumRedirects: 3,
    });
    return { body: downloaded.body, mimeType: downloaded.mimeType };
  }
  if (asset.assetType === "video") {
    const downloaded = await downloadPublicRemoteVideo({
      url,
      maximumBytes: Number(
        process.env.FANJIN_RELAY_VIDEO_MAX_BYTES || DEFAULT_MAX_VIDEO_BYTES,
      ),
      timeoutMs: Number(
        process.env.FANJIN_RELAY_MEDIA_DOWNLOAD_TIMEOUT_MS || 600_000,
      ),
      maximumRedirects: 3,
    });
    return { body: downloaded.body, mimeType: downloaded.mimeType };
  }
  throw Object.assign(new Error("unsupported history asset type"), {
    code: "HISTORY_ASSET_TYPE_UNSUPPORTED",
  });
}

function failureCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code || "").trim();
    if (code) return code.slice(0, 120);
  }
  return "HISTORY_ASSET_BACKFILL_FAILED";
}

function activeUnmanagedQuery(database: Knex) {
  return database("o_media_asset")
    .where({ deletionState: "active" })
    .andWhere((builder) => {
      builder.whereNull("storageKey").orWhere("storageKey", "");
    });
}

function migratableUnmanagedQuery(database: Knex) {
  return activeUnmanagedQuery(database)
    .whereIn("assetType", [...MIGRATABLE_ASSET_TYPES]);
}

function unsupportedUnmanagedQuery(database: Knex) {
  return activeUnmanagedQuery(database)
    .whereNotIn("assetType", [...MIGRATABLE_ASSET_TYPES]);
}

export async function inspectMediaAssetsControlledStorage(
  database: Knex,
): Promise<MediaAssetControlledStorageInspection> {
  const [migratableRow, unsupportedRows] = await Promise.all([
    migratableUnmanagedQuery(database)
      .count<{ total: number | string }[]>({ total: "*" })
      .first() as Promise<{ total?: number | string } | undefined>,
    unsupportedUnmanagedQuery(database)
      .select("assetType")
      .count<{ assetType?: unknown; total?: number | string }[]>({ total: "*" })
      .groupBy("assetType") as Promise<Array<{
        assetType?: unknown;
        total?: number | string;
      }>>,
  ]);
  const migratableRemaining = Number(migratableRow?.total || 0);
  const unsupportedByType = unsupportedRows.reduce(
    (counts, row) => {
      const type = String(row.assetType || "").trim().toLowerCase();
      const total = Number(row.total || 0);
      if (!Number.isSafeInteger(total) || total <= 0) return counts;
      if (type === "audio" || type === "file") counts[type] += total;
      else counts.unknown += total;
      return counts;
    },
    { audio: 0, file: 0, unknown: 0 },
  );
  const unsupportedRemaining = Object.values(unsupportedByType)
    .reduce((sum, count) => sum + count, 0);
  const remaining = migratableRemaining + unsupportedRemaining;
  return {
    migratableRemaining,
    unsupportedRemaining,
    unsupportedByType,
    remaining,
    migratableReady: migratableRemaining === 0,
    unsupportedReady: unsupportedRemaining === 0,
    ready: remaining === 0,
  };
}

async function reconcileLocalManagedAsset(
  asset: BackfillAsset,
  storageKey: string,
  runtime: MediaAssetStorageBackfillRuntime,
): Promise<boolean> {
  const writer = runtime.writer ?? u.oss;
  if (writer.fileExists && !(await writer.fileExists(storageKey))) return false;
  const updated = await runtime.database("o_media_asset")
    .where({ id: asset.id, deletionState: "active" })
    .andWhere((builder) => {
      builder.whereNull("storageKey").orWhere("storageKey", "");
    })
    .update({
      localPath: storageKey,
      storageKey,
      metadata: JSON.stringify({
        ...parseMetadata(asset.metadata),
        controlledStorage: true,
        storageBackfillVersion: "history-storage-backfill.v1",
      }),
    });
  return Number(updated) === 1;
}

async function migrateProjectAsset(
  asset: BackfillAsset,
  projectId: number,
  downloaded: DownloadedMedia,
  runtime: MediaAssetStorageBackfillRuntime,
): Promise<boolean> {
  const workspaceId = String(asset.workspaceId || "").trim();
  if (!workspaceId) {
    throw Object.assign(new Error("workspace ownership missing"), {
      code: "HISTORY_ASSET_WORKSPACE_MISSING",
    });
  }
  const extension = MIME_EXTENSIONS[downloaded.mimeType];
  if (!extension) {
    throw Object.assign(new Error("media mime unsupported"), {
      code: "HISTORY_ASSET_MIME_UNSUPPORTED",
    });
  }
  const durableDatabase = runtime.durableDatabase ?? runtime.database;
  const durable = await writeObjectWithDurableIntent({
    purpose: asset.assetType === "video" ? "relay_final" : "agent_generation",
    workspaceId,
    projectId,
    body: downloaded.body,
    storageKey: (intentId) =>
      `${projectId}/history-backfill/${intentId}.${extension}`,
    writerIdPrefix: "history-storage-backfill",
  }, {
    database: durableDatabase,
    writer: runtime.writer ?? u.oss,
    ...(runtime.idFactory ? { idFactory: runtime.idFactory } : {}),
    ...(runtime.clock ? { clock: runtime.clock } : {}),
  });
  try {
    const committed = await runtime.database.transaction(async (transaction) => {
      const current = await transaction("o_media_asset")
        .where({
          id: asset.id,
          workspaceId,
          projectId,
          deletionState: "active",
        })
        .select("id", "storageKey")
        .forUpdate()
        .first();
      if (!current || String(current.storageKey || "").trim()) return false;
      const contentSha256 = crypto.createHash("sha256")
        .update(downloaded.body)
        .digest("hex");
      await transaction("o_media_asset").where({ id: asset.id }).update({
        url: durable.url,
        localPath: durable.storageKey,
        storageKey: durable.storageKey,
        mimeType: downloaded.mimeType,
        metadata: JSON.stringify({
          ...parseMetadata(asset.metadata),
          controlledStorage: true,
          contentSha256,
          storageBackfillVersion: "history-storage-backfill.v1",
        }),
      });
      await commitObjectWriteIntentInTransaction(
        transaction,
        durable.claim,
        {
          version: "object-write-reference.v1",
          table: "o_media_asset",
          rowId: asset.id,
          workspaceId,
          projectId,
          storageKey: durable.storageKey,
        },
        runtime.clock ? { clock: runtime.clock } : {},
      );
      return true;
    });
    if (!committed) {
      await queueDurableObjectWriteCompensation(
        durable.claim,
        "history asset was already migrated by another worker",
        {
          database: durableDatabase,
          ...(runtime.clock ? { clock: runtime.clock } : {}),
        },
      );
    }
    return committed;
  } catch (error) {
    await queueDurableObjectWriteCompensation(
      durable.claim,
      error,
      {
        database: durableDatabase,
        ...(runtime.clock ? { clock: runtime.clock } : {}),
      },
    );
    throw error;
  }
}

async function migrateWorkspaceAsset(
  asset: BackfillAsset,
  downloaded: DownloadedMedia,
  runtime: MediaAssetStorageBackfillRuntime,
): Promise<boolean> {
  const workspaceId = String(asset.workspaceId || "").trim();
  if (!workspaceId) {
    throw Object.assign(new Error("workspace ownership missing"), {
      code: "HISTORY_ASSET_WORKSPACE_MISSING",
    });
  }
  const extension = MIME_EXTENSIONS[downloaded.mimeType];
  if (!extension) {
    throw Object.assign(new Error("media mime unsupported"), {
      code: "HISTORY_ASSET_MIME_UNSUPPORTED",
    });
  }
  const writer = runtime.writer ?? u.oss;
  if (!writer.compensateFailedWrite) {
    throw Object.assign(new Error("storage compensation unavailable"), {
      code: "HISTORY_ASSET_STORAGE_COMPENSATION_UNAVAILABLE",
    });
  }
  const workspaceDigest = crypto.createHash("sha256")
    .update(workspaceId)
    .digest("hex")
    .slice(0, 32);
  const objectId = runtime.idFactory?.() ?? crypto.randomUUID();
  const storageKey = [
    "workspaces",
    workspaceDigest,
    "history-backfill",
    `${objectId}.${extension}`,
  ].join("/");
  const receipt = await writer.writeFile(storageKey, downloaded.body);
  let compensationAttempted = false;

  try {
    const url = await writer.getFileUrl(storageKey);
    const migrated = await runtime.database.transaction(async (transaction) => {
      const current = await transaction("o_media_asset")
        .where({
          id: asset.id,
          workspaceId,
          deletionState: "active",
        })
        .select("id", "projectId", "storageKey")
        .forUpdate()
        .first();
      if (
        !current
        || current.projectId != null
        || String(current.storageKey || "").trim()
      ) {
        return false;
      }
      const contentSha256 = crypto.createHash("sha256")
        .update(downloaded.body)
        .digest("hex");
      await transaction("o_media_asset").where({ id: asset.id }).update({
        url,
        localPath: storageKey,
        storageKey,
        mimeType: downloaded.mimeType,
        metadata: JSON.stringify({
          ...parseMetadata(asset.metadata),
          controlledStorage: true,
          contentSha256,
          storageBackfillVersion: "history-storage-backfill.v1",
        }),
      });
      return true;
    });
    if (!migrated) {
      compensationAttempted = true;
      await writer.compensateFailedWrite(storageKey, receipt);
    }
    return migrated;
  } catch (error) {
    if (compensationAttempted) throw error;
    compensationAttempted = true;
    try {
      await writer.compensateFailedWrite(storageKey, receipt);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "workspace history migration failed and exact storage compensation failed",
      );
    }
    throw error;
  }
}

export async function backfillMediaAssetsToControlledStorage(
  runtime: MediaAssetStorageBackfillRuntime,
  options: { apply?: boolean; limit?: number } = {},
): Promise<MediaAssetStorageBackfillReport> {
  const apply = options.apply === true;
  const limit = Number.isSafeInteger(options.limit) && Number(options.limit) > 0
    ? Math.min(1_000, Number(options.limit))
    : DEFAULT_BATCH_LIMIT;
  // This job deliberately owns only image/video. Audio, file, and malformed
  // active rows are surfaced by a separate production P0 instead of being
  // silently skipped or passed to an arbitrary-file network downloader.
  const rows = await migratableUnmanagedQuery(runtime.database)
    .whereNotNull("url")
    .andWhereNot("url", "")
    .select(
      "id",
      "workspaceId",
      "projectId",
      "assetType",
      "url",
      "metadata",
    )
    .orderBy("createTime", "asc")
    .orderBy("id", "asc")
    .limit(limit) as BackfillAsset[];
  let migrated = 0;
  let reconciled = 0;
  const failures: MediaAssetStorageBackfillReport["failures"] = [];

  if (apply) {
    for (const asset of rows) {
      try {
        const managedKey = localManagedStorageKey(asset.url);
        if (managedKey && await reconcileLocalManagedAsset(
          asset,
          managedKey,
          runtime,
        )) {
          reconciled += 1;
          continue;
        }
        const downloaded = await (runtime.download ?? defaultDownload)(asset);
        const projectId = positiveInteger(asset.projectId);
        const migratedAsset = projectId
          ? await migrateProjectAsset(asset, projectId, downloaded, runtime)
          : await migrateWorkspaceAsset(asset, downloaded, runtime);
        if (migratedAsset) {
          migrated += 1;
        }
      } catch (error) {
        failures.push({ assetId: asset.id, code: failureCode(error) });
      }
    }
  }

  const inspection = await inspectMediaAssetsControlledStorage(runtime.database);
  return {
    apply,
    examined: rows.length,
    migrated,
    reconciled,
    failed: failures.length,
    migratableRemaining: inspection.migratableRemaining,
    unsupportedRemaining: inspection.unsupportedRemaining,
    unsupportedByType: inspection.unsupportedByType,
    remaining: inspection.remaining,
    ready: inspection.ready && failures.length === 0,
    failures,
  };
}
