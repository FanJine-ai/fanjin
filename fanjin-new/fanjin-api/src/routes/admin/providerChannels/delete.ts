import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success, error } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import {
  assertProviderChannelMutationAllowed,
  lockRelayConfigTablesForMutation,
  normalizeRelayConfigScope,
  RelayConfigValidationError,
  relayConfigValidationErrorBody,
  serializeRelayConfigMutation,
} from "@/lib/relayConfigValidation";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  id: z.string().trim().min(1),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const id = parsed.data.id;
  let result: { kind: "missing" } | { kind: "disabled"; workspaceId: string | null };
  try {
    result = await serializeRelayConfigMutation(async () => db.transaction(async (trx) => {
      await lockRelayConfigTablesForMutation(trx);
      const existing = await trx("o_provider_channel").where({ id }).first();
      if (!existing) return { kind: "missing" as const };

      const scoped = normalizeRelayConfigScope(existing);
      await assertProviderChannelMutationAllowed(
        trx,
        existing as unknown as Record<string, unknown>,
        {
          ...scoped,
          provider: String(existing.provider || "").trim(),
          endpointType: String(existing.endpointType || "").trim(),
          disabled: 1,
        },
        { forceDisableCheck: true },
      );
      const count = await trx("o_provider_channel").where({ id }).update({
        disabled: 1,
        updateTime: Date.now(),
      });
      if (!count) return { kind: "missing" as const };
      return { kind: "disabled" as const, workspaceId: scoped.workspaceId };
    }));
  } catch (caught) {
    if (caught instanceof RelayConfigValidationError) {
      return res.status(caught.statusCode).send(relayConfigValidationErrorBody(caught));
    }
    throw caught;
  }

  if (result.kind === "missing") return res.status(404).send(error("Provider channel 不存在"));
  await writeAuditLog(req, {
    workspaceId: result.workspaceId,
    action: "admin.provider_channel.disable",
    resourceType: "provider_channel",
    resourceId: id,
    metadata: { disabled: 1 },
  });
  res.status(200).send(success({ id, disabled: 1 }));
});
