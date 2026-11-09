import express from "express";
import { db } from "@/utils/db";
import { requireWorkspacePermission } from "@/middleware/permissions";
import { success } from "@/lib/responseFormat";
import { readMcpStatus } from "@/tools/presence";

const router = express.Router();
router.get("/", requireWorkspacePermission("project:read"), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const auth = (req as any).auth;
  if (!auth?.workspaceId || !auth?.user?.id) return res.status(401).json({ message: "请先登录工作区" });
  try {
    return res.json(success(await readMcpStatus(db, Number(auth.user.id), String(auth.workspaceId))));
  } catch {
    return res.status(503).json({ message: "暂时无法确认本地 MCP 状态", code: "MCP_STATUS_UNAVAILABLE" });
  }
});
export default router;
