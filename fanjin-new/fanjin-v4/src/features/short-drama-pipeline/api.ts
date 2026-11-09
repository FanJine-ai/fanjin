import { apiPost, type ApiRequestOptions } from "../../api/http";

export type PipelineState = "not_started" | "processing" | "ready" | "failed";

export type PipelineShot = {
  id: number;
  index: number;
  title: string;
  state: PipelineState;
  stateLabel: string;
  failureReason: string | null;
  assetIds: number[];
};

export type PipelineScene = {
  id: number;
  state: PipelineState;
  stateLabel: string;
  failureReason: string | null;
  selectedVideoId: number | null;
  videoVersionIds: number[];
  shots: PipelineShot[];
};

export type PipelineEpisode = {
  id: number;
  name: string;
  state: PipelineState;
  stateLabel: string;
  failureReason: string | null;
  scriptAssetIds: number[];
  scenes: PipelineScene[];
  ungroupedShots: PipelineShot[];
};

export type ShortDramaPipelineStatus = {
  projectId: number;
  episodes: PipelineEpisode[];
  versionRefs: Array<{
    refId: string;
    assetId: number;
    assetVersionId: string;
    revision: number;
    updatedAt: number;
  }>;
  readOnly: true;
  refreshedAt: number;
};

export function getShortDramaPipelineStatus(projectId: number, options?: ApiRequestOptions) {
  return apiPost<ShortDramaPipelineStatus, { projectId: number }>(
    "/production/workbench/getPipelineStatus",
    { projectId },
    undefined,
    options,
  );
}
