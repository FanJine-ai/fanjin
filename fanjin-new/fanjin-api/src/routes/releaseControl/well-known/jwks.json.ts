import express from "express";
import {
  getConfiguredReleaseControlBridgeRuntime,
  ReleaseControlBridgeError,
} from "@/lib/releaseControlHumanBridge";

const router = express.Router();

export default router.get("/", async (_req, res, next) => {
  try {
    const runtime = await getConfiguredReleaseControlBridgeRuntime();
    res.setHeader("cache-control", "public, max-age=300, must-revalidate");
    return res.status(200).send(runtime.authority.jwks);
  } catch (error) {
    if (error instanceof ReleaseControlBridgeError) {
      return res.status(error.status).send({
        error: { code: error.code, message: "发布器身份元数据暂不可用" },
      });
    }
    return next(error);
  }
});
