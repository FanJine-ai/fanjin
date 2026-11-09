import { publicModelId } from "@/lib/minimaxH3PublicIdentity";
import express from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { generateApiKey, maskApiKey } from "@/middleware/apiKeyAuth";
import { relayScopes } from "@/lib/relay";
import {
  isPlatformAdmin,
  requireWorkspacePermission,
} from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";
import { assertWorkspaceApiKeyLimit, WorkspaceLimitError } from "@/lib/workspaceLimits";
import { assertMembershipFeature } from "@/lib/membership";
import { MembershipError } from "@/lib/membershipCatalog";
import { resolveApiKeyAccessScope } from "@/lib/apiKeyWorkspaceScope";
import {
  ApiKeyAuthorityError,
  assertLiveWorkspaceApiKeyOwner,
  isWorkspaceAuthorityError,
  lockLivePlatformApiKeyFundingAuthority,
  lockLivePlatformApiKeyUsers,
  requestActorUserId,
} from "@/lib/apiKeyAuthority";
import { requireLiveWorkspaceAuthority } from "@/lib/workspaceAccess";
import {
  DEFAULT_RELAY_API_KEY_PERMISSIONS,
  normalizeRelayApiKeyPermissions,
  RELAY_API_KEY_PERMISSIONS,
} from "@/lib/relayApiKeyPermissions";
import { API_KEY_QUOTA_UNIT_GU_MICROS, guMicrosPerGu } from "@/lib/billing";

const router = express.Router();

const bodySchema = z.object({
  name: z.string().min(1),
  scope: z.enum(relayScopes).default("platform"),
  workspaceId: z.string().optional().nullable(),
  ownerUserId: z.number().int().positive().optional().nullable(),
  permissions: z
    .array(z.enum(RELAY_API_KEY_PERMISSIONS))
    .max(RELAY_API_KEY_PERMISSIONS.length)
    .default([...DEFAULT_RELAY_API_KEY_PERMISSIONS]),
  quotaLimit: z.number().nonnegative()
    .max(Number.MAX_SAFE_INTEGER / guMicrosPerGu)
    .optional()
    .nullable(),
  rateLimitPerMinute: z.number().int().nonnegative().optional().nullable(),
  expiresAt: z.number().int().nonnegative().optional().nullable(),
  modelAllowlist: z.array(z.string()).default([]),
  ipAllowlist: z.array(z.string()).default([]),
}).strict();

