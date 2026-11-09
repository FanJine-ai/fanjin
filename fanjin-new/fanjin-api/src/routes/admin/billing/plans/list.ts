import express from "express";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

router.use(requirePlatformAdmin);

export default router.post("/", async (_req, res) => {
  const rows = await db("o_billing_plan").orderBy("createdAt", "desc");
  res.status(200).send(
    success(
      rows.map((row: any) => ({
        ...row,
        metadata: parseMetadata(row.metadata),
      })),
    ),
  );
});

