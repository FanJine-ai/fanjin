import type { Knex } from "knex";

import { assetLibrarySchemaAvailable } from "@/lib/accountWorkspaceAssetLibrary";
import { PROJECT_ASSET_REF_TABLE } from "@/lib/migrations/accountWorkspaceAssetLibrary";
import { redactSensitiveText } from "@/lib/redactSensitiveText";

export type PipelineState = "not_started" | "processing" | "ready" | "failed";

export type ShortDramaPipelineShot = {
  id: number;
  index: number;
  title: string;
  state: PipelineState;
  stateLabel: string;
  failureReason: string | null;
  assetIds: number[];
};

export type ShortDramaPipelineScene = {
  id: number;
  state: PipelineState;
  stateLabel: string;
  failureReason: string | null;
  selectedVideoId: number | null;
  videoVersionIds: number[];
  shots: ShortDramaPipelineShot[];
};

export type ShortDramaPipelineEpisode = {
  id: number;
  name: string;
  state: PipelineState;
  stateLabel: string;
  failureReason: string | null;
  scriptAssetIds: number[];
  scenes: ShortDramaPipelineScene[];
  ungroupedShots: ShortDramaPipelineShot[];
};

function cleanFailure(value: unknown): string | null {
  const message = redactSensitiveText(String(value || "").trim());
  return message || null;
}

export function normalizePipelineState(value: unknown, failure: unknown): {
  state: PipelineState;
  stateLabel: string;
  failureReason: string | null;
} {
  const raw = String(value || "").trim();
  const reason = cleanFailure(failure);
  if (reason || /失败|failed|error/i.test(raw)) return { state: "failed", stateLabel: raw || "失败", failureReason: reason || "任务失败，未返回具体原因" };
  if (/生成中|处理中|排队|running|pending|queued|submitted/i.test(raw)) return { state: "processing", stateLabel: raw, failureReason: null };
  if (/完成|成功|ready|succeeded|complete/i.test(raw)) return { state: "ready", stateLabel: raw, failureReason: null };
  return { state: "not_started", stateLabel: raw || "未开始", failureReason: null };
}

function aggregateState(children: Array<{ state: PipelineState; failureReason: string | null }>, fallback: ReturnType<typeof normalizePipelineState>) {
  if (fallback.state === "failed") return fallback;
  const failed = children.find((child) => child.state === "failed");
  if (failed) return { state: "failed" as const, stateLabel: "存在失败", failureReason: failed.failureReason };
  if (children.some((child) => child.state === "processing")) return { state: "processing" as const, stateLabel: "处理中", failureReason: null };
  if (children.length && children.every((child) => child.state === "ready")) return { state: "ready" as const, stateLabel: "已完成", failureReason: null };
  return fallback;
}

