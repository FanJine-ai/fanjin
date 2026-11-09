import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success, error } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import {
  lockRelayConfigTablesForMutation,
  serializeRelayConfigMutation,
} from "@/lib/relayConfigValidation";
import {
  isBootstrapManagedModelRoute,
  recordModelRouteBootstrapTombstone,
} from "@/lib/modelRouteBootstrapTombstones";
import { isManagedModelRoute } from "@/lib/modelRouteGroups";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  id: z.string().trim().min(1),
  permanent: z.boolean().default(false),
}).strict();

type DeleteResult =
  | { kind: "missing" }
  | { kind: "managed" }
  | { kind: "enabled" }
  | { kind: "certified"; certificationCount: number }
  | { kind: "deleted"; route: Record<string, unknown>; bootstrapTombstone: boolean };

function isForeignKeyConflict(caught: unknown): boolean {
  const errorValue = caught as { code?: unknown; errno?: unknown; message?: unknown };
  const code = String(errorValue?.code ?? errorValue?.errno ?? "");
  const message = String(errorValue?.message ?? "");
  return code === "23503"
    || code === "SQLITE_CONSTRAINT_FOREIGNKEY"
    || /foreign key constraint/i.test(message);
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  if (!parsed.data.permanent) {
    const route = await db("o_model_route").where({ id: parsed.data.id }).first();
    if (!route) return res.status(404).send(error("Model route 不存在"));
    if (isManagedModelRoute(route)) {
      return res.status(409).send({
        message: "该物理路由由逻辑模型路由组管理，请在模型路由页停用整个路由组",
        code: "managed_model_route_requires_group_api",
      });
    }
    const count = await db("o_model_route").where({ id: parsed.data.id }).update({
      disabled: 1,
      updateTime: Date.now(),
    });

    if (!count) return res.status(404).send(error("Model route 不存在"));
    await writeAuditLog(req, {
      action: "admin.model_route.disable",
      resourceType: "model_route",
      resourceId: parsed.data.id,
      metadata: { disabled: 1 },
    });
    return res.status(200).send(success({ id: parsed.data.id, disabled: 1 }));
  }

  let result: DeleteResult;
  try {
    result = await serializeRelayConfigMutation(async () => db.transaction(async (trx) => {
      await lockRelayConfigTablesForMutation(trx);
      const route = await trx("o_model_route").where({ id: parsed.data.id }).first();
      if (!route) return { kind: "missing" as const };
      if (isManagedModelRoute(route)) return { kind: "managed" as const };
      if (Number(route.disabled) !== 1) return { kind: "enabled" as const };

      if (await trx.schema.hasTable("o_model_route_certification")) {
        const certificationRow = await trx("o_model_route_certification")
          .where({ routeId: parsed.data.id })
          .count({ total: "*" })
          .first();
        const certificationCount = Number(certificationRow?.total || 0);
        if (certificationCount > 0) {
          return { kind: "certified" as const, certificationCount };
        }
      }

      const bootstrapTombstone = isBootstrapManagedModelRoute(route.routeConfig)
        ? await recordModelRouteBootstrapTombstone(trx, {
            endpointType: String(route.endpointType || ""),
            model: String(route.model || ""),
            provider: String(route.provider || ""),
          })
        : false;
      const count = await trx("o_model_route").where({ id: parsed.data.id, disabled: 1 }).del();
      if (!count) return { kind: "missing" as const };
      return {
        kind: "deleted" as const,
        route: route as Record<string, unknown>,
        bootstrapTombstone,
      };
    }));
  } catch (caught) {
    if (isForeignKeyConflict(caught)) {
      return res.status(409).send({
        message: "该模型路由仍有关联的审计或生产记录，不能永久删除；请保持停用。",
        code: "model_route_delete_referenced",
      });
    }
    throw caught;
  }

  if (result.kind === "missing") return res.status(404).send(error("Model route 不存在"));
  if (result.kind === "managed") {
    return res.status(409).send({
      message: "该物理路由由逻辑模型路由组管理，不能绕过路由组永久删除",
      code: "managed_model_route_requires_group_api",
    });
  }
  if (result.kind === "enabled") {
    return res.status(409).send({
      message: "启用中的模型路由不能删除，请先停用后再删除。",
      code: "model_route_delete_requires_disabled",
    });
  }
  if (result.kind === "certified") {
    return res.status(409).send({
      message: `该模型路由包含 ${result.certificationCount} 条不可删除的生产认证记录，请保持停用以保留审计证据。`,
      code: "model_route_delete_certified",
    });
  }

  await writeAuditLog(req, {
    workspaceId: typeof result.route.workspaceId === "string" ? result.route.workspaceId : null,
    action: "admin.model_route.delete",
    resourceType: "model_route",
    resourceId: parsed.data.id,
    metadata: {
      permanent: true,
      name: result.route.name,
      model: result.route.model,
      endpointType: result.route.endpointType,
      provider: result.route.provider,
      channelId: result.route.channelId,
      scope: result.route.scope,
      bootstrapTombstone: result.bootstrapTombstone,
    },
  });
  return res.status(200).send(success({ id: parsed.data.id, deleted: true }));
});
