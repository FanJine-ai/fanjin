import express from "express";
import { z } from "zod";

import {
  PORTRAIT_ASSET_RELAY_VERSION,
  PortraitAssetRelayContractError,
} from "@/lib/portraitAssetRelayContract";
import {
  executePortraitAssetRelayAction,
  PortraitAssetRelayError,
} from "@/lib/portraitAssetRelayService";
import { VolcenginePortraitAssetsError } from "@/lib/volcenginePortraitAssets";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const schema = z.object({
  Action: z.enum(["GetAssetGroup", "ListAssetGroups", "GetAsset", "ListAssets"]),
  Body: z.record(z.string(), z.unknown()),
  Version: z.literal(PORTRAIT_ASSET_RELAY_VERSION).optional(),
  workspaceId: z.string().trim().min(1).max(256),
}).strict();

router.post("/", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const actorUserId = Number((req as any).auth?.user?.id || (req as any).user?.id || 0);
  try {
    const result = await executePortraitAssetRelayAction({
      action: parsed.data.Action,
      actorUserId,
      body: parsed.data.Body,
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
      const status = error.httpStatus && error.httpStatus >= 400 && error.httpStatus <= 599
        ? error.httpStatus
        : error.dispatchState === "not_dispatched" ? 400 : 502;
      return res.status(status)
        .send({ code: error.code, message: error.message });
    }
    console.error("[admin-portrait-asset-relay] query failed", error instanceof Error ? error.name : "UnknownError");
    return res.status(500).send({ code: "portrait_asset_internal_error", message: "人像资产读取失败" });
  }
});

export default router;
