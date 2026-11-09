import express from "express";
import { z } from "zod";

import {
  CanvasPublicationError,
  listFjtvModerationQueue,
  reviewFjtvPublication,
} from "@/lib/canvasPublication";
import { writeAuditLog } from "@/lib/audit";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { db } from "@/utils/db";

const router = express.Router();
router.use(requirePlatformAdmin);

function sendFailure(res: express.Response, error: unknown) {
  if (error instanceof CanvasPublicationError) {
    return res.status(error.status).send({ code: error.code, message: error.message });
  }
  console.error("[admin-fjtv] request failed", error);
  return res.status(500).send({ code: "FJTV_ADMIN_FAILED", message: "FJTV 审核服务暂时不可用" });
}

router.get("/", async (req, res) => {
  try {
    const publications = await listFjtvModerationQueue(db, req.query.status);
    return res.status(200).send(success({ publications }));
  } catch (error) {
    return sendFailure(res, error);
  }
});

router.post("/:publicationId/review", async (req, res) => {
  const parsed = z.object({
    expectedRevision: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    decision: z.enum(["publish", "reject", "unpublish"]),
    reason: z.string().trim().max(2_000).optional(),
  }).strict().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const user = (req as any).auth?.user ?? (req as any).user ?? {};
  try {
    const publication = await reviewFjtvPublication(db, {
      publicationId: req.params.publicationId,
      moderatorUserId: Number(user.id || 0),
      ...parsed.data,
      audit: async (updated, previousStatus, transaction) => {
        await writeAuditLog(req, {
          action: "admin.fjtv.publication.review",
          resourceType: "fjtv_publication",
          resourceId: updated.id,
          required: true,
          metadata: {
            decision: parsed.data.decision,
            previousStatus,
            status: updated.status,
            revision: updated.revision,
          },
        }, transaction);
      },
    });
    return res.status(200).send(success({ publication }));
  } catch (error) {
    return sendFailure(res, error);
  }
});

export default router;
