import express from "express";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import {
  createReleaseArtifactUploadTarget,
  MAX_RELEASE_ARTIFACT_BYTE_SIZE,
  ReleaseArtifactUploadError,
} from "@/lib/releaseArtifactUpload";
import {
  abortReleaseArtifactMultipartUpload,
  completeReleaseArtifactMultipartUpload,
  createReleaseArtifactMultipartPartTarget,
  getReleaseArtifactMultipartUploadStatus,
  initReleaseArtifactMultipartUpload,
  ReleaseArtifactMultipartUploadError,
} from "@/lib/releaseArtifactMultipartUpload";
import { success } from "@/lib/responseFormat";
import { requireReleasePublisher } from "@/middleware/permissions";

import { readAdminMachineIdentity } from "@/lib/adminMachineIdentity";

const router = express.Router();
router.use(requireReleasePublisher);

const baseUploadSchema = z.object({
  releaseId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(200),
  byteSize: z.number().int().positive().safe().max(MAX_RELEASE_ARTIFACT_BYTE_SIZE),
  contentType: z.literal("application/gzip"),
  idempotencyKey: z.string().trim().min(8).max(128),
});

const singleUploadSchema = baseUploadSchema.strict();
const multipartInitSchema = baseUploadSchema.extend({
  action: z.literal("multipart_init"),
  sha256: z.string().trim().toLowerCase().regex(/^[a-f0-9]{64}$/u),
}).strict();
const multipartAuthorizationSchema = z.object({
  sessionId: z.string().uuid(),
  resumeGrant: z.string().trim().min(8).max(512),
});
const multipartStatusSchema = multipartAuthorizationSchema.extend({
  action: z.literal("multipart_status"),
}).strict();
const multipartPartSchema = multipartAuthorizationSchema.extend({
  action: z.literal("multipart_part"),
  partNumber: z.number().int().positive().max(10_000),
}).strict();
const multipartCompleteSchema = multipartAuthorizationSchema.extend({
  action: z.literal("multipart_complete"),
}).strict();
const multipartAbortSchema = multipartAuthorizationSchema.extend({
  action: z.literal("multipart_abort"),
}).strict();
const bodySchema = z.union([
  singleUploadSchema,
  multipartInitSchema,
  multipartStatusSchema,
  multipartPartSchema,
  multipartCompleteSchema,
  multipartAbortSchema,
]);

function operatorUserId(req: express.Request): number {
  return Number((req as any).auth?.user?.id ?? (req as any).user?.id ?? 0);
}

function operatorSessionId(req: express.Request): string {
  return String(readAdminMachineIdentity(req)?.id || (req as any).auth?.session?.id || "");
}

export default router.post("/", async (req, res, next) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).send({
      message: parsed.error.issues[0]?.message || "参数错误",
      code: "RELEASE_ARTIFACT_UPLOAD_INPUT_INVALID",
      errors: parsed.error.issues,
    });
  }

  try {
    const data = parsed.data;
    const action = "action" in data ? data.action : "single_put";
    const multipartAuthorization = (authorized: {
      sessionId: string;
      resumeGrant: string;
    }) => ({
      sessionId: authorized.sessionId,
      resumeGrant: authorized.resumeGrant,
      operatorUserId: operatorUserId(req),
      operatorSessionId: operatorSessionId(req),
    });
    let target: Record<string, any>;
    let uploadAuditMetadata: Record<string, unknown> = {};
    if ("action" in data && data.action === "multipart_init") {
      target = await initReleaseArtifactMultipartUpload({
        releaseId: data.releaseId,
        fileName: data.fileName,
        byteSize: data.byteSize,
        contentType: data.contentType,
        sha256: data.sha256,
        idempotencyKey: data.idempotencyKey,
        operatorUserId: operatorUserId(req),
        operatorSessionId: operatorSessionId(req),
      });
      uploadAuditMetadata = {
        releaseId: data.releaseId,
        byteSize: data.byteSize,
        contentType: data.contentType,
      };
    } else if ("action" in data && data.action === "multipart_status") {
      target = await getReleaseArtifactMultipartUploadStatus(
        multipartAuthorization(data),
      );
    } else if ("action" in data && data.action === "multipart_part") {
      target = await createReleaseArtifactMultipartPartTarget({
        ...multipartAuthorization(data),
        partNumber: data.partNumber,
      });
    } else if ("action" in data && data.action === "multipart_complete") {
      target = await completeReleaseArtifactMultipartUpload(
        multipartAuthorization(data),
      );
    } else if ("action" in data && data.action === "multipart_abort") {
      target = await abortReleaseArtifactMultipartUpload(
        multipartAuthorization(data),
      );
    } else {
      target = await createReleaseArtifactUploadTarget({
        ...data,
        operatorUserId: operatorUserId(req),
      });
      uploadAuditMetadata = {
        releaseId: data.releaseId,
        byteSize: data.byteSize,
        contentType: data.contentType,
      };
    }
    const resourceId = "sessionId" in target
      ? target.sessionId
      : target.reservationId;
    await writeAuditLog(req, {
      action: "admin.release_artifact.upload_url",
      resourceType: "release_artifact_upload",
      resourceId,
      metadata: {
        mode: action,
        ...uploadAuditMetadata,
        ...("partNumber" in target
          ? {
              partNumber: target.partNumber,
              byteSize: target.byteSize,
            }
          : {}),
        ...("expiresAt" in target ? { expiresAt: target.expiresAt } : {}),
        ...("idempotent" in target
          ? { idempotent: target.idempotent }
          : {}),
      },
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Pragma", "no-cache");
    return res.status(200).send(success(target));
  } catch (error) {
    if (error instanceof ReleaseArtifactMultipartUploadError) {
      return res.status(error.status).send({
        message: error.message,
        code: error.code,
      });
    }
    if (error instanceof ReleaseArtifactUploadError) {
      return res.status(error.status).send({ message: error.message, code: error.code });
    }
    return next(error);
  }
});
