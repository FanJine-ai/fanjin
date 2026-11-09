import express from "express";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { listPricingGroups } from "@/lib/pricingGroups";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

export default router.post("/", async (_req, res) => {
  return res.status(200).send(success(await listPricingGroups(db)));
});
