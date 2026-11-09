import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { generateApiKey, maskApiKey } from "@/middleware/apiKeyAuth";
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
router.use(requireWorkspacePermission("api_key:write"));

const bodySchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().trim().min(1).optional().nullable(),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
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
      return res.status(404).send(error("API Key 不存在或不可轮换"));
    }
    const result = await db.transaction(async (trx) => {
      const authority = await lockApiKeyMutationAuthority({
        trx,
        req,
        snapshot,
        scope,
        requireOwnerAuthority: true,
      });
      const row = authority.row;
      if (
        row.disabled
        || (row.revokedAt && Number(row.revokedAt) !== 0)
      ) {
        throw new Error("API_KEY_NOT_ROTATABLE");
      }
      const { plainKey, keyPrefix, keyHash } = generateApiKey();
      const now = Date.now();
      await trx("o_api_key").where({ id: row.id }).update({
        keyPrefix,
        keyHash,
        lastUsedAt: null,
        updateTime: now,
      });
      await writeAuditLog(req, {
        workspaceId: row.workspaceId ?? (req as any).auth?.workspaceId ?? null,
        action: "api_key.rotate",
        resourceType: "api_key",
        resourceId: row.id,
        required: true,
        metadata: {
          before: { keyPrefix: row.keyPrefix },
          after: { keyPrefix, rotatedAt: now },
        },
      }, trx);
      return {
        id: row.id,
        name: row.name,
        apiKey: plainKey,
        maskedKey: maskApiKey(keyPrefix),
        keyPrefix,
        rotatedAt: now,
        note: "旧 API Key 已立即失效，新明文 Key 只在本次响应返回。",
      };
    });
    return res.status(200).send(success(result));
  } catch (err: unknown) {
    if (err instanceof ApiKeyAuthorityError || isWorkspaceAuthorityError(err)) {
      return res.status(err.status).send(error(err.message, {
        code: err.code,
      }));
    }
    const message = String((err as Error)?.message || "");
    if (message === "API_KEY_NOT_ROTATABLE") {
      return res.status(404).send(error("API Key 不存在或不可轮换"));
    }
    if (message.startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(error("审计写入失败，API Key 未轮换", {
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      }));
    }
    throw err;
  }
});
