import express from "express";
import {
  createReleaseControlHumanHandler,
  releaseControlListLimit,
} from "@/lib/releaseControlHumanRoutes";
import { requireReleasePublisher } from "@/middleware/permissions";

const router = express.Router();
router.use(requireReleasePublisher);

router.get("/", createReleaseControlHumanHandler({
  method: "GET",
  path: (req) => `/v1/human/plans?limit=${releaseControlListLimit(req)}`,
  scopes: ["release.read"],
}));

router.post("/", createReleaseControlHumanHandler({
  method: "POST",
  path: () => "/v1/human/plans",
  scopes: ["release.plan.create"],
}));

export default router;
