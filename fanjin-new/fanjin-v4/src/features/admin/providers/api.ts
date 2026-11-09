import { ApiError, apiPost } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";
import type {
  ProviderChannel,
  ProviderChannelFormErrors,
  ProviderChannelFormField,
  ProviderChannelHealthDraft,
  ProviderChannelPayload,
} from "./types";

export interface ProviderChannelHealthResult {
  id: string;
  live: boolean;
  healthStatus: "ok" | "degraded" | "failed" | "disabled" | null;
  configurationStatus: "ready" | "disabled" | "missing_credential" | "missing_probe_url";
  lastHealthCheckAt: string | number | null;
  lastHealthLatencyMs: number | null;
  lastHealthError: string | null;
  persisted: boolean;
}

export interface ProviderChannelModelDiscoveryResult {
  models: string[];
  total: number;
  truncated: boolean;
  persisted: false;
}

const providerFormFields = new Set<ProviderChannelFormField>([
  "name",
  "provider",
  "endpointType",
  "scope",
  "workspaceId",
  "apiKey",
  "providerAccountId",
  "assetsProjectName",
  "portraitAccessKeyId",
  "portraitSecretAccessKey",
  "portraitSessionToken",
  "imagexServiceId",
  "imagexAccessKeyId",
  "imagexSecretAccessKey",
  "imagexSessionToken",
  "priority",
  "weight",
  "timeoutMs",
  "concurrencyLimit",
  "configJsonText",
]);

export function providerFormErrorsFromApiError(error: unknown): ProviderChannelFormErrors {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object") return {};
  const issues = (error.details as { errors?: unknown }).errors;
  if (!Array.isArray(issues)) return {};
  const fieldErrors: ProviderChannelFormErrors = {};
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") continue;
    const path = (issue as { path?: unknown }).path;
    const message = (issue as { message?: unknown }).message;
    const field = Array.isArray(path) && typeof path[0] === "string" ? path[0] : "";
    if (!providerFormFields.has(field as ProviderChannelFormField) || typeof message !== "string") continue;
    const normalizedMessage = message.trim();
    if (normalizedMessage) fieldErrors[field as ProviderChannelFormField] = normalizedMessage;
  }
  return fieldErrors;
}

function unwrapPayload(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in value) return (value as { data?: unknown }).data;
  return value;
}

function extractItems(value: unknown): ProviderChannel[] {
  const payload = unwrapPayload(value);
  if (Array.isArray(payload)) return payload as ProviderChannel[];
  if (payload && typeof payload === "object" && "items" in payload && Array.isArray((payload as { items?: unknown }).items)) {
    return (payload as { items: ProviderChannel[] }).items;
  }
  return [];
}

export async function listProviderChannels() {
  return extractItems(await apiPost<unknown>("/admin/providerChannels/list", { includeDisabled: true }));
}

export async function saveProviderChannel(id: string, payload: ProviderChannelPayload) {
  if (id) return apiPostWithStepUp<ProviderChannel>(
    "/admin/providerChannels/update",
    { id, ...payload },
    "admin.provider_channel",
  );
  return apiPostWithStepUp<ProviderChannel>(
    "/admin/providerChannels/create",
    { ...payload },
    "admin.provider_channel",
  );
}

export async function setProviderChannelDisabled(id: string, disabled: boolean) {
  if (disabled) return apiPostWithStepUp("/admin/providerChannels/delete", { id }, "admin.provider_channel");
  return apiPostWithStepUp("/admin/providerChannels/update", { id, disabled: 0 }, "admin.provider_channel");
}

export async function checkProviderChannelHealth(id: string, live: boolean) {
  return apiPostWithStepUp<ProviderChannelHealthResult>(
    "/admin/providerChannels/health",
    { id, live },
    "admin.provider_channel",
  );
}

export async function testProviderChannelDraft(draft: ProviderChannelHealthDraft) {
  return apiPostWithStepUp<ProviderChannelHealthResult>(
    "/admin/providerChannels/health",
    { draft, live: true },
    "admin.provider_channel",
  );
}

export async function discoverProviderChannelModels(draft: ProviderChannelHealthDraft) {
  return apiPostWithStepUp<ProviderChannelModelDiscoveryResult>(
    "/admin/providerChannels/models",
    { draft },
    "admin.provider_channel",
  );
}
