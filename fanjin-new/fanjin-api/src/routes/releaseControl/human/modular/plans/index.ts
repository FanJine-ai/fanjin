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
  path: (req) => `/v1/human/modular/plans?limit=${releaseControlListLimit(req)}`,
  scopes: ["release.read"],
}));

router.post("/", (_req, res) => res.status(410).send({
  error: {
    code: "HUMAN_RAW_MODULAR_PLAN_CREATION_RETIRED",
    message: "模块化候选必须由受信 CI 注册；人工发布请使用统一 ReleaseCandidate 工作台",
  },
}));

export default router;
