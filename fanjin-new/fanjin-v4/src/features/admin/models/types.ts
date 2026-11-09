export interface ModelRouteRecord {
  id?: string;
  name?: string | null;
  /** 用户可见映射名;空时前台回退 name/model。 */
  displayName?: string | null;
  model?: string | null;
  endpointType?: string | null;
  provider?: string | null;
  channelId?: string | null;
  scope?: string | null;
  workspaceId?: string | null;
  priority?: number | null;
  fallbackOrder?: number | null;
  disabled?: number | boolean | null;
  routeConfig?: Record<string, unknown> | null;
  createTime?: number | string | null;
  updateTime?: number | string | null;
  readiness?: ModelRouteReadiness | null;
  certifications?: ModelRouteCertificationRecord[];
  [key: string]: unknown;
}

export type ModelRouteReadinessCheckStatus = "pass" | "fail" | "not_checked";

export interface ModelRouteReadinessCheck {
  status: ModelRouteReadinessCheckStatus;
  reason?: string;
}

export interface ModelRouteVideoDeliveryProof {
  version: "public-video-delivery-proof/v1";
  operationKey: "resolution:2k" | "resolution:4k";
  resolution: "2k" | "4k";
  delivery: string;
  width: number;
  height: number;
  durationMs: number;
  videoCodec: string;
  bitrateBps: number;
  audioTrackCount: number;
  audioCodecs: string[];
  contentLengthBytes: number;
  downloadVerified: true;
  costMicros: number;
  currency: "GU";
}

export interface ModelRouteReadiness {
  readinessVersion: "workbench-model-route-readiness/v1";
  routeId: string | null;
  evaluatedWorkspaceId: string;
  effectiveRouteId: string | null;
  selectedForCatalog: boolean;
  productionReady: boolean;
  canSubmit: boolean;
  capabilityStatus: "verified" | "configured" | "legacy" | "unverified" | "unavailable";
  resolvedChannelId: string | null;
  resolvedProvider: string | null;
  selectionReason?: string;
  checks: Record<
    "route" | "channel" | "health" | "credential" | "adapter" | "pricing" | "certification" | "capability" | "catalog",
    ModelRouteReadinessCheck
  >;
  deliveryProofs: ModelRouteVideoDeliveryProof[];
  reasons: string[];
}

export interface ModelRouteCertificationRecord {
  id: string;
  routeId: string;
  pricingRuleId: string;
  operationKey: string;
  batchId: string;
  releaseId: string | null;
  sourceCommit: string | null;
  priceSourceUrl: string;
  priceSourceDigest: string;
  priceCheckedAt: number;
  upstreamCurrency: string;
  upstreamUnitPriceMicros: number;
  billingCurrency: string;
  billingDimension: string;
  taskEvidenceId: string;
  usageEvidenceId: string;
  certifiedByUserId: number;
  certifiedAt: number;
  validUntil: number;
  revokedAt: number | null;
  revokeReason: string | null;
}

export interface ModelRouteFilters {
  keyword: string;
  endpointType: string;
  provider: string;
  status: string;
}

export interface ModelRouteRow {
  id: string;
  source: ModelRouteRecord;
  name: string;
  displayName: string;
  enhanceDisplayName: string;
  model: string;
  endpointType: string;
  provider: string;
  channelId: string;
  scope: string;
  priority: number;
  fallbackOrder: number;
  resolutions: string[];
  defaultResolution: string;
  status: "enabled" | "disabled";
  readiness: ModelRouteReadiness | null;
}

export interface ModelRouteForm {
  id: string;
  name: string;
  displayName: string;
  enhanceDisplayName: string;
  scope: string;
  workspaceId: string;
  endpointType: string;
  model: string;
  provider: string;
  channelId: string;
  priority: number;
  fallbackOrder: number;
  routeConfigText: string;
  disabled: boolean;
}
