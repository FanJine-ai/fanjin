import express from "express";
import { z } from "zod";

import { error, success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";
import {
  TenantCertificateError,
  bindCertificateToDomain,
  rotateDomainCertificate,
} from "@/lib/tenantCertificate";

const router = express.Router({ mergeParams: true });
router.use(requirePlatformAdmin);

const bindSchema = z.object({
  certificateId: z.string().trim().min(1),
}).strict();

const rotateSchema = z.object({
  newCertificateId: z.string().trim().min(1),
}).strict();

function domainIdFromParams(req: express.Request): string {
  return String((req.params as Record<string, string>).domainId || "");
}

/**
 * POST /api/admin/tenantDomains/:domainId/certificates/bind
 * 绑定证书到域名（校验租户归属与 SAN 覆盖）。
 */
router.post("/bind", async (req, res) => {
  const parsed = bindSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const domainId = domainIdFromParams(req);
  if (!domainId) return res.status(400).send(error("域名 ID 无效"));
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const bound = await bindCertificateToDomain({
      domainId,
      certificateId: parsed.data.certificateId,
      operatorUserId,
    });
    await writeAuditLog(req, {
      action: "admin.tenant_domain.certificate.bind",
      resourceType: "tenant_domain",
      resourceId: domainId,
      required: true,
      metadata: { certificateId: bound.certificateId, desiredRevision: bound.desiredRevision },
    });
    return res.status(200).send(success(bound));
  } catch (err) {
    if (err instanceof TenantCertificateError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    throw err;
  }
});

/**
 * POST /api/admin/tenantDomains/:domainId/certificates/rotate
 * 轮换证书：绑定新证书，旧证书延迟解绑（云端步骤以 pending 标注）。
 */
router.post("/rotate", async (req, res) => {
  const parsed = rotateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const domainId = domainIdFromParams(req);
  if (!domainId) return res.status(400).send(error("域名 ID 无效"));
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const rotation = await rotateDomainCertificate({
      domainId,
      newCertificateId: parsed.data.newCertificateId,
      operatorUserId,
    });
    await writeAuditLog(req, {
      action: "admin.tenant_domain.certificate.rotate",
      resourceType: "tenant_domain",
      resourceId: domainId,
      required: true,
      metadata: {
        previousCertificateId: rotation.previousCertificateId,
        newCertificateId: rotation.newCertificateId,
        pendingCloudSteps: rotation.pendingCloudSteps,
      },
    });
    return res.status(200).send(success(rotation));
  } catch (err) {
    if (err instanceof TenantCertificateError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    throw err;
  }
});

export default router;
