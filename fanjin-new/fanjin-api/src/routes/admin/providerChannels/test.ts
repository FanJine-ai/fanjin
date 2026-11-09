// 通道测试：管理员手动测试通道可用性
import express from "express";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { testChannel } from "@/lib/channelRouter";

const router = express.Router();

router.post("/:id/test", requirePlatformAdmin, async (req, res) => {
  const id = String(req.params.id);
  const result = await testChannel(id);
  res.json(result);
});

export default router;
