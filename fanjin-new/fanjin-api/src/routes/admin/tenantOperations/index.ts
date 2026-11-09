import express from "express";
import { z } from "zod";

import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";
import {
  TenantCapacityError,
  certificateExpiryAlertScan,
  domainDriftReport,
  listIngressCapacity,
  mailDnsGuidance,
  mediaCorsAllowedOrigins,
  refreshIngressClusterUsage,
  reconcileDomainDrift,
  validateTenantCallbackUrls,
} from "@/lib/tenantCapacity";

const router = express.Router();
router.use(requirePlatformAdmin);

const reconcileSchema = z.object({
  domainId: z.string().trim().min(1).max(64),
}).strict();

const callbackSchema = z.object({
  tenantId: z.string().trim().regex(/^[A-Z][A-Z0-9_-]{1,63}$/),
  urls: z.array(z.string().trim().min(4).max(1024)).min(1).max(50),
}).strict();

/**
 * GET /api/admin/tenantOperations/capacity
 * MT-P1-08 SNI 容量水位（70% 预警 / 80% 准备分片 / 90% 阻断）。
 */
router.get("/capacity", async (req, res) => {
  const clusters = await listIngressCapacity(db as any);
  return res.status(200).send(success({ clusters }));
});

/**
 * POST /api/admin/tenantOperations/capacity/refresh
 * 刷新入口集群用量缓存（定时任务或手动触发）。
 */
router.post("/capacity/refresh", async (req, res) => {
  const result = await refreshIngressClusterUsage(db as any);
  const clusters = await listIngressCapacity(db as any);
  await writeAuditLog(req, {
    action: "admin.tenant_operations.capacity.refresh",
    resourceType: "ingress_cluster",
    resourceId: null,
    required: true,
    metadata: { clusters: result.clusters },
  });
  return res.status(200).send(success({ refreshed: result.clusters, clusters }));
});

/**
 * GET /api/admin/tenantOperations/drift
 * MT-P1-09 期望版本 vs 观测版本漂移报告。
 */
router.get("/drift", async (req, res) => {
  const report = await domainDriftReport(db as any);
  return res.status(200).send(success(report));
});

/**
 * POST /api/admin/tenantOperations/drift/reconcile
 * MT-P1-09 受控漂移修复：同步观测版本到期望版本并记录操作。
 */
router.post("/drift/reconcile", async (req, res) => {
  const parsed = reconcileSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const result = await reconcileDomainDrift({ domainId: parsed.data.domainId, operatorUserId });
    await writeAuditLog(req, {
      action: "admin.tenant_operations.drift.reconcile",
      resourceType: "tenant_domain",
      resourceId: parsed.data.domainId,
      required: true,
      metadata: {
        reconciled: result.reconciled,
        previousObservedRevision: result.previousObservedRevision,
        observedRevision: result.observedRevision,
        pendingCloudSteps: result.pendingCloudSteps,
      },
    });
    return res.status(200).send(success(result));
  } catch (err) {
    if (err instanceof TenantCapacityError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    throw err;
  }
});

/**
 * GET /api/admin/tenantOperations/certificate-alerts
 * MT-P1-06 证书到期告警扫描（45/30/14/7/3/1 天窗口 + 告警联系人）。
 */
router.get("/certificate-alerts", async (req, res) => {
  const scan = await certificateExpiryAlertScan(db as any);
  return res.status(200).send(success(scan));
});

/**
 * POST /api/admin/tenantOperations/validate-callbacks
 * MT-P1-05 校验回调 URL 归属（HTTPS + 租户已激活域名）。
 */
router.post("/validate-callbacks", async (req, res) => {
  const parsed = callbackSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const result = await validateTenantCallbackUrls({
    tenantId: parsed.data.tenantId,
    urls: parsed.data.urls,
    database: db as any,
  });
  return res.status(200).send(success(result));
});

/**
 * GET /api/admin/tenantOperations/media-cors
 * MT-P1-07 媒体用途域名的 CORS 允许源清单（禁止 * + credentials）。
 */
router.get("/media-cors", async (req, res) => {
  const result = await mediaCorsAllowedOrigins(db as any);
  return res.status(200).send(success(result));
});

/**
 * GET /api/admin/tenantOperations/mail-dns-guidance?hostname=...
 * MT-P1-06 发件域名 SPF/DKIM/DMARC DNS 记录指引。
 */
router.get("/mail-dns-guidance", async (req, res) => {
  const hostname = String(req.query.hostname || "").trim();
  if (!hostname) return res.status(400).send(error("hostname 必填"));
  try {
    const guidance = await mailDnsGuidance({ hostname, database: db as any });
    return res.status(200).send(success(guidance));
  } catch (err) {
    if (err instanceof TenantCapacityError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    throw err;
  }
});

export default router;
