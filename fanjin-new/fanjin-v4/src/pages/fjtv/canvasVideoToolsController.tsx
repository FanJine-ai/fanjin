import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { taskRequiresBillingReconciliation } from "./canvasTaskState";
import { readVideoFrameFile } from "./canvasUploadMedia";
import type { CanvasModelType, VideoEnhanceResolution, VideoSubtitleEraseType, VideoFrameExtractMode, AudioSeparateRole, NodeData, VideoTrimDraft, VideoCropDraft, EdgeData, GroupData, CanvasMetaState } from "./canvasDataTypes";
import type { NodeType } from "./canvasMediaTypes";
import { submitAfterPortraitPreparation } from "../../features/quick-create/portraitPreparation";
import { generationPreparationPatch } from "../../features/quick-create/generationPreparation";
import { flushSync } from "react-dom";
import { type CanvasRealCapabilities } from "./canvasCapabilities";
import { getCanvasCatalogVideoEditCapability, resolveSelectedCanvasAspectRatio } from "./canvasCatalogContract";
import { api, createVideoEnhanceAttemptId, resolveCanvasVideoGenerationAttemptId, shouldRetainCanvasVideoGenerationAttempt, type AiModelOption } from "@/lib/api";
import { toApiErrorView } from "@/api/http";
import { normalizeProjectId } from "@/stores/projectStore";
import { type CanvasGenerationDebugSnapshot } from "./canvasGenerationDebug";
import { clampVideoCropDraft, formatVideoClock } from "./canvasAssetPresentation";
import { getBoundVideoSourceAssetId, resolveCanvasVideoSourceResolution } from "./canvasTaskResults";

export interface CanvasVideoToolsControllerDependencies {
  canvasCapabilities: CanvasRealCapabilities;
  setStatus: Dispatch<SetStateAction<string>>;
  resolvePendingVideoBillingBeforeSubmit: (node: NodeData, options?: { allowIdempotentRetryWithoutTaskId?: boolean; }) => Promise<boolean>;
  activeProjectContextId: string | null;
  preflightCanvasModel: (modelType: CanvasModelType, requestedModelId?: string, options?: { allowCatalogDefault?: boolean; openPicker?: boolean; }) => AiModelOption | null;
  parseDurationSeconds: (raw?: string) => number;
  setModelOpen: Dispatch<SetStateAction<boolean>>;
  videoNodeDurations: Record<string, number>;
  normalizeVideoResolutionForModel: (modelId: string | undefined, value: string | undefined, model?: AiModelOption) => string;
  beginNodeGenerationSession: (nodeId: string) => string;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  setGenerateDebug: (snapshot: CanvasGenerationDebugSnapshot | null) => void;
  isNodeGenerationSessionCurrent: (nodeId: string, sessionId: string) => boolean;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  beginNodeProgressSimulation: (nodeId: string, phase: "upload" | "generation") => void;
  pollTaskUntilDone: (taskId: string, node: NodeData, sessionId: string, startedAt?: number, options?: { kind?: "generation" | "video_enhance"; queryFailures?: number; }) => Promise<boolean>;
  finishNodeGenerationSession: (nodeId: string, sessionId?: string) => void;
  showNodeStatusChip: (nodeId: string, text: string, tone?: "neutral" | "success" | "error", durationMs?: number) => void;
  nodesRef: RefObject<NodeData[]>;
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  edges: EdgeData[];
  setActiveVideoEditor: Dispatch<SetStateAction<{ nodeId: string; mode: "trim" | "erase-subtitle" | "erase-region"; } | null>>;
  setVideoCropDraft: Dispatch<SetStateAction<VideoCropDraft | null>>;
  setExpanded: Dispatch<SetStateAction<boolean>>;
  setVideoTrimDraft: Dispatch<SetStateAction<VideoTrimDraft | null>>;
  setVideoTrimDragging: Dispatch<SetStateAction<{ type: "start" | "end" | "move"; pointerStart: number; initialStart: number; initialEnd: number; } | null>>;
  nodeVideoRefs: RefObject<Record<string, HTMLVideoElement | null>>;
  setVideoCropDragging: Dispatch<SetStateAction<{ type: "move" | "left" | "right" | "top" | "bottom" | "corner"; startX: number; startY: number; initial: VideoCropDraft; aspect: number; } | null>>;
  setVideoSubtitleMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setVideoEnhanceResolutionOpen: Dispatch<SetStateAction<boolean>>;
  createNode: (id: string, type: NodeType, centerX: number, centerY: number) => NodeData;
  nodes: NodeData[];
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  ensureApiKeyReady: () => boolean;
  resolveNodeRemoteReferenceUrl: (node: NodeData) => Promise<string>;
  buildAudioSeparateNodeTitle: (sourceTitle: string, role: AudioSeparateRole) => string;
  canvasMeta: CanvasMetaState;
  applyTaskResultToNode: (node: NodeData, taskData: any, sessionId?: string) => Promise<boolean>;
  activeVideoEditor: { nodeId: string; mode: "trim" | "erase-subtitle" | "erase-region"; } | null;
  videoTrimDraft: VideoTrimDraft | null;
  nodeMap: Map<string, NodeData>;
  videoEnhanceResolutionRank: (value: string) => 0 | 1 | 2 | 4 | 3;
  VIDEO_ENHANCE_RESOLUTIONS: VideoEnhanceResolution[];
  buildVideoEnhanceNodeTitle: (resolution: VideoEnhanceResolution | undefined) => string;
  VIDEO_ENHANCE_MODEL: "HuoShan-画质增强";
  stopNodeProgressTimer: (nodeId: string) => void;
  videoNodeCurrentTimes: Record<string, number>;
  createDerivedImageNode: (sourceNode: NodeData, title: string, patch?: Partial<NodeData>) => Promise<NodeData>;
  buildVideoFrameNodeTitle: (sourceTitle: string, mode: VideoFrameExtractMode) => string;
  videoCropDraft: VideoCropDraft | null;
  buildVideoSubtitleEraseNodeTitle: (sourceTitle: string, type: VideoSubtitleEraseType) => string;
  VIDEO_SUBTITLE_ERASE_MODEL: "HuoShan-智能去字幕";
}

