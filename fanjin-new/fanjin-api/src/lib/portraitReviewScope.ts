import type { Knex } from "knex";

/** Fanjin checks portrait identity/rights; the generation provider reviews content. */
export const PORTRAIT_REVIEW_SCOPE_VERSION = "portrait-only/2026-09-27";

type Row = Record<string, any>;
const LOCAL_DETECTION_ERRORS = [
  "portrait_face_scan_required", "portrait_face_scan_failed", "portrait_face_scan_uncertain",
  "portrait_multiple_faces_not_supported", "PORTRAIT_SCAN_FAILED",
];

function isLocalDetectionDenial(row: Row): boolean {
  return LOCAL_DETECTION_ERRORS.includes(String(row.safeErrorCode || ""));
}

export function isPlatformContentReviewError(row: Row): boolean {
  return /^(PORTRAIT_MODERATION_|IMAGEX_VIDEO_)/.test(String(row.safeErrorCode || ""));
}

function isHistoricalContentDenial(row: Row): boolean {
  return row.moderationState === "denied" && (
    isPlatformContentReviewError(row)
    || (!row.safeErrorCode && /^imagex_(image|video)_denied$/.test(String(row.moderationReasonCode || "")))
  );
}

/** Project legacy combined compliance onto portrait scope without rewriting audit results. */
export function portraitScopeCompliance(row: Row): string {
  const state = String(row.complianceState || "pending");
  if (["revoked", "expired"].includes(state)) return state;
  if (state === "denied" && !isHistoricalContentDenial(row) && !isLocalDetectionDenial(row)) return state;
  if (row.subjectKind === "ordinary" && ["confirmed", "not_required"].includes(row.declarationState)) {
    return "not_required";
  }
  // The selected reference route owns registration. Detector availability and
  // sampled face counts cannot veto an upstream registration request.
  if ((row.subjectKind === "detected_person" && row.declarationState === "not_required")
    || (["real_person", "virtual_person", "trusted_output"].includes(row.subjectKind)
      && row.declarationState === "confirmed")) return "allowed";
  return "pending";
}

export function withPortraitReviewScope<T extends Row>(row: T): T {
  const contentError = isPlatformContentReviewError(row);
  return {
    ...row,
    complianceState: portraitScopeCompliance(row),
    // A content-review worker used to fail portrait registration as a side effect.
    // Actual provider asset state and identity/consent checks remain authoritative.
    providerSyncState: contentError && row.providerSyncState === "failed"
      ? ["detected_person", "real_person", "virtual_person", "trusted_output"].includes(row.subjectKind)
        ? "queued" : "not_needed"
      : row.providerSyncState,
    safeErrorCode: contentError ? null : row.safeErrorCode,
    safeErrorMessage: contentError ? null : row.safeErrorMessage,
  };
}

/** SQL counterpart used to find portrait work; locked rows are checked again. */
export function wherePortraitScopeEligible(query: Knex.QueryBuilder, prefix = ""): void {
  const column = (name: string) => prefix ? `${prefix}.${name}` : name;
  query.whereNotIn(column("complianceState"), ["revoked", "expired"])
    .where((eligible) => eligible.whereNot(column("complianceState"), "denied")
      .orWhereIn(column("safeErrorCode"), LOCAL_DETECTION_ERRORS)
      .orWhere((historical) => historical.where(column("moderationState"), "denied")
        .where((reason) => reason
          .whereLike(column("safeErrorCode"), "PORTRAIT_MODERATION_%")
          .orWhereLike(column("safeErrorCode"), "IMAGEX_VIDEO_%")
          .orWhere((noError) => noError.whereNull(column("safeErrorCode"))
            .whereIn(column("moderationReasonCode"), ["imagex_image_denied", "imagex_video_denied"])))));
}

export function portraitScopeEvidenceId(admissionId: string, revision: number): string {
  // The legacy API field is called moderationEvidenceId, but this ID explicitly
  // attests only to portrait scope; it does not claim a content audit passed.
  return `portrait-only:${admissionId}:r${revision}`;
}
