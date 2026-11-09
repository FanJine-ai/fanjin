import express from "express";
import { createHmac } from "node:crypto";
import { requirePlatformRoot } from "@/middleware/permissions";
import { success } from "@/lib/responseFormat";

const router = express.Router();
router.use(requirePlatformRoot);
router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
router.get("/", (_req, res) => res.send(success({
  managed: /^[a-f0-9]{64}$/.test(process.env.FANJIN_COMMUNITY_UPDATE_SECRET || ""),
})));
router.post("/", (_req, res) => {
  const secret = process.env.FANJIN_COMMUNITY_UPDATE_SECRET || "";
  if (!/^[a-f0-9]{64}$/.test(secret)) return res.status(409).send({ code: "LOCAL_UPDATER_NOT_INSTALLED", message: "当前安装尚未接入本地更新器" });
  // The product issues a short-lived local UI capability, never a company
  // publisher credential or a shell/deployment command.
  const payload = Buffer.from(JSON.stringify({ scope: "local-update", expiresAt: Date.now() + 15 * 60_000 })).toString("base64url");
  const token = payload + "." + createHmac("sha256", secret).update(payload).digest("base64url");
  res.setHeader("Cache-Control", "no-store");
  return res.send(success({ path: "/__fanjin_update/#token=" + token }));
});
export default router;
