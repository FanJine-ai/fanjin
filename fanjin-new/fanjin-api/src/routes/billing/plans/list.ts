import express from "express";
import { z } from "zod";
import { listBillingPlans } from "@/lib/billing";
import { success } from "@/lib/responseFormat";

const router = express.Router();

const bodySchema = z.object({
  includeArchived: z.boolean().optional(),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  res.status(200).send(success(await listBillingPlans(parsed.data)));
});
