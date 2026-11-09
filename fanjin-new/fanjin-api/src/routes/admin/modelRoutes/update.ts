import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success, error } from "@/lib/responseFormat";
import { relayEndpointTypes, relayProviders, relayScopes } from "@/lib/relay";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import {
  lockRelayConfigTablesForMutation,
  normalizeAndValidateModelRoute,
  normalizeModelRouteDisplayName,
  normalizeRouteConfigEnhanceDisplayName,
  RelayConfigValidationError,
  relayConfigValidationErrorBody,
  serializeRelayConfigMutation,
} from "@/lib/relayConfigValidation";
import {
  certifyModelRoute,
  ModelRouteCertificationError,
  revokeModelRouteCertification,
} from "@/lib/modelRouteCertification";
import { isManagedModelRoute } from "@/lib/modelRouteGroups";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  displayName: z.string().trim().max(200).optional().nullable(),
  scope: z.enum(relayScopes).optional(),
  workspaceId: z.string().trim().optional().nullable(),
  endpointType: z.enum(relayEndpointTypes).optional(),
  model: z.string().trim().min(1).optional(),
  provider: z.enum(relayProviders).optional().nullable(),
  channelId: z.string().trim().optional().nullable(),
  priority: z.number().int().optional(),
  fallbackOrder: z.number().int().optional(),
  routeConfig: z.record(z.string(), z.any()).optional(),
  disabled: z.number().int().min(0).max(1).optional(),
  certification: z.object({
    pricingRuleId: z.string().trim().min(1),
    operationKey: z.string().trim().min(1).max(100),
    priceSourceUrl: z.string().url().max(2_000),
    priceSourceDigest: z.string().regex(/^[a-fA-F0-9]{64}$/),
    priceCheckedAt: z.number().int().positive(),
    upstreamCurrency: z.string().trim().regex(/^[A-Z]{3}$/),
    upstreamUnitPriceMicros: z.number().int().positive(),
    billingCurrency: z.literal("GU"),
    billingDimension: z.string().trim().min(1).max(100),
    taskEvidenceId: z.string().trim().min(1).max(200),
    usageEvidenceId: z.string().trim().min(1).max(200),
    validUntil: z.number().int().positive(),
  }).strict().optional(),
  revokeCertification: z.object({
    operationKey: z.string().trim().min(1).max(100),
    reason: z.string().trim().min(3).max(500),
  }).strict().optional(),
});

function operatorUserId(req: express.Request): number {
  return Number((req as any).auth?.user?.id ?? (req as any).user?.id ?? 0);
}

