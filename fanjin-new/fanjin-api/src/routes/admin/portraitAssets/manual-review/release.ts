import express from "express";
import { z } from "zod";
import {
  PortraitManualReviewError,
  portraitManualReviewActor,
  portraitManualReviewSessionHash,
  releasePortraitManualReview,
} from "@/lib/portraitManualReview";
import { error as apiError, success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { db } from "@/utils/db";

const router = express.Router();
router.use(requirePlatformAdmin);

const schema = z.object({
  admissionId: z.string().trim().min(1).max(256),
  reviewId: z.string().trim().min(1).max(256),
  expectedAdmissionRevision: z.number().int().positive(),
  expectedReviewRevision: z.number().int().positive(),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const actor = portraitManualReviewActor(req);
    return res.status(200).send(success(await releasePortraitManualReview({
      database: db,
      auditRequest: req,
      ...parsed.data,
      actorUserId: actor.userId,
      sessionHash: portraitManualReviewSessionHash(req),
    })));
  } catch (caught) {
    if (caught instanceof PortraitManualReviewError) {
      return res.status(caught.status).send({ message: caught.message, code: caught.code });
    }
    if (caught instanceof Error && caught.message.startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(apiError(
        "安全审计暂不可用，操作未执行",
        { code: "FJADMIN_AUDIT_UNAVAILABLE" },
      ));
    }
    throw caught;
  }
});
