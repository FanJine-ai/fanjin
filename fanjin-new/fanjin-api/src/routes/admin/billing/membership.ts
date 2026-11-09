import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { writeAuditLog } from "@/lib/audit";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { MEMBERSHIP_PLANS, MEMBERSHIP_VERSION, MembershipError } from "@/lib/membershipCatalog";
import { membershipFundingContract, membershipFundingRuleSchema, parseMembershipFundingRules, validateMembershipFundingRules } from "@/lib/membershipFunding";
import { fulfillMembershipPeriod } from "@/lib/membership";
import { MEMBERSHIP_TABLES as T } from "@/lib/migrations/membershipEntitlements";

const router = express.Router();
router.use(requirePlatformAdmin);
router.post("/status", async (_req, res) => {
  const control = await db(T.control).where({ tenantId: "FANJIN" }).first();
  const periods = await db(`${T.period} as p`).join(`${T.subscription} as s`, "s.id", "p.subscriptionId")
    .where("s.tenantId", "FANJIN").orderBy("p.updatedAt", "desc").limit(100)
    .select("p.*", "s.workspaceId", "s.paymentOrderId", "s.planId", "s.status as subscriptionStatus");
  return res.send(success({ version: MEMBERSHIP_VERSION, plans: MEMBERSHIP_PLANS,
    salesEnabled: !!control?.salesEnabled, authorizationEnabled: !!control?.authorizationEnabled,
    fundingRules: parseMembershipFundingRules(control?.fundingRules), periods }));
});
router.post("/contract", async (req, res) => {
  const input = z.object({ channelId: z.string().min(1), pricingRuleId: z.string().min(1) }).strict().safeParse(req.body);
  if (!input.success) return res.status(400).send({ message: "请选择模型通道和定价规则" });
  const result = await membershipFundingContract(db, input.data.channelId, input.data.pricingRuleId);
  if (!result) return res.status(409).send({ message: "通道或定价规则不可用" });
  return res.send(success(result));
});
const configSchema = z.object({ version: z.literal(MEMBERSHIP_VERSION), salesEnabled: z.boolean(), authorizationEnabled: z.boolean(),
  fundingRules: z.array(membershipFundingRuleSchema).max(100), reason: z.string().trim().min(8).max(500) }).strict();
router.post("/configure", async (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).send({ message: "会员配置无效", errors: parsed.error.issues });
  try {
    await db.transaction(async trx => {
      const before = await trx(T.control).where({ tenantId: "FANJIN" }).forUpdate().first();
      if (!before) throw new MembershipError("会员数据尚未升级", "MEMBERSHIP_SCHEMA_REQUIRED", 409);
      const { reason, fundingRules, ...config } = parsed.data;
      if (config.salesEnabled && !config.authorizationEnabled) throw new MembershipError("开售前必须启用统一权益校验");
      // Closing sales must remain possible even if a cost attestation expired.
      if (config.salesEnabled) await validateMembershipFundingRules(trx, fundingRules);
      await trx(T.control).where({ tenantId: "FANJIN" }).update({ ...config, fundingRules: JSON.stringify(fundingRules), updatedAt: Date.now() });
      await writeAuditLog(req, { action: "admin.membership.configure", resourceType: "membership_control", resourceId: "FANJIN",
        required: true, metadata: { before, after: parsed.data, reason } }, trx);
    });
    return res.send(success({ saved: true }));
  } catch (error) {
    if (error instanceof MembershipError) return res.status(error.status).send({ message: error.message, code: error.code });
    throw error;
  }
});
router.post("/retry", async (req, res) => {
  const input = z.object({ periodId: z.string().uuid(), reason: z.string().trim().min(8).max(500) }).strict().safeParse(req.body);
  if (!input.success) return res.status(400).send({ message: "请填写期次编号和补发原因" });
  // Audit intent before the idempotent recovery; failures leave the period pending.
  await writeAuditLog(req, { action: "admin.membership.retry", resourceType: "membership_period", resourceId: input.data.periodId,
    required: true, metadata: { reason: input.data.reason } });
  const granted = await fulfillMembershipPeriod(input.data.periodId);
  return res.send(success({ granted }));
});
export default router;
