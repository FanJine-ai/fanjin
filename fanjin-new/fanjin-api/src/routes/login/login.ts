import express from "express";
import { db } from "@/utils/db";
import jwt from "jsonwebtoken";
import { AuthError, loginWithPassword } from "@/lib/auth";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getBooleanPlatformSetting } from "@/lib/platformSettings";
import { z } from "zod";
const router = express.Router();

export function setToken(payload: string | object, expiresIn: string | number, secret: string): string {
  if (!payload || typeof secret !== "string" || !secret) {
    throw new Error("参数不合法");
  }
  return (jwt.sign as any)(payload, secret, { expiresIn });
}

// 登录
export default router.post(
  "/",
  validateFields({
    username: z.string(),
    password: z.string(),
  }),
  async (req, res) => {
    const { username, password } = req.body;

    try {
      const passwordLoginEnabled = await getBooleanPlatformSetting("platform.auth.passwordLoginEnabled", true);
      if (!passwordLoginEnabled) {
        return res.status(403).send(error("当前已关闭账号密码登录，请使用企业指定登录方式。"));
      }
      const result = (await loginWithPassword(db as any, username, password, {
        userAgent: Array.isArray(req.headers["user-agent"])
          ? req.headers["user-agent"].join(",")
          : req.headers["user-agent"],
        ip: req.ip,
      })) as any;
      return res.status(200).send(
        success(
          {
            token: result.token,
            name: result.user?.name,
            id: result.user?.id,
            user: result.user,
            workspace: result.workspace,
            workspaces: result.workspaces,
            security: result.security,
          },
          "登录成功",
        ),
      );
    } catch (err: any) {
      const status = err instanceof AuthError ? err.status : 400;
      if (err instanceof AuthError && err.retryAfterSeconds) res.setHeader("Retry-After", String(err.retryAfterSeconds));
      return res.status(status).send(error(
        err?.message || "用户名或密码错误",
        err instanceof AuthError ? { code: err.code, ...(err.data || {}) } : null,
      ));
    }
  },
);
