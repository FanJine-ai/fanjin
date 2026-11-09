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
  path: (req) => `/v1/human/modular/executions?limit=${releaseControlListLimit(req)}`,
  scopes: ["release.read"],
}));

router.post("/", createReleaseControlHumanHandler({
  method: "POST",
  path: () => "/v1/human/modular/executions",
  scopes: [
    "release.read",
    "release.execute.production",
    "release.unit.web",
    "release.unit.api",
    "release.unit.worker",
    "release.unit.controller",
    "release.migration",
  ],
}));

export default router;
