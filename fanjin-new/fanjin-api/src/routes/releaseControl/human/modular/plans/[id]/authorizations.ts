import express from "express";
import {
  createReleaseControlHumanHandler,
  releaseControlEncodedId,
} from "@/lib/releaseControlHumanRoutes";
import { requireReleasePublisher } from "@/middleware/permissions";

const router = express.Router({ mergeParams: true });
router.use(requireReleasePublisher);

export default router.post("/", createReleaseControlHumanHandler({
  method: "POST",
  path: (req) => `/v1/human/modular/plans/${releaseControlEncodedId(req)}/authorizations`,
  scopes: [
    "release.read",
    "release.authorize.production",
    "release.unit.web",
    "release.unit.api",
    "release.unit.worker",
    "release.unit.controller",
    "release.migration",
  ],
  requireMfa: true,
}));
