import express from "express";
import { z } from "zod";
import { error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 打开本地文件夹仅在已下线的桌面客户端中有意义；Web 部署下始终不支持。
export default router.post(
  "/",
  validateFields({
    path: z.string(),
  }),
  async (_req, res) => {
    return res.status(400).send(error("仅支持客户端打开文件夹"));
  },
);