router.use(requireWorkspacePermission("api_key:write"));

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  try {
    const now = Date.now();
    const id = uuid();
    const { plainKey, keyPrefix, keyHash } = generateApiKey();
    const data = parsed.data;
    const permissions = normalizeRelayApiKeyPermissions(data.permissions);
    const platformAdmin = isPlatformAdmin(req);
    const scope = platformAdmin ? data.scope : "workspace";
    const access = scope === "platform"
      ? { ok: true as const, scope: "platform" as const, workspaceId: null }
      : resolveApiKeyAccessScope(req, data.workspaceId);
    if (!access.ok) return res.status(access.status).send({ message: access.message });
    if (platformAdmin && scope === "workspace" && !data.workspaceId?.trim()) {
      return res.status(400).send({ message: "平台管理员创建工作区 API Key 必须显式提供 workspaceId" });
    }
    const workspaceId = access.workspaceId;
    const authenticatedUserId = Number((req as any).auth?.user?.id || 0) || null;
    const actorRole = String((req as any).auth?.user?.role || "").toLowerCase();
    if (
      platformAdmin
      && actorRole !== "root"
      && data.ownerUserId != null
      && Number(data.ownerUserId) !== authenticatedUserId
    ) {
      return res.status(403).send(error("只有 root 可以跨账号签发 API Key", {
        code: "API_KEY_CROSS_OWNER_ROOT_REQUIRED",
      }));
    }
    const ownerUserId = platformAdmin
      ? data.ownerUserId ?? authenticatedUserId
      : authenticatedUserId;
    await db.transaction(async (trx) => {
      if (!ownerUserId) throw new Error("API_KEY_OWNER_REQUIRED");
      const actorUserId = requestActorUserId(req);

      if (scope === "platform") {
        const authority = await lockLivePlatformApiKeyUsers({
          trx,
          actorUserId,
          ownerUserId,
          requireOwnerAuthority: true,
        });
        await lockLivePlatformApiKeyFundingAuthority({
          trx,
          owner: authority.owner,
        });
        if (
          ownerUserId !== actorUserId
          && String(authority.actor.role || "").toLowerCase() !== "root"
        ) {
          throw new ApiKeyAuthorityError(
            "只有 root 可以跨账号签发 API Key",
            403,
            "API_KEY_CROSS_OWNER_ROOT_REQUIRED",
          );
        }
      } else {
        const authority = await requireLiveWorkspaceAuthority({
          database: trx,
          actorUserId,
          additionalUserIds: [ownerUserId],
          additionalMemberUserIds: [ownerUserId],
          authenticatedWorkspaceId: String(
            (req as any).auth?.workspaceId || "",
          ),
          workspaceId: workspaceId!,
          permission: "api_key:write",
        });
        assertLiveWorkspaceApiKeyOwner(authority, ownerUserId);
        await assertMembershipFeature(workspaceId!, "apiManagement", trx);
        await assertWorkspaceApiKeyLimit(workspaceId!, 1, trx);
      }

      await trx("o_api_key").insert({
        id,
        name: data.name,
        keyPrefix,
        keyHash,
        scope,
        workspaceId: scope === "workspace" ? workspaceId : null,
        ownerUserId,
        permissions: JSON.stringify(permissions),
        quotaUnit: API_KEY_QUOTA_UNIT_GU_MICROS,
        quotaLimit: data.quotaLimit == null
          ? null
          : Math.round(data.quotaLimit * guMicrosPerGu),
        quotaUsed: 0,
        quotaReserved: 0,
        rateLimitPerMinute: data.rateLimitPerMinute ?? null,
        expiresAt: data.expiresAt ?? null,
        modelAllowlist: JSON.stringify(data.modelAllowlist.filter(Boolean)),
        ipAllowlist: JSON.stringify(data.ipAllowlist.filter(Boolean)),
        lastUsedAt: null,
        disabled: 0,
        revokedAt: null,
        createTime: now,
        updateTime: now,
      });

      await writeAuditLog(req, {
        workspaceId: scope === "workspace" ? workspaceId : null,
        action: "api_key.create",
        resourceType: "api_key",
        resourceId: id,
        required: true,
        metadata: {
          name: data.name,
          scope,
          workspaceId: scope === "workspace" ? workspaceId : null,
          ownerUserId,
          permissions,
          quotaUnit: API_KEY_QUOTA_UNIT_GU_MICROS,
          quotaLimit: data.quotaLimit ?? null,
          rateLimitPerMinute: data.rateLimitPerMinute ?? null,
          expiresAt: data.expiresAt ?? null,
          modelAllowlist: data.modelAllowlist.filter(Boolean).map(publicModelId),
          ipAllowlist: data.ipAllowlist.filter(Boolean),
        },
      }, trx);
    });

    return res.status(200).send(
      success({
        id,
        name: data.name,
        apiKey: plainKey,
        maskedKey: maskApiKey(keyPrefix),
        keyPrefix,
        scope,
        workspaceId: scope === "workspace" ? workspaceId : null,
        permissions,
        quotaUnit: API_KEY_QUOTA_UNIT_GU_MICROS,
        quotaLimit: data.quotaLimit ?? null,
        quotaUsed: 0,
        quotaReserved: 0,
        modelAllowlist: data.modelAllowlist.filter(Boolean).map(publicModelId),
        ipAllowlist: data.ipAllowlist.filter(Boolean),
        expiresAt: data.expiresAt ?? null,
        createTime: now,
        note: "明文 API Key 只在本次响应返回，请立即保存。",
      }),
    );
  } catch (err: any) {
    if (err instanceof MembershipError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    if (err instanceof ApiKeyAuthorityError || isWorkspaceAuthorityError(err)) {
      return res.status(err.status).send(error(err.message, {
        code: err.code,
      }));
    }
    if (err instanceof WorkspaceLimitError) {
      return res.status(err.status).send({ message: err.message, code: err.code, details: err.details });
    }
    const message = String(err?.message || "");
    if (message === "API_KEY_OWNER_REQUIRED" || message === "API_KEY_OWNER_UNAVAILABLE") {
      return res.status(400).send(error("API Key 所属账号不存在或不可用", {
        code: "API_KEY_OWNER_UNAVAILABLE",
      }));
    }
    if (message === "PLATFORM_API_KEY_OWNER_INVALID") {
      return res.status(403).send(error("平台 API Key 必须归属启用的平台管理员", {
        code: "PLATFORM_API_KEY_OWNER_INVALID",
      }));
    }
    if (message === "API_KEY_WORKSPACE_UNAVAILABLE") {
      return res.status(403).send(error("API Key 所属工作区不存在或不可用", {
        code: "API_KEY_WORKSPACE_UNAVAILABLE",
      }));
    }
    if (message === "WORKSPACE_API_KEY_OWNER_UNAUTHORIZED") {
      return res.status(403).send(error("API Key 所属成员无权管理工作区密钥", {
        code: "WORKSPACE_API_KEY_OWNER_UNAUTHORIZED",
      }));
    }
    if (message.startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(error("审计写入失败，API Key 未创建", {
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      }));
    }
    throw err;
  }
});
