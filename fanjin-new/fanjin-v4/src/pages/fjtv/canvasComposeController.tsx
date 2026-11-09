import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { NodeData, EdgeData, GroupData } from "./canvasDataTypes";
import type { NodeType } from "./canvasMediaTypes";
import { nearestRatio, mediaToNodeDimensions } from "./canvasMediaGeometry";
import { resolveCanvasComposeInputNodeIds } from "./canvasComposeInputs";
import { composeSegmentLength, findComposeClipByTime, getComposeClipLocalTime, layoutComposeClips, persistedComposeTimeline, type ComposeClip, type PersistedComposeClip } from "./canvasComposeTimeline";
import { api, buildCanvasComposeIdempotencyKey, resolveCanvasComposeAttemptId, shouldRetainCanvasComposeAttempt, type CanvasComposeVideoAsset } from "@/lib/api";
import { toApiErrorView } from "@/api/http";
import { normalizeProjectId } from "@/stores/projectStore";
import { triggerBrowserDownload } from "./canvasAssetPresentation";

export interface CanvasComposeControllerDependencies {
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  nodesRef: RefObject<NodeData[]>;
  edges: EdgeData[];
  composeClips: ComposeClip[];
  setComposeClips: Dispatch<SetStateAction<ComposeClip[]>>;
  setComposeRenderResult: Dispatch<SetStateAction<CanvasComposeVideoAsset | null>>;
  setComposeExportError: Dispatch<SetStateAction<string>>;
  composeEditorNodeId: string | null;
  composeMuted: boolean;
  composeExportEpochRef: RefObject<number>;
  setComposeEditorNodeId: Dispatch<SetStateAction<string | null>>;
  setComposeSelectedClipId: Dispatch<SetStateAction<string | null>>;
  setComposeCurrentTime: Dispatch<SetStateAction<number>>;
  setComposePlaying: Dispatch<SetStateAction<boolean>>;
  setComposeExportOpen: Dispatch<SetStateAction<boolean>>;
  setComposePreviewFullscreen: Dispatch<SetStateAction<boolean>>;
  setComposeScale: Dispatch<SetStateAction<number>>;
  setComposeExporting: Dispatch<SetStateAction<boolean>>;
  setComposeInspectorOpen: Dispatch<SetStateAction<boolean>>;
  setComposeTimelineDragging: Dispatch<SetStateAction<boolean>>;
  nodes: NodeData[];
  nodeMap: Map<string, NodeData>;
  setStatus: Dispatch<SetStateAction<string>>;
  setComposeLoading: Dispatch<SetStateAction<boolean>>;
  setComposeMuted: Dispatch<SetStateAction<boolean>>;
  composeTotalDuration: number;
  composePreviewRef: RefObject<HTMLVideoElement | null>;
  composePlaying: boolean;
  composeSelectedClip: ComposeClip | null;
  composeCanCrop: boolean;
  composeCurrentTime: number;
  composeActiveClip: ComposeClip | null;
  composeRenderResult: CanvasComposeVideoAsset | null;
  composeExporting: boolean;
  activeProjectContextId: string | null;
  canvasBalance: { refresh: () => void; loading: boolean; error: string; availableMicros: number; reservedMicros: number; baselineMicros: number; spentMicros: number; percent: number; lastRechargeAt: number | null; };
  createNode: (id: string, type: NodeType, centerX: number, centerY: number) => NodeData;
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
}

export function createCanvasComposeController(deps: CanvasComposeControllerDependencies) {
  const { setNodePatch, persistCanvas, nodesRef, edges, composeClips, setComposeClips, setComposeRenderResult, setComposeExportError, composeEditorNodeId, composeMuted, composeExportEpochRef, setComposeEditorNodeId, setComposeSelectedClipId, setComposeCurrentTime, setComposePlaying, setComposeExportOpen, setComposePreviewFullscreen, setComposeScale, setComposeExporting, setComposeInspectorOpen, setComposeTimelineDragging, nodes, nodeMap, setStatus, setComposeLoading, setComposeMuted, composeTotalDuration, composePreviewRef, composePlaying, composeSelectedClip, composeCanCrop, composeCurrentTime, composeActiveClip, composeRenderResult, composeExporting, activeProjectContextId, canvasBalance, createNode, setNodes, setEdges, setSelectedNodeIds, setSelectedEdgeIds, setActiveNodeId } = deps;
function getNodeMediaUrl(node: NodeData | null | undefined) {
    if (!node) return "";
    if (node.type === "image") return node.imageUrl || node.localPreviewUrl || "";
    if (node.type === "video") return node.videoUrl || node.localVideoUrl || "";
    return "";
  }

async function readVideoDuration(url: string) {
    return new Promise<number>((resolve) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => resolve(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 5);
      video.onerror = () => resolve(5);
      video.src = url;
    });
  }