export function createCanvasVideoToolsController(deps: CanvasVideoToolsControllerDependencies) {
  const { canvasCapabilities, setStatus, resolvePendingVideoBillingBeforeSubmit, activeProjectContextId, preflightCanvasModel, parseDurationSeconds, setModelOpen, videoNodeDurations, normalizeVideoResolutionForModel, beginNodeGenerationSession, setNodePatch, setGenerateDebug, isNodeGenerationSessionCurrent, persistCanvas, beginNodeProgressSimulation, pollTaskUntilDone, finishNodeGenerationSession, showNodeStatusChip, nodesRef, setNodes, edges, setActiveVideoEditor, setVideoCropDraft, setExpanded, setVideoTrimDraft, setVideoTrimDragging, nodeVideoRefs, setVideoCropDragging, setVideoSubtitleMenuNodeId, setVideoEnhanceResolutionOpen, createNode, nodes, setEdges, setSelectedNodeIds, setSelectedEdgeIds, setActiveNodeId, ensureApiKeyReady, resolveNodeRemoteReferenceUrl, buildAudioSeparateNodeTitle, canvasMeta, applyTaskResultToNode, activeVideoEditor, videoTrimDraft, nodeMap, videoEnhanceResolutionRank, VIDEO_ENHANCE_RESOLUTIONS, buildVideoEnhanceNodeTitle, VIDEO_ENHANCE_MODEL, stopNodeProgressTimer, videoNodeCurrentTimes, createDerivedImageNode, buildVideoFrameNodeTitle, videoCropDraft, buildVideoSubtitleEraseNodeTitle, VIDEO_SUBTITLE_ERASE_MODEL } = deps;
async function submitVideoClipRewrite(node: NodeData): Promise<boolean> {
    if (!canvasCapabilities.videoClipRewrite) {
      setStatus("当前工作区没有已验证的片段局部重绘模型，入口保持关闭");
      return false;
    }
    if (node.type !== "video" || !node.videoUrl) {
      setStatus("请先选择已有视频节点");
      return false;
    }
    if (!Number.isSafeInteger(Number(node.assetVersionId)) || Number(node.assetVersionId) <= 0) {
      setStatus("当前视频尚未写入项目资产版本，请重新上传后再重绘");
      return false;
    }
    if (!(await resolvePendingVideoBillingBeforeSubmit(
      node,
      { allowIdempotentRetryWithoutTaskId: true },
    ))) return false;
    const projectId = normalizeProjectId(activeProjectContextId);
    if (projectId === null) {
      setStatus("请先选择项目，再提交片段局部重绘");
      return false;
    }
    const catalogModel = preflightCanvasModel("video", node.model, { openPicker: true });
    if (!catalogModel) return false;
    const requestedDuration = parseDurationSeconds(node.duration);
    const editCapability = getCanvasCatalogVideoEditCapability(catalogModel, requestedDuration);
    if (!editCapability) {
      setModelOpen(true);
      setStatus("当前模型未验证 edit + 时间范围能力，请选择已支持局部重绘的模型");
      return false;
    }
    const rawDurationMs = Number(node.mediaDurationMs)
      || Math.round(Number(videoNodeDurations[node.id] || requestedDuration) * 1000);
    const startMs = Math.max(0, Math.round(Number(node.videoTrimStart || 0) * 1000));
    const requestedEndMs = Number.isFinite(Number(node.videoTrimEnd))
      ? Math.round(Number(node.videoTrimEnd) * 1000)
      : rawDurationMs;
    const endMs = Math.min(rawDurationMs, requestedEndMs);
    if (
      !Number.isFinite(rawDurationMs)
      || rawDurationMs <= 0
      || startMs >= rawDurationMs
      || endMs <= startMs
    ) {
      setStatus("无法读取有效的片段时间范围，请先完成视频元数据加载");
      return false;
    }
    const instruction = window.prompt(
      `输入 ${formatVideoClock(startMs / 1000)} - ${formatVideoClock(endMs / 1000)} 的重绘要求`,
      node.videoRewriteInstruction || "",
    )?.trim();
    if (!instruction) {
      setStatus("已取消片段局部重绘");
      return false;
    }
    if (!window.confirm("请确认你拥有该视频的再创作权利。本操作将提交模型任务并可能产生费用；原视频不会被覆盖。是否继续？")) {
      setStatus("已取消片段局部重绘");
      return false;
    }
    const ratio = resolveSelectedCanvasAspectRatio(catalogModel, node.ratio);
    if (!ratio) {
      setStatus("当前模型不支持该视频比例，请重新选择模型或比例");
      return false;
    }
    const normalizedRequestedResolution = normalizeVideoResolutionForModel(
      catalogModel.id,
      node.resolution,
      catalogModel,
    );
    const resolution = editCapability.resolutions.find((candidate) => (
      candidate.toLowerCase() === normalizedRequestedResolution.toLowerCase()
    )) || editCapability.resolutions[0];
    if (!resolution) {
      setStatus("当前编辑 operation 未声明可用分辨率，已阻止提交");
      return false;
    }
    const attemptId = resolveCanvasVideoGenerationAttemptId(node.videoGenerationAttemptId);
    const sourceAssetVersionId = Number(node.assetVersionId);
    const rewriteNode: NodeData = {
      ...node,
      model: catalogModel.id,
      videoGenerationAttemptId: attemptId,
      videoRewriteSourceVideoUrl: node.videoUrl,
      videoRewriteSourceAssetVersionId: sourceAssetVersionId,
      videoRewriteSourceReferenceAssetUri: node.referenceAssetUri,
      videoRewriteOutputVideoUrl: undefined,
      videoRewriteOutputAssetVersionId: undefined,
      videoRewriteOutputReferenceAssetUri: undefined,
      videoRewriteInstruction: instruction,
      videoRewriteStartMs: startMs,
      videoRewriteEndMs: endMs,
      videoRewriteViewing: "source",
      videoRewritePending: true,
    };
    const payload = {
      mediaType: "video",
      projectId,
      generationAttemptId: attemptId,
      model: catalogModel.id,
      prompt: instruction,
      mode: "video_edit",
      operation: "edit",
      resolution,
      ratio,
      duration: editCapability.durationSeconds,
      generateAudio: false,
      preserveSourceAudio: false,
      references: [{
        assetVersionId: String(sourceAssetVersionId),
        role: "subject",
        mediaType: "video",
        order: 0,
      }],
      source: { assetVersionId: String(sourceAssetVersionId) },
      edit: { startMs, endMs, instruction, preserve: [] },
    };
    const sessionId = beginNodeGenerationSession(node.id);
    flushSync(() => {
      setNodePatch(node.id, {
        ...rewriteNode,
        isGenerating: true,
        generationState: "submitting",
        taskStatus: "processing",
        taskId: undefined,
        taskKind: "generation",
        generationProgress: 1,
      });
      setStatus("片段局部重绘任务提交中...");
    });
    setGenerateDebug({ phase: "submitting", payload });
    try {
      const result = await submitAfterPortraitPreparation({
        submit: () => api.generateNode(payload),
        isCurrent: () => isNodeGenerationSessionCurrent(node.id, sessionId),
        onProgress: setStatus,
      });
      if (!isNodeGenerationSessionCurrent(node.id, sessionId)) return false;
      const taskId = String((result as any)?.taskId || (result as any)?.id || "").trim();
      setGenerateDebug({ phase: "generate-response", payload, response: result });
      if (!taskId) throw new Error("视频局部重绘响应缺少任务编号");
      setNodePatch(node.id, {
        isGenerating: true,
        generationState: "processing",
        taskStatus: "processing",
        taskId,
        taskKind: "generation",
        generationProgress: 3,
        ...generationPreparationPatch(result),
      });
      void persistCanvas();
      beginNodeProgressSimulation(node.id, "generation");
      const ok = await pollTaskUntilDone(taskId, rewriteNode, sessionId);
      if (ok) setStatus("片段局部重绘完成，可对比或恢复原片");
      return ok;
    } catch (error) {
      if (!isNodeGenerationSessionCurrent(node.id, sessionId)) return false;
      const errorView = toApiErrorView(error);
      const transportUncertain = shouldRetainCanvasVideoGenerationAttempt(errorView.status);
      setNodePatch(node.id, {
        isGenerating: false,
        generationState: "idle",
        taskId: undefined,
        taskKind: transportUncertain ? "generation" : undefined,
        taskStatus: transportUncertain ? "pending_reconcile" : "failed",
        videoGenerationAttemptId: transportUncertain ? attemptId : undefined,
        videoRewritePending: transportUncertain,
        generationProgress: 0,
      });
      finishNodeGenerationSession(node.id, sessionId);
      showNodeStatusChip(
        node.id,
        transportUncertain ? "提交结果待确认" : "重绘失败，已保留原片",
        transportUncertain ? "neutral" : "error",
        3200,
      );
      setStatus(
        transportUncertain
          ? "局部重绘提交结果尚未确认；再次点击将使用同一请求编号安全查询或重放"
          : errorView.message || "片段局部重绘失败，原片未被修改",
      );
      return false;
    }
  }

function showVideoRewriteVersion(node: NodeData, viewing: "source" | "output") {
    const videoUrl = viewing === "source"
      ? node.videoRewriteSourceVideoUrl
      : node.videoRewriteOutputVideoUrl;
    const assetVersionId = viewing === "source"
      ? node.videoRewriteSourceAssetVersionId
      : node.videoRewriteOutputAssetVersionId;
    const referenceAssetUri = viewing === "source"
      ? node.videoRewriteSourceReferenceAssetUri
      : node.videoRewriteOutputReferenceAssetUri;
    if (!videoUrl || !assetVersionId) {
      setStatus(viewing === "source" ? "原片版本不可用" : "重绘版本不可用");
      return;
    }
    const nextNodes = nodesRef.current.map((candidate) => candidate.id === node.id
      ? {
          ...candidate,
          videoUrl,
          assetVersionId,
          referenceAssetUri,
          mediaAssetId: undefined,
          mediaAssetUrl: undefined,
          videoPosterUrl: undefined,
          videoRewriteViewing: viewing,
        }
      : candidate);
    setNodes(nextNodes);
    void persistCanvas(nextNodes, edges);
    setStatus(viewing === "source" ? "已切换到原片；重绘版本仍保留" : "已切换到重绘版本");
  }

function restoreVideoRewriteSource(node: NodeData) {
    if (!window.confirm("恢复后原片将成为当前画布版本，重绘产物仍保留用于对比。是否继续？")) return;
    showVideoRewriteVersion(node, "source");
  }

function applyTrimSnap(value: number, enabled: boolean) {
    return enabled ? Math.round(value) : value;
  }

function openVideoTrimEditor(node: NodeData) {
    const duration = Math.max(0.5, videoNodeDurations[node.id] || parseDurationSeconds(node.duration) || 5);
    const start = Math.max(0, Math.min(duration - 0.1, node.videoTrimStart ?? 0));
    const end = Math.max(start + 0.1, Math.min(duration, node.videoTrimEnd ?? duration));
    setActiveVideoEditor({ nodeId: node.id, mode: "trim" });
    setVideoCropDraft(null);
    setExpanded(false);
    setVideoTrimDraft({
      start,
      end,
      duration,
      snapToWholeSecond: node.videoSnapToWholeSecond ?? false,
      loopSelection: node.videoLoopSelection ?? false,
    });
    setVideoTrimDragging(null);
    const video = nodeVideoRefs.current[node.id];
    if (video) {
      video.currentTime = start;
      video.play().catch(() => undefined);
    }
  }

function openVideoSubtitleEraseEditor(node: NodeData) {
    setActiveVideoEditor({ nodeId: node.id, mode: "erase-subtitle" });
    setVideoTrimDraft(null);
    setVideoTrimDragging(null);
    setVideoCropDraft(null);
    setVideoCropDragging(null);
    setExpanded(false);
    setVideoSubtitleMenuNodeId(null);
  }

function openVideoRegionEraseEditor(node: NodeData) {
    setActiveVideoEditor({ nodeId: node.id, mode: "erase-region" });
    setVideoTrimDraft(null);
    setVideoTrimDragging(null);
    setExpanded(false);
    setVideoSubtitleMenuNodeId(null);
    setVideoCropDraft(
      clampVideoCropDraft({
        x: 0.32,
        y: 0.32,
        width: 0.28,
        height: 0.24,
      }),
    );
    setVideoCropDragging(null);
  }

function closeVideoEditor() {
    setActiveVideoEditor(null);
    setVideoTrimDraft(null);
    setVideoCropDraft(null);
    setVideoTrimDragging(null);
    setVideoCropDragging(null);
    setVideoEnhanceResolutionOpen(false);
    setVideoSubtitleMenuNodeId(null);
  }

async function createDerivedVideoNode(sourceNode: NodeData, patch: Partial<NodeData>, titleSuffix: string) {
    const id = `node_${Date.now()}_${titleSuffix}`;
    const nextNode: NodeData = {
      ...createNode(id, "video", sourceNode.x + sourceNode.width + 220, sourceNode.y + sourceNode.height / 2),
      title: `${sourceNode.title} ${titleSuffix}`,
      titleCustomized: true,
      videoUrl: sourceNode.videoUrl,
      localVideoUrl: sourceNode.localVideoUrl,
      mediaNaturalWidth: patch.mediaNaturalWidth ?? sourceNode.mediaNaturalWidth,
      mediaNaturalHeight: patch.mediaNaturalHeight ?? sourceNode.mediaNaturalHeight,
      duration: patch.duration ?? sourceNode.duration,
      resolution: patch.resolution ?? sourceNode.resolution,
      ratio: patch.ratio ?? sourceNode.ratio,
      ...patch,
    };
    const nextEdge: EdgeData = {
      id: `edge_${Date.now()}_${id}`,
      fromNodeId: sourceNode.id,
      fromSide: "right",
      toNodeId: id,
      toSide: "left",
    };
    const nextNodes = [...nodes, nextNode];
    const nextEdges = [...edges, nextEdge];
    setNodes(nextNodes);
    setEdges(nextEdges);
    setSelectedNodeIds([id]);
    setSelectedEdgeIds([nextEdge.id]);
    setActiveNodeId(id);
    await persistCanvas(nextNodes, nextEdges);
  }

async function submitAudioSeparate(sourceNode: NodeData) {
    if (!ensureApiKeyReady()) return;
    let videoUrl = "";
    try {
      videoUrl = await resolveNodeRemoteReferenceUrl(sourceNode);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "视频素材上传失败");
      return;
    }
    if (!videoUrl) {
      setStatus("请先准备可用的视频素材");
      return;
    }

    const stamp = Date.now();
    const voiceNodeId = `node_${stamp}_separate_voice`;
    const bgmNodeId = `node_${stamp}_separate_bgm`;
    const muteVideoNodeId = `node_${stamp}_separate_mute_video`;
    const audioNodeX = sourceNode.x + sourceNode.width + 120;
    const voiceNode: NodeData = {
      ...createNode(voiceNodeId, "audio", sourceNode.x + sourceNode.width + 170, sourceNode.y - 80),
      title: buildAudioSeparateNodeTitle(sourceNode.title, "voice"),
      titleCustomized: true,
      x: audioNodeX,
      y: sourceNode.y + 8,
      width: 304,
      height: 120,
      audioSeparateMode: true,
      audioSeparateRole: "voice",
      isGenerating: true,
      generationState: "submitting",
      taskStatus: "processing",
      price: "",
    };
    const bgmNode: NodeData = {
      ...createNode(bgmNodeId, "audio", sourceNode.x + sourceNode.width + 170, sourceNode.y + sourceNode.height + 80),
      title: buildAudioSeparateNodeTitle(sourceNode.title, "bgm"),
      titleCustomized: true,
      x: audioNodeX,
      y: sourceNode.y + sourceNode.height - 8 + 56,
      width: 304,
      height: 120,
      audioSeparateMode: true,
      audioSeparateRole: "bgm",
      isGenerating: true,
      generationState: "submitting",
      taskStatus: "processing",
      price: "",
    };
    const muteVideoNode: NodeData = {
      ...createNode(muteVideoNodeId, "video", sourceNode.x + sourceNode.width + 700, sourceNode.y + sourceNode.height / 2),
      title: buildAudioSeparateNodeTitle(sourceNode.title, "mute-video"),
      titleCustomized: true,
      x: sourceNode.x + sourceNode.width + 520,
      y: sourceNode.y,
      width: sourceNode.width,
      height: sourceNode.height,
      ratio: sourceNode.ratio,
      resolution: sourceNode.resolution,
      mediaNaturalWidth: sourceNode.mediaNaturalWidth || 1280,
      mediaNaturalHeight: sourceNode.mediaNaturalHeight || 720,
      duration: sourceNode.duration,
      audioSeparateMode: true,
      audioSeparateRole: "mute-video",
      isGenerating: true,
      generationState: "submitting",
      taskStatus: "processing",
      price: "",
    };
    const nextEdges: EdgeData[] = [
      {
        id: `edge_${stamp}_separate_voice`,
        fromNodeId: sourceNode.id,
        fromSide: "right",
        toNodeId: voiceNodeId,
        toSide: "left",
      },
      {
        id: `edge_${stamp}_separate_bgm`,
        fromNodeId: sourceNode.id,
        fromSide: "right",
        toNodeId: bgmNodeId,
        toSide: "left",
      },
      {
        id: `edge_${stamp}_separate_mute_video`,
        fromNodeId: sourceNode.id,
        fromSide: "right",
        toNodeId: muteVideoNodeId,
        toSide: "left",
      },
    ];
    const nextNodes = [...nodes, voiceNode, bgmNode, muteVideoNode];
    const mergedEdges = [...edges, ...nextEdges];
    setNodes(nextNodes);
    setEdges(mergedEdges);
    setSelectedNodeIds([voiceNodeId, bgmNodeId, muteVideoNodeId]);
    setSelectedEdgeIds(nextEdges.map((item) => item.id));
    setActiveNodeId(muteVideoNodeId);
    await persistCanvas(nextNodes, mergedEdges);

    const voiceSession = beginNodeGenerationSession(voiceNodeId);
    const bgmSession = beginNodeGenerationSession(bgmNodeId);
    const muteSession = beginNodeGenerationSession(muteVideoNodeId);
    try {
      const result = await api.separateAudio({
        canvasId: canvasMeta.canvasId || undefined,
        sourceType: "video",
        videoUrl,
        voiceNodeId,
        bgmNodeId,
        muteVideoNodeId,
      });
      const taskId = (result as any)?.taskId || (result as any)?.id || "";
      const status = String((result as any)?.status || "").toLowerCase();
      setStatus("已提交音频分离任务");
      if (status === "processing" && taskId) {
        setNodePatch(voiceNodeId, { taskId, taskStatus: "processing", generationState: "processing", generationProgress: 3, ...generationPreparationPatch(result) }); beginNodeProgressSimulation(voiceNodeId, "generation");
        setNodePatch(bgmNodeId, { taskId, taskStatus: "processing", generationState: "processing", generationProgress: 3, ...generationPreparationPatch(result) }); beginNodeProgressSimulation(bgmNodeId, "generation");
        setNodePatch(muteVideoNodeId, { taskId, taskStatus: "processing", generationState: "processing", generationProgress: 3, ...generationPreparationPatch(result) }); beginNodeProgressSimulation(muteVideoNodeId, "generation");
        void pollTaskUntilDone(taskId, voiceNode, voiceSession);
        void pollTaskUntilDone(taskId, bgmNode, bgmSession);
        void pollTaskUntilDone(taskId, muteVideoNode, muteSession);
        return;
      }
      const okVoice = await applyTaskResultToNode(voiceNode, result, voiceSession);
      const okBgm = await applyTaskResultToNode(bgmNode, result, bgmSession);
      const okMute = await applyTaskResultToNode(muteVideoNode, result, muteSession);
      setStatus(okVoice || okBgm || okMute ? "音频分离完成" : "音频分离失败");
    } catch (error) {
      setNodePatch(voiceNodeId, { isGenerating: false, generationState: "idle", taskId: undefined, taskStatus: "failed" });
      setNodePatch(bgmNodeId, { isGenerating: false, generationState: "idle", taskId: undefined, taskStatus: "failed" });
      setNodePatch(muteVideoNodeId, { isGenerating: false, generationState: "idle", taskId: undefined, taskStatus: "failed" });
      finishNodeGenerationSession(voiceNodeId, voiceSession);
      finishNodeGenerationSession(bgmNodeId, bgmSession);
      finishNodeGenerationSession(muteVideoNodeId, muteSession);
      setStatus(error instanceof Error ? error.message : "音频分离任务提交失败");
    }
  }

