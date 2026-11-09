import { portraitScopeCompliance } from "@/lib/portraitReviewScope";
import { hasUpstreamRealPersonRejection } from "@/lib/portraitUpstreamRejection";

export function isPortraitProviderRefusal(code: unknown): boolean {
  const normalized = String(code || "").toUpperCase();
  return ["CONTENT_REJECTED", "CONTENT_REVIEW_REJECTED", "VOLC_PORTRAIT_ASSET_REJECTED"]
    .includes(normalized)
    || /^INPUT(?:VIDEO|IMAGE)SENSITIVECONTENTDETECTED(?:\.[A-Z0-9_]+)?$/.test(normalized);
}

export const PORTRAIT_PROVIDER_REFUSAL_MESSAGE = "上游在人物素材登记时拒绝了此素材，返回内容规则限制；未提供更具体的命中原因。来源声明已保留，请更换素材或携带素材版本编号联系平台复核。重复点击检查不会解除该拒绝。";

/** Local detection is advisory. Actual rights restrictions and provider refusals remain authoritative. */
export function hasPortraitSubmissionRestriction(row: Record<string, any>, now = Date.now()): boolean {
  if (hasUpstreamRealPersonRejection(row) || isPortraitProviderRefusal(row.safeErrorCode)) return true;
  const compliance = portraitScopeCompliance(row);
  if (["revoked", "expired"].includes(compliance)) return true;
  if (compliance === "denied" && row.safeErrorCode !== "PORTRAIT_SOURCE_UNCERTAIN") return true;
  if (row.currentConsentId && row.consentStatus !== "active") return true;
  if (["revoked", "expired"].includes(String(row.consentStatus))
    || ["revoked", "denied"].includes(String(row.identityState))
    || ["revoked", "rejected"].includes(String(row.providerAssetState))) return true;
  const expiresAt = row.consentExpiresAt ?? row.expiresAt;
  if (expiresAt != null && (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) <= now)) return true;
  if (row.subjectKind === "real_person"
    && (row.consentStatus !== "active" || row.identityState !== "active")) return true;
  return false;
}
