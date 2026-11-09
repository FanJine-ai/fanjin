import express from "express";
import { z } from "zod";

import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";
import { listRuntimeCommercialTenants, CommercialTenantError } from "@/lib/commercialTenant";
import {
  TenantAttributionError,
  changeUserOwnerTenant,
  listUserAttributionHistory,
  readUserAttribution,
} from "@/lib/tenantAttribution";

const router = express.Router({ mergeParams: true });
router.use(requirePlatformAdmin);

const userIdParam = z.string().trim().regex(/^\d+$/, "用户 ID 必须是数字");

function userIdFromParams(req: express.Request): string {
  return String((req.params as Record<string, string>).userId || "");
}

const changeOwnerSchema = z.object({
  ownerTenantId: z.string().trim().regex(/^[A-Z][A-Z0-9_-]{1,63}$/, "目标所属租户 ID 无效"),
  expectedRevision: z.number().int().min(0),
  reason: z.string().trim().min(5).max(500),
}).strict();

async function attributionTenantNames() {
  const tenants = await listRuntimeCommercialTenants(db);
  return new Map(tenants.map((tenant) => [tenant.id, tenant.name]));
}

/**
 * GET /api/admin/users/:userId/commercial-attribution
 * 查看用户注册租户、注册入口、当前所属租户与修改审计信息。
 */
router.get("/", async (req, res) => {
  const parsed = userIdParam.safeParse(userIdFromParams(req));
  if (!parsed.success) return res.status(400).send(error("用户 ID 无效"));
  const userId = Number(parsed.data);
  const user = await db("o_user").where({ id: userId }).select("id", "name", "email", "status").first();
  if (!user) return res.status(404).send(error("用户不存在"));
  const attribution = await readUserAttribution(db as any, userId);
  const history = await listUserAttributionHistory(db as any, userId);
  const names = await attributionTenantNames();
  return res.status(200).send(success({
    userId,
    userName: user.name,
    attribution,
    registeredTenantName: names.get(attribution.registeredTenantId) || null,
    ownerTenantName: names.get(attribution.ownerTenantId) || null,
    history: history.map((item) => ({
      ...item,
      fromTenantName: names.get(item.fromTenantId) || null,
      toTenantName: names.get(item.toTenantId) || null,
    })),
  }));
});

/**
 * POST /api/admin/users/:userId/commercial-attribution/change-owner
 * 平台管理员修改用户当前所属租户（step-up MFA + 乐观锁 + 必填原因 + 审计）。
 * 明确不迁移余额、工作区、项目、素材或历史账单。
 */
router.post("/change-owner", async (req, res) => {
  const parsedUser = userIdParam.safeParse(userIdFromParams(req));
  const parsedBody = changeOwnerSchema.safeParse(req.body ?? {});
  if (!parsedUser.success || !parsedBody.success) {
    return res.status(400).send({
      message: "参数错误",
      errors: [...(parsedUser.success ? [] : parsedUser.error.issues), ...(parsedBody.success ? [] : parsedBody.error.issues)],
    });
  }
  const userId = Number(parsedUser.data);
  const operatorUserId = Number((req as any).auth?.user?.id || 0);
  try {
    const result = await changeUserOwnerTenant({
      userId,
      ownerTenantId: parsedBody.data.ownerTenantId,
      expectedRevision: parsedBody.data.expectedRevision,
      reason: parsedBody.data.reason,
      operatorUserId,
      audit: async (auditInput, trx) => {
        await writeAuditLog(req, {
          action: "admin.user.commercial_attribution.change_owner",
          resourceType: "user_commercial_attribution",
          resourceId: String(userId),
          required: true,
          metadata: {
            fromTenantId: auditInput.fromTenantId,
            toTenantId: auditInput.toTenantId,
            revision: auditInput.revision,
            reason: auditInput.reason,
            note: "仅调整运营/对账归属，不迁移余额、工作区、项目、素材或历史账单",
          },
        }, trx);
      },
    });
    const names = await attributionTenantNames();
    return res.status(200).send(success({
      userId: result.userId,
      previousTenantId: result.previousTenantId,
      ownerTenantId: result.ownerTenantId,
      ownerTenantRevision: result.ownerTenantRevision,
      ownerTenantName: names.get(result.ownerTenantId) || null,
    }));
  } catch (err) {
    if (err instanceof TenantAttributionError || err instanceof CommercialTenantError) {
      const typed = err as { status?: number; code?: string; message?: string };
      return res.status(typed.status || 400).send(error(typed.message || "租户操作失败", { code: typed.code }));
    }
    const message = String((err as Error)?.message || "");
    if (message.startsWith("AUDIT_REQUIRED_WRITE_FAILED")) {
      return res.status(503).send(error("审计服务不可用，已阻止修改", { code: "FJADMIN_AUDIT_UNAVAILABLE" }));
    }
    throw err;
  }
});

/**
 * GET /api/admin/users/:userId/commercial-attribution/history
 * 归属修改历史（不可变）。
 */
router.get("/history", async (req, res) => {
  const parsed = userIdParam.safeParse(userIdFromParams(req));
  if (!parsed.success) return res.status(400).send(error("用户 ID 无效"));
  const userId = Number(parsed.data);
  const user = await db("o_user").where({ id: userId }).select("id").first();
  if (!user) return res.status(404).send(error("用户不存在"));
  const history = await listUserAttributionHistory(db as any, userId);
  const names = await attributionTenantNames();
  return res.status(200).send(success({
    userId,
    items: history.map((item) => ({
      ...item,
      fromTenantName: names.get(item.fromTenantId) || null,
      toTenantName: names.get(item.toTenantId) || null,
    })),
  }));
});

export default router;
