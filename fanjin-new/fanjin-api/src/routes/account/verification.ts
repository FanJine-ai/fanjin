import express from "express";
import { z } from "zod";
import u from "@/utils";
import { buildVerificationPatch, getAccountProfile } from "@/lib/accountProfile";
import { success, error } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";

const router = express.Router();

const bodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("personal"),
    realName: z.string().trim().min(2).max(64),
    idNumber: z.string().trim().min(6).max(32),
    contactPhone: z.string().trim().min(5).max(32),
  }),
  z.object({
    type: z.literal("enterprise"),
    companyName: z.string().trim().min(2).max(128),
    unifiedSocialCreditCode: z.string().trim().min(6).max(64),
    legalRepresentative: z.string().trim().min(2).max(64),
    contactPhone: z.string().trim().min(5).max(32),
    businessLicenseUploaded: z.boolean().optional(),
  }),
]);

function currentUserId(req: express.Request): number {
  return Number(((req as any).auth?.user || (req as any).user || {}).id || 0);
}

router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const userId = currentUserId(req);
  if (!userId) return res.status(401).send(error("未登录"));

  const now = Date.now();
  const type = parsed.data.type;
  const id = `${userId}:${type}`;
  const patch = buildVerificationPatch(type, parsed.data as Record<string, unknown>);
  const workspaceId = (req as any).auth?.workspaceId || null;
  const db = u.db as any;
  const existing = await db("o_account_verification").where("id", id).first();

  if (existing) {
    await db("o_account_verification").where("id", id).update(patch);
  } else {
    await db("o_account_verification").insert({
      id,
      userId,
      workspaceId,
      type,
      createdAt: now,
      ...patch,
    });
  }

  await writeAuditLog(req, {
    workspaceId,
    action: "account.verification.submit",
    resourceType: "account_verification",
    resourceId: id,
    metadata: {
      type,
      status: "pending",
    },
  });

  const profile = await getAccountProfile({ userId, workspaceId });
  return res.status(200).send(success(profile?.verification?.[type] || null, "认证资料已提交，等待审核"));
});

export default router;
