import express from "express";
import { z } from "zod";
import { requireReleasePublisher } from "@/middleware/permissions";

const router = express.Router();
router.use(requireReleasePublisher);

const bodySchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  return res.status(410).send({
    message: "直接标记正式发布已停用，请先登记已验证制品并创建滚动发布任务",
    code: "PLATFORM_RELEASE_DEPLOYMENT_REQUIRED",
  });
});