async function confirmVideoTrim() {
    if (!activeVideoEditor || activeVideoEditor.mode !== "trim" || !videoTrimDraft) return;
    const sourceNode = nodeMap.get(activeVideoEditor.nodeId);
    if (!sourceNode) return;
    const start = applyTrimSnap(videoTrimDraft.start, videoTrimDraft.snapToWholeSecond);
    const end = Math.max(start + 0.1, applyTrimSnap(videoTrimDraft.end, videoTrimDraft.snapToWholeSecond));
    const clipDuration = Math.max(0.1, end - start);
    await createDerivedVideoNode(
      sourceNode,
      {
        videoTrimStart: start,
        videoTrimEnd: end,
        videoLoopSelection: videoTrimDraft.loopSelection,
        videoSnapToWholeSecond: videoTrimDraft.snapToWholeSecond,
        duration: clipDuration.toFixed(2).replace(/\.?0+$/, ""),
      },
      "剪辑",
    );
    closeVideoEditor();
    setStatus("已生成剪辑后的视频节点");
  }

async function openVideoEnhanceEditor(node: NodeData) {
    if (!canvasCapabilities.videoEnhance) {
      setStatus("视频 2K/4K 超分通道尚未完成真实配置，当前不会提交增强任务");
      return;
    }
    setExpanded(false);
    const sourceResolution = resolveCanvasVideoSourceResolution(node);
    const sourceRank = videoEnhanceResolutionRank(sourceResolution);
    const candidates = VIDEO_ENHANCE_RESOLUTIONS.filter((item) => videoEnhanceResolutionRank(item) > sourceRank);
    if (candidates.length === 0) {
      setStatus("当前视频已是最高公开分辨率");
      return;
    }
    const durationSeconds = Math.max(
      1,
      Math.ceil(videoNodeDurations[node.id] || Number(node.duration) || Number(node.mediaDurationMs || 0) / 1000 || 1),
    );
    setStatus("正在检查真实视频增强通道...");
    const quoteResults = await Promise.all(candidates.map(async (targetResolution) => {
      try {
        const result = await api.quoteVideoEnhance({
          sourceResolution,
          targetResolution,
          durationSeconds,
        });
        return {
          targetResolution,
          amountGu: Number((result as any)?.quote?.amountGu || 0),
        };
      } catch {
        return null;
      }
    }));
    const available = quoteResults.filter(
      (item): item is { targetResolution: VideoEnhanceResolution; amountGu: number } => Boolean(item),
    );
    if (available.length === 0) {
      setStatus("当前没有已配置价格且健康可用的视频增强档位");
      return;
    }
    const id = `node_${Date.now()}_enhance`;
    const defaultResolution = available.some((item) => item.targetResolution === "1080P")
      ? "1080P"
      : available[0].targetResolution;
    const quoteGu = Object.fromEntries(
      available.map((item) => [item.targetResolution, item.amountGu]),
    ) as Partial<Record<VideoEnhanceResolution, number>>;
    const nextNode: NodeData = {
      ...createNode(id, "video", node.x + node.width + 220, node.y + node.height / 2),
      title: buildVideoEnhanceNodeTitle(defaultResolution),
      titleCustomized: true,
      resolution: defaultResolution,
      mediaNaturalWidth: 1280,
      mediaNaturalHeight: 720,
      videoEnhanceMode: true,
      videoEnhanceModel: VIDEO_ENHANCE_MODEL,
      videoEnhanceVersion: "standard",
      videoEnhanceResolution: defaultResolution,
      videoEnhanceFrameRate: "original",
      videoEnhanceAvailableResolutions: available.map((item) => item.targetResolution),
      videoEnhanceQuoteGu: quoteGu,
    };
    const nextEdge: EdgeData = {
      id: `edge_${Date.now()}_${id}`,
      fromNodeId: node.id,
      fromSide: "right",
      toNodeId: id,
      toSide: "left",
    };
    const nextNodes = [...nodes, nextNode];
    const nextEdges = [...edges, nextEdge];
    setNodes(nextNodes);
    setEdges(nextEdges);
    setSelectedNodeIds([id]);
    setSelectedEdgeIds([nextEdge.id]);
    setActiveNodeId(id);
    setExpanded(false);
    await persistCanvas(nextNodes, nextEdges);
    setStatus(`已加载 ${available.length} 个真实可用的视频增强档位`);
  }

