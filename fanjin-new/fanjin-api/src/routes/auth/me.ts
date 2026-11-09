import express from "express";
import { db } from "@/utils/db";
import { AuthError, getAuthProfile } from "@/lib/auth";
import { error, success } from "@/lib/responseFormat";

const router = express.Router();

export default router.get("/", async (req, res) => {
  try {
    const userId = Number((req as any).user?.id);
    if (!userId) throw new AuthError("未登录", 401);
    const profile = await getAuthProfile(db as any, userId);
    return res.status(200).send(success(profile));
  } catch (err: any) {
    const status = err instanceof AuthError ? err.status : 500;
    return res.status(status).send(error(err?.message || "获取用户失败"));
  }
});
