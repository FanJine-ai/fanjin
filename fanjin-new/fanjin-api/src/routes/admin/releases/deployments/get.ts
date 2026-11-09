import express from "express";
import { z } from "zod";
import { getReleaseDeployment, ReleaseDeploymentError } from "@/lib/releaseDeployments";
import { success } from "@/lib/responseFormat";
import { requireReleasePublisher } from "@/middleware/permissions";

const router = express.Router();
router.use(requireReleasePublisher);

const bodySchema = z.object({ id: z.string().uuid() }).strict();

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  try {
    return res.status(200).send(success(await getReleaseDeployment(parsed.data.id)));
  } catch (error) {
    if (error instanceof ReleaseDeploymentError) return res.status(error.status).send({ message: error.message, code: error.code });
    throw error;
  }
});
