import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { listModelPoolItems } from "@/lib/modelRouteGroups";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  scope: z.enum(["platform", "workspace"]).optional(),
  workspaceId: z.string().trim().optional().nullable(),
  endpointType: z.string().trim().optional(),
  includeDisabled: z.boolean().default(false),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  const items = await listModelPoolItems(db, parsed.data);
  return res.status(200).send(success(items));
});
