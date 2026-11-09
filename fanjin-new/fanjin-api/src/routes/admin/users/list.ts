import { guMicrosPerGu } from "@/lib/billingUnits";
import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const tenantFilterSchema = z.union([
  z.literal("all"),
  z.string().trim().regex(/^[A-Z][A-Z0-9_-]{0,63}$/),
]);

const bodySchema = z.object({
  keyword: z.string().optional().default(""),
  status: z.enum(["all", "active", "disabled", "locked"]).optional().default("all"),
  accountType: z.enum(["all", "personal", "enterprise"]).optional().default("all"),
  role: z.string().optional().default("all"),
  pricingGroup: z.string().trim().max(48).optional().default("all"),
  ownerTenantId: tenantFilterSchema.optional().default("all"),
  registeredTenantId: tenantFilterSchema.optional().default("all"),
  pageNum: z.number().int().positive().optional().default(1),
  pageSize: z.number().int().positive().max(100).optional().default(20),
});

function guFromMicros(value: unknown): number {
  return Math.round((Number(value || 0) / guMicrosPerGu) * 100) / 100;
}

function yuanFromGuMicros(value: unknown): number {
  return Math.round((Number(value || 0) / 1_000_000_000) * 100) / 100;
}

function normalizeStatus(value: unknown): string {
  const status = String(value || "active");
  return status || "active";
}

function verificationStatusText(status: unknown): string {
  const value = String(status || "not_started");
  if (value === "approved") return "已认证";
  if (value === "pending") return "待审核";
  if (value === "rejected") return "已驳回";
  return "未认证";
}

