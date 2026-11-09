import { auditAnalyticsExport } from "@/analytics/audit";
import express from "express";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { createAnalyticsService } from "@/analytics/service";
import { analyticsActions, AnalyticsError, type AnalyticsAction } from "@/analytics/contracts";

const router = express.Router();
const service = createAnalyticsService(db, Date.now, auditAnalyticsExport);
router.post("/:action", async (req, res, next) => {
  const auth = (req as any).auth;
  const userId = Number(auth?.user?.id || (req as any).user?.id || 0);
  if (!userId || (req as any).apiKey) return res.status(401).send({ message: "请登录；机器调用请使用 Tools API", code: "SESSION_REQUIRED" });
  if (!analyticsActions.includes(req.params.action as AnalyticsAction)) return res.status(404).send({ message: "查询不存在" });
  try {
    const data = await service.execute({ userId, workspaceId: auth?.workspaceId }, req.params.action as AnalyticsAction, req.body ?? {});
    return res.status(200).send(success(data));
  } catch (error) {
    if (error instanceof AnalyticsError) return res.status(error.status).send({ message: error.message, code: error.code });
    return next(error);
  }
});
export default router;
