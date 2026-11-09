import express from "express";
import type { Knex } from "knex";
import { z } from "zod";
import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";
import { revokeUserAccess } from "@/lib/workspaceAccess";
import { PricingGroupError, requireActivePricingGroup } from "@/lib/pricingGroups";

const router = express.Router();
router.use(requirePlatformAdmin);

const commercialSchema = z.object({
  accountType: z.enum(["personal", "enterprise"]).optional(),
  commercialGroup: z.string().trim().min(1).max(48).optional(),
  pricingGroup: z.string().trim().max(48).optional().nullable(),
  rechargeDiscountBps: z.number().int().min(1).max(10000).optional(),
  billingMode: z.enum(["prepaid", "postpaid", "hybrid"]).optional(),
  settlementType: z.enum(["online", "offline", "contract"]).optional(),
  notes: z.string().trim().max(500).optional().nullable(),
}).strict();

const bodySchema = z.object({
  userId: z.number().int().positive(),
  displayName: z.string().trim().max(64).optional().nullable(),
  email: z.string().trim().email().optional().nullable(),
  status: z.enum(["active", "disabled", "locked"]).optional(),
  role: z.enum([
    "root",
    "admin",
    "super_admin",
    "finance_viewer",
    "finance_operator",
    "finance_manager",
    "owner",
    "member",
  ]).optional(),
  commercial: commercialSchema.optional(),
}).strict();

const protectedPlatformRoles = new Set(["root", "admin", "super_admin"]);

class AdminUserUpdateError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "AdminUserUpdateError";
  }
}

