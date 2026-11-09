import express from "express";
import { createReleaseControlHumanHandler } from "@/lib/releaseControlHumanRoutes";
import { requireReleasePublisher } from "@/middleware/permissions";

const router = express.Router();
router.use(requireReleasePublisher);

export default router.post("/", createReleaseControlHumanHandler({
  method: "POST",
  path: () => "/v1/human/release-candidates/resolve",
  scopes: ["release.read"],
}));
