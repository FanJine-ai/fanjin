export type PortraitAssetAction =
  | "CreateAssetGroup" | "GetAssetGroup" | "ListAssetGroups" | "UpdateAssetGroup" | "DeleteAssetGroup"
  | "CreateAsset" | "GetAsset" | "ListAssets" | "UpdateAsset" | "DeleteAsset"
  | "CreateVisualValidateSession" | "GetVisualValidateResult";

export type PortraitRelayTime = string | number | null;

export interface PortraitGroupRow {
  id: string;
  workspaceId: string;
  upstreamGroupId: string;
  groupType: string;
  name: string | null;
  description: string | null;
  projectName: string | null;
  createTime: PortraitRelayTime;
  updateTime: PortraitRelayTime;
}

export interface PortraitAssetRow {
  id: string;
  workspaceId: string;
  groupId: string;
  upstreamAssetId: string;
  assetType: string;
  name: string | null;
  upstreamStatus: string | null;
  errorMessage: string | null;
  projectName: string | null;
  createTime: PortraitRelayTime;
  updateTime: PortraitRelayTime;
}

export interface PortraitRelaySnapshot {
  groups: PortraitGroupRow[];
  assets: PortraitAssetRow[];
  refreshedAt: number | null;
  metrics: {
    groupCount: number;
    assetCount: number;
    activeAssetCount: number;
    processingAssetCount: number;
    failedAssetCount: number;
  };
}

export interface PortraitRelayResponse {
  ResponseMetadata?: Record<string, unknown>;
  Result: Record<string, unknown>;
}

export interface PortraitRelayActionInput {
  Action: PortraitAssetAction;
  Body: Record<string, unknown>;
  workspaceId: string;
  consentConfirmed?: boolean;
  idempotencyKey?: string;
  signal?: AbortSignal;
}
