import crypto from "node:crypto";
import type { Knex } from "knex";

import { insertAndReturnId } from "@/lib/dbDialect";
import {
  queueDurableObjectWriteCompensation,
  writeObjectWithDurableIntent,
  type DurableObjectWriter,
  type DurableObjectWriteResult,
} from "@/lib/durableObjectWrite";
import { commitObjectWriteIntentInTransaction } from "@/lib/objectWriteIntent";
import type { ObjectStorageWriteReceipt } from "@/lib/objectStorage";
import { logger } from "@/lib/logger";
import { downloadPublicRemoteImage } from "@/lib/safeRemoteVideoDownload";
import { registerAccountOwnedAssetIfAvailable } from "@/lib/accountWorkspaceAssetLibrary";
import u from "@/utils";

const DEFAULT_MAXIMUM_IMAGE_BYTES = 64 * 1024 * 1024;

const IMAGE_MIME_EXTENSIONS = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const);

export interface GeneratedImageResultItem {
  url?: string;
  b64_json?: string;
}

export interface PersistedGeneratedImage {
  mediaAssetId: string;
  assetId: number;
  assetVersionId: number;
  taskId: string;
  url: string;
  storageKey: string;
  contentSha256: string;
  assetType: "image";
  model: string;
  prompt: string;
  createdAt: number;
}

export interface PersistedGeneratedWorkspaceImage {
  mediaAssetId: string;
  assetId: null;
  assetVersionId: null;
  taskId: string;
  url: string;
  storageKey: string;
  contentSha256: string;
  assetType: "image";
  model: string;
  prompt: string;
  createdAt: number;
}

export interface GeneratedImagePersistenceRuntime {
  database: Knex;
  durableDatabase?: Knex;
  writer?: DurableObjectWriter;
  fetcher?: typeof fetch;
  clock?: () => number;
  idFactory?: () => string;
  onBeforeCommit?: (
    transaction: Knex.Transaction,
    assets: PersistedGeneratedImage[],
  ) => Promise<void>;
}

interface DownloadedImage {
  body: Buffer;
  mimeType: keyof typeof IMAGE_MIME_EXTENSIONS;
}

interface StagedGeneratedImage {
  index: number;
  durable: DurableObjectWriteResult;
  mimeType: keyof typeof IMAGE_MIME_EXTENSIONS;
  contentSha256: string;
}

interface StagedGeneratedWorkspaceImage {
  index: number;
  storageKey: string;
  url: string;
  receipt: ObjectStorageWriteReceipt | null;
  mimeType: keyof typeof IMAGE_MIME_EXTENSIONS;
  contentSha256: string;
}

function persistenceError(
  primary: unknown,
  queueFailures: unknown[],
): Error & { code: string; cause?: unknown; queueFailures?: unknown[] } {
  const error = queueFailures.length > 0
    ? new AggregateError(
      [primary, ...queueFailures],
      "generated image persistence failed and compensation could not be fully queued",
    )
    : new Error("generated image persistence failed; compensation is queued");
  return Object.assign(error, {
    code: "GENERATED_IMAGE_PERSISTENCE_FAILED",
    cause: primary,
    ...(queueFailures.length > 0 ? { queueFailures } : {}),
  });
}

function maximumImageBytes(): number {
  const value = Number(
    process.env.FANJIN_RELAY_IMAGE_MAX_BYTES
      || DEFAULT_MAXIMUM_IMAGE_BYTES,
  );
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_MAXIMUM_IMAGE_BYTES;
}

