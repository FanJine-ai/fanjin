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
  path: (req) => `/v1/human/plans/${releaseControlEncodedId(req)}/authorizations`,
  scopes: ["release.authorize.production"],
  requireMfa: true,
}));
