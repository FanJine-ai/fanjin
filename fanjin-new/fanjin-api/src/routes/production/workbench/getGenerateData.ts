import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { isRecoverableWorkbenchRelayVideo, syncWorkbenchVideoRelay, videoFileUrl } from "@/lib/workbenchVideoRelay";
import { projectWorkbenchRelayVideoForPublic } from "@/lib/workbenchRelayPublicProjection";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import { isCandidateRuntimeReadonlyEvidenceMode } from "@/lib/candidateRuntimeAttestation";
const router = express.Router();

interface VideoItem {
  id: number;
  src: string;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
  relayTaskId?: string | null;
  relay?: Record<string, unknown> | null;
}

interface TrackMedia {
  src: string;
  id?: number;
  fileType: "image" | "video" | "audio";
  videoDesc?: string;
}

interface TrackItem {
  id?: number;
  prompt: string;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
  reason?: string;
  duration?: number;
  selectVideoId?: number;
  medias: TrackMedia[];
  videoList: VideoItem[];
}

function parseJsonObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function pickFirst(obj: any, paths: string[]): unknown {
  for (const path of paths) {
    const value = path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function hasResolutionEnhancement(resultPayload: Record<string, any>): boolean {
  return Boolean(pickFirst(resultPayload, ["enhancement.taskId", "enhancement.task_id", "enhancement.payload"]));
}

function videoResolutionPlan(task: any): Record<string, unknown> | null {
  if (!task) return null;
  const requestPayload = parseJsonObject(task.requestPayload);
  const resultPayload = parseJsonObject(task.resultPayload);
  const requestedResolution = pickFirst(resultPayload, ["internal.requestedResolution"]) ?? requestPayload.resolution ?? null;
  const generationResolution = pickFirst(resultPayload, ["internal.generationResolution"]) ?? null;
  const finalResolution = pickFirst(resultPayload, ["internal.finalResolution"]) ?? requestPayload.resolution ?? null;
  return {
    requestedResolution,
    generationResolution,
    finalResolution,
    needsEnhancement: Boolean(generationResolution && finalResolution && generationResolution !== finalResolution) || hasResolutionEnhancement(resultPayload),
  };
}

function relayProcessingStage(task: any): string {
  if (!task) return "";
  const status = String(task.status || "");
  const resultPayload = parseJsonObject(task.resultPayload);
  if (["queued", "created", "pending", "submitted", "waiting"].includes(status)) return "排队中";
  if (status === "running" && hasResolutionEnhancement(resultPayload)) return "高清处理中";
  if (status === "running") return "基础生成中";
  if (status === "succeeded") return "已完成";
  if (status === "mocked") return "模拟完成";
  if (["failed", "cancelled"].includes(status)) return status === "cancelled" ? "已取消" : "失败";
  return status;
}

function relayStorageState(assets: any[]): Record<string, unknown> | null {
  const finalAsset = assets.find((asset) => asset.source === "relay_final" && asset.assetType === "video") || assets.find((asset) => asset.assetType === "video");
  if (!finalAsset) return null;
  const metadata = parseJsonObject(finalAsset.metadata);
  const mirrored = Boolean(metadata.mirrored || finalAsset.localPath);
  return {
    source: finalAsset.source || "relay",
    mirrored,
    label: mirrored ? "已转存到服务端" : "使用上游视频地址",
  };
}

function videoRelayMeta(task: any, assets: any[]): Record<string, unknown> | null {
  if (!task) return null;
  return {
    id: task.id,
    status: task.status || "",
    providerTaskId: task.providerTaskId || null,
    processingStage: relayProcessingStage(task),
    resolutionPlan: videoResolutionPlan(task),
    storage: relayStorageState(assets),
  };
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
  }),
  requireProjectPermission("project:read"),
  async (req, res) => {
    const { projectId, scriptId } = req.body;

    const storyboardList = await u.db("o_storyboard").where({ scriptId, projectId }).orderBy("index", "asc");
    await Promise.all(
      storyboardList.map(async (i) => {
        i.filePath = i.filePath ? await u.oss.getSmallImageUrl(i.filePath) : "";
      }),
    );
    const storyboardTrackRecord: Record<number, any[]> = {};
    storyboardList.forEach((i) => {
      if (storyboardTrackRecord[i.trackId!]) {
        storyboardTrackRecord[i.trackId!].push({
          src: i.filePath,
          fileType: "image",
          sources: "storyboard",
          ...(i.prompt != null ? { prompt: i.videoDesc } : {}),
          ...(i.id != null ? { id: i.id } : {}),
          index: i.index,
        });
      } else {
        storyboardTrackRecord[i.trackId!] = [
          {
            src: i.filePath,
            fileType: "image",
            sources: "storyboard",
            ...(i.prompt != null ? { prompt: i.videoDesc } : {}),
            ...(i.id != null ? { id: i.id } : {}),
            index: i.index,
          },
        ];
      }
    });
    // 按 storyboardId 分组的资产数据，key 为 storyboardId
    const otherDataMap: Record<number, any[]> = {};
    const storyIds = storyboardList.map((s) => s.id);
    if (storyIds.length) {
      const assetDatas = await u
        .db("o_assets2Storyboard")
        .leftJoin("o_assets", "o_assets2Storyboard.assetId", "o_assets.id")
        .leftJoin("o_image", "o_image.id", "o_assets.imageId")
        .whereIn("o_assets2Storyboard.storyboardId", storyIds as number[])
        .select("o_assets.*", "o_image.filePath", "o_assets2Storyboard.storyboardId");

      // The selected runtime model, not the project's legacy `mode`, decides
      // whether audio references are accepted. Return every controlled audio
      // binding so the client can validate it against the live model catalog.
      const queryAudioIds = [
        ...assetDatas.map((i) => i.id!),
        ...assetDatas.map((i) => i.assetsId!),
      ].filter(Boolean);
      const assets2AudioData = queryAudioIds.length
        ? await u
            .db("o_assetsRole2Audio")
            .leftJoin("o_assets", "o_assets.assetsId", "o_assetsRole2Audio.assetsAudioId")
            .leftJoin("o_image", "o_image.id", "o_assets.imageId")
            .whereIn("o_assetsRole2Audio.assetsRoleId", queryAudioIds)
            .select(
              "o_assets.id",
              "o_assets.name",
              "o_assetsRole2Audio.assetsRoleId",
              "o_assets.describe",
              "o_assets.type",
              "o_assets.prompt",
              "o_image.filePath",
            )
        : [];
      const audioRecord: Record<string, any> = {};
      await Promise.all(
        assets2AudioData.map(async (i) => {
          if (!audioRecord[i.assetsRoleId]) audioRecord[i.assetsRoleId] = [];
          audioRecord[i.assetsRoleId].push({
            id: i.id,
            name: i.name,
            describe: i.describe,
            type: i.type,
            fileType: "audio" as const,
            sources: "assets",
            prompt: i.prompt,
            src: i.filePath ? await u.oss.getFileUrl(i.filePath) : "",
          });
        }),
      );

      await Promise.all(
        assetDatas.map(async (i) => {
          const item = {
            id: i.id,
            name: i.name,
            describe: i.describe,
            type: i.type,
            fileType: "image" as const,
            sources: "assets",
            src: i.filePath ? await u.oss.getSmallImageUrl(i.filePath) : "",
          };
          const sid = i.storyboardId as number;
          if (!otherDataMap[sid]) otherDataMap[sid] = [];
          otherDataMap[sid].push(item);
          if (audioRecord[i.id]) otherDataMap[sid].push(...audioRecord[i.id]);
          if (audioRecord[i.assetsId]) otherDataMap[sid].push(...audioRecord[i.assetsId]);
        }),
      );
    }

    const trackData = await u.db("o_videoTrack").where({ projectId, scriptId });
    const videoList = await u.db("o_video").whereIn(
      "videoTrackId",
      trackData.map((t) => t.id),
    );
    const readonlyEvidence =
      isCandidateRuntimeReadonlyEvidenceMode();
    if (!readonlyEvidence) {
      await Promise.all(
        videoList.filter(isRecoverableWorkbenchRelayVideo)
          .map(syncWorkbenchVideoRelay),
      );
    }
    const refreshedVideoList = readonlyEvidence
      ? videoList
      : await u.db("o_video").whereIn(
        "videoTrackId",
        trackData.map((t) => t.id),
      );
    const relayTaskIds = [
      ...new Set(
        refreshedVideoList
          .map((video: any) => String(video.relayTaskId || ""))
          .filter(Boolean),
      ),
    ];
    const [relayTaskRows, relayMediaRows] = relayTaskIds.length
      ? await Promise.all([
          u.db("o_relay_task").whereIn("id", relayTaskIds),
          u.db("o_media_asset").whereIn("taskId", relayTaskIds).orderBy("createTime", "asc"),
        ])
      : [[], []];
    const relayTaskRecord = relayTaskRows.reduce((acc: Record<string, any>, row: any) => {
      acc[row.id] = row;
      return acc;
    }, {});
    const relayMediaRecord = relayMediaRows.reduce((acc: Record<string, any[]>, row: any) => {
      acc[row.taskId] = acc[row.taskId] || [];
      acc[row.taskId].push(row);
      return acc;
    }, {});
    const trackList: TrackItem[] = [];
    const trackIdMap = [...new Set<number>(trackData.map((t) => t.id!))];
    for (const trackId of trackIdMap) {
      const item = trackData.find((t) => t.id === trackId);
      trackList.push({
        id: trackId,
        duration: item?.duration ?? 0,
        prompt: item?.prompt || "",
        state: (item?.state as "未生成" | "生成中" | "已完成" | "生成失败") ?? "未生成",
        reason: item?.reason ?? "",
        selectVideoId: Number(item?.videoId)!,
        medias: (() => {
          const storyboardMedias = storyboardTrackRecord[trackId] ?? [];
          const assetMedias = storyboardMedias.flatMap((s) => otherDataMap[s.id] ?? []);

          const seenAssetIds = new Set<number>();
          const uniqueAssets = assetMedias.filter((a) => {
            if (seenAssetIds.has(a.id)) return false;
            seenAssetIds.add(a.id);
            return true;
          });

          const hasImageAssetData = uniqueAssets.filter((i) => i.src);
          const notHasImageAssetData = uniqueAssets.filter((i) => !i.src);

          return [...hasImageAssetData, ...storyboardMedias, ...notHasImageAssetData];
        })(),
        videoList: await Promise.all(
          refreshedVideoList
            .filter((v) => v.videoTrackId === trackId)
            .map(async (v) => {
              const relayTaskId = v.relayTaskId ? String(v.relayTaskId) : null;
              const relayTask = relayTaskId ? relayTaskRecord[relayTaskId] : null;
              const publicVideo = projectWorkbenchRelayVideoForPublic({
                state: v.state,
                filePath: v.filePath,
                errorReason: v.errorReason,
                relayStatus: relayTask?.status,
              });
              const publicRelayTask = publicVideo.syntheticQuarantined
                ? {
                    ...relayTask,
                    status: "failed",
                    errorMessage: publicVideo.errorReason,
                  }
                : relayTask;
              return {
                id: v.id!,
                src: await videoFileUrl(publicVideo.filePath),
                state: publicVideo.state === "已完成" || publicVideo.state === "生成成功" ? "已完成" : publicVideo.state === "生成中" ? "生成中" : publicVideo.state === "生成失败" ? "生成失败" : "未生成",
                errorReason: redactSensitiveText(publicVideo.errorReason),
                relayTaskId,
                relay: videoRelayMeta(
                  publicRelayTask,
                  relayTaskId && !publicVideo.syntheticQuarantined
                    ? relayMediaRecord[relayTaskId] || []
                    : [],
                ),
              };
            }),
        ),
      });
    }
    res.status(200).send(
      success({
        storyboardList: await Promise.all(
          storyboardList.map(async (s) => ({
            ...s,
            src: s.filePath,
          })),
        ),
        trackList,
      }),
    );
  },
);
