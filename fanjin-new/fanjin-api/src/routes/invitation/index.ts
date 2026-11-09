// 邀请奖励端点
import express from "express";
import { ensureInvitationCode, processInvitation, listInvitations, getInvitationStats } from "@/lib/invitationReward";

const router = express.Router();

// 获取我的邀请码
router.get("/my-code", async (req, res) => {
  const auth = (req as any).auth;
  if (!auth?.user?.id) return res.status(401).json({ error: { message: "请先登录" } });
  const code = await ensureInvitationCode(auth.user.id);
  const stats = await getInvitationStats(auth.user.id);
  res.json({ code, ...stats });
});

// 使用邀请码注册（注册流程中调用）
router.post("/use", async (req, res) => {
  const auth = (req as any).auth;
  if (!auth?.user?.id) return res.status(401).json({ error: { message: "请先登录" } });
  const { invitationCode } = req.body || {};
  const result = await processInvitation({ inviteeUserId: auth.user.id, invitationCode });
  res.status(result.ok ? 200 : 400).json(result);
});

// 我的邀请记录
router.get("/list", async (req, res) => {
  const auth = (req as any).auth;
  if (!auth?.user?.id) return res.status(401).json({ error: { message: "请先登录" } });
  const { page, pageSize } = req.query;
  const result = await listInvitations(auth.user.id, Number(page) || 1, Number(pageSize) || 20);
  res.json(result);
});

export default router;
