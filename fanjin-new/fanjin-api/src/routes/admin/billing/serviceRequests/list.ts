import express from "express";
import { z } from "zod";
import { listBillingServiceRequests } from "@/lib/billingServiceRequests";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  type: z.enum(["invoice", "credit_limit", "offline_payment"]).optional().nullable(),
  status: z.enum(["pending", "approved", "rejected", "issued", "cancelled"]).optional().nullable(),
  pageNum: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });
  return res.status(200).send(success(await listBillingServiceRequests(parsed.data)));
});
