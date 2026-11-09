import express from "express";
import { error, success } from "@/lib/responseFormat";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import {
  getUserVideoEnhanceTask,
  toPublicUserVideoEnhanceTask,
} from "@/lib/videoFulfillment/userEnhance";
import { USER_VIDEO_ENHANCE_BILLING_SUBJECT } from "@/lib/videoFulfillment/recipes";

const router = express.Router();

/**
 * 创作台画质增强任务查询(异步收口):enhancing 状态下轮询超分通道,
 * 成功则资产入库 + video_enhance 结算,失败则释放冻结;终态直接返回。
 */
export default router.post(
  "/",
  requireActiveWorkspacePermission("generation:create"),
  async (req, res) => {
    const workspaceId = String((req as any).auth?.workspaceId || "");
    const taskId = String(req.body?.taskId || req.query?.taskId || "").trim();
    if (!taskId) return res.status(400).send(error("缺少 taskId", { code: "ENHANCE_TASK_ID_REQUIRED" }));
    try {
      const task = await getUserVideoEnhanceTask({ taskId, workspaceId });
      if (!task) return res.status(404).send(error("增强任务不存在", { code: "ENHANCE_TASK_NOT_FOUND" }));
      return res.status(200).send(
        success({
          billingSubject: USER_VIDEO_ENHANCE_BILLING_SUBJECT,
          task: await toPublicUserVideoEnhanceTask(task),
        }),
      );
    } catch (err: any) {
      console.error("[workbench-video-enhance] task query failed", taskId, err?.message || err);
      return res.status(500).send(error("增强任务查询失败", { code: "ENHANCE_TASK_QUERY_FAILED" }));
    }
  },
);