function normalizedMimeType(
  value: string | null | undefined,
): keyof typeof IMAGE_MIME_EXTENSIONS | null {
  const mimeType = String(value || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return Object.prototype.hasOwnProperty.call(
    IMAGE_MIME_EXTENSIONS,
    mimeType,
  )
    ? mimeType as keyof typeof IMAGE_MIME_EXTENSIONS
    : null;
}

function imageSignatureMatches(
  body: Buffer,
  mimeType: keyof typeof IMAGE_MIME_EXTENSIONS,
): boolean {
  return mimeType === "image/png"
    ? body.length >= 8 && body.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    : mimeType === "image/jpeg"
      ? body.length >= 3
        && body[0] === 0xff
        && body[1] === 0xd8
        && body[2] === 0xff
      : body.length >= 12
        && body.subarray(0, 4).toString("ascii") === "RIFF"
        && body.subarray(8, 12).toString("ascii") === "WEBP";
}

function assertImageSignature(
  body: Buffer,
  mimeType: keyof typeof IMAGE_MIME_EXTENSIONS,
): void {
  if (!imageSignatureMatches(body, mimeType)) {
    throw new Error("GENERATED_IMAGE_SIGNATURE_INVALID");
  }
}

function decodeBase64Image(value: string): DownloadedImage {
  const match = value.match(
    /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/u,
  );
  const encoded = match ? match[2] : value;
  const declaredMimeType = match ? normalizedMimeType(match[1]) : null;
  if (match && !declaredMimeType) {
    throw new Error("GENERATED_IMAGE_MIME_INVALID");
  }
  if (
    !encoded
    || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  ) {
    throw new Error("GENERATED_IMAGE_BASE64_INVALID");
  }
  const body = Buffer.from(encoded, "base64");
  if (
    body.length === 0
    || body.length > maximumImageBytes()
    || body.toString("base64") !== encoded
  ) {
    throw new Error("GENERATED_IMAGE_BASE64_INVALID");
  }
  // Bare b64_json has no MIME declaration. Derive its supported format from
  // the bytes; providers may return JPEG/WebP even when the request asks for
  // a URL. Explicit data-URL declarations must still match the signature.
  const mimeType = declaredMimeType ?? (
    Object.keys(IMAGE_MIME_EXTENSIONS) as Array<keyof typeof IMAGE_MIME_EXTENSIONS>
  ).find((candidate) => imageSignatureMatches(body, candidate));
  if (!mimeType) throw new Error("GENERATED_IMAGE_SIGNATURE_INVALID");
  assertImageSignature(body, mimeType);
  return { body, mimeType };
}

async function downloadGeneratedImage(
  item: GeneratedImageResultItem,
  fetcher?: typeof fetch,
): Promise<DownloadedImage> {
  if (typeof item.b64_json === "string" && item.b64_json.trim()) {
    return decodeBase64Image(item.b64_json.trim());
  }
  const rawUrl = String(item.url || "").trim();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("GENERATED_IMAGE_URL_INVALID");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
  ) {
    throw new Error("GENERATED_IMAGE_URL_INVALID");
  }
  if (!fetcher) {
    const downloaded = await downloadPublicRemoteImage({
      url: url.toString(),
      maximumBytes: maximumImageBytes(),
      timeoutMs: Number(
        process.env.FANJIN_RELAY_MEDIA_DOWNLOAD_TIMEOUT_MS || 600_000,
      ),
      maximumRedirects: 3,
    });
    const mimeType = normalizedMimeType(downloaded.mimeType);
    if (!mimeType) throw new Error("GENERATED_IMAGE_MIME_INVALID");
    assertImageSignature(downloaded.body, mimeType);
    return {
      body: downloaded.body,
      mimeType,
    };
  }
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(
      Number(process.env.FANJIN_RELAY_MEDIA_DOWNLOAD_TIMEOUT_MS || 600_000),
    ),
  });
  if (!response.ok) {
    throw new Error(`GENERATED_IMAGE_DOWNLOAD_FAILED_${response.status}`);
  }
  const mimeType = normalizedMimeType(response.headers.get("content-type"));
  if (!mimeType) throw new Error("GENERATED_IMAGE_MIME_INVALID");
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (
    Number.isFinite(contentLength)
    && contentLength > maximumImageBytes()
  ) {
    throw new Error("GENERATED_IMAGE_TOO_LARGE");
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0 || body.length > maximumImageBytes()) {
    throw new Error("GENERATED_IMAGE_TOO_LARGE");
  }
  assertImageSignature(body, mimeType);
  return { body, mimeType };
}