async function submitVideoEnhance(node: NodeData) {
    if (!canvasCapabilities.videoEnhance) {
      setStatus("视频 2K/4K 超分通道尚未完成真实配置，当前不会提交增强任务");
      return;
    }
    if (!(await resolvePendingVideoBillingBeforeSubmit(node, { allowIdempotentRetryWithoutTaskId: true }))) {
      return;
    }
    if (!ensureApiKeyReady()) return;
    const sourceNode = edges
      .filter((edge) => edge.toNodeId === node.id)
      .map((edge) => nodeMap.get(edge.fromNodeId))
      .find((item): item is NodeData => Boolean(item && item.type === "video"));
    if (!sourceNode) {
      setStatus("请先连接一个视频节点");
      return;
    }
    let videoUrl = "";
    try {
      videoUrl = await resolveNodeRemoteReferenceUrl(sourceNode);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "视频素材上传失败");
      return;
    }
    if (!videoUrl) {
      setStatus("请先准备可用的视频素材");
      return;
    }

    const resolution = node.videoEnhanceResolution || "1080P";
    const sourceResolution = resolveCanvasVideoSourceResolution(sourceNode);
    const durationSeconds = Math.max(
      1,
      Math.ceil(videoNodeDurations[sourceNode.id] || Number(sourceNode.duration) || Number(sourceNode.mediaDurationMs || 0) / 1000 || 1),
    );
    try {
      await api.quoteVideoEnhance({
        sourceResolution,
        targetResolution: resolution,
        durationSeconds,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "当前视频增强档位不可用");
      return;
    }
    const sourceAssetId = getBoundVideoSourceAssetId(sourceNode, videoUrl);
    const attemptId = node.videoEnhanceAttemptId || createVideoEnhanceAttemptId();
    const sessionId = beginNodeGenerationSession(node.id);
    flushSync(() => {
      setNodePatch(node.id, {
        isGenerating: true,
        generationState: "submitting",
        taskId: undefined,
        taskKind: "video_enhance",
        taskStatus: "processing",
        videoEnhanceAttemptId: attemptId,
        generationProgress: 1,
      });
      setStatus("高清视频任务提交中...");
    });
    try {
      // Path B: dedicated workbench enhance (video_enhance billing), not silent generation.
      const result = await api.enhanceVideo({
        canvasId: canvasMeta.canvasId || undefined,
        nodeId: node.id,
        videoUrl,
        sourceAssetId,
        sourceResolution,
        resolution,
        attemptId,
      });
      if (!isNodeGenerationSessionCurrent(node.id, sessionId)) return;
      const task = (result as any)?.task || result;
      const taskId = String(task?.id || (result as any)?.taskId || "");
      const status = String(task?.status || (result as any)?.status || "").toLowerCase();
      flushSync(() => {
        setNodePatch(node.id, { generationState: "processing" });
        setStatus(`已提交视频画质增强：${sourceResolution} → ${resolution}`);
      });
      if (
        (
          status === "pending_reconcile"
          || status === "running"
          || status === "enhancing"
          || status === "processing"
          || status === "created"
          || status === "queued"
        )
        && taskId
      ) {
        setNodePatch(node.id, {
          taskId,
          taskKind: "video_enhance",
          taskStatus: "processing",
          generationState: "processing",
          generationProgress: 3,
        });
        beginNodeProgressSimulation(node.id, "generation");
        await pollTaskUntilDone(taskId, node, sessionId, Date.now(), { kind: "video_enhance" });
        return;
      }
      const ok = await applyTaskResultToNode(node, task, sessionId);
      if (!ok && !isNodeGenerationSessionCurrent(node.id, sessionId)) return;
      if (ok && taskRequiresBillingReconciliation(task)) {
        showNodeStatusChip(node.id, "高清视频已交付", "neutral", 3200);
        setStatus("高清视频已交付，费用明细可在账单中查询");
      } else {
        setStatus(ok ? "高清生成完成" : "高清生成失败");
      }
    } catch (error) {
      if (!isNodeGenerationSessionCurrent(node.id, sessionId)) return;
      setNodePatch(node.id, {
        isGenerating: false,
        generationState: "idle",
        taskId: undefined,
        taskKind: "video_enhance",
        taskStatus: "pending_reconcile",
        videoEnhanceAttemptId: attemptId,
      });
      finishNodeGenerationSession(node.id, sessionId);
      showNodeStatusChip(node.id, "提交结果待确认", "error", 3200);
      setStatus(
        error instanceof Error
          ? `${error.message}；再次点击将使用同一请求安全重试，不会创建新尝试`
          : "提交结果待确认；再次点击将使用同一请求安全重试",
      );
    }
  }

