import { withPortraitReviewScope } from "@/lib/portraitReviewScope";
import crypto from "node:crypto";
import { VolcengineImageXReviewError } from "@/lib/volcengineImageXReview";
import { hasUpstreamRealPersonRejection } from "@/lib/portraitUpstreamRejection";
import { isPortraitProviderRefusal } from "@/lib/portraitSubmissionPolicy";

export function portraitEvidenceHash(value: unknown): string {
  const stable = (v: any): string => {
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    if (v && typeof v === "object") {
      return `{${Object.keys(v).sort().map(key => `${JSON.stringify(key)}:${stable(v[key])}`).join(",")}}`;
    }
    return JSON.stringify(v ?? null);
  };
  return crypto.createHash("sha256").update(stable(value)).digest("hex");
}

const AUTH_REJECTIONS = /^(AccessDenied(?:\.[A-Za-z0-9_.-]+)?|Unauthorized|InvalidAccessKeyId|InvalidAccessKey|SignatureDoesNotMatch|InvalidSecurityToken|ExpiredToken)$/u;
export function isPortraitAuthRejection(diagnostic: any): boolean {
  return Boolean(diagnostic && diagnostic.dispatchState === "response_received"
    && [401, 403].includes(diagnostic.httpStatus)
    && typeof diagnostic.upstreamCode === "string" && AUTH_REJECTIONS.test(diagnostic.upstreamCode)
    && typeof diagnostic.requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(diagnostic.requestId)
    && !diagnostic.requestId.startsWith("AKLT"));
}

const SAFE_PREDISPATCH_RECOVERY_CODES = new Set([
  "PORTRAIT_IMAGEX_CHANNEL_UNAVAILABLE",
  "PORTRAIT_VIDEO_STORAGE_AUTHORITY_UNAVAILABLE",
]);

function isVideoStoragePreDispatchFailure(diagnostic: any): boolean {
  return diagnostic?.code === "PORTRAIT_VIDEO_STORAGE_AUTHORITY_UNAVAILABLE"
    && diagnostic.dispatchState === "not_dispatched"
    && diagnostic.upstreamCode == null
    && diagnostic.requestId == null
    && diagnostic.httpStatus == null;
}

export function isPortraitRetrySafeFailure(diagnostic: any): boolean {
  return isPortraitAuthRejection(diagnostic) || Boolean(
    diagnostic
    && diagnostic.dispatchState === "not_dispatched"
    && SAFE_PREDISPATCH_RECOVERY_CODES.has(String(diagnostic.code))
    && (diagnostic.code !== "PORTRAIT_VIDEO_STORAGE_AUTHORITY_UNAVAILABLE"
      || isVideoStoragePreDispatchFailure(diagnostic)),
  );
}

export function portraitFailure(caught: unknown) {
  const error = caught instanceof VolcengineImageXReviewError ? caught : null;
  const configuration = Boolean(error && (
    [400, 401, 403].includes(Number(error.httpStatus))
    || /CREDENTIAL|CONFIGURATION|ENDPOINT|CHANNEL_UNAVAILABLE|STORAGE_AUTHORITY_UNAVAILABLE/.test(error.code)
  ));
  const retrySafe = isPortraitRetrySafeFailure(error);
  return {
    category: configuration ? "configuration" : "unavailable",
    code: error?.code ?? "PORTRAIT_UPSTREAM_UNAVAILABLE",
    upstreamCode: error?.upstreamCode ?? null,
    requestId: error?.requestId ?? null,
    httpStatus: error?.httpStatus ?? null,
    dispatchState: error?.dispatchState ?? "outcome_unknown",
    retrySafe,
    message: configuration ? "素材检查服务配置或授权异常，请联系管理员修复后重试" : "素材检查服务暂时不可用，请稍后重试；结果未知的请求需管理员核对",
  };
}

export function readPortraitEvidence(row: any): Record<string, any> | null {
  try {
    const e = JSON.parse(String(row.detectorEvidenceJson || "{}"));
    return e && !Array.isArray(e) && e.sourceSha256 === row.sourceSha256
      && portraitEvidenceHash(e) === row.detectorEvidenceHash ? e : null;
  } catch { return null; }
}

/** A timeout, generic/legacy failure or corrupted evidence never authorizes
 * another paid call. Video recovery is limited to the exact storage-authority
 * failure proven to have happened before any upstream dispatch. */
export function canRecoverPortraitFace(row: any): boolean {
  row = withPortraitReviewScope(row);
  const e = readPortraitEvidence(row);
  const d = e?.diagnostic;
  const permittedMediaFailure = row.mediaType === "image"
    ? d?.code !== "PORTRAIT_VIDEO_STORAGE_AUTHORITY_UNAVAILABLE"
    : row.mediaType === "video" && isVideoStoragePreDispatchFailure(d);
  // Older persisted video failures recorded retrySafe=false before this exact
  // pre-dispatch code was recognized. Re-evaluate only that hash-checked case.
  const recordedRetryFlagValid = d?.retrySafe === true
    || (row.mediaType === "video" && d?.retrySafe === false && isVideoStoragePreDispatchFailure(d));
  return permittedMediaFailure && row.faceScanState === "failed" && e?.version === "portrait-detector-failure/v2"
    && !hasUpstreamRealPersonRejection(row)
    && !isPortraitProviderRefusal(row.safeErrorCode)
    && row.safeErrorCode !== "VOLC_PORTRAIT_OUTCOME_UNKNOWN"
    && !["denied", "revoked", "expired"].includes(String(row.complianceState))
    && row.providerSyncState === "not_needed"
    && !["pending", "in_review", "completed"].includes(String(row.manualReviewState))
    && recordedRetryFlagValid && isPortraitRetrySafeFailure(d)
    && Array.isArray(e.recoveryHistory) && e.recoveryHistory.length < 3;
}

export function portraitRecoveryHistory(row: any): any[] {
  const e = readPortraitEvidence(row);
  return e && Array.isArray(e.recoveryHistory) && e.recoveryHistory.length <= 3 ? e.recoveryHistory : [];
}
