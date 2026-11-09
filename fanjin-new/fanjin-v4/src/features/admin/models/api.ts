import { apiPost } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";
import type {
  ModelRouteCertificationRecord,
  ModelRouteReadiness,
  ModelRouteRecord,
} from "./types";

export function listModelRoutes(workspaceId?: string | null, signal?: AbortSignal) {
  return apiPost<ModelRouteRecord[]>("/admin/modelRoutes/list", {
    includeDisabled: true,
    includeReadiness: true,
    includeCertifications: true,
    ...(workspaceId ? { readinessWorkspaceId: workspaceId } : {}),
  }, undefined, { signal });
}

export function preflightModelRoute(payload: Record<string, unknown>, workspaceId?: string | null) {
  return apiPost<ModelRouteReadiness>("/admin/modelRoutes/list", {
    preflight: payload,
    ...(workspaceId ? { readinessWorkspaceId: workspaceId } : {}),
  });
}

export function createModelRoute(payload: Record<string, unknown>) {
  return apiPostWithStepUp<ModelRouteRecord>("/admin/modelRoutes/create", payload, "admin.model_route");
}

export function updateModelRoute(id: string, patch: Record<string, unknown>) {
  return apiPostWithStepUp<ModelRouteRecord>("/admin/modelRoutes/update", { id, ...patch }, "admin.model_route");
}

export function certifyModelRoute(
  id: string,
  certification: Record<string, unknown>,
) {
  return apiPostWithStepUp<ModelRouteCertificationRecord>(
    "/admin/modelRoutes/update",
    { id, certification },
    "admin.model_route",
  );
}

export function revokeModelRouteCertification(
  id: string,
  operationKey: string,
  reason: string,
) {
  return apiPostWithStepUp<ModelRouteCertificationRecord>(
    "/admin/modelRoutes/update",
    { id, revokeCertification: { operationKey, reason } },
    "admin.model_route",
  );
}

export function disableModelRoute(id: string) {
  return apiPostWithStepUp<{ id: string; disabled: number }>("/admin/modelRoutes/delete", { id }, "admin.model_route");
}

export function deleteModelRoute(id: string) {
  return apiPostWithStepUp<{ id: string; deleted: true }>(
    "/admin/modelRoutes/delete",
    { id, permanent: true },
    "admin.model_route",
  );
}
