import express from "express";
import { assertMembershipFeature } from "@/lib/membership";
import { MembershipError } from "@/lib/membershipCatalog";
import { z } from "zod";
import { db } from "@/utils/db";
import { success, error } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";
import { writeAuditLog } from "@/lib/audit";
import { resolveApiKeyAccessScope } from "@/lib/apiKeyWorkspaceScope";
import {
  ApiKeyAuthorityError,
  isWorkspaceAuthorityError,
  lockApiKeyMutationAuthority,
  readApiKeyMutationSnapshot,
} from "@/lib/apiKeyAuthority";
import { assertWorkspaceApiKeyLimit, WorkspaceLimitError } from "@/lib/workspaceLimits";
import {
  normalizeRelayApiKeyPermissions,
  RELAY_API_KEY_PERMISSIONS,
} from "@/lib/relayApiKeyPermissions";
import { API_KEY_QUOTA_UNIT_GU_MICROS, guMicrosPerGu } from "@/lib/billing";

const router = express.Router();

const bodySchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().trim().min(1).optional().nullable(),
  name: z.string().min(1).optional(),
  quotaLimit: z.number().nonnegative()
    .max(Number.MAX_SAFE_INTEGER / guMicrosPerGu)
    .optional()
    .nullable(),
  rateLimitPerMinute: z.number().int().nonnegative().optional().nullable(),
  expiresAt: z.number().int().nonnegative().optional().nullable(),
  disabled: z.boolean().optional(),
  permissions: z
    .array(z.enum(RELAY_API_KEY_PERMISSIONS))
    .max(RELAY_API_KEY_PERMISSIONS.length)
    .optional(),
  modelAllowlist: z.array(z.string()).optional(),
  ipAllowlist: z.array(z.string()).optional(),
}).strict();

function cleanList(value: string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  return Array.from(new Set(value.map((item) => item.trim()).filter(Boolean)));
}

function readStoredList(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    return Array.isArray(parsed)
      ? cleanList(parsed.filter((item): item is string => typeof item === "string")) ?? []
      : [];
  } catch {
    return [];
  }
}

