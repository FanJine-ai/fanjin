import express from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { insertAndReturnId } from "@/lib/dbDialect";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import u from "@/utils";
import { db } from "@/utils/db";
import {
  queueDurableObjectWriteCompensation,
  writeObjectWithDurableIntent,
  type DurableObjectWriteResult,
} from "@/lib/durableObjectWrite";
import {
  commitObjectWriteIntentInTransaction,
} from "@/lib/objectWriteIntent";
import {
  abortReferenceMultipartUpload,
  completeReferenceMultipartUpload,
  createReferenceMultipartPartTarget,
  getReferenceMultipartUploadStatus,
  initReferenceMultipartUpload,
  ReferenceMultipartUploadError,
} from "@/lib/referenceMultipartUpload";
import { createPortraitAdmissionForUpload } from "@/lib/portraitAdmissionStore";
import { registerAccountOwnedAssetIfAvailable } from "@/lib/accountWorkspaceAssetLibrary";

const router = express.Router();

export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_REFERENCE_BYTES / 3) * 4;

const REFERENCE_MIME_TYPES = {
  "image/jpeg": { ext: "jpg", category: "image" },
  "image/jpg": { ext: "jpg", category: "image" },
  "image/png": { ext: "png", category: "image" },
  "image/gif": { ext: "gif", category: "image" },
  "image/webp": { ext: "webp", category: "image" },
  "video/mp4": { ext: "mp4", category: "video" },
  "video/webm": { ext: "webm", category: "video" },
  "video/quicktime": { ext: "mov", category: "video" },
  "audio/mpeg": { ext: "mp3", category: "audio" },
  "audio/mp3": { ext: "mp3", category: "audio" },
  "audio/wav": { ext: "wav", category: "audio" },
  "audio/mp4": { ext: "m4a", category: "audio" },
  "application/pdf": { ext: "pdf", category: "document" },
  "text/plain": { ext: "txt", category: "document" },
  "text/markdown": { ext: "md", category: "document" },
  "text/x-markdown": { ext: "md", category: "document" },
} as const;

export type ReferenceCategory = (typeof REFERENCE_MIME_TYPES)[keyof typeof REFERENCE_MIME_TYPES]["category"];

class ReferenceUploadError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ReferenceUploadError";
    this.status = status;
  }
}

function hasPrefix(data: Buffer, bytes: number[]): boolean {
  return bytes.every((value, index) => data[index] === value);
}

function hasAscii(data: Buffer, offset: number, value: string): boolean {
  return data.length >= offset + value.length && data.subarray(offset, offset + value.length).toString("ascii") === value;
}

function hasExpectedSignature(mime: string, data: Buffer): boolean {
  switch (mime) {
    case "image/jpeg":
    case "image/jpg":
      return hasPrefix(data, [0xff, 0xd8, 0xff]);
    case "image/png":
      return hasPrefix(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/gif":
      return hasAscii(data, 0, "GIF87a") || hasAscii(data, 0, "GIF89a");
    case "image/webp":
      return hasAscii(data, 0, "RIFF") && hasAscii(data, 8, "WEBP");
    case "video/mp4":
    case "video/quicktime":
    case "audio/mp4":
      return hasAscii(data, 4, "ftyp");
    case "video/webm":
      return hasPrefix(data, [0x1a, 0x45, 0xdf, 0xa3]);
    case "audio/mpeg":
    case "audio/mp3":
      return hasAscii(data, 0, "ID3")
        || (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0);
    case "audio/wav":
      return hasAscii(data, 0, "RIFF") && hasAscii(data, 8, "WAVE");
    case "application/pdf":
      return hasAscii(data, 0, "%PDF-");
    case "text/plain":
    case "text/markdown":
    case "text/x-markdown":
      if (data.includes(0)) return false;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data);
        return true;
      } catch {
        return false;
      }
    default:
      return false;
  }
}

export function parseReferenceDataUrl(value: string, claimedCategory: ReferenceCategory) {
  const match = String(value || "").match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new ReferenceUploadError(400, "参考附件必须是合法的 base64 data URL");

  const mime = match[1].trim().toLowerCase();
  const definition = REFERENCE_MIME_TYPES[mime as keyof typeof REFERENCE_MIME_TYPES];
  if (!definition) throw new ReferenceUploadError(415, `不支持的参考附件类型: ${mime}`);
  if (definition.category !== claimedCategory) {
    throw new ReferenceUploadError(400, "参考附件类型与 MIME 不匹配");
  }

  const encoded = match[2];
  if (encoded.length % 4 !== 0 || encoded.length > MAX_BASE64_LENGTH) {
    throw new ReferenceUploadError(encoded.length > MAX_BASE64_LENGTH ? 413 : 400, "参考附件 base64 编码无效");
  }
  const data = Buffer.from(encoded, "base64");
  if (!data.length || data.length > MAX_REFERENCE_BYTES) {
    throw new ReferenceUploadError(data.length > MAX_REFERENCE_BYTES ? 413 : 400, "参考附件大小无效，最大 20MB");
  }
  if (data.toString("base64") !== encoded) {
    throw new ReferenceUploadError(400, "参考附件 base64 编码无效");
  }
  if (!hasExpectedSignature(mime, data)) {
    throw new ReferenceUploadError(415, "参考附件内容与 MIME 不匹配");
  }

  return { data, mime, ext: definition.ext, category: definition.category };
}

