import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { success, error } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { checkMediaService, listMediaServices, MediaServiceError, saveMediaService } from "@/lib/mediaServices";

const router = express.Router();
router.use(requirePlatformAdmin);
const saveSchema = z.object({
  id: z.string().trim().min(1).max(256).optional(),
  kind: z.enum(["mediakit", "imagex"]), name: z.string().trim().min(1).max(120),
  enabled: z.boolean(), expectedUpdateTime: z.number().int().nonnegative().optional(),
  acceptNewJobs: z.boolean().optional(),
  apiKey: z.string().max(16384).optional(), serviceId: z.string().trim().max(256).optional(),
  accessKeyId: z.string().trim().max(256).optional(), secretAccessKey: z.string().max(512).optional(), sessionToken: z.string().max(768).optional(),
}).strict();
function failure(res: express.Response, caught: unknown) {
  if (caught instanceof Error && (caught as Error & { code?: string }).code === "IMAGEX_ACTIVE_REQUEST") {
    return res.status(409).send({ ...error(caught.message), code: "IMAGEX_ACTIVE_REQUEST" });
  }
  return caught instanceof MediaServiceError
    ? res.status(caught.status).send({ ...error(caught.message), code: caught.code })
    : res.status(400).send(error("媒体服务配置无效，或暂时无法完成操作"));
}
router.get("/", async (_req, res) => {
  try { return res.send(success({ services: await listMediaServices(db as any) })); }
  catch (caught) { return failure(res, caught); }
});
router.post("/save", async (req, res) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).send(error("请检查媒体服务名称、类型和凭据字段"));
  try {
    const result = await db.transaction(async trx => {
      const saved = await saveMediaService(trx as any, parsed.data);
      await writeAuditLog(req, { action: "admin.media_service.save", resourceType: "media_service", resourceId: saved.service.id, required: true, metadata: { kind: saved.service.kind, enabled: saved.service.enabled, credentialUpdated: saved.credentialChanged, acceptNewJobs: saved.service.acceptNewJobs, replacedServiceIds: saved.replacedServiceIds } }, trx);
      return saved;
    });
    return res.send(success(result.service));
  } catch (caught) { return failure(res, caught); }
});
router.post("/check", async (req, res) => {
  const parsed = z.object({ id: z.string().trim().min(1).max(256) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).send(error("缺少媒体服务 ID"));
  try {
    const result = await checkMediaService(db as any, parsed.data.id);
    await writeAuditLog(req, { action: "admin.media_service.check", resourceType: "media_service", resourceId: parsed.data.id, metadata: { ok: result.ok } });
    return res.send(success(result));
  } catch (caught) { return failure(res, caught); }
});
export default router;