async function upsertCommercialProfile(
  database: Knex | Knex.Transaction,
  userId: number,
  patch: z.infer<typeof commercialSchema>,
) {
  const now = Date.now();
  const existing = await database("o_user_commercial_profile").where({ userId }).first();
  const pricingGroup = patch.pricingGroup !== undefined
    ? await requireActivePricingGroup(database, patch.pricingGroup)
    : existing?.pricingGroup ?? null;
  const data = {
    accountType: patch.accountType || existing?.accountType || "personal",
    commercialGroup: patch.commercialGroup || existing?.commercialGroup || "default",
    pricingGroup,
    rechargeDiscountBps: patch.rechargeDiscountBps ?? existing?.rechargeDiscountBps ?? 10000,
    billingMode: patch.billingMode || existing?.billingMode || "prepaid",
    settlementType: patch.settlementType || existing?.settlementType || "online",
    notes: patch.notes ?? existing?.notes ?? null,
    updatedAt: now,
  };

  if (existing) {
    await database("o_user_commercial_profile").where({ userId }).update(data);
  } else {
    await database("o_user_commercial_profile").insert({
      id: String(userId),
      userId,
      createdAt: now,
      ...data,
    });
  }
  return data;
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const data = parsed.data;
  const actorId = Number((req as any).auth?.user?.id || 0);
  try {
    const result = await db.transaction(async (trx) => {
      // Every writer of this endpoint acquires the root rows in the same
      // deterministic order before locking its target. This serializes
      // concurrent root demotions/locks and prevents two requests from each
      // observing the other root as still active.
      const activeRoots = await trx("o_user")
        .where({ role: "root", status: "active" })
        .orderBy("id", "asc")
        .forUpdate()
        .select("id");
      const lockedUsers = await trx("o_user")
        .whereIn("id", Array.from(new Set([actorId, data.userId])).sort((left, right) => left - right))
        .orderBy("id", "asc")
        .forUpdate()
        .select("*");
      const actor = lockedUsers.find((row: any) => Number(row.id) === actorId);
      const user = lockedUsers.find((row: any) => Number(row.id) === data.userId);
      const actorRole = String(actor?.role || "").toLowerCase();
      if (
        !actor
        || actor.status !== "active"
        || !protectedPlatformRoles.has(actorRole)
      ) {
        throw new AdminUserUpdateError(
          "管理员身份已失效",
          403,
          "PLATFORM_ADMIN_AUTHORITY_STALE",
        );
      }
      if (!user) {
        throw new AdminUserUpdateError("用户不存在", 404, "USER_NOT_FOUND");
      }
      const targetRole = String(user.role || "").toLowerCase();
      if (actorRole !== "root" && targetRole === "root") {
        throw new AdminUserUpdateError(
          "只有 root 管理员可以管理 root 账号",
          403,
          "ROOT_ROLE_MANAGEMENT_RESTRICTED",
        );
      }
      if (actorRole !== "root" && protectedPlatformRoles.has(targetRole)) {
        throw new AdminUserUpdateError(
          "只有 root 管理员可以管理平台管理员账号",
          403,
          "PLATFORM_ADMIN_MANAGEMENT_RESTRICTED",
        );
      }
      if (
        actorRole !== "root"
        && data.role !== undefined
        && protectedPlatformRoles.has(data.role)
      ) {
        throw new AdminUserUpdateError(
          "只有 root 管理员可以授予平台管理员角色",
          403,
          "PLATFORM_ADMIN_ROLE_GRANT_RESTRICTED",
        );
      }

      const removesActiveRoot = (
        targetRole === "root"
        && String(user.status || "active") === "active"
        && (
          (data.role !== undefined && data.role !== "root")
          || (data.status !== undefined && data.status !== "active")
        )
      );
      if (removesActiveRoot) {
        if (activeRoots.length <= 1) {
          throw new AdminUserUpdateError(
            "至少需要保留一个启用的 root 管理员",
            409,
            "LAST_ACTIVE_ROOT_REQUIRED",
          );
        }
      }

      const changesGlobalAuthority = (
        (data.status !== undefined && data.status !== user.status)
        || (
          data.role !== undefined
          && data.role !== String(user.role || "").toLowerCase()
        )
      );
      if (changesGlobalAuthority) {
        const ownedWorkspaces = await trx("o_workspace")
          .where({ ownerUserId: data.userId })
          .orderBy("id", "asc")
          .forUpdate()
          .select("id", "status");
        if (ownedWorkspaces.length) {
          throw new AdminUserUpdateError(
            "该用户仍是工作区 owner，请先通过独立 owner transfer 流程转移所有权",
            409,
            "WORKSPACE_OWNER_TRANSFER_REQUIRED",
          );
        }
      }

      const timestamp = Date.now();
      const beforeUser = {
        displayName: user.displayName ?? null,
        email: user.email ?? null,
        status: user.status,
        role: user.role,
      };
      const userPatch: Record<string, unknown> = { updatedAt: timestamp };
      if (data.displayName !== undefined) userPatch.displayName = data.displayName || user.name || "";
      if (data.email !== undefined) userPatch.email = data.email || null;
      if (data.status !== undefined) userPatch.status = data.status;
      if (data.role !== undefined) userPatch.role = data.role;
      if (Object.keys(userPatch).length > 1) {
        await trx("o_user").where({ id: data.userId }).update(userPatch);
      }

      const authorityChanged = (
        (data.status !== undefined && data.status !== user.status)
        || (data.role !== undefined && data.role !== targetRole)
      );
      const revoked = authorityChanged
        ? await revokeUserAccess({ userId: data.userId, database: trx })
        : null;
      const commercialBefore = data.commercial
        ? await trx("o_user_commercial_profile")
            .where({ userId: data.userId })
            .select(
              "accountType",
              "commercialGroup",
              "pricingGroup",
              "rechargeDiscountBps",
              "billingMode",
              "settlementType",
              "notes",
            )
            .first()
        : null;
      const commercial = data.commercial
        ? await upsertCommercialProfile(trx, data.userId, data.commercial)
        : null;
      const afterUser = {
        displayName: userPatch.displayName ?? beforeUser.displayName,
        email: data.email !== undefined ? data.email || null : beforeUser.email,
        status: userPatch.status ?? beforeUser.status,
        role: userPatch.role ?? beforeUser.role,
      };

      await writeAuditLog(req, {
        action: "admin.user.update",
        resourceType: "user",
        resourceId: data.userId,
        required: true,
        metadata: {
          before: {
            user: beforeUser,
            commercial: commercialBefore,
          },
          after: {
            user: afterUser,
            commercial: commercial ?? commercialBefore,
          },
          revoked,
        },
      }, trx);
      return { userPatch, commercial, revoked };
    });

    return res.status(200).send(success({
      userId: data.userId,
      ...result.userPatch,
      commercial: result.commercial,
      revoked: result.revoked,
    }));
  } catch (err: unknown) {
    if (err instanceof PricingGroupError) {
      return res.status(err.statusCode).send(error(err.message, { code: err.code }));
    }
    if (err instanceof AdminUserUpdateError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    if (String((err as Error)?.message || "").startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(error("审计写入失败，用户未更新", {
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      }));
    }
    throw err;
  }
});
