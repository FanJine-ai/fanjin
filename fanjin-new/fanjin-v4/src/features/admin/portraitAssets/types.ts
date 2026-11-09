export type PortraitFeatureStatus = {
  available: boolean;
  code: "PORTRAIT_ASSETS_FEATURE_UNAVAILABLE" | null;
  message: string | null;
  requiredSchema: 47;
};

export type PortraitConfigurationStatus = {
  configured: boolean;
  valid: boolean;
  ready: boolean;
  reason: string | null;
  worker?: {
    source: "local" | "durable_heartbeat";
    running: boolean;
    heartbeatFresh: boolean;
    heartbeatAt: number | null;
    heartbeatAgeMs: number | null;
    lastSuccessAt: number | null;
    safeReason: string | null;
  };
};

export type PortraitAssetRow = {
  id: string;
  workspace: { id: string; name: string };
  project: { id: number; name: string };
  asset: {
    id: number;
    versionId: number;
    name: string;
    mediaType: "image" | "video";
  };
  subjectKind: string;
  faceScan: { state: string; faceCount: number | null };
  declaration?: {
    classification: "real_person" | "virtual_person" | null;
    termsVersion: string | null;
    acceptedAt: number | null;
    actorRef: string | null;
  };
  manualReview: {
    state: string;
    decision: string | null;
    reviewId: string | null;
  };
  imageXReview: {
    state: "prepared" | "submitting" | "submission_unknown" | "polling" | "allowed" | "denied" | "review_required" | "failed";
    terminal: boolean;
    attempts: number;
    ageMs: number;
    lastActivityAt: number;
    safeError: { code: string; message: string } | null;
  } | null;
  moderationState: string;
  complianceState: string;
  providerSyncState: string;
  provider: {
    channelId: string | null;
    channelName: string | null;
    name: string | null;
    groupType: string | null;
    groupState: string | null;
    assetState: string | null;
  };
  error: { code: string; message: string } | null;
  updatedAt: number;
};

export type PortraitAssetsResponse = {
  feature: PortraitFeatureStatus;
  configuration: {
    detector: PortraitConfigurationStatus;
    moderation: PortraitConfigurationStatus;
  };
  metrics: {
    total: number;
    admitted: number;
    awaitingAuthorization: number;
    syncing: number;
    active: number;
    failed: number;
    awaitingManualReview: number;
  };
  items: PortraitAssetRow[];
  pagination: {
    pageNum: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

export type PortraitAssetsFilters = {
  keyword: string;
  subjectKind: string;
  faceScanState: string;
  moderationState: string;
  complianceState: string;
  providerSyncState: string;
  manualReviewState: string;
  imageXReviewState: string;
  pageNum: number;
  pageSize: number;
};

export const emptyPortraitAssetsFilters: PortraitAssetsFilters = {
  keyword: "",
  subjectKind: "",
  faceScanState: "",
  moderationState: "",
  complianceState: "",
  providerSyncState: "",
  manualReviewState: "",
  imageXReviewState: "",
  pageNum: 1,
  pageSize: 20,
};

export type PortraitManualReviewDetail = {
  admission: {
    id: string;
    revision: number;
    workspaceId: string;
    projectId: number;
    assetId: number;
    assetVersionId: number;
    mediaType: "video";
    faceScanState: string;
    faceScanCoverage: string;
    manualReviewState: string;
    manualReviewDecision: string | null;
    moderationState: string;
    declarationState: string;
    complianceState: string;
    providerSyncState: string;
  };
  review: {
    id: string;
    revision: number;
    state: string;
    claimedByCurrentAdmin: boolean;
    claimLeaseExpiresAt: number | null;
    decision: string | null;
    createdAt: number;
    updatedAt: number;
  };
};

export type PortraitManualReviewDecision =
  | "no_face"
  | "single_face"
  | "multiple_faces"
  | "uncertain";
