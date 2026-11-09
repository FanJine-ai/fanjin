import express from "express";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { archivePlatformRelease, PlatformReleaseError } from "@/lib/platformReleases";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict();

function operatorUserId(req: express.Request): number | null {
  const value = (req as any).auth?.user?.id ?? (req as any).user?.id;
  return value == null ? null : Number(value);
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    const item = await archivePlatformRelease({ ...parsed.data, operatorUserId: operatorUserId(req) });
    await writeAuditLog(req, {
      action: "admin.platform_release.archive",
      resourceType: "platform_release",
      resourceId: item.id,
      metadata: { version: item.version, channel: item.channel, status: item.status, revision: item.revision, archivedAt: item.archivedAt },
    });
    return res.status(200).send(success(item));
  } catch (error) {
    if (error instanceof PlatformReleaseError) return res.status(error.status).send({ message: error.message, code: error.code });
    throw error;
  }
});
