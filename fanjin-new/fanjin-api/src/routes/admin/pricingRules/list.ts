import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { relayEndpointTypes, relayProviders, relayScopes } from "@/lib/relay";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { listModelRouteGroups, toLogicalModelPricingView } from "@/lib/modelRouteGroups";
import { enrichModelRouteGroupPublication } from "@/lib/modelRoutePublication";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  scope: z.enum(relayScopes).optional(),
  workspaceId: z.string().optional(),
  endpointType: z.enum(relayEndpointTypes).optional(),
  provider: z.enum(relayProviders).optional(),
  model: z.string().optional(),
  includeDisabled: z.boolean().optional(),
  view: z.literal("logicalModels").optional(),
});

function parseJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  if (parsed.data.view === "logicalModels") {
    const groups = await enrichModelRouteGroupPublication(
      db,
      await listModelRouteGroups(db, {
        scope: parsed.data.scope,
        workspaceId: parsed.data.workspaceId,
        endpointType: parsed.data.endpointType,
        includeDisabled: parsed.data.includeDisabled ?? true,
      }),
    );
    return res.status(200).send(success(groups.map(toLogicalModelPricingView)));
  }

  const query = db("o_pricing_rule").orderBy("createTime", "desc");
  const data = parsed.data;
  if (data.scope) query.where("scope", data.scope);
  if (data.workspaceId) query.where("workspaceId", data.workspaceId);
  if (data.endpointType) query.where("endpointType", data.endpointType);
  if (data.provider) query.where("provider", data.provider);
  if (data.model) query.where("model", data.model);
  if (!data.includeDisabled) query.where("disabled", 0);

  const rows = await query;
  res.status(200).send(
    success(
      rows.map((row) => ({
        ...row,
        ruleConfig: parseJson(row.ruleConfig),
      })),
    ),
  );
});
