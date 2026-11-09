import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { relayEndpointTypes, relayProviders, relayScopes } from "@/lib/relay";
import {
  normalizeAndValidateModelRoute,
  RelayConfigValidationError,
  relayConfigValidationErrorBody,
} from "@/lib/relayConfigValidation";
import { explainWorkbenchModelRouteReadiness } from "@/lib/workbenchModelCatalog";
import { listModelRouteCertificationHistory } from "@/lib/modelRouteCertification";
import { requirePlatformAdmin } from "@/middleware/permissions";

const router = express.Router();
router.use(requirePlatformAdmin);

const preflightBodySchema = z.object({
  id: z.string().trim().min(1).optional(),
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

const bodySchema = z.object({
  scope: z.enum(relayScopes).optional(),
  workspaceId: z.string().optional(),
  endpointType: z.enum(relayEndpointTypes).optional(),
  model: z.string().optional(),
  provider: z.enum(relayProviders).optional(),
  includeDisabled: z.boolean().optional(),
  includeReadiness: z.boolean().optional(),
  includeCertifications: z.boolean().optional(),
  readinessWorkspaceId: z.string().trim().min(1).optional(),
  preflight: preflightBodySchema.optional(),
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

  const data = parsed.data;
  if (data.preflight) {
    try {
      const integrity = await normalizeAndValidateModelRoute(db, data.preflight);
      const readiness = await explainWorkbenchModelRouteReadiness({
        route: { ...data.preflight, ...integrity },
        workspaceId: data.readinessWorkspaceId || (req as any).auth?.workspaceId || "default",
        database: db,
      });
      return res.status(200).send(success(readiness));
    } catch (caught) {
      if (caught instanceof RelayConfigValidationError) {
        return res.status(caught.statusCode).send(relayConfigValidationErrorBody(caught));
      }
      throw caught;
    }
  }

  const query = db("o_model_route").orderBy("priority", "asc").orderBy("fallbackOrder", "asc");
  if (data.scope) query.where("scope", data.scope);
  if (data.workspaceId) query.where("workspaceId", data.workspaceId);
  if (data.endpointType) query.where("endpointType", data.endpointType);
  if (data.model) query.where("model", data.model);
  if (data.provider) query.where("provider", data.provider);
  if (!data.includeDisabled) query.where("disabled", 0);

  const rows = await query;
  const formattedRows = rows.map((row) => ({
    ...row,
    displayName: row.displayName ?? null,
    routeConfig: parseJson(row.routeConfig),
  }));
  const responseRows = data.includeReadiness || data.includeCertifications
    ? await Promise.all(formattedRows.map(async (row) => ({
        ...row,
        ...(data.includeReadiness
          ? {
              readiness: await explainWorkbenchModelRouteReadiness({
                route: row,
                workspaceId: data.readinessWorkspaceId || (req as any).auth?.workspaceId || "default",
                database: db,
              }),
            }
          : {}),
        ...(data.includeCertifications
          ? {
              certifications: await listModelRouteCertificationHistory(
                db,
                String(row.id || ""),
              ),
            }
          : {}),
      })))
    : formattedRows;
  res.status(200).send(success(responseRows));
});
