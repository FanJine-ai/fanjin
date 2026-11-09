import express from "express";
import { z } from "zod";

import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";
import { listCommercialTenants } from "@/lib/commercialTenant";
import { productionTenantDomainOrchestrator } from "@/lib/tenantDomainProductionOrchestrator";
import {
  TenantDirectoryError,
  activateTenantDirectoryRecord,
  archiveTenantDirectoryRecord,
  createTenantDirectoryRecord,
  importTenantDirectoryFromEnv,
  listTenantDirectory,
  readTenantBrandConfig,
  resumeTenantDirectoryRecord,
  suspendTenantDirectoryRecord,
  tenantDirectoryMode,
  updateTenantBrandConfig,
  updateTenantDirectoryRecord,
} from "@/lib/tenantDirectory";

const router = express.Router();
router.use(requirePlatformAdmin);

const createSchema = z.object({
  tenantId: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]{1,63}$/),
  name: z.string().trim().min(1).max(128),
  operatorName: z.string().trim().min(1).max(256),
  rechargeEnabled: z.boolean().optional(),
  settlementRequired: z.boolean().optional(),
  wholesaleRatePpm: z.number().int().min(0).max(1_000_000).optional(),
}).strict();

// R8：通用更新不再接受 status —— 生命周期只能走专用命令。
const updateSchema = z.object({
  tenantId: z.string().trim().regex(/^[A-Z][A-Z0-9_-]{1,63}$/),
  expectedRevision: z.number().int().min(1),
  name: z.string().trim().min(1).max(128).optional(),
  operatorName: z.string().trim().min(1).max(256).optional(),
  rechargeEnabled: z.boolean().optional(),
  settlementRequired: z.boolean().optional(),
  wholesaleRatePpm: z.number().int().min(0).max(1_000_000).optional(),
}).strict().refine((value) => Object.keys(value).length > 2, {
  message: "至少提交一项要修改的字段",
});

const lifecycleSchema = z.object({
  tenantId: z.string().trim().regex(/^[A-Z][A-Z0-9_-]{1,63}$/),
  expectedRevision: z.number().int().min(1),
  reason: z.string().trim().min(5).max(500),
}).strict();

const brandSchema = z.object({
  tenantId: z.string().trim().regex(/^[A-Z][A-Z0-9_-]{1,63}$/),
  expectedRevision: z.number().int().min(1),
  theme: z.string().trim().max(64).nullable().optional(),
  logoUrl: z.string().trim().max(512).nullable().optional(),
  customerServiceEmail: z.string().trim().max(254).nullable().optional(),
  customerServiceUrl: z.string().trim().max(512).nullable().optional(),
  agreementVersion: z.string().trim().max(64).nullable().optional(),
  alertContacts: z.array(z.string().trim().min(3).max(254)).max(10).optional(),
}).strict().refine((value) => Object.keys(value).length > 2, {
  message: "至少提交一项要修改的品牌字段",
});

/**
 * GET /api/admin/tenantDirectory
 * 数据库租户目录 + 环境变量视图（双读对账）。
 */
router.get("/", async (req, res) => {
  const [directory, envTenants] = await Promise.all([
    listTenantDirectory(db as any),
    Promise.resolve(listCommercialTenants()),
  ]);
  const envIds = new Set(envTenants.map((tenant) => tenant.id));
  const dbIds = new Set(directory.map((tenant) => tenant.id));
  return res.status(200).send(success({
    mode: tenantDirectoryMode(),
    items: directory,
    envView: envTenants.map((tenant) => ({ id: tenant.id, name: tenant.name, hosts: tenant.hosts })),
    diff: {
      dbOnly: [...dbIds].filter((id) => !envIds.has(id)),
      envOnly: [...envIds].filter((id) => !dbIds.has(id)),
    },
  }));
});

/**
 * POST /api/admin/tenantDirectory
 * 创建商业租户（草稿）。
 */
router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const record = await createTenantDirectoryRecord({ ...parsed.data, operatorUserId });
    await writeAuditLog(req, {
      action: "admin.tenant_directory.create",
      resourceType: "commercial_tenant_directory",
      resourceId: record.id,
      required: true,
      metadata: { tenantId: record.id, name: record.name, operatorName: record.operatorName },
    });
    return res.status(200).send(success(record));
  } catch (err) {
    if (err instanceof TenantDirectoryError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    throw err;
  }
});

/**
 * POST /api/admin/tenantDirectory/update
 * 更新商业租户基础字段（乐观锁 + 审计）。
 */
router.post("/update", async (req, res) => {
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "status")) {
    return res.status(422).send(error(
      "生命周期状态不允许通过通用更新修改，请使用专用命令（activate/suspend/resume/archive）",
      { code: "TENANT_LIFECYCLE_FIELD_FORBIDDEN" },
    ));
  }
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const { tenantId, expectedRevision, ...patch } = parsed.data;
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const record = await updateTenantDirectoryRecord({
      tenantId,
      expectedRevision,
      ...patch,
      operatorUserId,
    });
    await writeAuditLog(req, {
      action: "admin.tenant_directory.update",
      resourceType: "commercial_tenant_directory",
      resourceId: record.id,
      required: true,
      metadata: { tenantId: record.id, changedFields: Object.keys(patch), configRevision: record.configRevision },
    });
    return res.status(200).send(success(record));
  } catch (err) {
    if (err instanceof TenantDirectoryError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    throw err;
  }
});

/**
 * POST /api/admin/tenantDirectory/import
 * 从环境变量导入租户目录（幂等，返回差异报告）。
 */
