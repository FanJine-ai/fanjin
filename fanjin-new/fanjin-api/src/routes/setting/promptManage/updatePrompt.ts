import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requirePlatformAdmin } from "@/middleware/permissions";
const router = express.Router();

export default router.post(
  "/",
  requirePlatformAdmin,
  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    const { id, data } = req.body;
    await u.db("o_prompt").where("id", id).update({
      useData: data,
    });
    res.status(200).send(success(123));
  },
);