router.use(requireWorkspacePermission("api_key:write"));

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const { workspaceId: requestedWorkspaceId, ...data } = parsed.data;
  const access = resolveApiKeyAccessScope(req, requestedWorkspaceId);
  if (!access.ok) return res.status(access.status).send({ message: access.message });
  try {
    const scope = access.scope === "workspace"
      ? { scope: "workspace" as const, workspaceId: access.workspaceId }
      : { scope: "platform" as const, workspaceId: null };
    const snapshot = await readApiKeyMutationSnapshot({
      id: data.id,
      ...scope,
    });
    if (!snapshot) {
      return res.status(404).send(error("API Key 不存在或不可编辑"));
    }
    const onlyDisables = (
      data.disabled === true
      && data.name === undefined
      && data.quotaLimit === undefined
      && data.rateLimitPerMinute === undefined
      && data.expiresAt === undefined
      && data.permissions === undefined
      && data.modelAllowlist === undefined
      && data.ipAllowlist === undefined
    );
    const result = await db.transaction(async (trx) => {
      const authority = await lockApiKeyMutationAuthority({
        trx,
        req,
        snapshot,
        scope,
        requireOwnerAuthority: !onlyDisables,
      });
      const row = authority.row;
      const ceiling = (value: unknown) => Number(value || 0) > 0 ? Number(value) : Infinity;
      const quotaGu = String(row.quotaUnit || "request") === API_KEY_QUOTA_UNIT_GU_MICROS && row.quotaLimit != null
        ? Number(row.quotaLimit) / guMicrosPerGu : row.quotaLimit;
      if (scope.scope === "workspace" && data.disabled !== true && (
        data.disabled === false || data.permissions !== undefined || data.modelAllowlist !== undefined || data.ipAllowlist !== undefined
        || (data.quotaLimit !== undefined && ceiling(data.quotaLimit) > ceiling(quotaGu))
        || (data.rateLimitPerMinute !== undefined && ceiling(data.rateLimitPerMinute) > ceiling(row.rateLimitPerMinute))
        || (data.expiresAt !== undefined && ceiling(data.expiresAt) > ceiling(row.expiresAt))
      )) await assertMembershipFeature(scope.workspaceId, "apiManagement", trx);
      if (row.revokedAt && Number(row.revokedAt) !== 0) {
        throw new Error("API_KEY_NOT_EDITABLE");
      }
      if (
        scope.scope === "workspace"
        && data.disabled === false
        && Number(row.disabled || 0) !== 0
      ) {
        await assertWorkspaceApiKeyLimit(scope.workspaceId, 1, trx);
      }

      const modelAllowlist = cleanList(data.modelAllowlist);
      const ipAllowlist = cleanList(data.ipAllowlist);
      const permissions = data.permissions === undefined
        ? undefined
        : normalizeRelayApiKeyPermissions(data.permissions);
      const patch: Record<string, unknown> = {
        updateTime: Date.now(),
      };
      if (data.name !== undefined) patch.name = data.name.trim();
      if (data.quotaLimit !== undefined) {
        patch.quotaLimit = data.quotaLimit == null
          ? null
          : Math.round(data.quotaLimit * guMicrosPerGu);
        patch.quotaUnit = API_KEY_QUOTA_UNIT_GU_MICROS;
        if (String(row.quotaUnit || "request") !== API_KEY_QUOTA_UNIT_GU_MICROS) {
          const charged = await trx("o_usage_record")
            .where({ apiKeyId: row.id, status: "charged" })
            .sum({ total: "costMicros" })
            .first();
          const reserved = await trx("o_billing_ledger")
            .where({ apiKeyId: row.id, type: "freeze" })
            .where("remainingMicros", ">", 0)
            .sum({ total: "remainingMicros" })
            .first();
          patch.quotaUsed = Math.max(0, Number((charged as any)?.total || 0));
          patch.quotaReserved = Math.max(0, Number((reserved as any)?.total || 0));
        }
      }
      if (data.rateLimitPerMinute !== undefined) patch.rateLimitPerMinute = data.rateLimitPerMinute;
      if (data.expiresAt !== undefined) patch.expiresAt = data.expiresAt;
      if (data.disabled !== undefined) patch.disabled = data.disabled ? 1 : 0;
      if (permissions !== undefined) {
        patch.permissions = JSON.stringify(permissions);
      }
      if (modelAllowlist !== undefined) patch.modelAllowlist = JSON.stringify(modelAllowlist);
      if (ipAllowlist !== undefined) patch.ipAllowlist = JSON.stringify(ipAllowlist);

      await trx("o_api_key").where({ id: row.id }).update(patch);
      const before = {
        name: row.name,
        quotaUnit: row.quotaUnit ?? "request",
        quotaLimit: String(row.quotaUnit || "request") === API_KEY_QUOTA_UNIT_GU_MICROS
          && row.quotaLimit != null
          ? Number(row.quotaLimit) / guMicrosPerGu
          : row.quotaLimit ?? null,
        rateLimitPerMinute: row.rateLimitPerMinute ?? null,
        expiresAt: row.expiresAt ?? null,
        disabled: Number(row.disabled || 0),
        permissions: readStoredList(row.permissions),
        modelAllowlist: readStoredList(row.modelAllowlist),
        ipAllowlist: readStoredList(row.ipAllowlist),
      };
      const after = {
        name: data.name !== undefined ? data.name.trim() : before.name,
        quotaUnit: data.quotaLimit !== undefined
          ? API_KEY_QUOTA_UNIT_GU_MICROS
          : before.quotaUnit,
        quotaLimit: data.quotaLimit !== undefined ? data.quotaLimit : before.quotaLimit,
        rateLimitPerMinute: data.rateLimitPerMinute !== undefined
          ? data.rateLimitPerMinute
          : before.rateLimitPerMinute,
        expiresAt: data.expiresAt !== undefined ? data.expiresAt : before.expiresAt,
        disabled: data.disabled !== undefined ? (data.disabled ? 1 : 0) : before.disabled,
        permissions: permissions === undefined
          ? before.permissions
          : permissions,
        modelAllowlist: modelAllowlist ?? before.modelAllowlist,
        ipAllowlist: ipAllowlist ?? before.ipAllowlist,
      };
      await writeAuditLog(req, {
        workspaceId: row.workspaceId ?? (req as any).auth?.workspaceId ?? null,
        action: "api_key.update",
        resourceType: "api_key",
        resourceId: row.id,
        required: true,
        metadata: { before, after },
      }, trx);
      return { id: row.id, updatedAt: patch.updateTime };
    });
    return res.status(200).send(success(result));
  } catch (err: unknown) {
    if (err instanceof MembershipError) return res.status(err.status).send(error(err.message, { code: err.code }));
    if (err instanceof ApiKeyAuthorityError || isWorkspaceAuthorityError(err)) {
      return res.status(err.status).send(error(err.message, {
        code: err.code,
      }));
    }
    if (err instanceof WorkspaceLimitError) {
      return res.status(err.status).send(error(err.message, {
        code: err.code,
        details: err.details,
      }));
    }
    const message = String((err as Error)?.message || "");
    if (message === "API_KEY_NOT_EDITABLE") {
      return res.status(404).send(error("API Key 不存在或不可编辑"));
    }
    if (message.startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(error("审计写入失败，API Key 未更新", {
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      }));
    }
    throw err;
  }
});
