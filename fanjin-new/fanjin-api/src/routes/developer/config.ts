import express from "express";
import { readPlatformSettings } from "@/lib/platformSettings";
import { success } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();
const readNotice: express.RequestHandler = async (_req, res) => {
  const { settings } = await readPlatformSettings();
  return res.status(200).send(success({ notice: settings["platform.site.notice"] }));
};
router.get("/notice", requireWorkspacePermission("workspace:read"), readNotice);
router.post("/notice", requireWorkspacePermission("workspace:read"), readNotice);
router.use(requireWorkspacePermission("api_key:read"));

export function publicUrl(req: express.Request, configured?: string | number | boolean): string {
  const value = String(configured || "").trim().replace(/\/+$/, "");
  const base = new URL(value || `${req.protocol}://${req.get("host")}`);
  const publicBase = process.env.FANJIN_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL;
  const configuredPublicBase = publicBase ? new URL(publicBase) : null;
  if (base.protocol === "http:" && (
    (req.secure && base.host === req.get("host"))
    || (configuredPublicBase?.protocol === "https:" && configuredPublicBase.hostname === base.hostname)
  )) base.protocol = "https:";
  return base.toString().replace(/\/+$/, "");
}

export default router.post("/", async (req, res) => {
  const { settings } = await readPlatformSettings();
  const apiBaseUrl = publicUrl(req, settings["platform.site.serverAddress"]);
  return res.status(200).send(
    success({
      systemName: settings["platform.site.systemName"],
      apiBaseUrl,
      docsLink: settings["platform.site.docsLink"],
      notice: settings["platform.site.notice"],
      endpoint: `${apiBaseUrl}/api/v3/contents/generations/tasks`,
      supportedResolutions: ["480p", "720p", "1080p", "2160p"],
    }),
  );
});
