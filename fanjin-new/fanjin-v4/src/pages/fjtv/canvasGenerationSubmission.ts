import { validateRedrawSubmission } from "../../features/video-redraw/redrawGraph";
import type * as React from "react";
import { patchLooksActivelyGenerating } from "./canvasTaskState";
import { type CanvasModelType, type NodeData, type EdgeData, type GroupData, type VideoGenerationMode, type VideoReferenceSummary } from "./canvasDataTypes";
import { type NodeType, type RatioKey } from "./canvasMediaTypes";
import { ratioToNodeDimensions } from "./canvasMediaGeometry";
import { savedCanvasGenerationPayload, canvasTaskNeedsPolling } from "./canvasGenerationRecovery";
import { supportsCanvasVideoDraft, canvasDraftRequest } from "./canvasVideoDraft";
import { requiredVideoRatio, videoOutputFormatRequestField } from "../../features/quick-create/videoOutputContract";
import { type CanvasPricingConfirmation } from "./CanvasPricingConfirmationDialog";
import { resolveCanvasArtifactInputs, type CanvasArtifactKind } from "./canvasTextArtifacts";
import { resolveCanvasStoryboardVideoInputs } from "./canvasStoryboardVideoPrompt";
import { submitAfterPortraitPreparation } from "../../features/quick-create/portraitPreparation";
import { generationPreparationMessage, generationPreparationPatch } from "../../features/quick-create/generationPreparation";
import { flushSync } from "react-dom";
import { normalizeNodeMaxImages } from "./canvasImageOutputCount";
import { getCanvasCatalogModeInputLimit, getCanvasCatalogVideoDefaultOutputFormat, getCanvasCatalogVideoOutputFormats, hasCanvasCatalogVideoOutputFormats, getCanvasCatalogVideoResolutions, isCanvasCatalogVideoModeSupported, normalizeCanvasCatalogVideoAudio, resolveCanvasCatalogVideoReferences, resolveSelectedCanvasAspectRatio, resolveSelectedCanvasVideoDuration, type CanvasCatalogImageQuality } from "./canvasCatalogContract";
import { buildCanvasGenerationPrompt } from "./canvasGenerationPrompt";
import { describeCanvasError } from "./canvasFriendlyError";
import { buildCanvasVideoExtensionFields, buildCanvasVideoEditFields, isCanvasSourceVideoMode } from "./canvasVideoExtension";
import { ApiError, api, buildCanvasImageIdempotencyKey, nextCanvasVideoGenerationAttemptId, shouldRetainCanvasVideoGenerationAttempt, type AiModelOption } from "@/lib/api";
import { toApiErrorView } from "@/api/http";
import { normalizeProjectId } from "@/stores/projectStore";
import { type CanvasGenerationDebugSnapshot } from "./canvasGenerationDebug";
import { getNodeTextContent, nodeHasMedia } from "./canvasAssetPresentation";
import { pickGeneratedImageChoices } from "./canvasTaskResults";

export interface CanvasGenerationSubmissionDependencies {
  activeNode: NodeData | null;
  nodesRef: React.RefObject<NodeData[]>;
  submitDraftFinalNode: (node: NodeData) => Promise<boolean>;
  generateCanvasTextNode: (node: NodeData, operation?: CanvasArtifactKind, newAttempt?: boolean) => Promise<boolean>;
  rejectGenerate: (nodeId: string | null | undefined, message: string) => void;
  resolvePendingVideoBillingBeforeSubmit: (node: NodeData, options?: { allowIdempotentRetryWithoutTaskId?: boolean; }) => Promise<boolean>;
  ensureApiKeyReady: () => boolean;
  activeProjectContextId: string | null;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  preflightCanvasModel: (modelType: CanvasModelType, requestedModelId?: string, options?: { allowCatalogDefault?: boolean; openPicker?: boolean; }) => AiModelOption | null;
  getNodeModelType: (type: NodeType) => "image" | "video" | "text" | "audio";
  resolveCanvasImageQuality: (model: AiModelOption, nodeResolution: string | undefined) => "" | CanvasCatalogImageQuality;
  edges: EdgeData[];
  createNode: (id: string, type: NodeType, centerX: number, centerY: number) => NodeData;
  summarizeVideoReferenceNodes: (nodes: NodeData[]) => VideoReferenceSummary;
  setGenerateDebug: (snapshot: CanvasGenerationDebugSnapshot | null) => void;
  nodeUploadPromiseRef: React.RefObject<Partial<Record<string, Promise<string>>>>;
  getDefaultVideoPromptTab: (summary: VideoReferenceSummary, modelId?: string, model?: AiModelOption) => ("文生视频" | "全能参考" | "图生视频" | "首尾帧" | "图片参考" | "延长视频" | "修改视频");
  getVideoTabForMode: (mode?: VideoGenerationMode) => ("文生视频" | "全能参考" | "图生视频" | "首尾帧" | "图片参考" | "延长视频" | "修改视频");
  getVideoModeForTab: (tab: ("文生视频" | "全能参考" | "图生视频" | "首尾帧" | "图片参考" | "延长视频" | "修改视频")) => VideoGenerationMode;
  isLk888LimitedVideoModel: (modelId: string | undefined) => boolean;
  isVideoPromptTabEnabled: (tab: ("文生视频" | "全能参考" | "图生视频" | "首尾帧" | "图片参考" | "延长视频" | "修改视频"), summary: VideoReferenceSummary, modelId?: string, model?: AiModelOption) => boolean;
  videoPromptTab: "文生视频" | "全能参考" | "图生视频" | "首尾帧" | "图片参考" | "延长视频" | "修改视频";
  buildReferenceResolutionSnapshot: (node: NodeData | null | undefined) => { nodeId: string; title: string; type: NodeType; referenceAssetUri: string; referenceAssetKind: string; imageUrl: string; videoUrl: string; localPreviewUrl: string; localVideoUrl: string; cachedRemoteUrl: string; localMappedRemoteUrl: string; hasPendingUpload: boolean; } | null;
  resolveNodeRemoteReferenceUrl: (node: NodeData) => Promise<string>;
  getImageNodeGeometry: (node: NodeData | null | undefined) => { width: number; height: number; ratio: RatioKey; nodeWidth: number; nodeHeight: number; } | null;
  inferImageReferenceGeometry: (referenceNodes: NodeData[]) => { width: number; height: number; ratio: RatioKey; nodeWidth: number; nodeHeight: number; } | null;
  getImageRequestRatio: (node: NodeData) => RatioKey;
  inferVideoRatioFromImageReferences: (referenceNodes: NodeData[]) => RatioKey | null;
  shouldInheritVideoRatioFromReference: (mode: VideoGenerationMode, node: NodeData, inferredRatio: RatioKey | null) => boolean;
  parseDurationSeconds: (raw?: string) => number;
  normalizeVideoResolutionForModel: (modelId: string | undefined, value: string | undefined, model?: AiModelOption) => string;
  VIDEO_REFERENCE_REQUIREMENT_TEXT: Record<"text_to_video" | "omni_reference" | "image_to_video" | "first_last_frame" | "image_reference" | "video_extension" | "video_edit", string>;
  videoNodeDurations: Record<string, number>;
  audioNodeDurations: Record<string, number>;
  beginNodeGenerationSession: (nodeId: string) => string;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  isNodeGenerationSessionCurrent: (nodeId: string, sessionId: string) => boolean;
  executeDraftWithApproval: (node: NodeData, request: Record<string, unknown>, attemptId: string) => Promise<any>;
  requestPricingConfirmation: (confirmation: CanvasPricingConfirmation) => Promise<boolean>;
  finishNodeGenerationSession: (nodeId: string, sessionId?: string) => void;
  showNodeStatusChip: (nodeId: string, text: string, tone?: "neutral" | "success" | "error", durationMs?: number) => void;
  beginNodeProgressSimulation: (nodeId: string, phase: "upload" | "generation") => void;
  pollTaskUntilDone: (taskId: string, node: NodeData, sessionId: string, startedAt?: number, options?: { kind?: "generation" | "video_enhance"; queryFailures?: number; }) => Promise<boolean>;
  applyTaskResultToNode: (node: NodeData, taskData: any, sessionId?: string) => Promise<boolean>;
}

