import express from "express";
import {
  createReleaseControlHumanHandler,
  releaseControlEncodedId,
} from "@/lib/releaseControlHumanRoutes";
import { requireReleasePublisher } from "@/middleware/permissions";

const router = express.Router({ mergeParams: true });
router.use(requireReleasePublisher);

export default router.get("/", createReleaseControlHumanHandler({
  method: "GET",
  path: (req) => `/v1/human/plans/${releaseControlEncodedId(req)}`,
  scopes: ["release.read"],
}));
