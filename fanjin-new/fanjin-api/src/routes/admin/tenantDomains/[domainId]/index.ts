import express from "express";
import { z } from "zod";

import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";
import {
  TenantDomainError,
  checkDomainVerification,
  preflightTenantDomain,
  softDeleteTenantDomain,
  startDomainVerification,
  tenantDomainById,
  updateDomainIcpState,
} from "@/lib/tenantDomain";
import {
  abortTenantDomainActivation,
  publishTenantDomain,
  restoreTenantDomain,
  suspendTenantDomain,
} from "@/lib/tenantDomainOrchestration";
import { productionTenantDomainOrchestrator } from "@/lib/tenantDomainProductionOrchestrator";

const router = express.Router({ mergeParams: true });
router.use(requirePlatformAdmin);

const domainIdParam = z.string().trim().min(1);

const icpSchema = z.object({
  icpState: z.enum(["not_required", "pending", "verified", "rejected", "unknown"]),
}).strict();

function domainIdFromParams(req: express.Request): string {
  return String((req.params as Record<string, string>).domainId || "");
}

function domainErrorResponse(res: express.Response, err: unknown) {
  if (err instanceof TenantDomainError) {
    return res.status(err.status).send(error(err.message, { code: err.code }));
  }
  const message = String((err as Error)?.message || "");
  if (message.startsWith("AUDIT_REQUIRED_WRITE_FAILED")) {
    return res.status(503).send(error("审计服务不可用，操作已阻止", { code: "FJADMIN_AUDIT_UNAVAILABLE" }));
  }
  throw err;
}

/**
 * GET /api/admin/tenantDomains/:domainId
 * 域名详情（含最近验证记录）。
 */
router.get("/", async (req, res) => {
  const parsed = domainIdParam.safeParse(domainIdFromParams(req));
  if (!parsed.success) return res.status(400).send(error("域名 ID 无效"));
  try {
    const domain = await tenantDomainById(db as any, parsed.data);
    const verifications = await db("o_domain_verification")
      .where({ domainId: domain.id })
      .orderBy("createdAt", "desc")
      .limit(10)
      .select("id", "recordName", "recordType", "valueHint", "state", "expiresAt", "attemptCount", "lastAttemptAt", "createdAt");
    return res.status(200).send(success({ domain, verifications }));
  } catch (err) {
    return domainErrorResponse(res, err);
  }
});

/**
 * POST /api/admin/tenantDomains/:domainId/verification
 * 生成 TXT 验证令牌（明文令牌仅本次响应显示一次）。
 */
router.post("/verification", async (req, res) => {
  const parsed = domainIdParam.safeParse(domainIdFromParams(req));
  if (!parsed.success) return res.status(400).send(error("域名 ID 无效"));
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const result = await startDomainVerification({ domainId: parsed.data, operatorUserId });
    await writeAuditLog(req, {
      action: "admin.tenant_domain.verification.start",
      resourceType: "tenant_domain",
      resourceId: parsed.data,
      required: true,
      metadata: { hostname: result.domain.hostname, recordName: result.recordName },
    });
    return res.status(200).send(success({
      recordName: result.recordName,
      recordType: result.recordType,
      token: result.token,
      valueHint: result.valueHint,
      expiresAt: result.expiresAt,
      domain: result.domain,
    }));
  } catch (err) {
    return domainErrorResponse(res, err);
  }
});

/**
 * POST /api/admin/tenantDomains/:domainId/verification/check
 * 检查 TXT 记录并推进所有权状态。
 */
router.post("/verification/check", async (req, res) => {
  const parsed = domainIdParam.safeParse(domainIdFromParams(req));
  if (!parsed.success) return res.status(400).send(error("域名 ID 无效"));
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const outcome = await checkDomainVerification({ domainId: parsed.data, operatorUserId });
    await writeAuditLog(req, {
      action: "admin.tenant_domain.verification.check",
      resourceType: "tenant_domain",
      resourceId: parsed.data,
      required: true,
      metadata: { hostname: outcome.domain.hostname, state: outcome.state, reason: outcome.reason },
    });
    return res.status(200).send(success(outcome));
  } catch (err) {
    return domainErrorResponse(res, err);
  }
});

/**
 * POST /api/admin/tenantDomains/:domainId/preflight
 * 发布预检：所有权/备案门禁/证书覆盖/冲突检查。
 */
router.post("/preflight", async (req, res) => {
  const parsed = domainIdParam.safeParse(domainIdFromParams(req));
  if (!parsed.success) return res.status(400).send(error("域名 ID 无效"));
  try {
    const result = await preflightTenantDomain({ domainId: parsed.data });
    return res.status(200).send(success(result));
  } catch (err) {
    return domainErrorResponse(res, err);
  }
});

/**
 * POST /api/admin/tenantDomains/:domainId/publish
 * 发布域名：ready → activating（+持久化 operation）。
 * cloud enabled 时执行完整观察证据编排后才写 active；cloud disabled 时保持
 * activating 并返回 pending operation，绝不假报 active。
 */
