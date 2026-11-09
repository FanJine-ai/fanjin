// 用户兑换码兑换端点
import express from "express";
import { redeemCode } from "@/lib/redemptionCode";

const router = express.Router();

router.post("/redeem", async (req, res) => {
  const auth = (req as any).auth;
  if (!auth?.user?.id) return res.status(401).json({ error: { message: "请先登录" } });
  const { code } = req.body || {};
  const result = await redeemCode({ code, userId: auth.user.id });
  res.status(result.ok ? 200 : 400).json(result);
});

export default router;
