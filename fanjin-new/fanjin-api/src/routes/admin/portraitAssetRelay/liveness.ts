import express from "express";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit";
import {
  PORTRAIT_ASSET_RELAY_VERSION,
  PortraitAssetRelayContractError,
} from "@/lib/portraitAssetRelayContract";
import {
  executePortraitAssetRelayAction,
  PortraitAssetRelayError,
} from "@/lib/portraitAssetRelayService";
import { VolcenginePortraitAssetsError } from "@/lib/volcenginePortraitAssets";
import { VolcenginePortraitIdempotencyStoreError } from "@/lib/volcenginePortraitIdempotencyStore";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const schema = z.object({
  Action: z.enum(["CreateVisualValidateSession", "GetVisualValidateResult"]),
  Body: z.record(z.string(), z.unknown()),
  Version: z.literal(PORTRAIT_ASSET_RELAY_VERSION).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
  workspaceId: z.string().trim().min(1).max(256),
}).strict();

router.post("/", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const actorUserId = Number((req as any).auth?.user?.id || (req as any).user?.id || 0);
  try {
    if (parsed.data.Action === "CreateVisualValidateSession") {
      await writeAuditLog(req, {
        action: "admin.portrait_asset_relay.liveness.requested",
        resourceType: "portrait_asset_relay",
        resourceId: parsed.data.workspaceId,
        metadata: { action: parsed.data.Action, outcome: "accepted" },
        required: true,
        workspaceId: parsed.data.workspaceId,
      });
    }
    const result = await executePortraitAssetRelayAction({
      action: parsed.data.Action,
      actorUserId,
      body: parsed.data.Body,
      idempotencyKey: parsed.data.idempotencyKey,
      workspaceId: parsed.data.workspaceId,
    });
    return res.status(200).send({ data: result });
  } catch (error) {
    if (error instanceof PortraitAssetRelayContractError) {
      return res.status(error.status).send({ code: error.code, message: error.message, errors: error.issues });
    }
    if (error instanceof PortraitAssetRelayError) {
      return res.status(error.status).send({ code: error.code, message: error.message });
    }
    if (error instanceof VolcenginePortraitAssetsError) {
      const status = error.code.includes("IDEMPOTENCY") || error.code.includes("OUTCOME_UNKNOWN")
        ? 409
        : error.httpStatus && error.httpStatus >= 400 && error.httpStatus <= 599
          ? error.httpStatus
          : error.dispatchState === "not_dispatched" ? 400 : 502;
      return res.status(status).send({ code: error.code, message: error.message });
    }
    if (error instanceof VolcenginePortraitIdempotencyStoreError) {
      const status = error.code.includes("CONFLICT") || error.code.includes("LEASE") ? 409 : 503;
      return res.status(status).send({ code: error.code, message: error.message });
    }
    if (error instanceof Error && error.message.startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send({
        code: "portrait_asset_audit_unavailable",
        message: "安全审计暂不可用，真人认证操作未发起",
      });
    }
    console.error("[admin-portrait-asset-relay] liveness failed", error instanceof Error ? error.name : "UnknownError");
    return res.status(500).send({ code: "portrait_asset_internal_error", message: "真人认证操作失败" });
  }
});

export default router;
