import express from "express";
import { z } from "zod";
import {
  getBillingOverview,
  getCandidateReadonlyBillingOverviewProjection,
} from "@/lib/billing";
import { isCandidateRuntimeReadonlyEvidenceMode } from "@/lib/candidateRuntimeAttestation";
import { success } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();
router.use(requireWorkspacePermission("billing:read"));

export const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
});

const handleOverview: express.RequestHandler = async (req, res) => {
  const parsed = bodySchema.safeParse(
    req.method === "GET" ? req.query : (req.body ?? {}),
  );
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const workspaceId = parsed.data.workspaceId || (req as any).auth?.workspaceId || "default";
  const overview = isCandidateRuntimeReadonlyEvidenceMode()
    ? await getCandidateReadonlyBillingOverviewProjection(workspaceId)
    : await getBillingOverview(workspaceId);
  res.status(200).send(success(overview));
};

router.get("/", handleOverview);
router.post("/", handleOverview);

export default router;