export function projectShortDramaPipelineRows(input: {
  scripts: any[];
  storyboards: any[];
  tracks: any[];
  videos: any[];
  scriptAssets: any[];
  storyboardAssets: any[];
}): ShortDramaPipelineEpisode[] {
  const videosByTrack = new Map<number, any[]>();
  for (const video of input.videos) {
    const trackId = Number(video.videoTrackId || 0);
    videosByTrack.set(trackId, [...(videosByTrack.get(trackId) || []), video]);
  }
  const assetsByScript = new Map<number, number[]>();
  for (const row of input.scriptAssets) {
    const scriptId = Number(row.scriptId || 0);
    const assetId = Number(row.assetId || 0);
    if (scriptId && assetId) assetsByScript.set(scriptId, [...(assetsByScript.get(scriptId) || []), assetId]);
  }
  const assetsByStoryboard = new Map<number, number[]>();
  for (const row of input.storyboardAssets) {
    const storyboardId = Number(row.storyboardId || 0);
    const assetId = Number(row.assetId || 0);
    if (storyboardId && assetId) assetsByStoryboard.set(storyboardId, [...(assetsByStoryboard.get(storyboardId) || []), assetId]);
  }

  const shot = (row: any): ShortDramaPipelineShot => {
    const status = normalizePipelineState(row.state, row.reason || row.errorReason);
    return {
      id: Number(row.id),
      index: Number(row.index || 0),
      title: String(row.title || row.prompt || `镜头 ${row.id}`).slice(0, 160),
      ...status,
      assetIds: [...new Set(assetsByStoryboard.get(Number(row.id)) || [])].sort((a, b) => a - b),
    };
  };

  return input.scripts
    .map((script): ShortDramaPipelineEpisode => {
      const scriptId = Number(script.id);
      const scriptShots = input.storyboards.filter((row) => Number(row.scriptId) === scriptId);
      const scenes = input.tracks
        .filter((track) => Number(track.scriptId) === scriptId)
        .map((track): ShortDramaPipelineScene => {
          const trackVideos = videosByTrack.get(Number(track.id)) || [];
          const videoStatuses = trackVideos.map((video) => normalizePipelineState(video.state, video.errorReason));
          const fallback = normalizePipelineState(track.state, track.reason);
          const shots = scriptShots.filter((row) => Number(row.trackId) === Number(track.id)).map(shot);
          const status = aggregateState([...videoStatuses, ...shots], fallback);
          return {
            id: Number(track.id),
            ...status,
            selectedVideoId: Number(track.videoId || 0) || null,
            videoVersionIds: trackVideos.map((video) => Number(video.id)).filter(Boolean).sort((a, b) => a - b),
            shots,
          };
        });
      const ungroupedShots = scriptShots.filter((row) => !Number(row.trackId || 0)).map(shot);
      const fallback = normalizePipelineState(script.extractState, script.errorReason);
      const status = aggregateState([...scenes, ...ungroupedShots], fallback);
      return {
        id: scriptId,
        name: String(script.name || `剧本 ${scriptId}`),
        ...status,
        scriptAssetIds: [...new Set(assetsByScript.get(scriptId) || [])].sort((a, b) => a - b),
        scenes,
        ungroupedShots,
      };
    })
    .sort((left, right) => left.id - right.id);
}

export async function readShortDramaPipeline(input: {
  database: Knex;
  workspaceId: string;
  projectId: number;
}) {
  const scripts = await input.database("o_script").where({ projectId: input.projectId }).orderBy("id", "asc");
  const scriptIds = scripts.map((row) => Number(row.id)).filter(Boolean);
  const [storyboards, tracks, scriptAssets] = scriptIds.length
    ? await Promise.all([
        input.database("o_storyboard").where({ projectId: input.projectId }).whereIn("scriptId", scriptIds).orderBy([{ column: "scriptId", order: "asc" }, { column: "index", order: "asc" }]),
        input.database("o_videoTrack").where({ projectId: input.projectId }).whereIn("scriptId", scriptIds).orderBy("id", "asc"),
        input.database("o_scriptAssets").whereIn("scriptId", scriptIds).select("scriptId", "assetId"),
      ])
    : [[], [], []];
  const trackIds = tracks.map((row) => Number(row.id)).filter(Boolean);
  const storyboardIds = storyboards.map((row) => Number(row.id)).filter(Boolean);
  const [videos, storyboardAssets] = await Promise.all([
    trackIds.length ? input.database("o_video").whereIn("videoTrackId", trackIds).orderBy("id", "asc") : [],
    storyboardIds.length ? input.database("o_assets2Storyboard").whereIn("storyboardId", storyboardIds).select("storyboardId", "assetId") : [],
  ]);
  const episodes = projectShortDramaPipelineRows({ scripts, storyboards, tracks, videos, scriptAssets, storyboardAssets });
  const allAssetIds = [...new Set(episodes.flatMap((episode) => [
    ...episode.scriptAssetIds,
    ...episode.scenes.flatMap((scene) => scene.shots.flatMap((item) => item.assetIds)),
    ...episode.ungroupedShots.flatMap((item) => item.assetIds),
  ]))];
  const versionRefs = allAssetIds.length && await assetLibrarySchemaAvailable(input.database)
    ? await input.database(PROJECT_ASSET_REF_TABLE)
        .where({ workspaceId: input.workspaceId, projectId: input.projectId })
        .whereNull("removedAt")
        .whereIn("assetId", allAssetIds)
        .select("id", "assetId", "assetVersionId", "revision", "updatedAt")
    : [];
  return {
    projectId: input.projectId,
    episodes,
    versionRefs: versionRefs.map((row) => ({
      refId: String(row.id),
      assetId: Number(row.assetId),
      assetVersionId: String(row.assetVersionId),
      revision: Number(row.revision),
      updatedAt: Number(row.updatedAt),
    })),
    readOnly: true as const,
    refreshedAt: Date.now(),
  };
}
