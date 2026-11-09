import express from "express";
import { requireAgentRuntimePreview } from "@/agent-runtime/featureFlags";
import { agentSuccess, sendAgentRuntimeError } from "@/agent-runtime/http";
import { getAgentRequestActor } from "@/agent-runtime/httpAccess";
import { inspectAgentSurfaceAvailability } from "@/agent-runtime/surfaceAvailability";

const router = express.Router({ mergeParams: true });
router.use(requireAgentRuntimePreview);

// GET /api/agent/chat-models — 主 Agent 对话模型目录。
// 返回值是 Agent 执行与发布门禁的唯一事实源。available=true 仍要求
// Worker、真实文本路由、图片/视频生成和对应 GU 计费链路全部就绪；
// capabilities 与 models 允许前台在单项生成能力退化时保持真实对话。
router.get("/", async (req , res) => {
  try {
    const actor = getAgentRequestActor(req);
    const availability = await inspectAgentSurfaceAvailability({
      workspaceId: actor.workspaceId,
    });
    return res.status(200).send(agentSuccess(availability));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

export default router;