function persistComposeDraft(
    nodeId: string,
    clips: ComposeClip[],
    muted: boolean,
    options: { preserveAttempt?: boolean } = {},
  ) {
    setNodePatch(nodeId, {
      composeTimeline: persistedComposeTimeline(clips),
      composeMuted: muted,
      ...(!options.preserveAttempt ? { composeRenderAttemptId: undefined } : {}),
    });
    window.setTimeout(() => void persistCanvas(nodesRef.current, edges), 40);
  }

function updateComposeClips(updater: ComposeClip[] | ((prev: ComposeClip[]) => ComposeClip[])) {
    const nextValue = typeof updater === "function" ? updater(composeClips) : updater;
    const nextClips = layoutComposeClips(nextValue);
    setComposeClips(nextClips);
    setComposeRenderResult(null);
    setComposeExportError("");
    if (composeEditorNodeId) {
      persistComposeDraft(composeEditorNodeId, nextClips, composeMuted);
    }
  }

function closeComposeEditor() {
    composeExportEpochRef.current += 1;
    setComposeEditorNodeId(null);
    setComposeClips([]);
    setComposeSelectedClipId(null);
    setComposeCurrentTime(0);
    setComposePlaying(false);
    setComposeExportOpen(false);
    setComposePreviewFullscreen(false);
    setComposeScale(1);
    setComposeExporting(false);
    setComposeExportError("");
    setComposeRenderResult(null);
    setComposeInspectorOpen(false);
    setComposeTimelineDragging(false);
  }

async function openComposeEditor(nodeId: string) {
    const connectedVideoNodes = resolveCanvasComposeInputNodeIds(
      nodeId,
      edges,
      nodes,
    )
      .map((connectedNodeId) => nodeMap.get(connectedNodeId))
      .filter((node): node is NodeData => Boolean(node && node.type === "video"));
    if (connectedVideoNodes.length === 0) {
      setStatus("请先连接视频节点后再打开视频合成");
      return;
    }
    setComposeLoading(true);
    setComposeEditorNodeId(nodeId);
    setComposeCurrentTime(0);
    setComposePlaying(false);
    setComposeExportOpen(false);
    setComposeInspectorOpen(false);
    setComposeExportError("");
    setComposeRenderResult(null);
    setComposeMuted(Boolean(nodeMap.get(nodeId)?.composeMuted));
    composeExportEpochRef.current += 1;
    const composeNode = nodeMap.get(nodeId);
    const nextClips: ComposeClip[] = [];
    const connectedById = new Map(connectedVideoNodes.map((node) => [node.id, node]));
    const savedTimeline = Array.isArray(composeNode?.composeTimeline)
      ? composeNode.composeTimeline
      : [];
    const timelineSources = savedTimeline.length > 0
      ? savedTimeline
          .map((saved) => ({
            saved,
            clipNode: connectedById.get(saved.nodeId),
          }))
          .filter(
            (
              entry,
            ): entry is { saved: PersistedComposeClip; clipNode: NodeData } =>
              Boolean(entry.clipNode),
          )
      : connectedVideoNodes.map((clipNode, index) => ({
          saved: {
            id: `compose_clip_${clipNode.id}_${index}`,
            nodeId: clipNode.id,
            assetVersionId: clipNode.assetVersionId,
            trimStart: 0,
            trimEnd: 0,
            speed: 1,
          },
          clipNode,
        }));
    for (const { saved, clipNode } of timelineSources) {
      const url = clipNode.videoUrl || clipNode.localVideoUrl || "";
      if (!url) continue;
      const duration = await readVideoDuration(url);
      const trimStart = Math.max(
        0,
        Math.min(duration - 0.1, Number(saved.trimStart) || 0),
      );
      const requestedTrimEnd = Number(saved.trimEnd);
      const trimEnd = Math.max(
        trimStart + 0.1,
        Math.min(
          duration,
          Number.isFinite(requestedTrimEnd) && requestedTrimEnd > 0
            ? requestedTrimEnd
            : duration,
        ),
      );
      nextClips.push({
        id: saved.id || `compose_clip_${clipNode.id}_${nextClips.length}`,
        nodeId: clipNode.id,
        assetVersionId:
          Number.isSafeInteger(Number(saved.assetVersionId))
          && Number(saved.assetVersionId) > 0
            ? Number(saved.assetVersionId)
            : clipNode.assetVersionId,
        title: clipNode.title,
        url,
        posterUrl: clipNode.videoPosterUrl || "",
        sourceDuration: duration,
        trimStart,
        trimEnd,
        speed: Math.min(4, Math.max(0.25, Number(saved.speed) || 1)),
        duration: trimEnd - trimStart,
        startAt: 0,
        endAt: trimEnd - trimStart,
      });
    }
    const laidOutClips = layoutComposeClips(nextClips);
    setComposeClips(laidOutClips);
    setComposeSelectedClipId(laidOutClips[0]?.id ?? null);
    setComposeLoading(false);
    if (laidOutClips.length === 0) {
      setStatus("已打开视频合成配置；连接的视频节点尚未生成或上传完成，完成后即可编辑");
    } else if (
      laidOutClips.some(
        (clip) =>
          !Number.isSafeInteger(Number(clip.assetVersionId))
          || Number(clip.assetVersionId) <= 0,
      )
    ) {
      setStatus("时间线已恢复；部分视频尚未写入项目资产，完成上传后才能真实导出");
    }
  }