async function submitVideoFrameExtract(sourceNode: NodeData, extractMode: VideoFrameExtractMode) {
    if (!ensureApiKeyReady()) return;
    const localVideo = nodeVideoRefs.current[sourceNode.id];
    const currentTime =
      videoNodeCurrentTimes[sourceNode.id] ??
      (localVideo && Number.isFinite(localVideo.currentTime) ? localVideo.currentTime : undefined) ??
      0;
    const projectId = normalizeProjectId(activeProjectContextId);
    const videoUrl = sourceNode.localVideoUrl || sourceNode.videoUrl || "";
    if (projectId === null) {
      setStatus("请先选择项目，再截取视频画面");
      return;
    }
    if (!videoUrl) {
      setStatus("请先准备可用的视频素材");
      return;
    }
    try {
      setStatus("正在截取视频画面并写入项目资产...");
      const frameFile = await readVideoFrameFile(
        videoUrl,
        sourceNode.fileName || sourceNode.title || "video",
        extractMode,
        currentTime,
      );
      const uploaded = await api.uploadImage(frameFile, { projectId });
      const targetNode = await createDerivedImageNode(sourceNode, buildVideoFrameNodeTitle(sourceNode.title, extractMode), {
        imageUrl: uploaded.url,
        primaryImageUrl: uploaded.url,
        referenceAssetUri: uploaded.assetId ? `asset://${uploaded.assetId}` : undefined,
        assetVersionId: uploaded.assetVersionId,
        isGenerating: false,
        generationState: "idle",
        taskStatus: "success",
      });
      setNodePatch(targetNode.id, {
        imageUrl: uploaded.url,
        primaryImageUrl: uploaded.url,
        referenceAssetUri: uploaded.assetId ? `asset://${uploaded.assetId}` : undefined,
        assetVersionId: uploaded.assetVersionId,
      });
      window.setTimeout(() => void persistCanvas(), 40);
      setStatus("截帧完成，结果已写入当前项目资产");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "视频截帧失败");
    }
  }

