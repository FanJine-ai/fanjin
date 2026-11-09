import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success, error } from "@/lib/responseFormat";
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
import { isLogicalModelManagedPricingRule, toLogicalModelPricingView } from "@/lib/modelRouteGroups";
import {
  ModelRouteGroupMutationError,
  updateLogicalModelPrice,
} from "@/lib/modelRouteGroupMutation";
import { logicalPriceSchema } from "@/lib/modelRouteGroupSchemas";
import { enrichModelRouteGroupPublication } from "@/lib/modelRoutePublication";
import { validatePricingGroupReferences } from "@/lib/pricingGroups";

const router = express.Router();
router.use(requirePlatformAdmin);

function parseRuleConfig(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

const pricingRuleBodySchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).optional(),
  scope: z.enum(relayScopes).optional(),
  workspaceId: z.string().trim().optional().nullable(),
  endpointType: z.enum(relayEndpointTypes).optional(),
  provider: z.enum(relayProviders).optional().nullable(),
  model: z.string().trim().optional().nullable(),
  unit: z.string().trim().min(1).optional(),
  unitPriceMicros: z.number().int().min(0).optional(),
  currency: z.string().optional(),
  ruleConfig: z.record(z.string(), z.any()).optional(),
  disabled: z.number().int().min(0).max(1).optional(),
});

const logicalModelPriceBodySchema = z.object({
  groupKey: z.string().trim().min(1),
  pricing: logicalPriceSchema,
}).strict();

const bodySchema = z.union([logicalModelPriceBodySchema, pricingRuleBodySchema]);

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  if ("groupKey" in parsed.data) {
    try {
      const rawSaved = await updateLogicalModelPrice(db, parsed.data);
      const saved = (await enrichModelRouteGroupPublication(db, [rawSaved]))[0];
      await writeAuditLog(req, {
        workspaceId: saved.workspaceId,
        action: "admin.pricing_rule.update",
        resourceType: "model_route_group",
        resourceId: saved.groupKey,
        metadata: {
          pricingRuleId: saved.pricing?.id || null,
          unit: saved.pricing?.unit || null,
          unitPriceMicros: saved.pricing?.unitPriceMicros || null,
          mirroredProviderCount: new Set(saved.targets.map((target) => target.provider)).size,
          publicationStatus: saved.publication.status,
        },
      });
      return res.status(200).send(success(toLogicalModelPricingView(saved)));
    } catch (caught) {
      if (caught instanceof ModelRouteGroupMutationError) {
        return res.status(caught.statusCode).send({ message: caught.message, code: caught.code, errors: caught.issues });
      }
      throw caught;
    }
  }

  const { id, ruleConfig, ...rest } = parsed.data;
  const result = await serializePricingRuleMutation(async () => db.transaction(async (trx) => {
    await lockPricingRuleTableForMutation(trx);
    const existing = await trx("o_pricing_rule").where({ id }).first();
    if (!existing) return { kind: "missing" as const };
    if (isLogicalModelManagedPricingRule(existing)) return { kind: "managed" as const };

    const nextDisabled = rest.disabled ?? Number(existing.disabled || 0);
    const nextUnitPriceMicros = rest.unitPriceMicros ?? Number(existing.unitPriceMicros || 0);
    if (nextUnitPriceMicros < 0) {
      return {
        kind: "invalid" as const,
        message: "价格规则 unitPriceMicros 不能小于 0",
        errors: [{ path: ["unitPriceMicros"], message: "单价不能小于 0" }],
      };
    }
    if (nextDisabled === 0 && nextUnitPriceMicros <= 0) {
      return {
        kind: "invalid" as const,
        message: "启用的价格规则 unitPriceMicros 必须大于 0；停用规则可使用 0",
        errors: [{ path: ["unitPriceMicros"], message: "启用规则单价必须大于 0" }],
      };
    }

    const selector = normalizePricingRuleSelector({
      scope: rest.scope ?? existing.scope,
      workspaceId: rest.workspaceId !== undefined ? rest.workspaceId : existing.workspaceId,
      endpointType: rest.endpointType ?? existing.endpointType,
      provider: rest.provider !== undefined ? rest.provider : existing.provider,
      model: rest.model !== undefined ? rest.model : existing.model,
      unit: rest.unit ?? existing.unit,
      disabled: nextDisabled,
    });
    const nextRuleConfig = ruleConfig === undefined ? parseRuleConfig(existing.ruleConfig) : ruleConfig;
    const selectorIssues = validatePricingRuleSelector(selector, nextRuleConfig);
    const pricingGroupIssues = await validatePricingGroupReferences(trx, nextRuleConfig);
    selectorIssues.push(...pricingGroupIssues.map((issue) => ({
      path: ["ruleConfig", "audiencePricing", "groups", issue.group],
      message: issue.message,
    })));
    if (selectorIssues.length > 0) {
      return {
        kind: "invalid" as const,
        message: "价格规则契约无效",
        errors: selectorIssues,
      };
    }
    if (!(await pricingRuleWorkspaceExists(trx, selector))) {
      return {
        kind: "invalid" as const,
        message: "workspaceId 无效：工作区不存在或已停用",
        errors: [{ path: ["workspaceId"], message: "请选择有效的活动工作区" }],
      };
    }
    const duplicateId = await findEnabledPricingRuleSelectorDuplicate(trx, selector, id);
    if (duplicateId) return { kind: "duplicate" as const, duplicateId };

    const updateData: Record<string, unknown> = {
      ...rest,
      scope: selector.scope,
      workspaceId: selector.workspaceId,
      endpointType: selector.endpointType,
      provider: selector.provider,
      model: selector.model,
      unit: selector.unit,
      disabled: selector.disabled,
      updateTime: Date.now(),
    };
    if (ruleConfig !== undefined) updateData.ruleConfig = JSON.stringify(ruleConfig);

    const count = await trx("o_pricing_rule").where({ id }).update(updateData);
    if (!count) return { kind: "missing" as const };
    return { kind: "updated" as const, selector, updateData };
  }));

  if (result.kind === "missing") return res.status(404).send(error("Pricing rule 不存在"));
  if (result.kind === "managed") {
    return res.status(409).send({
      message: "该价格属于逻辑模型，请在模型定价页统一调整",
      code: "managed_logical_price_requires_group_api",
    });
  }
  if (result.kind === "invalid") {
    return res.status(400).send({ message: result.message, errors: result.errors });
  }
  if (result.kind === "duplicate") {
    return res.status(409).send({
      message: "已存在启用的相同价格规则选择器",
      data: { conflictId: result.duplicateId },
    });
  }

  await writeAuditLog(req, {
    workspaceId: result.selector.workspaceId,
    action: "admin.pricing_rule.update",
    resourceType: "pricing_rule",
    resourceId: id,
    metadata: result.updateData,
  });
  res.status(200).send(success({ id, ...result.updateData }));
});
