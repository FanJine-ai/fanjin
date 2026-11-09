import express from "express";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { readPlatformSettings } from "@/lib/platformSettings";
import { uiStatePatchSchema, workbenchUiState } from "@/lib/workbenchUiState";
import { FRONTSTAGE_RELEASE_NOTES, latestReleaseNotificationId, hashText } from "../../../../../contracts/ui/notifications";
export const bodySchema = uiStatePatchSchema;
const router = express.Router();
const handler: express.RequestHandler = async (req, res) => {
  if (!["GET", "POST"].includes(req.method)) return res.sendStatus(405);
  const userId = Number((req as any).auth?.user?.id), workspaceId = (req as any).auth?.workspaceId;
  if (!userId || !workspaceId) return res.status(401).json({ message: "请登录工作区" });
  const parsed = bodySchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(422).json({ message: "设置参数不正确", errors: parsed.error.issues });
  try {
    const { settings } = await readPlatformSettings();
    const notice = String(settings["platform.site.notice"] || "").trim();
    const notifications = [
      ...(notice ? [{ id: `announcement:${hashText(notice)}`, kind: "announcement", title: "平台公告", body: notice }] : []),
      { id: latestReleaseNotificationId, kind: "release", title: FRONTSTAGE_RELEASE_NOTES[0].title, body: FRONTSTAGE_RELEASE_NOTES[0].summary },
    ];
    const patch = req.method === "GET" ? undefined : { ...parsed.data,
      ...(parsed.data.markAllRead ? { readIds: [...parsed.data.readIds || [], ...notifications.map(n => n.id)] } : {}) };
    const state = await workbenchUiState(db, { userId, workspaceId }, patch);
    return res.json(success({ ...state, notifications: notifications.map(n => ({ ...n, read: state.readIds.includes(n.id) })) }));
  } catch (error: any) {
    return res.status(error.status || 500).json({ code: error.code || "UI_STATE_UNAVAILABLE", message: error.status ? error.message : "界面设置暂不可用" });
  }
};
router.get("/", handler);
router.post("/", handler);
export default router;
