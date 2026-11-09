import { publicModelId } from "@/lib/minimaxH3PublicIdentity";
import express from "express";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { maskApiKey } from "@/middleware/apiKeyAuth";
import { requireWorkspacePermission } from "@/middleware/permissions";
import { apiKeyOwnerFilter, resolveApiKeyAccessScope } from "@/lib/apiKeyWorkspaceScope";
import { z } from "zod";
import { API_KEY_QUOTA_UNIT_GU_MICROS, guMicrosPerGu } from "@/lib/billing";

const router = express.Router();

function parsePermissions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseStringList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
  } catch {
    return [];
  }
}

router.use(requireWorkspacePermission("api_key:read"));

export const bodySchema = z.object({
  workspaceId: z.string().trim().min(1).optional().nullable(),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const access = resolveApiKeyAccessScope(req, parsed.data.workspaceId);
  if (!access.ok) return res.status(access.status).send({ message: access.message });

  const query = db("o_api_key").select(
    "id",
    "name",
    "keyPrefix",
    "scope",
    "workspaceId",
    "ownerUserId",
    "permissions",
    "quotaUnit",
    "quotaLimit",
    "quotaUsed",
    "quotaReserved",
    "rateLimitPerMinute",
    "expiresAt",
    "modelAllowlist",
    "ipAllowlist",
    "lastUsedAt",
    "disabled",
    "revokedAt",
    "createTime",
    "updateTime",
  );
  query.where({
    scope: access.scope,
    workspaceId: access.workspaceId,
    ...apiKeyOwnerFilter(req),
  });
  const rows = await query.orderBy("createTime", "desc").orderBy("id", "desc");

  res.status(200).send(
    success(
      rows.map((row) => {
        const quotaUnit = String(row.quotaUnit || "request");
        const guQuota = quotaUnit === API_KEY_QUOTA_UNIT_GU_MICROS;
        const quotaLimitMicros = guQuota && row.quotaLimit != null ? Number(row.quotaLimit) : null;
        const quotaUsedMicros = guQuota ? Number(row.quotaUsed || 0) : null;
        const quotaReservedMicros = guQuota ? Number(row.quotaReserved || 0) : null;
        return {
          ...row,
          quotaUnit,
          quotaLimit: guQuota && quotaLimitMicros != null ? quotaLimitMicros / guMicrosPerGu : row.quotaLimit,
          quotaUsed: guQuota ? Number(row.quotaUsed || 0) / guMicrosPerGu : Number(row.quotaUsed || 0),
          quotaReserved: guQuota ? Number(row.quotaReserved || 0) / guMicrosPerGu : Number(row.quotaReserved || 0),
          quotaLimitMicros,
          quotaUsedMicros,
          quotaReservedMicros,
          key: maskApiKey(row.keyPrefix),
          permissions: parsePermissions(row.permissions),
          modelAllowlist: parseStringList(row.modelAllowlist).map(publicModelId),
          ipAllowlist: parseStringList(row.ipAllowlist),
        };
      }),
    ),
  );
});
