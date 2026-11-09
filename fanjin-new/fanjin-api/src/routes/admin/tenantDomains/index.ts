import express from "express";
import { z } from "zod";

import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";
import {
  TenantDomainError,
  createTenantDomain,
  listDomainOperations,
  listTenantDomains,
} from "@/lib/tenantDomain";

const router = express.Router();
router.use(requirePlatformAdmin);

const createSchema = z.object({
  tenantId: z.string().trim().regex(/^[A-Z][A-Z0-9_-]{1,63}$/),
  hostname: z.string().trim().min(3).max(253),
  purpose: z.enum(["web_api", "auth", "callback", "media"]).optional(),
  isPrimary: z.boolean().optional(),
  icpState: z.enum(["not_required", "pending", "verified", "rejected", "unknown"]).optional(),
}).strict();

/**
 * GET /api/admin/tenantDomains?tenantId=...&state=...
 * 域名列表（含操作记录摘要）。
 */
router.get("/", async (req, res) => {
  const tenantId = String(req.query.tenantId || "").trim() || undefined;
  const lifecycleState = String(req.query.state || "").trim() || undefined;
  const domains = await listTenantDomains(db as any, { tenantId, lifecycleState });
  const operations = await listDomainOperations(db as any, tenantId ? { tenantId } : {});
  return res.status(200).send(success({ items: domains, recentOperations: operations.slice(0, 20) }));
});

/**
 * POST /api/admin/tenantDomains
 * 登记域名（进入 ownership_pending，需完成 TXT 验证）。
 */
router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const domain = await createTenantDomain({ ...parsed.data, operatorUserId });
    await writeAuditLog(req, {
      action: "admin.tenant_domain.create",
      resourceType: "tenant_domain",
      resourceId: domain.id,
      required: true,
      metadata: { tenantId: domain.tenantId, hostname: domain.hostname, purpose: domain.purpose },
    });
    return res.status(200).send(success(domain));
  } catch (err) {
    if (err instanceof TenantDomainError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    throw err;
  }
});

export default router;