router.post(
  "/",
  requireProjectPermission("project:write"),
  validateFields({
    projectId: z.number().int().positive(),
    base64Data: z.string().min(1).max(MAX_BASE64_LENGTH + 128),
    type: z.enum(["image", "video", "audio", "document"]),
    name: z.string().trim().min(1).max(255),
  }),
  async (req, res) => {
    const { projectId, base64Data, type, name } = req.body as {
      projectId: number;
      base64Data: string;
      type: ReferenceCategory;
      name: string;
    };

    let parsed: ReturnType<typeof parseReferenceDataUrl>;
    try {
      parsed = parseReferenceDataUrl(base64Data, type);
    } catch (error) {
      const uploadError = error instanceof ReferenceUploadError
        ? error
        : new ReferenceUploadError(400, "参考附件格式无效");
      return res.status(uploadError.status).send({ message: uploadError.message });
    }

    const intentId = uuid();
    const filePath =
      `/${projectId}/assets/references/${intentId}.${parsed.ext}`;
    let durableWrite: DurableObjectWriteResult | null = null;
    try {
      durableWrite = await writeObjectWithDurableIntent({
        purpose: "direct_upload",
        workspaceId: String((req as any).project?.workspaceId || ""),
        projectId,
        body: parsed.data,
        storageKey: () => filePath,
        writerIdPrefix: "reference-upload",
      }, {
        database: db,
        idFactory: () => intentId,
        writer: u.oss,
      });
      const sourceSha256 = crypto.createHash("sha256").update(parsed.data).digest("hex");
      const { assetId, assetVersionId, portraitAdmissionId } = await db.transaction(async (trx: any) => {
        // Acquire the project lock before inserting FK children. Concurrent
        // uploads otherwise hold KEY SHARE locks from o_assets, then both try
        // to upgrade to UPDATE inside commitObjectWriteIntentInTransaction.
        const project = await trx("o_project")
          .where({ id: projectId, workspaceId: String((req as any).project?.workspaceId || ""), deletionState: "active" })
          .select("id").forUpdate().first();
        if (!project) throw new ReferenceUploadError(409, "项目已不可用，请重新选择项目");
        const assetId = await insertAndReturnId(trx, "o_assets", {
          type: parsed.category,
          projectId,
          name,
          startTime: Date.now(),
        });
        const assetVersionId = await insertAndReturnId(trx, "o_image", {
          filePath,
          storageKey: durableWrite!.storageKey,
          type: parsed.category,
          assetsId: assetId,
          state: "已完成",
        });
        await trx("o_assets").where({ id: assetId, projectId }).update({ imageId: assetVersionId });
        const actorUserId = Number((req as any).auth?.user?.id || (req as any).user?.id || 0);
        const workspaceId = String((req as any).project?.workspaceId || "");
        if (actorUserId > 0 && workspaceId) {
          await registerAccountOwnedAssetIfAvailable({
            transaction: trx,
            assetId,
            projectId,
            workspaceId,
            actorUserId,
            assetVersionId: `image:${assetVersionId}`,
            idempotencyKey: `reference-upload:${intentId}:ownership`,
          });
        }
        await commitObjectWriteIntentInTransaction(
          trx,
          durableWrite!.claim,
          {
            version: "object-write-reference.v1",
            table: "o_image",
            rowId: String(assetVersionId),
            workspaceId: String((req as any).project?.workspaceId || ""),
            projectId,
            storageKey: durableWrite!.storageKey,
          },
        );
        const portraitAdmissionId = await createPortraitAdmissionForUpload({
          database: trx,
          workspaceId: String((req as any).project?.workspaceId || ""),
          projectId,
          assetId,
          assetVersionId,
          mediaType: parsed.category,
          sourceSha256,
        });
        return { assetId, assetVersionId, portraitAdmissionId };
      });

      return res.status(200).send(success({
        assetId,
        assetVersionId,
        filePath,
        previewUrl: `/api/assets/getReferenceFile?id=${assetId}&disposition=inline`,
        type: parsed.category,
        mimeType: parsed.mime,
        size: parsed.data.length,
        name,
        portraitAdmissionId,
      }));
    } catch (error) {
      if (durableWrite) {
        await queueDurableObjectWriteCompensation(
          durableWrite.claim,
          error,
          { database: db },
        ).catch((queueError) => {
          console.error(
            "Reference upload compensation queue failed",
            queueError,
          );
        });
      }
      console.error("Reference attachment upload failed", error);
      if (error instanceof ReferenceUploadError) return res.status(error.status).send({ message: error.message });
      return res.status(500).send({ message: "参考附件上传失败" });
    }
  },
);

