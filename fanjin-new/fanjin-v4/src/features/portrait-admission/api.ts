import { apiGet, apiPost } from "../../api/http";

export const PORTRAIT_ADMISSION_ENDPOINTS = {
  collection: "/workbench/portrait-admissions",
  declaration: "/workbench/portrait-admissions/declaration",
  authorization: "/workbench/portrait-admissions/authorization",
  retry: "/workbench/portrait-admissions/retry",
  register: "/workbench/portrait-admissions/register",
} as const;

export const PORTRAIT_DECLARATION_TERMS_VERSION =
  "portrait-declaration/2026-08-17-user-classification-v2" as const;

export type PortraitVideoRoutePolicy = { available: boolean; enabled: boolean; configured: boolean };

export function getPortraitVideoRoutePolicy(projectId: number, model: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ projectId: String(projectId), model });
  return apiGet<PortraitVideoRoutePolicy>(`${PORTRAIT_ADMISSION_ENDPOINTS.collection}/video-route-policy?${query}`, undefined, { signal });
}

export type PortraitDeclarationChoice =
  | "real_person_with_rights"
  | "fully_virtual_person"
  | "ordinary_no_person";

export type PortraitAdmissionStage =
  | "scanning"
  | "moderating"
  | "manual_review"
  | "needs_declaration"
  | "needs_real_authorization"
  | "real_authorization_pending"
  | "virtual_attestation"
  | "trusted_output_verification"
  | "syncing"
  | "ready"
  | "blocked"
  | "failed";

export type PortraitAdmission = {
  id: string;
  projectId: number;
  assetVersionId: number;
  mediaType: "image" | "video";
  stage: PortraitAdmissionStage;
  nextAction: string;
  faceScanState: string;
  faceRetryAllowed?: boolean;
  faceSignal: "present" | "absent" | "inconclusive";
  classificationRequired: boolean;
  userClassification: PortraitDeclarationChoice | null;
  disclaimer: {
    termsVersion: string;
    text: string;
    accepted: boolean;
    acceptedAt: number | null;
  };
  subjectKind: string;
  identityLabel: string;
  declarationState: string;
  complianceState: string;
  providerSyncState: string;
  blocking: boolean;
  revision: number;
  error: null | { code: string; message: string };
};

type PortraitAdmissionMutationInput = {
  projectId: number;
  assetVersionId: number;
  revision: number;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`人像准入响应缺少有效的 ${field}`);
  return parsed;
}

function admissionStage(raw: Record<string, unknown>): PortraitAdmissionStage {
  const declaredStage = String(raw.stage || "").trim();
  const supported = new Set<PortraitAdmissionStage>([
    "scanning",
    "moderating",
    "manual_review",
    "needs_declaration",
    "needs_real_authorization",
    "real_authorization_pending",
    "virtual_attestation",
    "trusted_output_verification",
    "syncing",
    "ready",
    "blocked",
    "failed",
  ]);
  if (supported.has(declaredStage as PortraitAdmissionStage)) return declaredStage as PortraitAdmissionStage;

  const nextAction = String(raw.nextAction || "").trim();
  const subjectKind = String(raw.subjectKind || "").trim();
  const providerSyncState = String(raw.providerSyncState || "").trim();
  if (nextAction === "wait_for_scan") return "scanning";
  if (nextAction === "wait_for_admin_review") return "manual_review";
  if (nextAction === "wait_for_moderation") return "moderating";
  if (nextAction === "confirm_source") return "needs_declaration";
  if (nextAction === "authorize_real_person") {
    return providerSyncState === "authorizing"
      ? "real_authorization_pending"
      : "needs_real_authorization";
  }
  if (nextAction === "ready") return "ready";
  if (nextAction === "replace_or_split_media") return "blocked";
  if (nextAction === "retry" || raw.error) return "failed";
  if (subjectKind === "trusted_output") return "trusted_output_verification";
  if (subjectKind === "virtual_person" && providerSyncState === "not_needed") return "virtual_attestation";
  if (nextAction === "wait_for_provider") return "syncing";
  return Boolean(raw.blocking) ? "blocked" : "ready";
}

/**
 * Keep the browser DTO deliberately narrower than the service response. In
 * particular, provider routing details are neither parsed nor exposed: the
 * server alone derives the provider group/type.
 */
