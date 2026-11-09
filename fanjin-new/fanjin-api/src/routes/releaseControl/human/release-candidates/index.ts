import express from "express";
import {
  createReleaseControlHumanHandler,
  releaseControlListLimit,
} from "@/lib/releaseControlHumanRoutes";
import { requireReleasePublisher } from "@/middleware/permissions";

const router = express.Router();
router.use(requireReleasePublisher);

export default router.get("/", createReleaseControlHumanHandler({
  method: "GET",
  path: (req) => `/v1/human/release-candidates?limit=${releaseControlListLimit(req)}`,
  scopes: ["release.read"],
}));