function parseRouteConfig(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function modelRouteResponse(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName ?? null,
    scope: row.scope,
    workspaceId: row.workspaceId ?? null,
    endpointType: row.endpointType,
    model: row.model,
    provider: row.provider,
    channelId: row.channelId,
    priority: Number(row.priority),
    fallbackOrder: Number(row.fallbackOrder),
    routeConfig: parseRouteConfig(row.routeConfig),
    disabled: Number(row.disabled),
    createTime: Number(row.createTime),
    updateTime: Number(row.updateTime),
  };
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const { id, routeConfig, displayName, certification, revokeCertification, ...rest } = parsed.data;
  if (certification && revokeCertification) {
    return res.status(400).send(error("认证与撤销不能在同一次请求中执行"));
  }
  if (certification || revokeCertification) {
    const routeMutationFields = Object.keys(rest);
    if (routeConfig !== undefined || displayName !== undefined || routeMutationFields.length) {
      return res.status(400).send(error("认证操作不能与路由配置更新混合提交"));
    }
    try {
      const actorId = operatorUserId(req);
      const item = certification
        ? await certifyModelRoute(db, {
            routeId: id,
            ...certification,
            certifiedByUserId: actorId,
          })
        : await revokeModelRouteCertification(db, {
            routeId: id,
            operationKey: revokeCertification!.operationKey,
            reason: revokeCertification!.reason,
            revokedByUserId: actorId,
          });
      await writeAuditLog(req, {
        action: certification
          ? "admin.model_route.certify"
          : "admin.model_route.certification_revoke",
        resourceType: "model_route_certification",
        resourceId: item.id,
        metadata: {
          routeId: id,
          operationKey: item.operationKey,
          pricingRuleId: item.pricingRuleId,
          taskEvidenceId: item.taskEvidenceId,
          usageEvidenceId: item.usageEvidenceId,
          priceSourceDigest: item.priceSourceDigest,
          validUntil: item.validUntil,
          revokedAt: item.revokedAt,
        },
      });
      return res.status(200).send(success(item));
    } catch (caught) {
      if (caught instanceof ModelRouteCertificationError) {
        return res.status(caught.statusCode).send({
          message: caught.message,
          code: caught.code,
        });
      }
      throw caught;
    }
  }
  let result:
    | { kind: "missing" }
    | { kind: "managed" }
    | { kind: "updated"; responseData: Record<string, unknown>; auditPatch: Record<string, unknown> };
  try {
    result = await serializeRelayConfigMutation(async () => db.transaction(async (trx) => {
      await lockRelayConfigTablesForMutation(trx);
      const existing = await trx("o_model_route").where({ id }).first();
      if (!existing) return { kind: "missing" as const };
      if (isManagedModelRoute(existing)) return { kind: "managed" as const };

      const integrity = await normalizeAndValidateModelRoute(trx, {
        scope: rest.scope ?? existing.scope,
        workspaceId: rest.workspaceId !== undefined ? rest.workspaceId : existing.workspaceId,
        endpointType: rest.endpointType ?? existing.endpointType,
        provider: rest.provider !== undefined ? rest.provider : existing.provider,
        channelId: rest.channelId !== undefined ? rest.channelId : existing.channelId,
        disabled: rest.disabled ?? existing.disabled,
      });
      const updateData: Record<string, unknown> = {
        ...rest,
        ...integrity,
        updateTime: Date.now(),
      };
      if (displayName !== undefined) updateData.displayName = normalizeModelRouteDisplayName(displayName);
      const normalizedRouteConfig = routeConfig !== undefined
        ? normalizeRouteConfigEnhanceDisplayName(routeConfig)
        : undefined;
      if (normalizedRouteConfig !== undefined) updateData.routeConfig = JSON.stringify(normalizedRouteConfig);

      const count = await trx("o_model_route").where({ id }).update(updateData);
      if (!count) return { kind: "missing" as const };
      const persisted = await trx("o_model_route").where({ id }).first();
      if (!persisted) return { kind: "missing" as const };
      if (displayName !== undefined) {
        const { mirrorRouteDisplayNameToOffer } = await import("@/lib/videoFulfillment/adminService");
        await mirrorRouteDisplayNameToOffer(trx, {
          model: String(persisted.model || existing.model || ""),
          displayName: persisted.displayName,
          endpointType: String(persisted.endpointType || existing.endpointType || ""),
        });
      }
      return {
        kind: "updated" as const,
        responseData: modelRouteResponse(persisted as unknown as Record<string, unknown>),
        auditPatch: {
          ...updateData,
          ...(normalizedRouteConfig !== undefined ? { routeConfig: normalizedRouteConfig } : {}),
        },
      };
    }));
  } catch (caught) {
    if (caught instanceof RelayConfigValidationError) {
      return res.status(caught.statusCode).send(relayConfigValidationErrorBody(caught));
    }
    throw caught;
  }

  if (result.kind === "missing") return res.status(404).send(error("Model route 不存在"));
  if (result.kind === "managed") {
    return res.status(409).send({
      message: "该物理路由由逻辑模型路由组管理，请在模型路由页编辑整个路由组",
      code: "managed_model_route_requires_group_api",
    });
  }
  await writeAuditLog(req, {
    workspaceId: typeof result.responseData.workspaceId === "string" ? result.responseData.workspaceId : null,
    action: "admin.model_route.update",
    resourceType: "model_route",
    resourceId: id,
    metadata: result.auditPatch,
  });
  res.status(200).send(success(result.responseData));
});
