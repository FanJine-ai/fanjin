import express from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { relayEndpointTypes, relayProviders, relayScopes } from "@/lib/relay";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import {
  findEnabledPricingRuleSelectorDuplicate,
  lockPricingRuleTableForMutation,
  normalizePricingRuleSelector,
  pricingRuleWorkspaceExists,
  serializePricingRuleMutation,
  validatePricingRuleSelector,
} from "@/lib/pricingRuleValidation";
import { isLogicalModelManagedPricingRule } from "@/lib/modelRouteGroups";
import { validatePricingGroupReferences } from "@/lib/pricingGroups";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  name: z.string().trim().min(1),
  scope: z.enum(relayScopes).default("platform"),
  workspaceId: z.string().trim().optional().nullable(),
  endpointType: z.enum(relayEndpointTypes),
  provider: z.enum(relayProviders).optional().nullable(),
  model: z.string().trim().optional().nullable(),
  unit: z.string().trim().min(1).default("task"),
  unitPriceMicros: z.number().int().min(0).default(0),
  currency: z.string().default("GU"),
  ruleConfig: z.record(z.string(), z.any()).default({}),
  disabled: z.number().int().min(0).max(1).default(0),
}).superRefine((data, context) => {
  if (data.disabled === 0 && data.unitPriceMicros <= 0) {
    context.addIssue({
      code: "custom",
      path: ["unitPriceMicros"],
      message: "启用的价格规则 unitPriceMicros 必须大于 0；停用规则可使用 0",
    });
  }
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const now = Date.now();
  const id = uuid();
  const data = parsed.data;
  if (isLogicalModelManagedPricingRule({ ruleConfig: data.ruleConfig })) {
    return res.status(409).send({
      message: "逻辑模型售价及运行时镜像必须通过模型定价页维护",
      code: "managed_logical_price_requires_group_api",
    });
  }
  const selector = normalizePricingRuleSelector(data);
  const selectorIssues = validatePricingRuleSelector(selector, data.ruleConfig);
  if (selectorIssues.length > 0) {
    return res.status(400).send({ message: "价格规则契约无效", errors: selectorIssues });
  }

  let workspaceExists = true;
  let duplicateId: string | null = null;
  let pricingGroupErrors: Array<{ group: string; message: string }> = [];
  await serializePricingRuleMutation(async () => {
    await db.transaction(async (trx) => {
      await lockPricingRuleTableForMutation(trx);
      pricingGroupErrors = await validatePricingGroupReferences(trx, data.ruleConfig);
      if (pricingGroupErrors.length) return;
      workspaceExists = await pricingRuleWorkspaceExists(trx, selector);
      if (!workspaceExists) return;
      duplicateId = await findEnabledPricingRuleSelectorDuplicate(trx, selector);
      if (duplicateId) return;
      await trx("o_pricing_rule").insert({
        id,
        name: data.name,
        scope: selector.scope,
        workspaceId: selector.workspaceId,
        endpointType: selector.endpointType,
        provider: selector.provider,
        model: selector.model,
        unit: selector.unit,
        unitPriceMicros: data.unitPriceMicros,
        currency: data.currency,
        ruleConfig: JSON.stringify(data.ruleConfig),
        disabled: selector.disabled,
        createTime: now,
        updateTime: now,
      });
    });
  });

  if (pricingGroupErrors.length) {
    return res.status(409).send({
      message: "价格规则引用了未创建或已停用的定价分组",
      code: "PRICING_GROUP_REFERENCE_INVALID",
      errors: pricingGroupErrors,
    });
  }

  if (!workspaceExists) {
    return res.status(400).send({
      message: "workspaceId 无效：工作区不存在或已停用",
      errors: [{ path: ["workspaceId"], message: "请选择有效的活动工作区" }],
    });
  }
  if (duplicateId) {
    return res.status(409).send({
      message: "已存在启用的相同价格规则选择器",
      data: { conflictId: duplicateId },
    });
  }

  await writeAuditLog(req, {
    workspaceId: selector.workspaceId,
    action: "admin.pricing_rule.create",
    resourceType: "pricing_rule",
    resourceId: id,
    metadata: { ...data, ...selector },
  });

  res.status(200).send(success({ id, ...data, ...selector, createTime: now, updateTime: now }));
});