function seekComposeTime(nextTime: number) {
    const capped = Math.max(0, Math.min(composeTotalDuration, nextTime));
    setComposeCurrentTime(capped);
    const clip = findComposeClipByTime(composeClips, capped);
    const preview = composePreviewRef.current;
    if (!clip || !preview) return;
    const localTime = getComposeClipLocalTime(clip, capped);
    preview.playbackRate = clip.speed;
    if (preview.src !== clip.url) {
      preview.src = clip.url;
      preview.load();
      preview.onloadedmetadata = () => {
        preview.currentTime = Math.min(Math.max(clip.trimStart, localTime), Math.max(clip.trimStart, clip.trimEnd - 0.02));
        if (composePlaying) void preview.play().catch(() => undefined);
      };
      return;
    }
    preview.currentTime = Math.min(Math.max(clip.trimStart, localTime), Math.max(clip.trimStart, clip.trimEnd - 0.02));
  }

function selectComposeClip(clipId: string) {
    setComposeSelectedClipId(clipId);
    setComposeInspectorOpen(true);
  }

function splitComposeClip() {
    if (!composeSelectedClip || !composeCanCrop) return;
    const splitTime = getComposeClipLocalTime(composeSelectedClip, composeCurrentTime);
    if (splitTime <= composeSelectedClip.trimStart + 0.08 || splitTime >= composeSelectedClip.trimEnd - 0.08) return;
    const leftClip: ComposeClip = {
      ...composeSelectedClip,
      trimEnd: splitTime,
    };
    const rightClip: ComposeClip = {
      ...composeSelectedClip,
      id: `${composeSelectedClip.id}_split_${Date.now()}`,
      trimStart: splitTime,
    };
    updateComposeClips((prev) => {
      const next: ComposeClip[] = [];
      prev.forEach((clip) => {
        if (clip.id !== composeSelectedClip.id) {
          next.push(clip);
          return;
        }
        next.push(leftClip, rightClip);
      });
      return next;
    });
    setComposeSelectedClipId(rightClip.id);
    setComposeInspectorOpen(true);
  }

function trimComposeClipLeft() {
    if (!composeSelectedClip || !composeCanCrop) return;
    const trimStart = getComposeClipLocalTime(composeSelectedClip, composeCurrentTime);
    if (trimStart >= composeSelectedClip.trimEnd - 0.08) return;
    updateComposeClips((prev) =>
      prev.map((clip) =>
        clip.id === composeSelectedClip.id
          ? {
              ...clip,
              trimStart,
            }
          : clip,
      ),
    );
    setComposeCurrentTime(composeSelectedClip.startAt);
  }