function multipartIdentity(req: express.Request) {
  return {
    sessionId: String(req.params.sessionId || ""),
    resumeGrant: String(req.body?.resumeGrant || ""),
    workspaceId: String((req as any).project?.workspaceId || ""),
    projectId: Number(req.body?.projectId || 0),
    actorUserId: Number((req as any).auth?.user?.id || 0),
  };
}

function sendMultipartError(req: express.Request, res: express.Response, cause: unknown) {
  const error = cause as { name?: unknown; code?: unknown; statusCode?: unknown } | null;
  const safeCode = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/u.test(value) ? value : undefined;
  console.error("reference_multipart_upload_failed", {
    stage: req.route?.path,
    sessionId: typeof req.params.sessionId === "string" && /^[a-f0-9-]{36}$/iu.test(req.params.sessionId) ? req.params.sessionId : undefined,
    errorName: safeCode(error?.name),
    errorCode: safeCode(error?.code),
    upstreamStatus: Number.isInteger(error?.statusCode) ? error?.statusCode : undefined,
  });
  const uploadError = cause instanceof ReferenceMultipartUploadError
    ? cause
    : new ReferenceMultipartUploadError(
        "素材上传未完成，请重试；已上传分片会继续使用",
        503,
        "REFERENCE_UPLOAD_UNAVAILABLE",
      );
  return res.status(uploadError.status).send({
    message: uploadError.message,
    code: uploadError.code,
  });
}

const multipartAuthorizationFields = {
  projectId: z.number().int().positive(),
  resumeGrant: z.string().min(32).max(256),
};

router.post(
  "/multipart/init",
  requireProjectPermission("project:write"),
  validateFields({
    projectId: z.number().int().positive(),
    idempotencyKey: z.string().min(8).max(128),
    fileName: z.string().trim().min(1).max(255),
    mediaType: z.enum(["image", "video", "audio"]),
    mimeType: z.string().trim().min(1).max(128),
    byteSize: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/iu),
  }),
  async (req, res) => {
    try {
      const result = await initReferenceMultipartUpload({
        workspaceId: String((req as any).project?.workspaceId || ""),
        projectId: Number(req.body.projectId),
        actorUserId: Number((req as any).auth?.user?.id || 0),
        idempotencyKey: req.body.idempotencyKey,
        fileName: req.body.fileName,
        mediaType: req.body.mediaType,
        mimeType: req.body.mimeType,
        byteSize: req.body.byteSize,
        sha256: req.body.sha256,
      });
      return res.status(200).send(success(result));
    } catch (cause) {
      return sendMultipartError(req, res, cause);
    }
  },
);

router.post(
  "/multipart/:sessionId/status",
  requireProjectPermission("project:write"),
  validateFields(multipartAuthorizationFields),
  async (req, res) => {
    try {
      return res.status(200).send(success(
        await getReferenceMultipartUploadStatus(multipartIdentity(req)),
      ));
    } catch (cause) {
      return sendMultipartError(req, res, cause);
    }
  },
);

router.post(
  "/multipart/:sessionId/part",
  requireProjectPermission("project:write"),
  validateFields({
    ...multipartAuthorizationFields,
    partNumber: z.number().int().min(1).max(10_000),
  }),
  async (req, res) => {
    try {
      return res.status(200).send(success(
        await createReferenceMultipartPartTarget({
          ...multipartIdentity(req),
          partNumber: req.body.partNumber,
        }),
      ));
    } catch (cause) {
      return sendMultipartError(req, res, cause);
    }
  },
);

router.post(
  "/multipart/:sessionId/complete",
  requireProjectPermission("project:write"),
  validateFields(multipartAuthorizationFields),
  async (req, res) => {
    try {
      return res.status(200).send(success(
        await completeReferenceMultipartUpload(multipartIdentity(req)),
      ));
    } catch (cause) {
      return sendMultipartError(req, res, cause);
    }
  },
);

router.post(
  "/multipart/:sessionId/abort",
  requireProjectPermission("project:write"),
  validateFields(multipartAuthorizationFields),
  async (req, res) => {
    try {
      return res.status(200).send(success(
        await abortReferenceMultipartUpload(multipartIdentity(req)),
      ));
    } catch (cause) {
      return sendMultipartError(req, res, cause);
    }
  },
);

export default router;
