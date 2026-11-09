import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import express from "express";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { PORTRAIT_MANUAL_REVIEW_TABLE } from "@/lib/migrations/portraitAssetAdmission";
import {
  PortraitManualReviewError,
  portraitManualReviewActor,
  portraitManualReviewSessionHash,
  resolvePortraitManualReviewPreview,
} from "@/lib/portraitManualReview";
import {
  mintPortraitManualReviewPreviewGrant,
  PortraitManualReviewPreviewGrantError,
  setPortraitManualReviewPreviewPrivateHeaders,
} from "@/lib/portraitManualReviewPreviewGrant";
import { error as apiError, success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import u from "@/utils";
import { db } from "@/utils/db";

const router = express.Router();
router.use(requirePlatformAdmin);

const previewSchema = z.object({
  reviewId: z.string().trim().min(1).max(256),
}).strict();
const grantSchema = z.object({
  reviewId: z.string().trim().min(1).max(256),
  expectedReviewRevision: z.number().int().positive(),
}).strict();
const SINGLE_RANGE = /^bytes=(?:\d+-\d*|-\d+)$/u;

router.post("/grant", async (req, res) => {
  setPortraitManualReviewPreviewPrivateHeaders(res);
  const parsed = grantSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  }
  try {
    const grant = await mintPortraitManualReviewPreviewGrant({
      database: db,
      request: req,
      response: res,
      reviewId: parsed.data.reviewId,
      expectedReviewRevision: parsed.data.expectedReviewRevision,
    });
    return res.status(200).send(success(grant));
  } catch (error) {
    if (
      error instanceof PortraitManualReviewError
      || error instanceof PortraitManualReviewPreviewGrantError
    ) {
      return res.status(error.status).send({ message: error.message, code: error.code });
    }
    return res.status(503).send(apiError(
      "安全审计或预览授权暂不可用，视频未读取",
      { code: "FJADMIN_AUDIT_UNAVAILABLE" },
    ));
  }
});

export default router.get("/", async (req, res) => {
  // Every success and error on this sensitive media endpoint must remain
  // private. Set the policy before any authorization, audit, object-storage,
  // or upstream failure can return a response.
  setPortraitManualReviewPreviewPrivateHeaders(res);
  const parsed = previewSchema.safeParse(req.query ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const range = String(req.header("range") || "").trim();
  if (range && !SINGLE_RANGE.test(range)) {
    return res.status(416).send({ message: "仅支持单段视频 Range 请求", code: "PORTRAIT_REVIEW_RANGE_INVALID" });
  }
  try {
    const actor = portraitManualReviewActor(req);
    const source = await resolvePortraitManualReviewPreview({
      database: db,
      reviewId: parsed.data.reviewId,
      actorUserId: actor.userId,
      sessionHash: portraitManualReviewSessionHash(req),
    });
    const reviewContext = await db(PORTRAIT_MANUAL_REVIEW_TABLE)
      .where({ id: parsed.data.reviewId })
      .select("workspaceId", "admissionId")
      .first();
    if (!reviewContext) {
      return res.status(404).send({
        message: "素材复核不存在",
        code: "portrait_review_not_found",
      });
    }
    try {
      await writeAuditLog(req, {
        workspaceId: String(reviewContext.workspaceId),
        action: "admin.portrait_manual_review.preview",
        resourceType: "portrait_manual_review",
        resourceId: parsed.data.reviewId,
        required: true,
        metadata: {
          admissionId: String(reviewContext.admissionId),
          delivery: "same_origin_proxy",
          rangeRequested: Boolean(range),
        },
      });
    } catch {
      return res.status(503).send(apiError(
        "安全审计暂不可用，视频未读取",
        { code: "FJADMIN_AUDIT_UNAVAILABLE" },
      ));
    }
    const signedSourceUrl = await u.oss.getPrivateFileUrl(
      source.filePath,
      { expiresInSeconds: 120 },
    );
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    const upstream = await fetch(signedSourceUrl, {
      headers: {
        "accept-encoding": "identity",
        ...(range ? { range } : {}),
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (
      ![200, 206].includes(upstream.status)
      || !upstream.body
      || (range && (
        upstream.status !== 206
        || !upstream.headers.get("content-range")
      ))
    ) {
      return res.status(502).send({
        message: "复核视频暂不可播放",
        code: "PORTRAIT_REVIEW_PREVIEW_UNAVAILABLE",
      });
    }
    res.status(upstream.status);
    res.setHeader("Content-Security-Policy", "default-src 'none'; media-src 'self' blob:");
    res.setHeader("Content-Type", upstream.headers.get("content-type") || source.contentType);
    for (const header of ["accept-ranges", "content-length", "content-range"] as const) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    await pipeline(Readable.fromWeb(upstream.body as any), res);
    return undefined;
  } catch (error) {
    if (error instanceof PortraitManualReviewError) {
      return res.status(error.status).send({ message: error.message, code: error.code });
    }
    if (!res.headersSent) {
      return res.status(502).send({
        message: "复核视频暂不可播放",
        code: "PORTRAIT_REVIEW_PREVIEW_UNAVAILABLE",
      });
    }
    res.destroy();
    return undefined;
  }
});