function trimComposeClipRight() {
    if (!composeSelectedClip || !composeCanCrop) return;
    const trimEnd = getComposeClipLocalTime(composeSelectedClip, composeCurrentTime);
    if (trimEnd <= composeSelectedClip.trimStart + 0.08) return;
    updateComposeClips((prev) =>
      prev.map((clip) =>
        clip.id === composeSelectedClip.id
          ? {
              ...clip,
              trimEnd,
            }
          : clip,
      ),
    );
    setComposeCurrentTime(Math.min(composeCurrentTime, composeSelectedClip.endAt));
  }

function setComposeClipSpeed(nextSpeed: number) {
    if (!composeSelectedClip) return;
    updateComposeClips((prev) =>
      prev.map((clip) =>
        clip.id === composeSelectedClip.id
          ? {
              ...clip,
              speed: Math.min(4, Math.max(0.25, nextSpeed)),
            }
          : clip,
      ),
    );
  }

function setComposeClipDuration(nextDuration: number) {
    if (!composeSelectedClip) return;
    const safeDuration = Math.max(0.1, nextDuration);
    const sourceSegment = composeSegmentLength(composeSelectedClip);
    const nextSpeed = Math.min(4, Math.max(0.25, sourceSegment / safeDuration));
    setComposeClipSpeed(nextSpeed);
  }

function jumpComposeToPreviousClip() {
    if (composeClips.length === 0) return;
    const currentIndex = composeActiveClip ? composeClips.findIndex((clip) => clip.nodeId === composeActiveClip.nodeId) : 0;
    const nextIndex = Math.max(0, currentIndex - 1);
    seekComposeTime(composeClips[nextIndex].startAt);
  }

function jumpComposeToNextClip() {
    if (composeClips.length === 0) return;
    const currentIndex = composeActiveClip ? composeClips.findIndex((clip) => clip.nodeId === composeActiveClip.nodeId) : 0;
    const nextIndex = Math.min(composeClips.length - 1, currentIndex + 1);
    seekComposeTime(composeClips[nextIndex].startAt);
  }

function toggleComposeMuted() {
    const nextMuted = !composeMuted;
    setComposeMuted(nextMuted);
    setComposeRenderResult(null);
    setComposeExportError("");
    if (composeEditorNodeId) {
      persistComposeDraft(composeEditorNodeId, composeClips, nextMuted);
    }
  }

async function renderComposeVideo(): Promise<CanvasComposeVideoAsset | null> {
    if (!composeEditorNodeId || composeClips.length === 0) return null;
    if (composeRenderResult) return composeRenderResult;
    if (composeExporting) return null;
    const projectId = normalizeProjectId(activeProjectContextId);
    if (projectId === null) {
      setComposeExportError("请先选择项目，再导出视频");
      return null;
    }
    const invalidClip = composeClips.find(
      (clip) =>
        !Number.isSafeInteger(Number(clip.assetVersionId))
        || Number(clip.assetVersionId) <= 0,
    );
    if (invalidClip) {
      setComposeExportError(
        `「${invalidClip.title}」尚未写入当前项目资产，请先等待生成完成或重新上传`,
      );
      return null;
    }
    const composeNode = nodeMap.get(composeEditorNodeId);
    if (!composeNode) return null;
    const attemptId = resolveCanvasComposeAttemptId(
      composeNode.composeRenderAttemptId,
    );
    const idempotencyKey = buildCanvasComposeIdempotencyKey({
      nodeId: composeEditorNodeId,
      attemptId,
    });
    const firstSource = nodeMap.get(composeClips[0].nodeId);
    const ratio = ["16:9", "9:16", "1:1", "4:3", "3:4"].includes(
      String(firstSource?.ratio || ""),
    )
      ? String(firstSource?.ratio)
      : "16:9";
    const exportEpoch = composeExportEpochRef.current + 1;
    composeExportEpochRef.current = exportEpoch;
    setComposeExporting(true);
    setComposeExportError("");
    setNodePatch(composeEditorNodeId, {
      composeRenderAttemptId: attemptId,
      composeTimeline: persistedComposeTimeline(composeClips),
      composeMuted,
    });
    try {
      await persistCanvas(nodesRef.current, edges);
      const result = await api.composeCanvasVideo(
        {
          projectId,
          ratio,
          clips: composeClips.map((clip) => ({
            assetVersionId: Number(clip.assetVersionId),
            trimStartSeconds: clip.trimStart,
            trimEndSeconds: clip.trimEnd,
            speed: clip.speed,
            volume: composeMuted ? 0 : 1,
          })),
        },
        { idempotencyKey },
      );
      if (
        composeExportEpochRef.current !== exportEpoch
        || composeEditorNodeId !== composeNode.id
      ) {
        return null;
      }
      setComposeRenderResult(result.asset);
      setNodePatch(composeEditorNodeId, {
        composeRenderAttemptId: undefined,
      });
      canvasBalance.refresh();
      await persistCanvas(nodesRef.current, edges).catch(() => {
        setStatus("合成结果已生成，但画布状态保存失败；刷新后可用相同请求安全恢复");
      });
      return result.asset;
    } catch (error) {
      if (composeExportEpochRef.current !== exportEpoch) return null;
      const errorView = toApiErrorView(error);
      const retainAttempt = shouldRetainCanvasComposeAttempt(errorView.status);
      setNodePatch(composeEditorNodeId, {
        composeRenderAttemptId: retainAttempt ? attemptId : undefined,
      });
      setComposeExportError(
        retainAttempt
          ? "合成结果尚未确认，可直接再次导出安全恢复，不会重复生成资产"
          : errorView.message || "视频合成失败",
      );
      void persistCanvas(nodesRef.current, edges).catch(() => {
        setComposeExportError((current) =>
          `${current || "视频合成失败"}；画布重试状态保存失败，请保持页面打开等待自动重试`,
        );
      });
      return null;
    } finally {
      if (composeExportEpochRef.current === exportEpoch) {
        setComposeExporting(false);
      }
    }
  }

