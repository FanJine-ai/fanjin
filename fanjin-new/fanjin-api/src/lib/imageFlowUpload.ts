import crypto from "node:crypto";
import type { Knex } from "knex";

import {
  queueDurableObjectWriteCompensation,
  writeObjectWithDurableIntent,
  type DurableObjectWriter,
  type DurableObjectWriteResult,
} from "@/lib/durableObjectWrite";
import {
  commitObjectWriteIntentInTransaction,
} from "@/lib/objectWriteIntent";

export const MAX_IMAGE_FLOW_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_FLOW_UPLOAD_BASE64_LENGTH =
  Math.ceil(MAX_IMAGE_FLOW_UPLOAD_BYTES / 3) * 4;

const IMAGE_FLOW_MIMES = Object.freeze({
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
} as const);

export interface ParsedImageFlowUpload {
  mimeType: keyof typeof IMAGE_FLOW_MIMES;
  extension: string;
  body: Buffer;
}

export function parseImageFlowUploadDataUrl(
  value: string,
): ParsedImageFlowUpload {
  const match = String(value || "").match(
    /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/u,
  );
  if (!match) throw new Error("IMAGE_FLOW_UPLOAD_DATA_URL_INVALID");
  const mimeType = (
    match[1].trim().toLowerCase()
  ) as keyof typeof IMAGE_FLOW_MIMES;
  const extension = IMAGE_FLOW_MIMES[mimeType];
  if (!extension) throw new Error("IMAGE_FLOW_UPLOAD_MIME_UNSUPPORTED");
  const encoded = match[2];
  if (
    encoded.length % 4 !== 0
    || encoded.length > MAX_IMAGE_FLOW_UPLOAD_BASE64_LENGTH
  ) {
    throw new Error("IMAGE_FLOW_UPLOAD_BASE64_INVALID");
  }
  const body = Buffer.from(encoded, "base64");
  if (
    body.length === 0
    || body.length > MAX_IMAGE_FLOW_UPLOAD_BYTES
    || body.toString("base64") !== encoded
  ) {
    throw new Error("IMAGE_FLOW_UPLOAD_BASE64_INVALID");
  }
  const signatureReady = mimeType === "image/png"
    ? body.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    : body.length >= 3
      && body[0] === 0xff
      && body[1] === 0xd8
      && body[2] === 0xff;
  if (!signatureReady) {
    throw new Error("IMAGE_FLOW_UPLOAD_SIGNATURE_INVALID");
  }
  return { mimeType, extension, body };
}

export interface PersistImageFlowUploadRuntime {
  database: Knex;
  writer: DurableObjectWriter;
  idFactory?: () => string;
  clock?: () => number;
}

export interface PersistedImageFlowUpload {
  mediaAssetId: string;
  storageKey: string;
  url: string;
}

function positiveId(value: unknown, code: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(code);
  }
  return id;
}

function workspaceId(value: unknown): string {
  const id = String(value || "").trim();
  if (
    !id
    || id.length > 255
    || /[\u0000-\u001f\u007f]/u.test(id)
  ) {
    throw new Error("IMAGE_FLOW_UPLOAD_WORKSPACE_INVALID");
  }
  return id;
}

export async function persistImageFlowUpload(
  input: {
    projectId: number;
    scriptId: number;
    workspaceId: string;
    upload: ParsedImageFlowUpload;
  },
  runtime: PersistImageFlowUploadRuntime,
): Promise<PersistedImageFlowUpload> {
  const projectId = positiveId(
    input.projectId,
    "IMAGE_FLOW_UPLOAD_PROJECT_INVALID",
  );
  const scriptId = positiveId(
    input.scriptId,
    "IMAGE_FLOW_UPLOAD_SCRIPT_INVALID",
  );
  const ownerWorkspaceId = workspaceId(input.workspaceId);
  const intentId = (runtime.idFactory ?? (() => crypto.randomUUID()))();
  const mediaAssetId =
    (runtime.idFactory ?? (() => crypto.randomUUID()))();
  const storageKey =
    `${projectId}/imageFlow/${scriptId}/${intentId}.`
      + input.upload.extension;
  let durableWrite: DurableObjectWriteResult | null = null;
  try {
    durableWrite = await writeObjectWithDurableIntent({
      purpose: "direct_upload",
      workspaceId: ownerWorkspaceId,
      projectId,
      body: input.upload.body,
      storageKey: () => storageKey,
      writerIdPrefix: "image-flow-upload",
    }, {
      database: runtime.database,
      writer: runtime.writer,
      idFactory: () => intentId,
      ...(runtime.clock ? { clock: runtime.clock } : {}),
    });
    const createdAt = runtime.clock?.() ?? Date.now();
    await runtime.database.transaction(async (transaction) => {
      const project = await transaction("o_project")
        .where({
          id: projectId,
          workspaceId: ownerWorkspaceId,
          deletionState: "active",
        })
        .select("id")
        .forUpdate()
        .first();
      const script = await transaction("o_script")
        .where({ id: scriptId, projectId })
        .select("id")
        .forUpdate()
        .first();
      if (!project || !script) {
        throw new Error("IMAGE_FLOW_UPLOAD_AUTHORITY_CHANGED");
      }
      await transaction("o_media_asset").insert({
        id: mediaAssetId,
        taskId: `image-flow-upload:${mediaAssetId}`,
        workspaceId: ownerWorkspaceId,
        projectId,
        assetType: "image",
        source: "image-flow-upload",
        url: durableWrite!.url,
        localPath: durableWrite!.storageKey,
        storageKey: durableWrite!.storageKey,
        mimeType: input.upload.mimeType,
        width: null,
        height: null,
        durationMs: null,
        metadata: JSON.stringify({
          version: "image-flow-upload.v1",
          scriptId,
          attachmentState: "project-scoped",
        }),
        createTime: createdAt,
      });
      await commitObjectWriteIntentInTransaction(
        transaction,
        durableWrite!.claim,
        {
          version: "object-write-reference.v1",
          table: "o_media_asset",
          rowId: mediaAssetId,
          workspaceId: ownerWorkspaceId,
          projectId,
          storageKey: durableWrite!.storageKey,
        },
        runtime.clock ? { clock: runtime.clock } : {},
      );
    });
    return {
      mediaAssetId,
      storageKey: durableWrite.storageKey,
      url: durableWrite.url,
    };
  } catch (error) {
    if (durableWrite) {
      try {
        await queueDurableObjectWriteCompensation(
          durableWrite.claim,
          error,
          {
            database: runtime.database,
            ...(runtime.clock ? { clock: runtime.clock } : {}),
          },
        );
      } catch (queueError) {
        throw Object.assign(new AggregateError(
          [error, queueError],
          "image-flow upload reference failed and compensation queue failed",
        ), {
          code: "IMAGE_FLOW_UPLOAD_COMPENSATION_QUEUE_FAILED",
        });
      }
    }
    throw error;
  }
}
