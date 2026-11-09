import express from "express";
import { db } from "@/utils/db";
import { extractBearerToken, revokeSession } from "@/lib/auth";
import { success } from "@/lib/responseFormat";

const router = express.Router();

export default router.post("/", async (req, res) => {
  const rawToken = extractBearerToken(req.headers.authorization || (req.query.token as string) || "");
  await revokeSession(db as any, rawToken, (req as any).user?.sid);
  return res.status(200).send(success(null, "退出登录成功"));
});