export function createCanvasGenerationSubmission({
  activeNode,
  nodesRef,
  submitDraftFinalNode,
  generateCanvasTextNode,
  rejectGenerate,
  resolvePendingVideoBillingBeforeSubmit,
  ensureApiKeyReady,
  activeProjectContextId,
  setStatus,
  preflightCanvasModel,
  getNodeModelType,
  resolveCanvasImageQuality,
  edges,
  createNode,
  summarizeVideoReferenceNodes,
  setGenerateDebug,
  nodeUploadPromiseRef,
  getDefaultVideoPromptTab,
  getVideoTabForMode,
  getVideoModeForTab,
  isLk888LimitedVideoModel,
  isVideoPromptTabEnabled,
  videoPromptTab,
  buildReferenceResolutionSnapshot,
  resolveNodeRemoteReferenceUrl,
  getImageNodeGeometry,
  inferImageReferenceGeometry,
  getImageRequestRatio,
  inferVideoRatioFromImageReferences,
  shouldInheritVideoRatioFromReference,
  parseDurationSeconds,
  normalizeVideoResolutionForModel,
  VIDEO_REFERENCE_REQUIREMENT_TEXT,
  videoNodeDurations,
  audioNodeDurations,
  beginNodeGenerationSession,
  setNodePatch,
  persistCanvas,
  isNodeGenerationSessionCurrent,
  executeDraftWithApproval,
  requestPricingConfirmation,
  finishNodeGenerationSession,
  showNodeStatusChip,
  beginNodeProgressSimulation,
  pollTaskUntilDone,
  applyTaskResultToNode,
}: CanvasGenerationSubmissionDependencies) {
  async function generateWithActiveNode(targetOverride?: NodeData): Promise<boolean> {
    const requestedNode = targetOverride ?? activeNode;
    const targetActiveNode = requestedNode
      ? nodesRef.current.find((node) => node.id === requestedNode.id) || requestedNode
      : null;
    if (!targetActiveNode) return false;
    if (targetActiveNode.videoWorkflow === "redraw" || targetActiveNode.videoRedrawSourceNodeId) {
      try {
        const plan = validateRedrawSubmission(targetActiveNode.id, targetActiveNode.videoRedrawDraft, nodesRef.current, edges);
        if (targetActiveNode.videoMode !== "video_edit" || targetActiveNode.videoRedrawSourceNodeId !== plan.sourceId) throw new Error("原片连线或编辑模式发生变化，请重新配置转绘节点后生成。");
      } catch (error) { rejectGenerate(targetActiveNode.id, error instanceof Error ? error.message : "请先完成转绘配置"); return false; }
    }
    if (targetActiveNode.videoRenderMode === "finalize") return submitDraftFinalNode(targetActiveNode);
    if (targetActiveNode.type === "text") {
      return await generateCanvasTextNode(targetActiveNode);
    }
    if (targetActiveNode.type === "script") {
      rejectGenerate(targetActiveNode.id, "爆款视频拆解暂未开放，已阻止提交");
      return false;
    }
    if (targetActiveNode.type === "audio") {
      rejectGenerate(targetActiveNode.id, "Canvas 音频生成当前未接入，已阻止提交");
      return false;
    }
    if (targetActiveNode.type !== "image" && targetActiveNode.type !== "video") {
      rejectGenerate(targetActiveNode.id, "Canvas 当前仅支持图片和视频生成，已阻止提交");
      return false;
    }
    if (
      targetActiveNode.type === "video"
      && !(await resolvePendingVideoBillingBeforeSubmit(
        targetActiveNode,
        { allowIdempotentRetryWithoutTaskId: true },
      ))
    ) {
      return false;
    }
    if (!ensureApiKeyReady()) {
      rejectGenerate(targetActiveNode.id, "登录状态不可用，请重新登录后再提交");
      return false;
    }
    if (patchLooksActivelyGenerating(targetActiveNode)) {
      rejectGenerate(targetActiveNode.id, "当前节点正在生成中，请稍候");
      return false;
    }
    const generationProjectId = normalizeProjectId(activeProjectContextId);
    if (generationProjectId === null) {
      setStatus(`请先选择项目，再提交${targetActiveNode.type === "image" ? "图片" : "视频"}生成`);
      return false;
    }
    // A failed image attempt is final in the canvas. Clicking Generate always starts a new one.
    const recoveringUncertain = targetActiveNode.type === "video"
      && targetActiveNode.taskStatus === "pending_reconcile";
    const imageGenerationAttemptId = targetActiveNode.type === "image"
      ? nextCanvasVideoGenerationAttemptId()
      : undefined;
    const videoGenerationAttemptId = targetActiveNode.type === "video"
      ? nextCanvasVideoGenerationAttemptId(targetActiveNode.videoGenerationAttemptId, recoveringUncertain)
      : undefined;
    let videoInputProvenancePatch: Partial<NodeData> = targetActiveNode.type === "video"
      ? {
          sourceImageNodeId: undefined,
          inputAssetVersionId: undefined,
          firstFrameAssetVersionId: undefined,
        }
      : {};

    const savedPayload = recoveringUncertain ? savedCanvasGenerationPayload(
      targetActiveNode.videoRequestAttempt,
      videoGenerationAttemptId,
      generationProjectId,
    ) : null;
    if (recoveringUncertain && !savedPayload) {
      setStatus("原请求参数未完整保存，无法安全重放。请先在生成历史中核对旧请求结果");
      return false;
    }
    if (savedPayload) videoInputProvenancePatch = {};
    const payload: Record<string, any> = savedPayload || {};
    let inheritedImageReferencePatch: Partial<NodeData> = {};
    if (!savedPayload) {
      const targetCatalogModel = preflightCanvasModel(
        getNodeModelType(targetActiveNode.type),
        targetActiveNode.model,
        { openPicker: true },
      );
      if (!targetCatalogModel) {
        rejectGenerate(targetActiveNode.id, "请先选择可用的生成模型后再提交");
        return false;
      }
      const imageQuality = targetActiveNode.type === "image"
        ? resolveCanvasImageQuality(targetCatalogModel, targetActiveNode.resolution)
        : "";
      if (targetActiveNode.type === "image" && !imageQuality) {
        rejectGenerate(targetActiveNode.id, `${targetCatalogModel.name} 未声明可用图片清晰度，已阻止提交`);
        return false;
      }
      if (patchLooksActivelyGenerating(targetActiveNode)) {
        rejectGenerate(targetActiveNode.id, "当前节点正在生成中，请稍候");
        return false;
      }
      const runtimeNodeMap = new Map(nodesRef.current.map((node) => [node.id, node]));
      const targetUpstreamNodes = edges
        .filter((edge) => edge.toNodeId === targetActiveNode.id && edge.relationship !== "draft_final")
        .map((edge) => runtimeNodeMap.get(edge.fromNodeId))
        .filter((node): node is NodeData => Boolean(node));
      const artifactInputs = resolveCanvasArtifactInputs({
        sources: targetUpstreamNodes.filter((node) => node.type === "text").map((node) => ({ id: node.id, text: getNodeTextContent(node), textArtifacts: node.textArtifacts })),
        bindings: targetActiveNode.textArtifactBindings,
        modes: targetActiveNode.textArtifactSourceModes,
        requireShotReferences: targetActiveNode.type === "image",
      });
      const storyboardInputs = resolveCanvasStoryboardVideoInputs({
        images: targetActiveNode.type === "video" ? targetUpstreamNodes : [],
        nodes: nodesRef.current,
        edges,
      });
      if (artifactInputs.errors.length || storyboardInputs.errors.length) {
        rejectGenerate(targetActiveNode.id, [...artifactInputs.errors, ...storyboardInputs.errors].join("；"));
        return false;
      }
      const unavailableMedia = targetUpstreamNodes.filter((node) =>
        ["image", "video", "audio"].includes(node.type)
        && (patchLooksActivelyGenerating(node) || !nodeHasMedia(node)),
      );
      if (unavailableMedia.length) {
        rejectGenerate(targetActiveNode.id, `上游素材尚未准备好：${unavailableMedia.map((node) => node.title || node.id).join("、")}。请先完成生成再提交`);
        return false;
      }
      for (const reference of artifactInputs.references) {
        if (reference.nodeId === targetActiveNode.id || targetUpstreamNodes.some((node) => Number(node.assetVersionId) === reference.assetVersionId)) continue;
        const referenceNode = {
          ...createNode(`artifact_reference_${reference.assetVersionId}`, "image", 0, 0),
          title: "卡片参考图", imageUrl: reference.imageUrl, primaryImageUrl: reference.imageUrl,
          assetVersionId: reference.assetVersionId, referenceAssetUri: reference.referenceAssetUri,
        };
        targetUpstreamNodes.push(referenceNode);
      }
      const targetVideoReferenceSummary = summarizeVideoReferenceNodes(targetUpstreamNodes);
      const upstreamTextPrompts = artifactInputs.prompts;
      const resolveEffectivePrompt = (artifactImagePrompt = artifactInputs.imagePrompt) => buildCanvasGenerationPrompt({
        mediaType: targetActiveNode.type === "video" ? "video" : "image",
        prompt: artifactInputs.usesCards ? [targetActiveNode.type === "image" ? artifactImagePrompt : upstreamTextPrompts.join("\n\n"), targetActiveNode.prompt.trim() ? `本次画面要求：${targetActiveNode.prompt.trim()}` : ""].filter(Boolean).join("\n\n") : targetActiveNode.prompt,
        upstreamTextPrompts,
        storyboardPrompts: storyboardInputs.prompts,
        cameraControl: targetActiveNode.cameraControl,
        // A connected text node replaces stale prompt content left on an image node.
        preferUpstreamText: !artifactInputs.usesCards && targetActiveNode.type === "image",
      });
      const effectivePrompt = resolveEffectivePrompt();
      if (!effectivePrompt) {
        setGenerateDebug({
          phase: "blocked-empty-prompt",
          payload: {
            prompt: targetActiveNode.prompt,
            effectivePrompt,
            upstreamTextPrompts,
            nodeId: targetActiveNode.id,
            model: targetActiveNode.model,
          },
        });
        setStatus("请先输入提示词");
        return false;
      }

      const upstreamReferenceNodes = targetUpstreamNodes
        .filter(
          (node): node is NodeData =>
            Boolean(node.referenceAssetUri || node.imageUrl || node.videoUrl || node.audioUrl || nodeUploadPromiseRef.current[node.id]),
        );
      const upstreamImageUrls: string[] = [];
      const upstreamVideoUrls: string[] = [];
      const upstreamAudioUrls: string[] = [];
      const resolvedVideoPromptTab = getDefaultVideoPromptTab(
        targetVideoReferenceSummary,
        targetActiveNode.model,
        targetCatalogModel,
      );
      const persistedVideoPromptTab = getVideoTabForMode(targetActiveNode.videoMode);
      const activeVideoMode = getVideoModeForTab(
        isCanvasSourceVideoMode(targetActiveNode.videoMode) ? getVideoTabForMode(targetActiveNode.videoMode) : isLk888LimitedVideoModel(targetActiveNode.model) && targetVideoReferenceSummary.hasImages
          ? "图生视频"
          : isVideoPromptTabEnabled(
              persistedVideoPromptTab,
              targetVideoReferenceSummary,
              targetActiveNode.model,
              targetCatalogModel,
            )
            ? persistedVideoPromptTab
            : isVideoPromptTabEnabled(
                videoPromptTab,
                targetVideoReferenceSummary,
                targetActiveNode.model,
                targetCatalogModel,
              )
              ? videoPromptTab
            : resolvedVideoPromptTab,
      );
      if (
        targetActiveNode.type === "video"
        && !isCanvasCatalogVideoModeSupported(targetCatalogModel, activeVideoMode)
      ) {
        setStatus("所选视频模型目录未声明当前生成模式，已阻止提交");
        return false;
      }

      const pushResolvedReference = (node: NodeData, url: string) => {
        if (!url) return;
        if (node.type === "video") {
          upstreamVideoUrls.push(url);
          return;
        }
        if (node.type === "audio") {
          upstreamAudioUrls.push(url);
          return;
        }
        upstreamImageUrls.push(url);
      };

      setGenerateDebug({
        phase: "reference-resolution-snapshot",
        payload: {
          targetActiveNode: buildReferenceResolutionSnapshot(targetActiveNode),
          upstreamNodes: upstreamReferenceNodes.map((node) => buildReferenceResolutionSnapshot(node)),
        },
      });

      try {
        // Do not recycle the node's own previous output as a reference on a
        // fresh draw. Only an explicit rewrite may treat it as the source clip.
        if (
          targetActiveNode.videoRewritePending
          && (targetActiveNode.type === "image" || targetActiveNode.type === "video")
          && (targetActiveNode.referenceAssetUri || targetActiveNode.imageUrl || targetActiveNode.videoUrl || targetActiveNode.audioUrl || nodeUploadPromiseRef.current[targetActiveNode.id])
        ) {
          const activeReferenceUrl = await resolveNodeRemoteReferenceUrl(targetActiveNode);
          if (activeReferenceUrl) {
            if (targetActiveNode.type === "video") {
              upstreamVideoUrls.unshift(activeReferenceUrl);
            } else {
              upstreamImageUrls.unshift(activeReferenceUrl);
            }
          }
        }

        for (const referenceNode of upstreamReferenceNodes) {
          const referenceUrl = await resolveNodeRemoteReferenceUrl(referenceNode);
          if (referenceUrl) {
            pushResolvedReference(referenceNode, referenceUrl);
          }
        }
      } catch (error) {
        setGenerateDebug({
          phase: "upload-local-reference-error",
          payload: {
            model: targetActiveNode.model,
            prompt: effectivePrompt,
            nodeId: targetActiveNode.id,
          },
          error: error instanceof Error ? error.message : String(error),
        });
        setStatus(error instanceof Error ? error.message : "参考图上传失败");
        return false;
      }
      const dedupedUpstreamImageUrls = Array.from(new Set(upstreamImageUrls.filter(Boolean)));
      // Fresh draw must not feed the node's own previous output back as a
      // reference — that re-teaches the wrong motion. Only an explicit rewrite
      // may use the current result as source.
      const includeSelfAsReference = Boolean(targetActiveNode.videoRewritePending);
      const videoReferenceCandidates = [
        ...(includeSelfAsReference && nodeHasMedia(targetActiveNode) ? [targetActiveNode] : []),
        ...upstreamReferenceNodes,
      ].filter((node, index, all) =>
        ["image", "video", "audio"].includes(node.type)
        && all.findIndex((candidate) => candidate.id === node.id) === index,
      );
      const controlledVideoReferenceNodes = videoReferenceCandidates.filter((node) =>
        Number.isSafeInteger(Number(node.assetVersionId)) && Number(node.assetVersionId) > 0,
      );
      const uncontrolledVideoReferenceNodes = videoReferenceCandidates.filter((node) =>
        !Number.isSafeInteger(Number(node.assetVersionId)) || Number(node.assetVersionId) <= 0,
      );
      const buildControlledVideoReference = (
        node: NodeData,
        role: "subject" | "style" | "storyboard" | "first_frame" | "last_frame",
      ) => ({
        assetVersionId: String(Number(node.assetVersionId)),
        role,
      });
      const selfImageReferenceGeometry = targetActiveNode.type === "image" && nodeHasMedia(targetActiveNode)
        ? getImageNodeGeometry(targetActiveNode)
        : null;
      const inheritedImageReferenceGeometry = targetActiveNode.type === "image"
        ? (selfImageReferenceGeometry || inferImageReferenceGeometry(upstreamReferenceNodes))
        : null;
      const imageRequestNode = inheritedImageReferenceGeometry
        ? {
            ...targetActiveNode,
            ratio: targetActiveNode.ratio === "auto" ? inheritedImageReferenceGeometry.ratio : targetActiveNode.ratio,
            width: inheritedImageReferenceGeometry.nodeWidth,
            height: inheritedImageReferenceGeometry.nodeHeight,
            mediaNaturalWidth: inheritedImageReferenceGeometry.width,
            mediaNaturalHeight: inheritedImageReferenceGeometry.height,
          }
        : targetActiveNode;
      Object.assign(payload, {
        mediaType: targetActiveNode.type, model: targetCatalogModel.id,
        prompt: effectivePrompt, projectId: generationProjectId,
      });
      if (targetActiveNode.type === "image") {
        payload.generationAttemptId = imageGenerationAttemptId;
        payload.nodeId = targetActiveNode.id;
        payload.idempotencyKey = buildCanvasImageIdempotencyKey({
          nodeId: targetActiveNode.id,
          attemptId: imageGenerationAttemptId,
        });
        // Output count is admitted only from the selected model's published
        // maxOutputs/count contract. Missing metadata fails closed to one.
        payload.count = normalizeNodeMaxImages(targetActiveNode.maxImages, targetCatalogModel);
        payload.quality = imageQuality;
        payload.ratio = resolveSelectedCanvasAspectRatio(
          targetCatalogModel,
          getImageRequestRatio(imageRequestNode),
        );
        if (!payload.ratio) {
          setStatus(`${targetCatalogModel.name} 不支持当前图片比例，请重新选择`);
          return false;
        }
        const upstreamImageNodes = upstreamReferenceNodes.filter((node) =>
          node.type === "image" && nodeHasMedia(node),
        );
        const uncontrolledReferences = upstreamImageNodes.filter((node) =>
          !Number.isSafeInteger(Number(node.assetVersionId)) || Number(node.assetVersionId) <= 0,
        );
        if (dedupedUpstreamImageUrls.length > 0 && uncontrolledReferences.length > 0) {
          setStatus("参考图尚未写入当前项目资产版本，请重新上传后再生成");
          return false;
        }
        const references = upstreamImageNodes
          .map((node) => Number(node.assetVersionId))
          .filter((assetVersionId) => Number.isSafeInteger(assetVersionId) && assetVersionId > 0)
          .filter((assetVersionId, index, all) => all.indexOf(assetVersionId) === index)
          .map((assetVersionId) => ({ assetVersionId: String(assetVersionId), role: "subject" }));
        if (references.length > 0) payload.references = references;
        if (artifactInputs.usesCards) {
          payload.prompt = resolveEffectivePrompt(artifactInputs.imagePromptForReferences(references.map((reference) => Number(reference.assetVersionId))));
        }
      } else if (targetActiveNode.type === "video") {
        let catalogVideoReferenceNodes: NodeData[] = [];
        payload.generationAttemptId = videoGenerationAttemptId;
        const inferredReferenceRatio = inferVideoRatioFromImageReferences(upstreamReferenceNodes);
        const inheritReferenceRatio = shouldInheritVideoRatioFromReference(activeVideoMode, targetActiveNode, inferredReferenceRatio);
        const inferredCatalogRatio = inheritReferenceRatio && inferredReferenceRatio
          ? resolveSelectedCanvasAspectRatio(targetCatalogModel, inferredReferenceRatio)
          : "";
        const requestRatio = requiredVideoRatio(targetCatalogModel.id, activeVideoMode) ||
          (isCanvasSourceVideoMode(activeVideoMode) ? "adaptive" : inferredCatalogRatio
          || resolveSelectedCanvasAspectRatio(targetCatalogModel, targetActiveNode.ratio === "auto" ? "adaptive" : targetActiveNode.ratio));
        if (!requestRatio) {
          setStatus(`${targetCatalogModel.name} 不支持当前视频比例，请重新选择`);
          return false;
        }
        payload.mode = activeVideoMode;
        payload.ratio = requestRatio;
        const outputFormats = getCanvasCatalogVideoOutputFormats(targetCatalogModel);
        const outputFormat = targetActiveNode.videoOutputFormat || getCanvasCatalogVideoDefaultOutputFormat(targetCatalogModel);
        if (!outputFormats.includes(outputFormat)) { setStatus("所选输出格式不在当前模型目录中"); return false; }
        Object.assign(payload, videoOutputFormatRequestField(hasCanvasCatalogVideoOutputFormats(targetCatalogModel), outputFormat));
        const requestedDuration = parseDurationSeconds(targetActiveNode.duration);
        const admittedDuration = resolveSelectedCanvasVideoDuration(
          targetCatalogModel,
          activeVideoMode,
          requestedDuration,
        );
        if (admittedDuration === null) {
          setStatus("所选时长不在当前模型目录的可提交范围内");
          return false;
        }
        payload.duration = admittedDuration;
        if (targetActiveNode.videoRenderMode === "draft" && !supportsCanvasVideoDraft(targetCatalogModel)) {
          setStatus("当前模型未开放样片，请选择支持样片的 Seedance 2.5 模型"); return false;
        }
        payload.resolution = targetActiveNode.videoRenderMode === "draft" ? "480P" : normalizeVideoResolutionForModel(targetCatalogModel.id, targetActiveNode.resolution, targetCatalogModel);
        if (targetActiveNode.videoRenderMode !== "draft" && !getCanvasCatalogVideoResolutions(targetCatalogModel).includes(payload.resolution)) {
          setStatus("所选视频清晰度不在当前模型的可提交范围内");
          return false;
        }
        payload.generateAudio = normalizeCanvasCatalogVideoAudio(targetCatalogModel, targetActiveNode.videoGenerateAudio);
        if (activeVideoMode === "omni_reference" || isCanvasSourceVideoMode(activeVideoMode)) {
          if (videoReferenceCandidates.length < 1) {
            setStatus(VIDEO_REFERENCE_REQUIREMENT_TEXT[activeVideoMode]);
            return false;
          }
          if (uncontrolledVideoReferenceNodes.length > 0) {
            setStatus("参考素材尚未写入当前项目资产版本，请重新上传后再生成");
            return false;
          }
          payload.references = controlledVideoReferenceNodes.map((node) =>
            buildControlledVideoReference(node, "subject"),
          );
          catalogVideoReferenceNodes = controlledVideoReferenceNodes;
        } else if (activeVideoMode === "image_to_video") {
          const imageReferences = videoReferenceCandidates.filter((node) => node.type === "image");
          if (imageReferences.length < 1) {
            setStatus(VIDEO_REFERENCE_REQUIREMENT_TEXT[activeVideoMode]);
            return false;
          }
          if (imageReferences.some((node) =>
            !Number.isSafeInteger(Number(node.assetVersionId)) || Number(node.assetVersionId) <= 0
          )) {
            setStatus("参考图尚未写入当前项目资产版本，请重新上传后再生成");
            return false;
          }
          // image_to_video has exactly one semantic first-frame slot for every
          // public model. Multi-image Grok input belongs to omni_reference and
          // must never leak through this mode as extra subject references.
          const selectedImage = imageReferences[0];
          payload.references = [
            buildControlledVideoReference(selectedImage, "first_frame"),
          ];
          catalogVideoReferenceNodes = [selectedImage];
          videoInputProvenancePatch = {
            sourceImageNodeId: selectedImage.id,
            inputAssetVersionId: Number(selectedImage.assetVersionId),
            firstFrameAssetVersionId: Number(selectedImage.assetVersionId),
          };
        } else if (activeVideoMode === "first_last_frame") {
          const imageReferences = videoReferenceCandidates.filter((node) => node.type === "image");
          if (imageReferences.length !== 2 || videoReferenceCandidates.length !== 2) {
            setStatus(VIDEO_REFERENCE_REQUIREMENT_TEXT[activeVideoMode]);
            return false;
          }
          if (imageReferences.some((node) =>
            !Number.isSafeInteger(Number(node.assetVersionId)) || Number(node.assetVersionId) <= 0
          )) {
            setStatus("首尾帧尚未写入当前项目资产版本，请重新上传后再生成");
            return false;
          }
          payload.references = [
            buildControlledVideoReference(imageReferences[0], "first_frame"),
            buildControlledVideoReference(imageReferences[1], "last_frame"),
          ];
          catalogVideoReferenceNodes = imageReferences;
        } else if (activeVideoMode === "image_reference") {
          const imageReferences = videoReferenceCandidates.filter((node) => node.type === "image");
          const inputLimit = getCanvasCatalogModeInputLimit(
            targetCatalogModel,
            "image_reference",
            "image",
          );
          if (
            !inputLimit
            || videoReferenceCandidates.length !== imageReferences.length
            || imageReferences.length < inputLimit.min
            || imageReferences.length > inputLimit.max
          ) {
            setStatus(VIDEO_REFERENCE_REQUIREMENT_TEXT[activeVideoMode]);
            return false;
          }
          if (imageReferences.some((node) =>
            !Number.isSafeInteger(Number(node.assetVersionId)) || Number(node.assetVersionId) <= 0
          )) {
            setStatus("参考图尚未写入当前项目资产版本，请重新上传后再生成");
            return false;
          }
          payload.references = imageReferences.map((node) =>
            buildControlledVideoReference(node, "subject"),
          );
          catalogVideoReferenceNodes = imageReferences;
        }
        if (catalogVideoReferenceNodes.some((node) => (
          !Number.isSafeInteger(Number(node.assetVersionId)) || Number(node.assetVersionId) <= 0
        ))) {
          setStatus("参考素材尚未写入当前项目资产版本，请重新上传后再生成");
          return false;
        }
        const catalogReferences = resolveCanvasCatalogVideoReferences(
          targetCatalogModel,
          activeVideoMode,
          catalogVideoReferenceNodes.map((node) => ({
            assetVersionId: String(Number(node.assetVersionId)),
            kind: node.type === "audio" ? "file" : node.type as "image" | "video",
            name: node.title,
            durationSeconds: node.type === "video" ? (videoNodeDurations[node.id] || Number(node.mediaDurationMs || 0) / 1000 || undefined) : node.type === "audio" ? audioNodeDurations[node.id] : undefined,
          })),
        );
        if (!catalogReferences.ok) {
          setStatus(catalogReferences.message);
          return false;
        }
        payload.operation = catalogReferences.operation;
        payload.references = catalogReferences.references;
        if (activeVideoMode === "video_extension") {
          Object.assign(payload, buildCanvasVideoExtensionFields(catalogReferences.references));
        } else if (activeVideoMode === "video_edit") {
          Object.assign(payload, buildCanvasVideoEditFields(catalogReferences.references, String(payload.prompt)));
        }
      }

      inheritedImageReferencePatch = inheritedImageReferenceGeometry && targetActiveNode.ratio === "auto"
        ? {
            ratio: inheritedImageReferenceGeometry.ratio,
            mediaNaturalWidth: inheritedImageReferenceGeometry.width,
            mediaNaturalHeight: inheritedImageReferenceGeometry.height,
            width: inheritedImageReferenceGeometry.nodeWidth,
            height: inheritedImageReferenceGeometry.nodeHeight,
            x: targetActiveNode.x + targetActiveNode.width / 2 - inheritedImageReferenceGeometry.nodeWidth / 2,
            y: targetActiveNode.y + targetActiveNode.height / 2 - inheritedImageReferenceGeometry.nodeHeight / 2,
          }
        : {};
    }
    const targetNode = targetActiveNode;
    const sessionId = beginNodeGenerationSession(targetNode.id);
    flushSync(() => {
      setNodePatch(targetNode.id, {
        isGenerating: true,
        generationState: "submitting",
        taskStatus: "processing",
        taskId: undefined,
        taskKind: "generation",
        imageGenerationAttemptId,
        ...(targetNode.type === "image" ? {
          imageRequestAttempt: { id: imageGenerationAttemptId!, payload: structuredClone(payload) },
          imagePendingMessage: undefined,
          imagePendingCode: undefined,
        } : {}),
        videoGenerationAttemptId,
        ...(targetNode.type === "video" ? {
          videoRequestAttempt: { id: videoGenerationAttemptId!, payload: structuredClone(payload) },
        } : {}),
        generationProgress: 1,
        uploadState: "idle",
        uploadProgress: undefined,
        ...videoInputProvenancePatch,
        ...inheritedImageReferencePatch,
        ...(targetNode.type === "video" && typeof payload.ratio === "string" && payload.ratio !== "adaptive"
          ? { ratio: payload.ratio as RatioKey, ...ratioToNodeDimensions(payload.ratio as RatioKey, "video") }
          : {}),
      });
      setStatus("任务提交中...");
    });
    setGenerateDebug({ phase: "submitting", payload });
    try {
      // Save the recovery handle before any external generation can begin.
      const savedCanvasId = await persistCanvas();
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return false;
      if (!savedCanvasId) throw new Error("画布未保存，已阻止提交生成。请处理保存冲突后重试原请求");
      const result = targetNode.videoRenderMode === "draft"
        ? await executeDraftWithApproval(targetNode, canvasDraftRequest(payload), videoGenerationAttemptId!)
        : targetNode.type === "video"
          ? await submitAfterPortraitPreparation({
              submit: () => api.generateNode(payload),
              isCurrent: () => isNodeGenerationSessionCurrent(targetNode.id, sessionId),
              onProgress: setStatus,
            })
          : await (async () => {
            try {
              return await api.generateNode(payload);
            } catch (error) {
              const detail = error as {
                status?: number;
                code?: string;
                message?: string;
                details?: Record<string, unknown>;
              } | null;
              const pricingDetails = detail?.details && typeof detail.details === "object"
                ? detail.details
                : {};
              const hasPricingToken = Boolean(
                String(pricingDetails.pricingConfirmationToken || "").trim(),
              );
              const isPricingConfirmation = detail?.status === 409
                && (
                  detail.code === "pricing_confirmation_required"
                  || hasPricingToken
                  || (!detail.code && /pricing[_ -]?confirmation|确认.*费用|费用.*确认/i.test(String(detail.message || "")))
                );
              if (
                targetNode.type !== "image"
                || !isPricingConfirmation
              ) {
                throw error;
              }
              const maximumCost = Number(pricingDetails.maximumCostGu);
              const approved = await requestPricingConfirmation({
                maximumGu: Number.isFinite(maximumCost) ? maximumCost : null,
                mayDuplicatePendingRequest: false,
              });
              if (!approved) return null;
              const token = String(pricingDetails.pricingConfirmationToken || "").trim();
              if (!token) throw error;
              payload.pricingConfirmation = { token };
              setNodePatch(targetNode.id, {
                imageRequestAttempt: { id: imageGenerationAttemptId!, payload: structuredClone(payload) },
              });
              const savedCanvasId = await persistCanvas();
              if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return null;
              if (!savedCanvasId) throw new Error("画布未保存，已阻止提交生成。请处理保存冲突后重试原请求");
              return api.generateNode(payload);
            }
          })();
      if (!result) {
        setNodePatch(targetNode.id, { isGenerating: false, generationState: "idle", taskStatus: "idle", generationProgress: 0,
          imageGenerationAttemptId: undefined, imageRequestAttempt: undefined, imagePendingMessage: undefined, imagePendingCode: undefined,
        });
        finishNodeGenerationSession(targetNode.id, sessionId); setStatus("已取消，未提交生成"); return false;
      }
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return false;
      const taskId = (result as any)?.taskId || (result as any)?.id || "";
      const status = String((result as any)?.status || "").toLowerCase();
      setGenerateDebug({ phase: "generate-response", payload, response: result });
      const inlineImageUrl = String(
        (result as any)?.imageUrl
        || (result as any)?.primaryImageUrl
        || (result as any)?.result?.imageUrl
        || (result as any)?.output?.imageUrl
        || pickGeneratedImageChoices(result)[0]?.url
        || "",
      ).trim();
      if (targetNode.type === "image" && !taskId && !inlineImageUrl) {
        throw new Error("图片任务响应缺少任务编号，结果暂时无法确认");
      }
      if (targetNode.type === "video" && !taskId) {
        throw new Error("视频任务创建响应缺少任务编号");
      }
      flushSync(() => {
        setNodePatch(targetNode.id, {
          isGenerating: true,
          generationState: "processing",
          taskStatus: "processing",
          generationProgress: 3,
          ...generationPreparationPatch(result),
          ...(taskId ? { taskId, taskKind: "generation" as const } : {}),
        });
        const shortId = taskId ? String(taskId).slice(0, 8) : "";
        setStatus(generationPreparationMessage(result) || (shortId
          ? `已提交 · 任务 ${shortId} 生成中，完成后自动出现在节点与「生成历史」`
          : "已提交 · 生成中，完成后自动出现在节点与「生成历史」"));
        showNodeStatusChip(targetNode.id, generationPreparationMessage(result) || "已提交 · 生成中 3%", "neutral", 2600);
      });

      if (canvasTaskNeedsPolling(status, String(taskId))) {
        setNodePatch(targetNode.id, {
          taskId,
          taskKind: "generation",
          taskStatus: "processing",
          generationState: "processing",
          generationProgress: 3,
          ...generationPreparationPatch(result),
        });
        void persistCanvas();
        beginNodeProgressSimulation(targetNode.id, "generation");
        return await pollTaskUntilDone(taskId, targetNode, sessionId);
      }

      await new Promise((resolve) => window.setTimeout(resolve, 260));
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return false;
      const ok = await applyTaskResultToNode(targetNode, result, sessionId);
      if (!ok && !isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return false;
      setStatus(ok ? "生成完成" : "生成失败");
      return ok;
    } catch (error) {
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return false;
      const errorView = toApiErrorView(error);
      const errorMessage = String(
        errorView.message || (error instanceof Error ? error.message : ""),
      );
      const definiteConflict = [
        "idempotency_conflict",
        "idempotency_scope_conflict",
        "video_submit_conflict",
        "pricing_confirmation_required",
      ]
        .includes(String(errorView.code || ""))
        || (
          !errorView.code
          && errorView.status === 409
          && /pricing[_ -]?confirmation|确认.*费用|费用.*确认/i.test(errorMessage)
        );
      const videoTransportUncertain = !definiteConflict
        && targetNode.type === "video"
        && Boolean(videoGenerationAttemptId)
        && shouldRetainCanvasVideoGenerationAttempt(errorView.status);
      const transportUncertain = videoTransportUncertain;
      setNodePatch(targetNode.id, transportUncertain
        ? {
            isGenerating: false,
            generationState: "idle",
            taskId: undefined,
            taskKind: "generation",
            taskStatus: "pending_reconcile",
            videoGenerationAttemptId,
            ...(videoTransportUncertain ? {
              videoRequestAttempt: { id: videoGenerationAttemptId!, payload: structuredClone(payload) },
            } : {}),
            videoRewritePending: targetNode.videoRewritePending,
          }
        : {
            isGenerating: false,
            generationState: "idle",
            taskId: undefined,
            taskKind: undefined,
            taskStatus: "failed",
            imageGenerationAttemptId: undefined,
            imageRequestAttempt: undefined,
            imagePendingMessage: undefined,
            imagePendingCode: undefined,
            videoGenerationAttemptId: undefined,
            videoRewritePending: false,
          });
      finishNodeGenerationSession(targetNode.id, sessionId);
      const apiError = error instanceof ApiError ? error : null;
      const friendly = describeCanvasError(
        errorView.message || (error instanceof Error ? error.message : error),
        "submit",
      );
      const rejectReason = transportUncertain
        ? "视频提交结果尚未确认；再次点击将继续核对原任务"
        : targetNode.type === "image"
          ? "图片生成失败，本次未完成；请直接点击节点下方的生成按钮重试"
          : friendly.message;
      setGenerateDebug({
        phase: "generate-error",
        payload,
        error: error instanceof Error ? error.message : "生成失败",
        response: apiError
          ? {
              status: apiError.status,
              url: apiError.url,
              details: apiError.details,
              responseText: apiError.responseText,
            }
          : undefined,
      });
      showNodeStatusChip(
        targetNode.id,
        transportUncertain ? "提交结果待确认" : targetNode.type === "image" ? "图片生成失败" : friendly.title,
        transportUncertain ? "neutral" : "error",
        transportUncertain ? 4200 : 5200,
      );
      setStatus(rejectReason);
      return false;
    }
  }
  return generateWithActiveNode;
}