router.post("/import", async (req, res) => {
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  const report = await importTenantDirectoryFromEnv(db as any, { operatorUserId });
  await writeAuditLog(req, {
    action: "admin.tenant_directory.import",
    resourceType: "commercial_tenant_directory",
    resourceId: null,
    required: true,
    metadata: report,
  });
  return res.status(200).send(success(report));
});

/**
 * POST /api/admin/tenantDirectory/activate
 * R8 专用激活命令：draft → active（域名/入口预检 + 乐观锁 + 审计）。
 */
router.post("/activate", async (req, res) => {
  const parsed = lifecycleSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const tenant = await activateTenantDirectoryRecord({ ...parsed.data, operatorUserId });
    await writeAuditLog(req, {
      action: "admin.tenant_directory.activate",
      resourceType: "commercial_tenant_directory",
      resourceId: parsed.data.tenantId,
      required: true,
      metadata: { reason: parsed.data.reason, configRevision: tenant.configRevision },
    });
    return res.status(200).send(success(tenant));
  } catch (err) {
    return directoryErrorResponse(res, err);
  }
});

/**
 * POST /api/admin/tenantDirectory/suspend
 * MT-P1-01 暂停租户：关闭充值并联动暂停全部 active 域名入口。
 */
router.post("/suspend", async (req, res) => {
  const parsed = lifecycleSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const result = await suspendTenantDirectoryRecord({
      ...parsed.data,
      operatorUserId,
      orchestrator: productionTenantDomainOrchestrator(),
    });
    await writeAuditLog(req, {
      action: "admin.tenant_directory.suspend",
      resourceType: "commercial_tenant_directory",
      resourceId: parsed.data.tenantId,
      required: true,
      metadata: {
        reason: parsed.data.reason,
        domainsSuspended: result.domainsSuspended,
        operationId: result.operationId,
        configRevision: result.tenant.configRevision,
      },
    });
    return res.status(200).send(success(result));
  } catch (err) {
    return directoryErrorResponse(res, err);
  }
});

/**
 * POST /api/admin/tenantDirectory/resume
 * MT-P1-01 恢复已暂停租户。
 */
router.post("/resume", async (req, res) => {
  const parsed = lifecycleSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const tenant = await resumeTenantDirectoryRecord({ ...parsed.data, operatorUserId });
    await writeAuditLog(req, {
      action: "admin.tenant_directory.resume",
      resourceType: "commercial_tenant_directory",
      resourceId: parsed.data.tenantId,
      required: true,
      metadata: { reason: parsed.data.reason, configRevision: tenant.configRevision },
    });
    return res.status(200).send(success(tenant));
  } catch (err) {
    return directoryErrorResponse(res, err);
  }
});

/**
 * POST /api/admin/tenantDirectory/archive
 * MT-P1-10 退租归档：依赖检查（域名/账期/未消费批次）通过后归档；
 * 全局用户数据永不删除。
 */
router.post("/archive", async (req, res) => {
  const parsed = lifecycleSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const result = await archiveTenantDirectoryRecord({
      ...parsed.data,
      operatorUserId,
      audit: async (auditInput, trx) => {
        await writeAuditLog(req, {
          action: "admin.tenant_directory.archive",
          resourceType: "commercial_tenant_directory",
          resourceId: parsed.data.tenantId,
          required: true,
          metadata: {
            reason: parsed.data.reason,
            blockers: auditInput.blockers,
            archived: auditInput.archived,
          },
        }, trx);
      },
    });
    return res.status(200).send(success(result));
  } catch (err) {
    return directoryErrorResponse(res, err);
  }
});

/**
 * GET /api/admin/tenantDirectory/brand?tenantId=...
 * MT-P1-04/06 读取品牌与告警联系人配置。
 */
router.get("/brand", async (req, res) => {
  const tenantId = String(req.query.tenantId || "").trim();
  if (!tenantId) return res.status(400).send(error("tenantId 必填"));
  try {
    const brand = await readTenantBrandConfig(db as any, tenantId);
    return res.status(200).send(success({ tenantId, brand }));
  } catch (err) {
    return directoryErrorResponse(res, err);
  }
});

/**
 * POST /api/admin/tenantDirectory/brand
 * MT-P1-04/06 更新品牌与告警联系人（乐观锁 + 邮箱校验 + 审计）。
 */
router.post("/brand", async (req, res) => {
  const parsed = brandSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const { tenantId, expectedRevision, ...patch } = parsed.data;
  const operatorUserId = Number((req as any).auth?.user?.id || 0) || null;
  try {
    const result = await updateTenantBrandConfig({ tenantId, expectedRevision, ...patch, operatorUserId });
    await writeAuditLog(req, {
      action: "admin.tenant_directory.brand.update",
      resourceType: "commercial_tenant_directory",
      resourceId: tenantId,
      required: true,
      metadata: {
        changedFields: Object.keys(patch),
        configRevision: result.tenant.configRevision,
      },
    });
    return res.status(200).send(success(result));
  } catch (err) {
    return directoryErrorResponse(res, err);
  }
});

function directoryErrorResponse(res: express.Response, err: unknown) {
  if (err instanceof TenantDirectoryError) {
    return res.status(err.status).send(error(err.message, { code: err.code, ...(err.details ?? {}) }));
  }
  const message = String((err as Error)?.message || "");
  if (message.startsWith("AUDIT_REQUIRED_WRITE_FAILED")) {
    return res.status(503).send(error("审计服务不可用，操作已阻止", { code: "FJADMIN_AUDIT_UNAVAILABLE" }));
  }
  throw err;
}

export default router;
