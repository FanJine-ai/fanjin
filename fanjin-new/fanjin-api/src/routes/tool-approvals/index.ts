import express from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getToolService } from "@/tools/runtime";
import { ToolError, toolFailure } from "@/tools/contracts";
import { transportGuard } from "@/tools/transport";
const router = express.Router();
router.use(transportGuard({ authenticate: (_q, _s, next) => next(), service: getToolService }));
// Mounted outside API-key tools: the normal session middleware validates JWT + active session.
router.use((req, res, next) => {
  if (!(req as any).auth?.user?.id || (req as any).apiKey) return res.status(401).json({ message: "请以密钥所属用户登录后确认" });
  next();
});
router.get("/:approvalId", async (req, res) => {
  try {
    const id = z.string().uuid().parse(req.params.approvalId);
    const service = (await getToolService()).creation;
    if (!service) throw new ToolError("UNAVAILABLE", "确认功能尚未配置", 503);
    res.json({ data: await service.review(Number((req as any).auth.user.id), id) });
  } catch (e) { const f = toolFailure(e, randomUUID()); res.status(f.status).json(f.body); }
});
router.post("/:approvalId", async (req, res) => {
  try {
    const id = z.string().uuid().parse(req.params.approvalId);
    const body = z.strictObject({ decision: z.enum(["approved", "rejected"]), quoteId: z.string().uuid() }).parse(req.body);
    const service = (await getToolService()).creation;
    if (!service) throw new ToolError("UNAVAILABLE", "确认功能尚未配置", 503);
    res.json({ data: await service.decide(Number((req as any).auth.user.id), id, body.decision, body.quoteId) });
  } catch (e) { const f = toolFailure(e, randomUUID()); res.status(f.status).json(f.body); }
});
export default router;
