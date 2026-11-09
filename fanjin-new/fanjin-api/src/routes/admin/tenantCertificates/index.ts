import express from "express";
import { z } from "zod";

import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";
import {
  TenantCertificateError,
  importTenantCertificate,
  listTenantCertificates,
  referenceTenantCertificate,
} from "@/lib/tenantCertificate";

const router = express.Router();
router.use(requirePlatformAdmin);

const importSchema = z.object({
  tenantId: z.string().trim().regex(/^[A-Z][A-Z0-9_-]{1,63}$/),
  certificateChain: z.string().min(64).max(65_536),
  privateKey: z.string().min(64).max(65_536),
  hostnames: z.array(z.string().trim().min(3).max(253)).min(1).max(20),
  name: z.string().trim().max(128).optional(),
}).strict();

const referenceSchema = z.object({
  tenantId: z.string().trim().regex(/^[A-Z][A-Z0-9_-]{1,63}$/),
  providerCertificateId: z.string().trim().min(1).max(256),
}).strict();

/**
 * GET /api/admin/tenantCertificates?tenantId=...
 * 证书元数据列表（不含任何私钥材料）。
 */
router.get("/", async (req, res) => {
  const tenantId = String(req.query.tenantId || "").trim() || undefined;
  const status = String(req.query.status || "").trim() || undefined;
  const certificates = await listTenantCertificates(db as any, { tenantId, status });
  return res.status(200).send(success({ items: certificates }));
});

/**
 * POST /api/admin/tenantCertificates/import
 * BYOC 上传：私钥仅在受控内存中校验并立即上传证书中心，
 * 不进入数据库、日志、审计正文或任何响应。
 */
router.post("/import", async (req, res) => {
  const parsed = importSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).send({ message: "参数错误", errors: parsed.error.issues.slice(0, 3) });
  }
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const record = await importTenantCertificate({
      tenantId: parsed.data.tenantId,
      certificateChain: parsed.data.certificateChain,
      privateKey: parsed.data.privateKey,
      hostnames: parsed.data.hostnames,
      name: parsed.data.name,
      operatorUserId,
    });
    await writeAuditLog(req, {
      action: "admin.tenant_certificate.import",
      resourceType: "tenant_certificate",
      resourceId: record.id,
      required: true,
      metadata: {
        tenantId: record.tenantId,
        providerCertificateId: record.providerCertificateId,
        fingerprintSha256: record.fingerprintSha256,
        commonName: record.commonName,
        notAfter: record.notAfter,
      },
    });
    return res.status(200).send(success(record));
  } catch (err) {
    if (err instanceof TenantCertificateError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    // 绝不回显 PEM 内容；只返回类别。
    return res.status(500).send(error("证书导入失败", { code: "CERT_IMPORT_FAILED" }));
  }
});

/**
 * POST /api/admin/tenantCertificates/reference
 * 平台 Root 引用证书中心已有证书。
 */
router.post("/reference", async (req, res) => {
  const parsed = referenceSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const actorRole = String((req as any).auth?.user?.role || "").toLowerCase();
  if (actorRole !== "root") {
    return res.status(403).send(error("仅平台 Root 可引用证书中心已有证书", { code: "PLATFORM_ROOT_REQUIRED" }));
  }
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const record = await referenceTenantCertificate({
      tenantId: parsed.data.tenantId,
      providerCertificateId: parsed.data.providerCertificateId,
      operatorUserId,
    });
    await writeAuditLog(req, {
      action: "admin.tenant_certificate.reference",
      resourceType: "tenant_certificate",
      resourceId: record.id,
      required: true,
      metadata: {
        tenantId: record.tenantId,
        providerCertificateId: record.providerCertificateId,
        commonName: record.commonName,
        notAfter: record.notAfter,
      },
    });
    return res.status(200).send(success(record));
  } catch (err) {
    if (err instanceof TenantCertificateError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    throw err;
  }
});

export default router;