async function submitVideoSubtitleErase(sourceNode: NodeData, eraseType: VideoSubtitleEraseType) {
    if (!ensureApiKeyReady()) return;
    let videoUrl = "";
    try {
      videoUrl = await resolveNodeRemoteReferenceUrl(sourceNode);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "视频素材上传失败");
      return;
    }
    if (!videoUrl) {
      setStatus("请先准备可用的视频素材");
      return;
    }

    const eraseAreas =
      eraseType === "region" && videoCropDraft
        ? [
            {
              top_left_x: Number(videoCropDraft.x.toFixed(4)),
              top_left_y: Number(videoCropDraft.y.toFixed(4)),
              bottom_right_x: Number((videoCropDraft.x + videoCropDraft.width).toFixed(4)),
              bottom_right_y: Number((videoCropDraft.y + videoCropDraft.height).toFixed(4)),
            },
          ]
        : [];

    const id = `node_${Date.now()}_${eraseType === "region" ? "erase_region" : "erase_subtitle"}`;
    const nextNode: NodeData = {
      ...createNode(id, "video", sourceNode.x + sourceNode.width + 220, sourceNode.y + sourceNode.height / 2),
      title: buildVideoSubtitleEraseNodeTitle(sourceNode.title, eraseType),
      titleCustomized: true,
      resolution: sourceNode.resolution,
      ratio: sourceNode.ratio,
      mediaNaturalWidth: sourceNode.mediaNaturalWidth || 1280,
      mediaNaturalHeight: sourceNode.mediaNaturalHeight || 720,
      duration: sourceNode.duration,
      videoSubtitleEraseMode: true,
      videoSubtitleEraseType: eraseType,
      videoSubtitleEraseAreas: eraseAreas,
      isGenerating: true,
      generationState: "submitting",
      taskStatus: "processing",
      taskId: undefined,
      model: VIDEO_SUBTITLE_ERASE_MODEL,
      price: "",
    };
    const nextEdge: EdgeData = {
      id: `edge_${Date.now()}_${id}`,
      fromNodeId: sourceNode.id,
      fromSide: "right",
      toNodeId: id,
      toSide: "left",
    };
    const nextNodes = [...nodes, nextNode];
    const nextEdges = [...edges, nextEdge];
    setNodes(nextNodes);
    setEdges(nextEdges);
    setSelectedNodeIds([id]);
    setSelectedEdgeIds([nextEdge.id]);
    setActiveNodeId(id);
    closeVideoEditor();
    await persistCanvas(nextNodes, nextEdges);

    const sessionId = beginNodeGenerationSession(id);
    try {
      const result = await api.eraseVideoSubtitle({
        canvasId: canvasMeta.canvasId || undefined,
        nodeId: id,
        videoUrl,
        eraseType,
        eraseAreas,
      });
      if (!isNodeGenerationSessionCurrent(id, sessionId)) return;
      const taskId = (result as any)?.taskId || (result as any)?.id || "";
      const status = String((result as any)?.status || "").toLowerCase();
      flushSync(() => {
        setNodePatch(id, { generationState: "processing" });
        setStatus(eraseType === "region" ? "已提交框选擦除任务" : "已提交一键去字幕任务");
      });
      const targetNode = nextNodes.find((item) => item.id === id) || nextNode;
      if (status === "processing" && taskId) {
        setNodePatch(id, { taskId, taskStatus: "processing", generationState: "processing" });
        await pollTaskUntilDone(taskId, targetNode, sessionId);
        return;
      }
      const ok = await applyTaskResultToNode(targetNode, result, sessionId);
      if (!ok && !isNodeGenerationSessionCurrent(id, sessionId)) return;
      setStatus(ok ? "擦除完成" : "擦除失败");
    } catch (error) {
      if (!isNodeGenerationSessionCurrent(id, sessionId)) return;
      setNodePatch(id, { isGenerating: false, generationState: "idle", taskId: undefined, taskStatus: "failed" });
      finishNodeGenerationSession(id, sessionId);
      setStatus(error instanceof Error ? error.message : "视频擦除任务提交失败");
    }
  }
  return { submitVideoClipRewrite, showVideoRewriteVersion, restoreVideoRewriteSource, applyTrimSnap, openVideoTrimEditor, openVideoSubtitleEraseEditor, openVideoRegionEraseEditor, closeVideoEditor, createDerivedVideoNode, submitAudioSeparate, confirmVideoTrim, openVideoEnhanceEditor, submitVideoEnhance, submitVideoFrameExtract, submitVideoSubtitleErase };
}
