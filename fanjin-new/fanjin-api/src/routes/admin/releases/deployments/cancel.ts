import express from "express";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { cancelReleaseDeployment, ReleaseDeploymentError } from "@/lib/releaseDeployments";
import { success } from "@/lib/responseFormat";
import { requireReleasePublisher } from "@/middleware/permissions";

const router = express.Router();
router.use(requireReleasePublisher);

const bodySchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
}).strict();

function operatorUserId(req: express.Request): number | null {
  const value = (req as any).auth?.user?.id ?? (req as any).user?.id;
  return value == null ? null : Number(value);
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: parsed.error.issues[0]?.message || "参数错误", errors: parsed.error.issues });
  try {
    const item = await cancelReleaseDeployment({ ...parsed.data, operatorUserId: operatorUserId(req) });
    await writeAuditLog(req, {
      action: "admin.release_deployment.cancel",
      resourceType: "release_deployment",
      resourceId: item.id,
      metadata: { releaseId: item.releaseId, scope: item.scope, status: item.status, revision: item.revision },
    });
    return res.status(200).send(success(item));
  } catch (error) {
    if (error instanceof ReleaseDeploymentError) return res.status(error.status).send({ message: error.message, code: error.code });
    throw error;
  }
});