export function normalizePortraitAdmission(value: unknown): PortraitAdmission {
  const raw = record(value);
  const faceScan = record(raw.faceScan);
  const identity = record(raw.identity);
  const faceSignal = record(raw.faceSignal);
  const disclaimer = record(raw.disclaimer);
  const rawError = record(raw.error);
  const error = raw.error
    ? {
        code: String(rawError.code || "portrait_admission_failed"),
        message: String(rawError.message || "人像素材校验未完成，请重试"),
      }
    : null;
  return {
    id: String(raw.id || "").trim(),
    projectId: positiveInteger(raw.projectId, "projectId"),
    assetVersionId: positiveInteger(raw.assetVersionId, "assetVersionId"),
    mediaType: raw.mediaType === "video" ? "video" : "image",
    stage: admissionStage(raw),
    nextAction: String(raw.nextAction || ""),
    faceScanState: String(faceScan.state || ""),
    faceRetryAllowed: faceScan.retryAllowed === true,
    faceSignal: ["present", "absent", "inconclusive"].includes(String(faceSignal.result))
      ? String(faceSignal.result) as PortraitAdmission["faceSignal"]
      : "inconclusive",
    classificationRequired: Boolean(raw.classificationRequired),
    userClassification: ["real_person_with_rights", "fully_virtual_person"].includes(String(raw.userClassification))
      ? String(raw.userClassification) as PortraitDeclarationChoice
      : null,
    disclaimer: {
      termsVersion: String(disclaimer.termsVersion || PORTRAIT_DECLARATION_TERMS_VERSION),
      text: String(disclaimer.text || ""),
      accepted: Boolean(disclaimer.accepted),
      acceptedAt: disclaimer.acceptedAt == null ? null : Number(disclaimer.acceptedAt),
    },
    subjectKind: String(raw.subjectKind || ""),
    identityLabel: String(identity.label || "").trim(),
    declarationState: String(raw.declarationState || ""),
    complianceState: String(raw.complianceState || ""),
    providerSyncState: String(raw.providerSyncState || ""),
    blocking: Boolean(raw.blocking),
    revision: Math.max(0, Number(raw.revision) || 0),
    error,
  };
}

function query(projectId: number, assetVersionId: number) {
  return new URLSearchParams({
    projectId: String(projectId),
    assetVersionId: String(assetVersionId),
  }).toString();
}

export async function getPortraitAdmission(
  projectId: number,
  assetVersionId: number,
  options: { signal?: AbortSignal } = {},
): Promise<PortraitAdmission> {
  const response = await apiGet<unknown>(
    `${PORTRAIT_ADMISSION_ENDPOINTS.collection}?${query(projectId, assetVersionId)}`,
    undefined,
    options,
  );
  return normalizePortraitAdmission(response);
}

export async function declarePortraitSource(
  input: PortraitAdmissionMutationInput & {
    model?: string;
    choice: PortraitDeclarationChoice;
    termsVersion: typeof PORTRAIT_DECLARATION_TERMS_VERSION;
    termsAccepted: true;
  },
): Promise<PortraitAdmission> {
  const response = await apiPost<unknown, typeof input>(PORTRAIT_ADMISSION_ENDPOINTS.declaration, input);
  return normalizePortraitAdmission(response);
}

export async function authorizeRealPortrait(
  input: PortraitAdmissionMutationInput & {
    identityLabel: string;
    rightsConfirmed: true;
  },
): Promise<{
  admission: PortraitAdmission;
  authorizationUrl: string;
  expiresAt: number;
}> {
  const response = await apiPost<unknown, typeof input>(PORTRAIT_ADMISSION_ENDPOINTS.authorization, input);
  const raw = record(response);
  const authorizationUrl = String(raw.authorizationUrl || "").trim();
  const expiresAt = Number(raw.expiresAt);
  let parsed: URL;
  try {
    parsed = new URL(authorizationUrl);
  } catch {
    throw new Error("真人授权服务未返回有效链接");
  }
  const localDevelopment = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(localDevelopment && parsed.protocol === "http:")) {
    throw new Error("真人授权链接必须使用 HTTPS");
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("真人授权链接已经失效，请重新发起");
  }
  return {
    admission: normalizePortraitAdmission(raw.admission),
    authorizationUrl: parsed.toString(),
    expiresAt,
  };
}

export async function retryPortraitAdmission(
  input: PortraitAdmissionMutationInput,
): Promise<PortraitAdmission> {
  const response = await apiPost<unknown, typeof input>(PORTRAIT_ADMISSION_ENDPOINTS.retry, input);
  return normalizePortraitAdmission(response);
}

export async function registerPortraitAsset(
  input: PortraitAdmissionMutationInput & { model?: string },
): Promise<PortraitAdmission> {
  const response = await apiPost<unknown, typeof input>(PORTRAIT_ADMISSION_ENDPOINTS.register, input);
  return normalizePortraitAdmission(record(response).admission);
}
