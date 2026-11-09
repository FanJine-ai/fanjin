import express from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import { hashPassword } from "@/lib/auth";
import { error, success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";
import { insertAndReturnId } from "@/lib/dbDialect";
import { DEFAULT_PASSWORD_POLICY, validatePasswordAgainstPolicy } from "@/lib/accountSecurity";
import { ensureWorkspaceBillingAccountRecord } from "@/lib/workspaceBillingAccount";
import { PricingGroupError, requireActivePricingGroup } from "@/lib/pricingGroups";
import { DEFAULT_COMMERCIAL_TENANT_ID } from "@/lib/commercialTenant";

const router = express.Router();
router.use(requirePlatformAdmin);
const platformAdminRoles = new Set(["root", "admin", "super_admin"]);

const bodySchema = z.object({
  name: z.string().trim().min(2).max(64),
  email: z.string().trim().email().optional().nullable(),
  displayName: z.string().trim().max(64).optional().nullable(),
  password: z.string().min(8).max(128),
  workspaceName: z.string().trim().max(80).optional().nullable(),
  accountType: z.enum(["personal", "enterprise"]).optional().default("personal"),
  commercialGroup: z.string().trim().min(1).max(48).optional().default("default"),
  pricingGroup: z.string().trim().max(48).optional().nullable(),
  rechargeDiscountBps: z.number().int().min(1).max(10000).optional().default(10000),
  billingMode: z.enum(["prepaid", "postpaid", "hybrid"]).optional().default("prepaid"),
  settlementType: z.enum(["online", "offline", "contract"]).optional().default("online"),
  notes: z.string().trim().max(500).optional().nullable(),
  registeredTenantId: z.string().trim().regex(/^[A-Z][A-Z0-9_-]{1,63}$/).optional().default(DEFAULT_COMMERCIAL_TENANT_ID),
}).strict();

function slugBase(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36) || "workspace"
  );
}

async function uniqueWorkspaceSlug(trx: any, input: string): Promise<string> {
  const base = slugBase(input);
  let candidate = base;
  let index = 1;
  while (await trx("o_workspace").where({ slug: candidate }).first()) {
    index += 1;
    candidate = `${base}-${index}`;
  }
  return candidate;
}

function isUniqueViolation(err: unknown): boolean {
  const candidate = err as { code?: unknown; message?: unknown } | null;
  const code = String(candidate?.code || "");
  const message = String(candidate?.message || "");
  return code === "23505"
    || code === "SQLITE_CONSTRAINT"
    || code === "SQLITE_CONSTRAINT_UNIQUE"
    || /unique constraint|unique failed|duplicate key/i.test(message);
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const data = parsed.data;
  const passwordError = validatePasswordAgainstPolicy(data.password, DEFAULT_PASSWORD_POLICY);
  if (passwordError) return res.status(400).send(error(passwordError));
  const now = Date.now();
  const workspaceId = uuid();
  const workspaceName = data.workspaceName || `${data.displayName || data.name} 的工作区`;
  const billingAccountId = uuid();
  const actorId = Number((req as any).auth?.user?.id || 0);
  let userId = 0;
  const passwordHash = await hashPassword(data.password);

  try {
    await db.transaction(async (trx) => {
      const actor = await trx("o_user").where({ id: actorId }).forUpdate().first();
      if (
        !actor
        || actor.status !== "active"
        || !platformAdminRoles.has(String(actor.role || "").toLowerCase())
      ) {
        throw new Error("PLATFORM_ADMIN_AUTHORITY_STALE");
      }
      const existing = await trx("o_user")
        .where({ name: data.name })
        .modify((query) => {
          if (data.email) query.orWhere("email", data.email);
        })
        .forUpdate()
        .first();
      if (existing) throw new Error("ADMIN_USER_ALREADY_EXISTS");
      const workspaceSlug = await uniqueWorkspaceSlug(trx, workspaceName);
      const pricingGroup = await requireActivePricingGroup(trx, data.pricingGroup);
      userId = await insertAndReturnId(trx, "o_user", {
        name: data.name,
        email: data.email || null,
        displayName: data.displayName || data.name,
        password: passwordHash,
        passwordChangedAt: now,
        role: "owner",
        status: "active",
        currentWorkspaceId: workspaceId,
        defaultWorkspaceId: workspaceId,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      });
      if (!userId) throw new Error("ADMIN_USER_CREATE_FAILED");
      await trx("o_workspace").insert({
        id: workspaceId,
        name: workspaceName,
        slug: workspaceSlug,
        ownerUserId: userId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await trx("o_workspace_member").insert({
        id: uuid(),
        workspaceId,
        userId,
        role: "owner",
        status: "active",
        permissions: null,
        createdAt: now,
        updatedAt: now,
      });
      await trx("o_billing_account").insert({
        id: billingAccountId,
        workspaceId,
        planId: null,
        currency: "GU",
        balanceMicros: 0,
        creditLimitMicros: 0,
        reservedMicros: 0,
        status: "active",
        billingMode: data.billingMode,
        createdAt: now,
        updatedAt: now,
      });
      await trx("o_user_commercial_profile").insert({
        id: String(userId),
        userId,
        accountType: data.accountType,
        commercialGroup: data.commercialGroup,
        pricingGroup,
        rechargeDiscountBps: data.rechargeDiscountBps,
        billingMode: data.billingMode,
        settlementType: data.settlementType,
        notes: data.notes || null,
        registeredTenantId: data.registeredTenantId,
        registrationHostname: null,
        registrationSource: "admin_create",
        ownerTenantId: data.registeredTenantId,
        ownerTenantRevision: 1,
        createdAt: now,
        updatedAt: now,
      });
      await writeAuditLog(req, {
        workspaceId,
        action: "admin.user.create",
        resourceType: "user",
        resourceId: userId,
        required: true,
        metadata: {
          name: data.name,
          email: data.email || null,
          accountType: data.accountType,
          commercialGroup: data.commercialGroup,
          workspaceId,
        },
      }, trx);
    });

    return res.status(200).send(
      success({
        userId,
        workspaceId,
        billingAccountId,
      }),
    );
  } catch (err: unknown) {
    if (err instanceof PricingGroupError) {
      return res.status(err.statusCode).send(error(err.message, { code: err.code }));
    }
    const message = String((err as Error)?.message || "");
    if (message === "ADMIN_USER_ALREADY_EXISTS") {
      return res.status(409).send(error("用户名或邮箱已存在"));
    }
    if (message === "PLATFORM_ADMIN_AUTHORITY_STALE") {
      return res.status(403).send(error("管理员身份已失效", {
        code: "PLATFORM_ADMIN_AUTHORITY_STALE",
      }));
    }
    // The lookup above only improves the error message; the database unique
    // indexes remain authoritative when two creates race.
    if (isUniqueViolation(err)) {
      return res.status(409).send(error("用户名、邮箱或工作区标识已存在"));
    }
    if (message === "ADMIN_USER_CREATE_FAILED") {
      return res.status(500).send(error("用户创建失败"));
    }
    if (message.startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(error("审计写入失败，用户未创建", {
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      }));
    }
    throw err;
  }
});
