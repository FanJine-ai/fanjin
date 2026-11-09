import express from "express";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import {
  createPlatformRelease,
  PLATFORM_RELEASE_VERSION_PATTERN,
  PlatformReleaseError,
} from "@/lib/platformReleases";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  version: z.string().trim().min(1).max(64).transform((value) => value.replace(/^v(?=\d)/i, "")).refine((value) => PLATFORM_RELEASE_VERSION_PATTERN.test(value), "版本号必须符合 SemVer，例如 1.8.0"),
  title: z.string().trim().min(2).max(120),
  channel: z.enum(["stable", "beta", "internal"]),
  summary: z.string().trim().min(4).max(500),
  releaseNotes: z.string().trim().min(4).max(20_000),
}).strict();

function operatorUserId(req: express.Request): number | null {
  const value = (req as any).auth?.user?.id ?? (req as any).user?.id;
  return value == null ? null : Number(value);
}

function sendError(res: express.Response, error: unknown) {
  if (error instanceof PlatformReleaseError) return res.status(error.status).send({ message: error.message, code: error.code });
  throw error;
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: parsed.error.issues[0]?.message || "参数错误", errors: parsed.error.issues });
  try {
    const item = await createPlatformRelease({ ...parsed.data, operatorUserId: operatorUserId(req) });
    await writeAuditLog(req, {
      action: "admin.platform_release.create",
      resourceType: "platform_release",
      resourceId: item.id,
      metadata: { version: item.version, title: item.title, channel: item.channel, status: item.status, revision: item.revision },
    });
    return res.status(200).send(success(item));
  } catch (error) {
    return sendError(res, error);
  }
});
