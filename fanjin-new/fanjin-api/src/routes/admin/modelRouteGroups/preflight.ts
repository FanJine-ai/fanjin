import express from "express";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { preflightModelRouteGroup } from "@/lib/modelRouteGroupMutation";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { modelRouteGroupDraftSchema } from "@/lib/modelRouteGroupSchemas";

const router = express.Router();
router.use(requirePlatformAdmin);

export default router.post("/", async (req, res) => {
  const parsed = modelRouteGroupDraftSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const result = await preflightModelRouteGroup(db, parsed.data);
  return res.status(200).send(success(result));
});
