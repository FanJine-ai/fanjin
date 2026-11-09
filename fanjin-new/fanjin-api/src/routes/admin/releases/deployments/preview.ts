import express from "express";
import { z } from "zod";
import { previewReleaseDeployment, ReleaseDeploymentError } from "@/lib/releaseDeployments";
import { success } from "@/lib/responseFormat";
import { requireReleasePublisher } from "@/middleware/permissions";

const router = express.Router();
router.use(requireReleasePublisher);

const bodySchema = z.object({
  releaseId: z.string().uuid(),
  releaseRevision: z.number().int().positive(),
  artifactId: z.string().uuid(),
  targetKeys: z.array(z.string().trim().min(1).max(128)).min(1).max(100).optional(),
}).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: parsed.error.issues[0]?.message || "参数错误", errors: parsed.error.issues });
  try {
    return res.status(200).send(success(await previewReleaseDeployment(parsed.data)));
  } catch (error) {
    if (error instanceof ReleaseDeploymentError) return res.status(error.status).send({ message: error.message, code: error.code });
    throw error;
  }
});
