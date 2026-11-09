import express from "express";
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

const router = express.Router();

const bodySchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().trim().min(1).optional().nullable(),
}).strict();

router.use(requireWorkspacePermission("api_key:write"));

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const access = resolveApiKeyAccessScope(req, parsed.data.workspaceId);
  if (!access.ok) return res.status(access.status).send({ message: access.message });
  try {
    const scope = access.scope === "workspace"
      ? { scope: "workspace" as const, workspaceId: access.workspaceId }
      : { scope: "platform" as const, workspaceId: null };
    const snapshot = await readApiKeyMutationSnapshot({
      id: parsed.data.id,
      ...scope,
    });
    if (!snapshot) {
      return res.status(404).send(error("API Key 不存在"));
    }
    const result = await db.transaction(async (trx) => {
      const authority = await lockApiKeyMutationAuthority({
        trx,
        req,
        snapshot,
        scope,
        requireOwnerAuthority: false,
      });
      const row = authority.row;
      if (row.revokedAt && Number(row.revokedAt) !== 0) {
        return {
          id: parsed.data.id,
          revokedAt: Number(row.revokedAt),
          alreadyRevoked: true,
        };
      }

      const now = Date.now();
      const count = await trx("o_api_key").where({ id: row.id }).where((builder) => {
        builder.whereNull("revokedAt").orWhere("revokedAt", 0);
      }).update({
        disabled: 1,
        revokedAt: now,
        updateTime: now,
      });
      if (!count) throw new Error("API_KEY_NOT_FOUND");
      await writeAuditLog(req, {
        workspaceId: row.workspaceId ?? null,
        action: "api_key.revoke",
        resourceType: "api_key",
        resourceId: parsed.data.id,
        required: true,
        metadata: {
          before: {
            disabled: Number(row.disabled || 0),
            revokedAt: row.revokedAt ?? null,
          },
          after: { disabled: 1, revokedAt: now },
        },
      }, trx);
      return { id: parsed.data.id, revokedAt: now, alreadyRevoked: false };
    });
    return res.status(200).send(success(result));
  } catch (err: unknown) {
    if (err instanceof ApiKeyAuthorityError || isWorkspaceAuthorityError(err)) {
      return res.status(err.status).send(error(err.message, {
        code: err.code,
      }));
    }
    const message = String((err as Error)?.message || "");
    if (message === "API_KEY_NOT_FOUND") {
      return res.status(404).send(error("API Key 不存在"));
    }
    if (message.startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(error("审计写入失败，API Key 未撤销", {
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      }));
    }
    throw err;
  }
});
