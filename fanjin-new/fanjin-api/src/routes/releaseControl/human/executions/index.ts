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
  path: (req) => `/v1/human/executions?limit=${releaseControlListLimit(req)}`,
  scopes: ["release.read"],
}));

router.post("/", createReleaseControlHumanHandler({
  method: "POST",
  path: () => "/v1/human/executions",
  scopes: ["release.execute.production"],
}));

export default router;