router.post("/publish", async (req, res) => {
  const parsed = domainIdParam.safeParse(domainIdFromParams(req));
  if (!parsed.success) return res.status(400).send(error("域名 ID 无效"));
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const result = await publishTenantDomain({
      domainId: parsed.data,
      operatorUserId,
      orchestrator: productionTenantDomainOrchestrator(),
    });
    await writeAuditLog(req, {
      action: "admin.tenant_domain.publish",
      resourceType: "tenant_domain",
      resourceId: parsed.data,
      required: true,
      metadata: {
        hostname: result.domain.hostname,
        tenantId: result.domain.tenantId,
        operationId: result.operationId,
        status: result.status,
        pendingCloudSteps: result.pendingCloudSteps,
        evidence: result.evidence,
      },
    });
    return res.status(200).send(success(result));
  } catch (err) {
    return domainErrorResponse(res, err);
  }
});

/**
 * POST /api/admin/tenantDomains/:domainId/abort
 * 中止激活中的域名发布（云端已绑定时执行补偿）。
 */
router.post("/abort", async (req, res) => {
  const parsed = domainIdParam.safeParse(domainIdFromParams(req));
  if (!parsed.success) return res.status(400).send(error("域名 ID 无效"));
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const domain = await abortTenantDomainActivation({
      domainId: parsed.data,
      operatorUserId,
      orchestrator: productionTenantDomainOrchestrator(),
    });
    await writeAuditLog(req, {
      action: "admin.tenant_domain.abort",
      resourceType: "tenant_domain",
      resourceId: parsed.data,
      required: true,
      metadata: { hostname: domain.hostname, tenantId: domain.tenantId, lifecycleState: domain.lifecycleState },
    });
    return res.status(200).send(success(domain));
  } catch (err) {
    return domainErrorResponse(res, err);
  }
});

/**
 * POST /api/admin/tenantDomains/:domainId/suspend
 * 暂停域名入口。
 */
router.post("/suspend", async (req, res) => {
  const parsed = domainIdParam.safeParse(domainIdFromParams(req));
  if (!parsed.success) return res.status(400).send(error("域名 ID 无效"));
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const domain = await suspendTenantDomain({
      domainId: parsed.data,
      operatorUserId,
      orchestrator: productionTenantDomainOrchestrator(),
    });
    await writeAuditLog(req, {
      action: "admin.tenant_domain.suspend",
      resourceType: "tenant_domain",
      resourceId: parsed.data,
      required: true,
      metadata: { hostname: domain.hostname, tenantId: domain.tenantId },
    });
    return res.status(200).send(success(domain));
  } catch (err) {
    return domainErrorResponse(res, err);
  }
});

/**
 * POST /api/admin/tenantDomains/:domainId/restore
 * 恢复已暂停域名（重新预检；cloud enabled 时走完整激活编排）。
 */
router.post("/restore", async (req, res) => {
  const parsed = domainIdParam.safeParse(domainIdFromParams(req));
  if (!parsed.success) return res.status(400).send(error("域名 ID 无效"));
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const result = await restoreTenantDomain({
      domainId: parsed.data,
      operatorUserId,
      orchestrator: productionTenantDomainOrchestrator(),
    });
    await writeAuditLog(req, {
      action: "admin.tenant_domain.restore",
      resourceType: "tenant_domain",
      resourceId: parsed.data,
      required: true,
      metadata: {
        hostname: result.domain.hostname,
        tenantId: result.domain.tenantId,
        status: result.status,
        operationId: result.operationId,
        pendingCloudSteps: result.pendingCloudSteps,
      },
    });
    return res.status(200).send(success(result));
  } catch (err) {
    return domainErrorResponse(res, err);
  }
});

/**
 * POST /api/admin/tenantDomains/:domainId/icp
 * 更新备案门禁状态（合规人员录入）。
 */
router.post("/icp", async (req, res) => {
  const parsedId = domainIdParam.safeParse(domainIdFromParams(req));
  const parsedBody = icpSchema.safeParse(req.body ?? {});
  if (!parsedId.success || !parsedBody.success) {
    return res.status(400).send({ message: "参数错误" });
  }
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const domain = await updateDomainIcpState({
      domainId: parsedId.data,
      icpState: parsedBody.data.icpState,
      operatorUserId,
    });
    await writeAuditLog(req, {
      action: "admin.tenant_domain.icp.update",
      resourceType: "tenant_domain",
      resourceId: parsedId.data,
      required: true,
      metadata: { hostname: domain.hostname, icpState: domain.icpState },
    });
    return res.status(200).send(success(domain));
  } catch (err) {
    return domainErrorResponse(res, err);
  }
});

/**
 * DELETE /api/admin/tenantDomains/:domainId
 * 软删除（仅非 active 域名）。
 */
router.delete("/", async (req, res) => {
  const parsed = domainIdParam.safeParse(domainIdFromParams(req));
  if (!parsed.success) return res.status(400).send(error("域名 ID 无效"));
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const domain = await softDeleteTenantDomain({ domainId: parsed.data, operatorUserId });
    await writeAuditLog(req, {
      action: "admin.tenant_domain.delete",
      resourceType: "tenant_domain",
      resourceId: parsed.data,
      required: true,
      metadata: { hostname: domain.hostname, tenantId: domain.tenantId, deletedAt: domain.deletedAt },
    });
    return res.status(200).send(success(domain));
  } catch (err) {
    return domainErrorResponse(res, err);
  }
});

export default router;
