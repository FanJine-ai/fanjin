import express from "express";
import { z } from "zod";
import {
  PortraitManualReviewError,
  portraitManualReviewActor,
  portraitManualReviewSessionHash,
  readPortraitManualReview,
} from "@/lib/portraitManualReview";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { db } from "@/utils/db";

const router = express.Router();
router.use(requirePlatformAdmin);

const schema = z.object({
  admissionId: z.string().trim().min(1).max(256),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const actor = portraitManualReviewActor(req);
    return res.status(200).send(success(await readPortraitManualReview({
      database: db,
      admissionId: parsed.data.admissionId,
      actorUserId: actor.userId,
      sessionHash: portraitManualReviewSessionHash(req),
    })));
  } catch (error) {
    if (error instanceof PortraitManualReviewError) {
      return res.status(error.status).send({ message: error.message, code: error.code });
    }
    throw error;
  }
});