async function hasTable(name: string): Promise<boolean> {
  try {
    return await db.schema.hasTable(name);
  } catch {
    return false;
  }
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const filters = parsed.data;
  const query = db("o_user")
    .select("id", "name", "email", "displayName", "role", "status", "currentWorkspaceId", "createdAt", "updatedAt", "lastLoginAt")
    .orderBy("createdAt", "desc");

  const keyword = filters.keyword.trim();
  if (keyword) {
    query.where((builder) => {
      builder
        .where("name", "like", `%${keyword}%`)
        .orWhere("email", "like", `%${keyword}%`)
        .orWhere("displayName", "like", `%${keyword}%`);
    });
  }
  if (filters.status !== "all") query.where("status", filters.status);
  if (filters.role && filters.role !== "all") query.where("role", filters.role);

  const users = await query;
  const userIds = users.map((row: any) => Number(row.id)).filter(Boolean);
  const currentWorkspaceIds = users.map((row: any) => row.currentWorkspaceId).filter(Boolean);

  const commercialRows = (await hasTable("o_user_commercial_profile")) && userIds.length ? await db("o_user_commercial_profile").whereIn("userId", userIds) : [];
  const verificationRows = (await hasTable("o_account_verification")) && userIds.length ? await db("o_account_verification").whereIn("userId", userIds) : [];
  const memberRows = userIds.length ? await db("o_workspace_member").whereIn("userId", userIds) : [];
  const ownedWorkspaceRows = userIds.length ? await db("o_workspace").whereIn("ownerUserId", userIds) : [];

  const joinedWorkspaceIds = memberRows.map((row: any) => row.workspaceId).filter(Boolean);
  const ownedWorkspaceIds = ownedWorkspaceRows.map((row: any) => row.id).filter(Boolean);
  const workspaceIds = Array.from(new Set([...currentWorkspaceIds, ...joinedWorkspaceIds, ...ownedWorkspaceIds]));
  const workspaceRows = workspaceIds.length ? await db("o_workspace").whereIn("id", workspaceIds) : [];
  const ownedMemberRows = ownedWorkspaceIds.length ? await db("o_workspace_member").whereIn("workspaceId", ownedWorkspaceIds).where("status", "active") : [];
  const billingRows = (await hasTable("o_billing_account")) && workspaceIds.length ? await db("o_billing_account").whereIn("workspaceId", workspaceIds) : [];
  const planIds = Array.from(new Set(billingRows.map((row: any) => row.planId).filter(Boolean)));
  const planRows = (await hasTable("o_billing_plan")) && planIds.length ? await db("o_billing_plan").whereIn("id", planIds) : [];

  const commercialByUser = new Map(commercialRows.map((row: any) => [Number(row.userId), row]));
  const verificationByUser = new Map<number, any[]>();
  verificationRows.forEach((row: any) => {
    const key = Number(row.userId);
    verificationByUser.set(key, [...(verificationByUser.get(key) || []), row]);
  });
  const memberByUser = new Map<number, any[]>();
  memberRows.forEach((row: any) => {
    const key = Number(row.userId);
    memberByUser.set(key, [...(memberByUser.get(key) || []), row]);
  });
  const ownedByUser = new Map<number, any[]>();
  ownedWorkspaceRows.forEach((row: any) => {
    const key = Number(row.ownerUserId);
    ownedByUser.set(key, [...(ownedByUser.get(key) || []), row]);
  });
  const workspaceById = new Map(workspaceRows.map((row: any) => [row.id, row]));
  const accountByWorkspace = new Map(billingRows.map((row: any) => [row.workspaceId, row]));
  const planById = new Map(planRows.map((row: any) => [row.id, row]));
  const ownedMemberCountByWorkspace = new Map<string, number>();
  ownedMemberRows.forEach((row: any) => {
    ownedMemberCountByWorkspace.set(row.workspaceId, (ownedMemberCountByWorkspace.get(row.workspaceId) || 0) + 1);
  });

  const enriched = users.map((user: any) => {
    const userId = Number(user.id);
    const commercial = commercialByUser.get(userId);
    const verifications = verificationByUser.get(userId) || [];
    const enterpriseVerification = verifications.find((row) => row.type === "enterprise");
    const personalVerification = verifications.find((row) => row.type === "personal");
    const accountType = commercial?.accountType || (enterpriseVerification && enterpriseVerification.status !== "not_started" ? "enterprise" : "personal");
    const activeVerification = accountType === "enterprise" ? enterpriseVerification : personalVerification;
    const currentWorkspace = workspaceById.get(user.currentWorkspaceId) || ownedByUser.get(userId)?.[0] || workspaceById.get(memberByUser.get(userId)?.[0]?.workspaceId);
    const ownedWorkspaces = ownedByUser.get(userId) || [];
    const billingAccount = currentWorkspace ? accountByWorkspace.get(currentWorkspace.id) : null;
    const plan = billingAccount?.planId ? planById.get(billingAccount.planId) : null;
    const memberCount = ownedWorkspaces.reduce((sum, workspace) => sum + (ownedMemberCountByWorkspace.get(workspace.id) || 0), 0);

    return {
      id: userId,
      name: user.name || "",
      email: user.email || null,
      displayName: user.displayName || user.name || "",
      role: user.role || "member",
      status: normalizeStatus(user.status),
      currentWorkspaceId: currentWorkspace?.id || user.currentWorkspaceId || null,
      currentWorkspaceName: currentWorkspace?.name || "-",
      createdAt: user.createdAt || null,
      updatedAt: user.updatedAt || null,
      lastLoginAt: user.lastLoginAt || null,
      accountType,
      verification: {
        status: activeVerification?.status || "not_started",
        statusText: verificationStatusText(activeVerification?.status),
        subjectName: activeVerification?.subjectName || activeVerification?.companyName || null,
        taxId: activeVerification?.unifiedSocialCreditCode || null,
      },
      team: {
        ownedWorkspaceCount: ownedWorkspaces.length,
        joinedWorkspaceCount: memberByUser.get(userId)?.length || 0,
        memberCount,
      },
      billing: {
        accountId: billingAccount?.id || null,
        balanceMicros: Number(billingAccount?.balanceMicros || 0),
        creditLimitMicros: Number(billingAccount?.creditLimitMicros || 0),
        reservedMicros: Number(billingAccount?.reservedMicros || 0),
        balanceGu: guFromMicros(billingAccount?.balanceMicros),
        creditLimitGu: guFromMicros(billingAccount?.creditLimitMicros),
        reservedGu: guFromMicros(billingAccount?.reservedMicros),
        balanceYuan: yuanFromGuMicros(billingAccount?.balanceMicros),
        creditLimitYuan: yuanFromGuMicros(billingAccount?.creditLimitMicros),
        reservedYuan: yuanFromGuMicros(billingAccount?.reservedMicros),
        planId: billingAccount?.planId || null,
        planName: plan?.name || null,
        billingMode: billingAccount?.billingMode || commercial?.billingMode || "prepaid",
      },
      commercial: {
        accountType,
        commercialGroup: commercial?.commercialGroup || (accountType === "enterprise" ? "enterprise" : "default"),
        pricingGroup: commercial?.pricingGroup || "",
        rechargeDiscountBps: Number(commercial?.rechargeDiscountBps ?? (accountType === "enterprise" ? 9500 : 10000)),
        billingMode: commercial?.billingMode || "prepaid",
        settlementType: commercial?.settlementType || (accountType === "enterprise" ? "offline" : "online"),
        notes: commercial?.notes || "",
      },
      attribution: {
        registeredTenantId: commercial?.registeredTenantId || null,
        registrationHostname: commercial?.registrationHostname || null,
        registrationSource: commercial?.registrationSource || null,
        ownerTenantId: commercial?.ownerTenantId || null,
        ownerTenantRevision: Number(commercial?.ownerTenantRevision || 0),
        ownerTenantChangedAt: commercial?.ownerTenantChangedAt || null,
        ownerTenantChangeReason: commercial?.ownerTenantChangeReason || null,
      },
    };
  });

  const typed = filters.accountType === "all" ? enriched : enriched.filter((row) => row.accountType === filters.accountType);
  const grouped = filters.pricingGroup === "all"
    ? typed
    : typed.filter((row) => String(row.commercial.pricingGroup || "default").toLowerCase() === filters.pricingGroup.toLowerCase());
  const byOwnerTenant = filters.ownerTenantId === "all"
    ? grouped
    : grouped.filter((row) => String(row.attribution.ownerTenantId || "").toUpperCase() === filters.ownerTenantId.toUpperCase());
  const byRegisteredTenant = filters.registeredTenantId === "all"
    ? byOwnerTenant
    : byOwnerTenant.filter((row) => String(row.attribution.registeredTenantId || "").toUpperCase() === filters.registeredTenantId.toUpperCase());
  const total = byRegisteredTenant.length;
  const start = (filters.pageNum - 1) * filters.pageSize;
  const items = byRegisteredTenant.slice(start, start + filters.pageSize);
  const summary = {
    total,
    active: enriched.filter((row) => row.status === "active").length,
    personal: enriched.filter((row) => row.accountType === "personal").length,
    enterprise: enriched.filter((row) => row.accountType === "enterprise").length,
  };

  res.status(200).send(success({ items, total, pageNum: filters.pageNum, pageSize: filters.pageSize, summary }));
});
