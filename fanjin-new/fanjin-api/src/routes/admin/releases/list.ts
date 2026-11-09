import express from "express";
import { z } from "zod";
import { listPlatformReleases } from "@/lib/platformReleases";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  query: z.string().trim().max(120).optional().nullable(),
  channel: z.enum(["stable", "beta", "internal"]).optional().nullable(),
  status: z.enum(["draft", "deploying", "published", "archived"]).optional().nullable(),
  pageNum: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(100).optional(),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  return res.status(200).send(success(await listPlatformReleases(parsed.data)));
});
