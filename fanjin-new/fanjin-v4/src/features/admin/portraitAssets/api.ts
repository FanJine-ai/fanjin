import { ApiError, apiPost, readApiSettings } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";
import type {
  PortraitAssetsFilters,
  PortraitAssetsResponse,
  PortraitManualReviewDecision,
  PortraitManualReviewDetail,
} from "./types";

function requestPayload(filters: PortraitAssetsFilters) {
  return {
    ...(filters.keyword.trim() ? { keyword: filters.keyword.trim() } : {}),
    ...(filters.subjectKind ? { subjectKind: filters.subjectKind } : {}),
    ...(filters.faceScanState ? { faceScanState: filters.faceScanState } : {}),
    ...(filters.moderationState ? { moderationState: filters.moderationState } : {}),
    ...(filters.complianceState ? { complianceState: filters.complianceState } : {}),
    ...(filters.providerSyncState ? { providerSyncState: filters.providerSyncState } : {}),
    ...(filters.manualReviewState ? { manualReviewState: filters.manualReviewState } : {}),
    ...(filters.imageXReviewState ? { imageXReviewState: filters.imageXReviewState } : {}),
    pageNum: filters.pageNum,
    pageSize: filters.pageSize,
  };
}

export async function getPortraitManualReview(
  admissionId: string,
  signal?: AbortSignal,
): Promise<PortraitManualReviewDetail> {
  return apiPost(
    "/admin/portraitAssets/manual-review/detail",
    { admissionId },
    undefined,
    { signal },
  );
}

type ReviewMutationInput = {
  admissionId: string;
  reviewId: string;
  expectedAdmissionRevision: number;
  expectedReviewRevision: number;
};

export async function claimPortraitManualReview(
  input: ReviewMutationInput,
  signal?: AbortSignal,
): Promise<PortraitManualReviewDetail> {
  return apiPostWithStepUp(
    "/admin/portraitAssets/manual-review/claim",
    input,
    "admin.portrait_review",
    "领取视频全片人脸复核",
    undefined,
    { signal },
  );
}

export async function releasePortraitManualReview(
  input: ReviewMutationInput,
  signal?: AbortSignal,
): Promise<PortraitManualReviewDetail> {
  return apiPostWithStepUp(
    "/admin/portraitAssets/manual-review/release",
    input,
    "admin.portrait_review",
    "释放视频全片人脸复核",
    undefined,
    { signal },
  );
}

export async function decidePortraitManualReview(input: ReviewMutationInput & {
  decision: PortraitManualReviewDecision;
  fullVideoViewed: true;
  faceCountOnlyConfirmed: true;
}, signal?: AbortSignal): Promise<PortraitManualReviewDetail> {
  return apiPostWithStepUp(
    "/admin/portraitAssets/manual-review/decide",
    input,
    "admin.portrait_review",
    "提交视频全片人脸复核结论",
    undefined,
    { signal },
  );
}

export function buildPortraitManualReviewPreviewUrl(
  baseUrl: string,
  reviewId: string,
  browserOrigin: string | null = typeof window === "undefined"
    ? null
    : window.location.origin,
): string {
  let base: URL;
  let url: URL;
  try {
    base = new URL(baseUrl);
    if (base.username || base.password || base.search || base.hash) throw new Error("unsafe API base");
    url = new URL(
      `${base.toString().replace(/\/+$/u, "")}/admin/portraitAssets/manual-review/preview?reviewId=${encodeURIComponent(reviewId)}`,
    );
  } catch {
    throw new ApiError("复核视频必须通过当前站点的同源安全代理播放", {
      code: "PORTRAIT_REVIEW_PREVIEW_SAME_ORIGIN_REQUIRED",
    });
  }
  if (
    url.username
    || url.password
    || url.hash
    || (browserOrigin && url.origin !== browserOrigin)
  ) {
    throw new ApiError("复核视频必须通过当前站点的同源安全代理播放", {
      code: "PORTRAIT_REVIEW_PREVIEW_SAME_ORIGIN_REQUIRED",
    });
  }
  return url.toString();
}

export async function loadPortraitManualReviewPreview(
  reviewId: string,
  expectedReviewRevision: number,
  signal?: AbortSignal,
): Promise<string> {
  const settings = readApiSettings();
  // Validate the native media URL before minting a database grant. A custom
  // cross-origin API preference cannot receive this Strict cookie and must not
  // leave behind an unusable read capability.
  const previewUrl = buildPortraitManualReviewPreviewUrl(settings.baseUrl, reviewId);
  await apiPost<{ expiresAt: number }>(
    "/admin/portraitAssets/manual-review/preview/grant",
    { reviewId, expectedReviewRevision },
    settings,
    { signal },
  );
  // The HttpOnly grant is the only credential on this URL. Assigning it
  // directly to <video> lets the browser issue native Range requests for
  // metadata and seeks without exposing a bearer or grant to JavaScript.
  return previewUrl;
}

export async function listPortraitAssets(
  filters: PortraitAssetsFilters,
  signal?: AbortSignal,
): Promise<PortraitAssetsResponse> {
  return apiPost<PortraitAssetsResponse>(
    "/admin/portraitAssets/list",
    requestPayload(filters),
    undefined,
    { signal },
  );
}