async function queueCompensations(
  staged: StagedGeneratedImage[],
  primary: unknown,
  database: Knex,
  clock?: () => number,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const image of staged) {
    try {
      await queueDurableObjectWriteCompensation(
        image.durable.claim,
        primary,
        {
          database,
          ...(clock ? { clock } : {}),
        },
      );
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/**
 * Persists provider-generated images as reusable project assets.
 *
 * Every image is copied into controlled object storage first. The media row,
 * logical asset, asset version and durable-write commit are then created in
 * one transaction, so callers never receive an assetVersionId that points to
 * an unmanaged provider URL.
 */
export async function persistGeneratedProjectImages(
  input: {
    workspaceId: string;
    projectId: number;
    source: string;
    prompt: string;
    finalPrompt: string;
    model: string;
    ratio: string;
    quality: string;
    resolution: string;
    taskIdPrefix: string;
    taskId?: string;
    items: GeneratedImageResultItem[];
    metadata?: Record<string, unknown>;
    targetAssetId?: number;
    actorUserId?: number;
  },
  runtime: GeneratedImagePersistenceRuntime,
): Promise<PersistedGeneratedImage[]> {
  if (!Number.isSafeInteger(input.projectId) || input.projectId <= 0) {
    throw new Error("GENERATED_IMAGE_PROJECT_INVALID");
  }
  if (!input.workspaceId.trim()) {
    throw new Error("GENERATED_IMAGE_WORKSPACE_INVALID");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.taskIdPrefix)) {
    throw new Error("GENERATED_IMAGE_TASK_PREFIX_INVALID");
  }
  if (input.taskId !== undefined && !input.taskId.trim()) {
    throw new Error("GENERATED_IMAGE_TASK_ID_INVALID");
  }
  if (
    input.targetAssetId !== undefined
    && (!Number.isSafeInteger(input.targetAssetId) || input.targetAssetId <= 0)
  ) {
    throw new Error("GENERATED_IMAGE_TARGET_ASSET_INVALID");
  }
  if (input.targetAssetId !== undefined && input.items.length !== 1) {
    throw new Error("GENERATED_IMAGE_TARGET_REQUIRES_SINGLE_RESULT");
  }
  const durableDatabase = runtime.durableDatabase ?? runtime.database;
  const writer = runtime.writer ?? u.oss;
  const fetcher = runtime.fetcher;
  const now = runtime.clock?.() ?? Date.now();
  const idFactory = runtime.idFactory ?? (() => crypto.randomUUID());
  const staged: StagedGeneratedImage[] = [];
  let stage = "project_lookup";

  try {
    const project = await runtime.database("o_project")
      .where({
        id: input.projectId,
        workspaceId: input.workspaceId,
      })
      .select("id")
      .first();
    if (!project) throw new Error("GENERATED_IMAGE_PROJECT_NOT_FOUND");

    for (const [index, item] of input.items.entries()) {
      stage = "download";
      const downloaded = await downloadGeneratedImage(item, fetcher);
      const extension = IMAGE_MIME_EXTENSIONS[downloaded.mimeType];
      stage = "object_storage";
      const durable = await writeObjectWithDurableIntent({
        purpose: "agent_generation",
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        body: downloaded.body,
        storageKey: (intentId) =>
          `${input.projectId}/generated/${input.taskIdPrefix}/${intentId}.${extension}`,
        writerIdPrefix: "generated-image",
      }, {
        database: durableDatabase,
        writer,
        idFactory,
        ...(runtime.clock ? { clock: runtime.clock } : {}),
      });
      staged.push({
        index,
        durable,
        mimeType: downloaded.mimeType,
        contentSha256: crypto.createHash("sha256").update(downloaded.body).digest("hex"),
      });
    }

    if (staged.length === 0) {
      throw new Error("GENERATED_IMAGE_RESULT_EMPTY");
    }

    stage = "database_commit";
    return await runtime.database.transaction(async (transaction) => {
      const project = await transaction("o_project")
        .where({
          id: input.projectId,
          workspaceId: input.workspaceId,
        })
        .select("id")
        .forUpdate()
        .first();
      if (!project) throw new Error("GENERATED_IMAGE_PROJECT_AUTHORITY_CHANGED");

      const assets: PersistedGeneratedImage[] = [];
      const targetAsset = input.targetAssetId === undefined
        ? null
        : await transaction("o_assets")
          .where({
            id: input.targetAssetId,
            projectId: input.projectId,
            deletionState: "active",
          })
          .whereIn("type", ["role", "scene", "tool"])
          .select("id", "type")
          .forUpdate()
          .first();
      if (input.targetAssetId !== undefined && !targetAsset) {
        throw new Error("GENERATED_IMAGE_TARGET_ASSET_NOT_FOUND");
      }
      for (const image of staged) {
        const createdAt = now + image.index;
        const mediaAssetId = idFactory();
        const taskId = input.taskId ?? `${input.taskIdPrefix}:${idFactory()}`;
        const baseMetadata = {
          ...(input.metadata || {}),
          version: "generated-project-image.v1",
          prompt: input.prompt,
          finalPrompt: input.finalPrompt,
          model: input.model,
          ratio: input.ratio,
          quality: input.quality,
          resolution: input.resolution,
          index: image.index,
          controlledStorage: true,
          // This digest is derived from the bytes already signature-checked
          // and committed by the durable object-write intent. Keep it after
          // caller metadata so an upstream payload cannot forge provenance.
          contentSha256: image.contentSha256,
        };
        await transaction("o_media_asset").insert({
          id: mediaAssetId,
          taskId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          assetType: "image",
          source: input.source,
          url: image.durable.url,
          localPath: image.durable.storageKey,
          storageKey: image.durable.storageKey,
          mimeType: image.mimeType,
          width: null,
          height: null,
          durationMs: null,
          metadata: JSON.stringify(baseMetadata),
          createTime: createdAt,
        });
        const assetId = targetAsset
          ? Number(targetAsset.id)
          : await insertAndReturnId(transaction, "o_assets", {
              type: "image",
              projectId: input.projectId,
              name: input.prompt.slice(0, 80),
              prompt: input.prompt,
              startTime: createdAt,
            });
        const assetVersionId = await insertAndReturnId(
          transaction,
          "o_image",
          {
            filePath: image.durable.storageKey,
            storageKey: image.durable.storageKey,
            type: "image",
            assetsId: assetId,
            model: input.model,
            resolution: input.resolution,
            state: "已完成",
          },
        );
        await transaction("o_assets")
          .where({ id: assetId })
          .update({
            imageId: assetVersionId,
            ...(targetAsset ? { prompt: input.prompt } : {}),
          });
        await transaction("o_media_asset")
          .where({ id: mediaAssetId })
          .update({
            metadata: JSON.stringify({
              ...baseMetadata,
              assetId,
              assetVersionId,
            }),
          });
        if (Number.isSafeInteger(input.actorUserId) && Number(input.actorUserId) > 0) {
          await registerAccountOwnedAssetIfAvailable({
            transaction,
            assetId,
            projectId: input.projectId,
            workspaceId: input.workspaceId,
            actorUserId: Number(input.actorUserId),
            assetVersionId: `image:${assetVersionId}`,
            idempotencyKey: `generated-image:${mediaAssetId}:ownership`,
            now: createdAt,
          });
        }
        await commitObjectWriteIntentInTransaction(
          transaction,
          image.durable.claim,
          {
            version: "object-write-reference.v1",
            table: "o_media_asset",
            rowId: mediaAssetId,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            storageKey: image.durable.storageKey,
          },
          runtime.clock ? { clock: runtime.clock } : {},
        );
        assets.push({
          mediaAssetId,
          assetId,
          assetVersionId,
          taskId,
          url: image.durable.url,
          storageKey: image.durable.storageKey,
          contentSha256: image.contentSha256,
          assetType: "image",
          model: input.model,
          prompt: input.prompt,
          createdAt,
        });
      }
      if (runtime.onBeforeCommit) {
        await runtime.onBeforeCommit(transaction, assets);
      }
      return assets;
    });
  } catch (error) {
    const detail = error as { code?: unknown; message?: unknown } | null;
    const candidateCode = String(detail?.code || detail?.message || "");
    logger.error({
      event: "generated_image_persistence_failed",
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      stage,
      // Do not log raw provider URLs, SQL bindings or credential-bearing errors.
      errorCode: /^[A-Z0-9_]{3,100}$/.test(candidateCode) ? candidateCode : "PERSISTENCE_ERROR",
    }, "Generated image persistence failed; provider checkpoint remains recoverable");
    const queueFailures = await queueCompensations(
      staged,
      error,
      durableDatabase,
      runtime.clock,
    );
    throw persistenceError(error, queueFailures);
  }
}

/**
 * Compatibility persistence for callers that have not materialized a project
 * yet. Provider URLs are never inserted into the creative library: the bytes
 * are copied to the configured Fanjin object-storage bucket first and the
 * media row keeps the authoritative storageKey. Project-bound creation should
 * continue to use persistGeneratedProjectImages so it also receives durable
 * intent and project-deletion evidence.
 */
export async function persistGeneratedWorkspaceImages(
  input: {
    workspaceId: string;
    source: string;
    prompt: string;
    finalPrompt: string;
    model: string;
    ratio: string;
    quality: string;
    resolution: string;
    taskIdPrefix: string;
    taskId?: string;
    items: GeneratedImageResultItem[];
    metadata?: Record<string, unknown>;
  },
  runtime: Omit<GeneratedImagePersistenceRuntime, "onBeforeCommit"> & {
    onBeforeCommit?: (
      transaction: Knex.Transaction,
      assets: PersistedGeneratedWorkspaceImage[],
    ) => Promise<void>;
  },
): Promise<PersistedGeneratedWorkspaceImage[]> {
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) throw new Error("GENERATED_IMAGE_WORKSPACE_INVALID");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.taskIdPrefix)) {
    throw new Error("GENERATED_IMAGE_TASK_PREFIX_INVALID");
  }
  if (input.taskId !== undefined && !input.taskId.trim()) {
    throw new Error("GENERATED_IMAGE_TASK_ID_INVALID");
  }

  const writer = runtime.writer ?? u.oss;
  const fetcher = runtime.fetcher;
  const now = runtime.clock?.() ?? Date.now();
  const idFactory = runtime.idFactory ?? (() => crypto.randomUUID());
  const workspaceDigest = crypto.createHash("sha256")
    .update(workspaceId)
    .digest("hex")
    .slice(0, 32);
  const staged: StagedGeneratedWorkspaceImage[] = [];

  try {
    for (const [index, item] of input.items.entries()) {
      const downloaded = await downloadGeneratedImage(item, fetcher);
      const extension = IMAGE_MIME_EXTENSIONS[downloaded.mimeType];
      const objectId = idFactory();
      const storageKey = [
        "workspaces",
        workspaceDigest,
        "generated",
        input.taskIdPrefix,
        `${objectId}.${extension}`,
      ].join("/");
      const receipt = await writer.writeFile(storageKey, downloaded.body);
      const image: StagedGeneratedWorkspaceImage = {
        index,
        storageKey,
        url: "",
        receipt,
        mimeType: downloaded.mimeType,
        contentSha256: crypto.createHash("sha256")
          .update(downloaded.body)
          .digest("hex"),
      };
      staged.push(image);
      image.url = await writer.getFileUrl(storageKey);
    }
    if (staged.length === 0) {
      throw new Error("GENERATED_IMAGE_RESULT_EMPTY");
    }

    return await runtime.database.transaction(async (transaction) => {
      const assets: PersistedGeneratedWorkspaceImage[] = [];
      for (const image of staged) {
        const createdAt = now + image.index;
        const mediaAssetId = idFactory();
        const taskId = input.taskId ?? `${input.taskIdPrefix}:${idFactory()}`;
        await transaction("o_media_asset").insert({
          id: mediaAssetId,
          taskId,
          workspaceId,
          projectId: null,
          assetType: "image",
          source: input.source,
          url: image.url,
          localPath: image.storageKey,
          storageKey: image.storageKey,
          mimeType: image.mimeType,
          width: null,
          height: null,
          durationMs: null,
          metadata: JSON.stringify({
            ...(input.metadata || {}),
            version: "generated-workspace-image.v1",
            prompt: input.prompt,
            finalPrompt: input.finalPrompt,
            model: input.model,
            ratio: input.ratio,
            quality: input.quality,
            resolution: input.resolution,
            index: image.index,
            controlledStorage: true,
            contentSha256: image.contentSha256,
          }),
          createTime: createdAt,
        });
        assets.push({
          mediaAssetId,
          assetId: null,
          assetVersionId: null,
          taskId,
          url: image.url,
          storageKey: image.storageKey,
          contentSha256: image.contentSha256,
          assetType: "image",
          model: input.model,
          prompt: input.prompt,
          createdAt,
        });
      }
      if (runtime.onBeforeCommit) {
        await runtime.onBeforeCommit(transaction, assets);
      }
      return assets;
    });
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    for (const image of [...staged].reverse()) {
      try {
        if (!writer.compensateFailedWrite) {
          throw new Error("GENERATED_IMAGE_COMPENSATION_UNAVAILABLE");
        }
        await writer.compensateFailedWrite(image.storageKey, image.receipt);
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    throw persistenceError(error, cleanupFailures);
  }
}
