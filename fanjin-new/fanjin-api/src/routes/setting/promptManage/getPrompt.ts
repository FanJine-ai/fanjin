import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();

export default router.post("/", requirePlatformAdmin, async (req, res) => {
  const list = await u.db("o_prompt").select("*");
  const data = await Promise.all(
    list.map(async (item) => {
      return {
        ...item,
        data: item.useData ? item.useData : item.data,
      };
    }),
  );
  res.status(200).send(success(data));
});
