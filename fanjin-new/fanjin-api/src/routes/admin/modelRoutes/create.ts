import express from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
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
import { isManagedModelRoute } from "@/lib/modelRouteGroups";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  name: z.string().trim().min(1),
  displayName: z.string().trim().max(200).optional().nullable(),
  scope: z.enum(relayScopes).default("platform"),
  workspaceId: z.string().trim().optional().nullable(),
  endpointType: z.enum(relayEndpointTypes),
  model: z.string().trim().min(1),
  provider: z.enum(relayProviders).optional().nullable(),
  channelId: z.string().trim().optional().nullable(),
  priority: z.number().int().default(100),
  fallbackOrder: z.number().int().default(0),
  routeConfig: z.record(z.string(), z.any()).default({}),
  disabled: z.number().int().min(0).max(1).default(0),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const now = Date.now();
  const id = uuid();
  const data = parsed.data;
  const routeConfig = normalizeRouteConfigEnhanceDisplayName(data.routeConfig);
  if (isManagedModelRoute({ routeConfig })) {
    return res.status(409).send({
      message: "逻辑模型路由必须通过模型路由组向导创建",
      code: "managed_model_route_requires_group_api",
    });
  }
  let created: Record<string, unknown>;
  try {
    created = await serializeRelayConfigMutation(async () => db.transaction(async (trx) => {
      await lockRelayConfigTablesForMutation(trx);
      const integrity = await normalizeAndValidateModelRoute(trx, data);
      const row = {
        id,
        name: data.name,
        displayName: normalizeModelRouteDisplayName(data.displayName),
        ...integrity,
        model: data.model,
        priority: data.priority,
        fallbackOrder: data.fallbackOrder,
        routeConfig: JSON.stringify(routeConfig),
        createTime: now,
        updateTime: now,
      };
      await trx("o_model_route").insert(row);
      if (data.displayName !== undefined) {
        const { mirrorRouteDisplayNameToOffer } = await import("@/lib/videoFulfillment/adminService");
        await mirrorRouteDisplayNameToOffer(trx, {
          model: String(data.model || ""),
          displayName: row.displayName as string | null,
          endpointType: String((integrity as any).endpointType || data.endpointType || ""),
        });
      }
      return { ...row, routeConfig };
    }));
  } catch (caught) {
    if (caught instanceof RelayConfigValidationError) {
      return res.status(caught.statusCode).send(relayConfigValidationErrorBody(caught));
    }
    throw caught;
  }

  await writeAuditLog(req, {
    workspaceId: typeof created.workspaceId === "string" ? created.workspaceId : null,
    action: "admin.model_route.create",
    resourceType: "model_route",
    resourceId: id,
    metadata: created,
  });

  res.status(200).send(success(created));
});