async function exportComposeToCanvas() {
    if (!composeEditorNodeId || composeClips.length === 0) return;
    const result = await renderComposeVideo();
    if (!result) return;
    const composeNode = nodeMap.get(composeEditorNodeId);
    if (!composeNode) return;
    const id = `node_${Date.now()}_compose_export`;
    const ratio = nearestRatio(result.width, result.height);
    const dimensions = mediaToNodeDimensions(result.width, result.height);
    const nextNode: NodeData = {
      ...createNode(id, "video", composeNode.x + composeNode.width + 120, composeNode.y + composeNode.height / 2),
      title: "视频合成结果",
      titleCustomized: true,
      width: dimensions.width,
      height: dimensions.height,
      ratio,
      videoUrl: result.url,
      localVideoUrl: undefined,
      mediaNaturalWidth: result.width,
      mediaNaturalHeight: result.height,
      mediaDurationMs: result.durationMs,
      duration: String(Math.max(0.1, result.durationMs / 1000)),
      mediaAssetId: result.id,
      mediaAssetUrl: result.url,
      assetVersionId: result.assetVersionId,
      referenceAssetUri: `asset://${result.assetId}`,
      taskStatus: "success",
      fileName: "视频合成结果.mp4",
    };
    const nextEdge: EdgeData = {
      id: `edge_${Date.now()}_${id}`,
      fromNodeId: composeNode.id,
      fromSide: "right",
      toNodeId: id,
      toSide: "left",
    };
    const nextNodes = [...nodesRef.current, nextNode];
    const nextEdges = [...edges, nextEdge];
    setNodes(nextNodes);
    nodesRef.current = nextNodes;
    setEdges(nextEdges);
    setSelectedNodeIds([id]);
    setSelectedEdgeIds([nextEdge.id]);
    setActiveNodeId(id);
    setComposeExportOpen(false);
    setStatus("真实合成视频已写入项目资产并导出到画布");
    await persistCanvas(nextNodes, nextEdges);
  }

async function exportComposeToLocal() {
    if (composeClips.length === 0) return;
    const result = await renderComposeVideo();
    if (!result) return;
    triggerBrowserDownload(result.url, "视频合成结果.mp4");
    setComposeExportOpen(false);
    setStatus("真实合成视频已生成并开始下载");
  }
  return { getNodeMediaUrl, readVideoDuration, persistComposeDraft, updateComposeClips, closeComposeEditor, openComposeEditor, seekComposeTime, selectComposeClip, splitComposeClip, trimComposeClipLeft, trimComposeClipRight, setComposeClipSpeed, setComposeClipDuration, jumpComposeToPreviousClip, jumpComposeToNextClip, toggleComposeMuted, renderComposeVideo, exportComposeToCanvas, exportComposeToLocal };
}
