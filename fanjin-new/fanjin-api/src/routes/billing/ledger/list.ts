import express from "express";
import { z } from "zod";
import { listBillingLedger } from "@/lib/billing";
import { success } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();
router.use(requireWorkspacePermission("billing:read"));

const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  pageNum: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const workspaceId = parsed.data.workspaceId || (req as any).auth?.workspaceId || "default";
  res.status(200).send(
    success(
      await listBillingLedger({
        workspaceId,
        pageNum: parsed.data.pageNum,
        pageSize: parsed.data.pageSize,
      }),
    ),
  );
});
