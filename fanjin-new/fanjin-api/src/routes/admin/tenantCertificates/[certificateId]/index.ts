import express from "express";
import { z } from "zod";

import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";
import {
  TenantCertificateError,
  tenantCertificateById,
} from "@/lib/tenantCertificate";

const router = express.Router({ mergeParams: true });
router.use(requirePlatformAdmin);

const certificateIdParam = z.string().trim().min(1);

function certificateIdFromParams(req: express.Request): string {
  return String((req.params as Record<string, string>).certificateId || "");
}

/**
 * GET /api/admin/tenantCertificates/:certificateId
 * 证书元数据详情。
 */
router.get("/", async (req, res) => {
  const parsed = certificateIdParam.safeParse(certificateIdFromParams(req));
  if (!parsed.success) return res.status(400).send(error("证书 ID 无效"));
  try {
    const record = await tenantCertificateById(db as any, parsed.data);
    return res.status(200).send(success(record));
  } catch (err) {
    if (err instanceof TenantCertificateError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    throw err;
  }
});

/**
 * POST /api/admin/tenantCertificates/:certificateId/validate
 * 重新读取证书中心元数据并刷新本地状态。
 */
router.post("/validate", async (req, res) => {
  const parsed = certificateIdParam.safeParse(certificateIdFromParams(req));
  if (!parsed.success) return res.status(400).send(error("证书 ID 无效"));
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const record = await tenantCertificateById(db as any, parsed.data);
    const timestamp = Date.now();
    await db("o_tenant_certificate")
      .where({ id: record.id })
      .update({ lastCheckedAt: timestamp, updatedAt: timestamp });
    await writeAuditLog(req, {
      action: "admin.tenant_certificate.validate",
      resourceType: "tenant_certificate",
      resourceId: record.id,
      required: true,
      metadata: { tenantId: record.tenantId, fingerprintSha256: record.fingerprintSha256 },
    });
    return res.status(200).send(success({ ...record, lastCheckedAt: timestamp }));
  } catch (err) {
    if (err instanceof TenantCertificateError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    throw err;
  }
});

/**
 * DELETE /api/admin/tenantCertificates/:certificateId
 * 删除证书记录（依赖检查：未被 active 域名引用）。
 */
router.delete("/", async (req, res) => {
  const parsed = certificateIdParam.safeParse(certificateIdFromParams(req));
  if (!parsed.success) return res.status(400).send(error("证书 ID 无效"));
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const record = await tenantCertificateById(db as any, parsed.data);
    const activeBinding = await db("o_tenant_domain")
      .where({ certificateId: record.id })
      .whereNull("deletedAt")
      .whereIn("lifecycleState", ["active", "activating", "ready"])
      .first();
    if (activeBinding) {
      return res.status(409).send(error("证书仍被生效域名引用，先解绑或更换证书", { code: "CERT_IN_USE" }));
    }
    await db("o_tenant_certificate").where({ id: record.id }).delete();
    await writeAuditLog(req, {
      action: "admin.tenant_certificate.delete",
      resourceType: "tenant_certificate",
      resourceId: record.id,
      required: true,
      metadata: { tenantId: record.tenantId, fingerprintSha256: record.fingerprintSha256 },
    });
    return res.status(200).send(success({ deleted: true, id: record.id }));
  } catch (err) {
    if (err instanceof TenantCertificateError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    throw err;
  }
});

export default router;
