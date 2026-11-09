import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { listModelRouteGroups } from "@/lib/modelRouteGroups";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({ groupKey: z.string().trim().min(1) }).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const groups = await listModelRouteGroups(db, { includeDisabled: true });
  const group = groups.find((candidate) => candidate.groupKey === parsed.data.groupKey);
  if (!group) return res.status(404).send({ message: "逻辑模型路由组不存在" });
  const eligible = group.targets.filter((target) => !target.disabled && target.health !== "unhealthy");
  const activeTier = (["P0", "P1", "P2"] as const).find((tier) => eligible.some((target) => target.tier === tier)) || null;
  return res.status(200).send(success({
    groupKey: group.groupKey,
    sideEffectFree: true,
    activeTier,
    targets: group.targets.map((target) => ({
      id: target.id,
      channelName: target.channelName,
      provider: target.provider,
      tier: target.tier,
      trafficWeight: target.trafficWeight,
      normalizedTrafficPercent: target.tier === activeTier ? target.normalizedTrafficPercent : 0,
      eligible: eligible.some((candidate) => candidate.id === target.id),
      selectedTier: target.tier === activeTier,
      health: target.health,
    })),
  }));
});
