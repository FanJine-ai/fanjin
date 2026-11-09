import type { NodeData, EdgeData } from "./canvasDataTypes";
import { canvasTaskVideoMeta, readCanvasRemoteMediaMeta as readRemoteMediaMeta } from "./canvasMediaMeta";
import { getCanvasTaskAssetLink } from "./canvasTaskResult";
import { getExplicitTaskResultMediaAssetId, pickTextResult, pickVideoResult, pickImageResult, pickGeneratedImageChoices } from "./canvasTaskResults";
import { taskRequiresBillingReconciliation, taskResultKind, patchLooksActivelyGenerating } from "./canvasTaskState";
import { nextCanvasImageResultVersion } from "./canvasAssetPresentation";
import { allArtifactCards, type CanvasArtifactKind, type CanvasArtifactCard } from "./canvasTextArtifacts";

export interface CanvasGenerationResultsDependencies {
  isNodeGenerationSessionCurrent: (nodeId: string, sessionId: string) => boolean;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  stopNodeProgressTimer: (nodeId: string) => void;
  finishNodeGenerationSession: (nodeId: string, sessionId?: string) => void;
  canvasBalance: { refresh: () => unknown };
  showNodeStatusChip: (nodeId: string, text: string, tone?: "neutral" | "success" | "error", durationMs?: number) => void;
  setStatus: (message: string) => void;
  loadHistoryItems: () => unknown;
  applyNodeMediaGeometry: (nodeId: string, width: number, height: number, patch?: Partial<NodeData>) => void;
  createAndUploadVideoPoster: (nodeId: string, videoUrl: string, fileName: string) => Promise<boolean>;
  persistCanvas: (nodes?: NodeData[], edges?: EdgeData[]) => Promise<string | null>;
  nodesRef: { current: NodeData[] };
  localResultPendingPersistenceRef: { current: Record<string, string> };
  editCanvasArtifact: (nodeId: string, kind: CanvasArtifactKind, cardId: string, patch: Partial<CanvasArtifactCard>) => void;
  edges: EdgeData[];
}

export function createCanvasGenerationResults({
  isNodeGenerationSessionCurrent,
  setNodePatch,
  stopNodeProgressTimer,
  finishNodeGenerationSession,
  canvasBalance,
  showNodeStatusChip,
  setStatus,
  loadHistoryItems,
  applyNodeMediaGeometry,
  createAndUploadVideoPoster,
  persistCanvas,
  nodesRef,
  localResultPendingPersistenceRef,
  editCanvasArtifact,
  edges,
}: CanvasGenerationResultsDependencies) {
  async function applyTaskResultToNode(node: NodeData, taskData: any, sessionId?: string): Promise<boolean> {
    if (sessionId && !isNodeGenerationSessionCurrent(node.id, sessionId)) return false;
    if (node.type === "text") {
      const outputText = pickTextResult(taskData);
      setNodePatch(node.id, {
        outputText,
        isGenerating: false,
        generationState: "idle",
        taskId: undefined,
        taskKind: undefined,
        taskStatus: "success",
        videoEnhanceAttemptId: undefined,
        generationProgress: 0,
      });
      stopNodeProgressTimer(node.id);
      finishNodeGenerationSession(node.id, sessionId);
      canvasBalance.refresh();
      return true;
    }

    if (node.type === "audio") {
      const resultAssets = Array.isArray(taskData?.result?.assets) ? taskData.result.assets : [];
      const rootAssets = Array.isArray(taskData?.assets) ? taskData.assets : [];
      const resultGeneratedAudios = Array.isArray(taskData?.result?.generatedAudios) ? taskData.result.generatedAudios : [];
      const rootGeneratedAudios = Array.isArray(taskData?.generatedAudios) ? taskData.generatedAudios : [];
      const resultAudioAsset = resultAssets.find((item: any) => item?.type === "audio");
      const rootAudioAsset = rootAssets.find((item: any) => item?.type === "audio");
      const audioUrl =
        node.audioSeparateMode && taskData?.result?.kind === "audio-separate"
          ? node.audioSeparateRole === "bgm"
            ? String(taskData?.result?.bgmUrl || "")
            : String(taskData?.result?.voiceUrl || "")
          : String(
              taskData?.result?.audioUrl ||
                taskData?.audioUrl ||
                resultAudioAsset?.url ||
                rootAudioAsset?.url ||
                resultAudioAsset?.sourceUrl ||
                rootAudioAsset?.sourceUrl ||
                resultGeneratedAudios[0]?.url ||
                rootGeneratedAudios[0]?.url ||
                taskData?.raw?.data?.audio ||
                taskData?.result?.raw?.data?.audio ||
                taskData?.data?.audio ||
                ""
            );
      if (!audioUrl) {
        if (sessionId && !isNodeGenerationSessionCurrent(node.id, sessionId)) return false;
        setNodePatch(node.id, {
          isGenerating: false,
          generationState: "idle",
          taskId: undefined,
          taskKind: undefined,
          taskStatus: "failed",
          imageGenerationAttemptId: undefined,
          videoEnhanceAttemptId: undefined,
          generationProgress: 0,
        });
        stopNodeProgressTimer(node.id);
        finishNodeGenerationSession(node.id, sessionId);
        showNodeStatusChip(node.id, "生成失败", "error", 2600);
        setStatus("生成成功但未解析到音频地址");
        return false;
      }
      setNodePatch(node.id, {
        audioUrl,
        localAudioUrl: undefined,
        isGenerating: false,
        generationState: "idle",
        taskId: undefined,
        taskKind: undefined,
        taskStatus: "success",
        videoEnhanceAttemptId: undefined,
        generationProgress: 0,
      });
      stopNodeProgressTimer(node.id);
      finishNodeGenerationSession(node.id, sessionId);
      void loadHistoryItems();
      canvasBalance.refresh();
      return true;
    }

    if (node.type === "video") {
      const videoUrl =
        node.audioSeparateMode && taskData?.result?.kind === "audio-separate"
          ? String(taskData?.result?.muteVideoUrl || "")
          : pickVideoResult(taskData);
      if (!videoUrl) {
        if (sessionId && !isNodeGenerationSessionCurrent(node.id, sessionId)) return false;
        const billingReconciliationRequired = taskRequiresBillingReconciliation(taskData);
        const billingTaskId = String(taskData?.id || taskData?.taskId || node.taskId || "").trim();
        const billingTaskKind = taskResultKind(taskData, node.taskKind);
        setNodePatch(node.id, {
          isGenerating: false,
          generationState: "idle",
          taskId: billingReconciliationRequired && billingTaskId ? billingTaskId : undefined,
          taskKind: billingReconciliationRequired ? billingTaskKind : undefined,
          taskStatus: billingReconciliationRequired ? "pending_reconcile" : "failed",
          videoGenerationAttemptId: undefined,
          videoEnhanceAttemptId: billingReconciliationRequired && billingTaskKind === "video_enhance"
            ? node.videoEnhanceAttemptId
            : undefined,
          videoRewritePending: billingReconciliationRequired ? node.videoRewritePending : false,
          generationProgress: 0,
        });
        stopNodeProgressTimer(node.id);
        finishNodeGenerationSession(node.id, sessionId);
        showNodeStatusChip(
          node.id,
          "暂未取得有效视频",
          "error",
          billingReconciliationRequired ? 3200 : 2600,
        );
        setStatus(
          billingReconciliationRequired
            ? "暂未取得有效视频结果，请稍后查看原任务；费用记录可在账单中查询"
            : "生成成功但未解析到视频地址",
        );
        return false;
      }
      const meta = canvasTaskVideoMeta(taskData) || await readRemoteMediaMeta(videoUrl, "video");
      if (sessionId && !isNodeGenerationSessionCurrent(node.id, sessionId)) return false;
      const taskAssetLink = getCanvasTaskAssetLink(taskData, "video");
      const mediaAssetId = taskAssetLink?.mediaAssetId || getExplicitTaskResultMediaAssetId(taskData);
      const billingReconciliationRequired = taskRequiresBillingReconciliation(taskData);
      const billingTaskId = String(taskData?.id || taskData?.taskId || node.taskId || "").trim();
      const billingTaskKind = taskResultKind(taskData, node.taskKind);
      const billingAttemptId = String(
        taskData?.idempotencyKey || node.videoEnhanceAttemptId || "",
      ).trim();
      const nextReferenceAssetUri = taskAssetLink?.assetId
        ? `asset://${taskAssetLink.assetId}`
        : node.referenceAssetUri;
      const nextAssetVersionId = taskAssetLink?.assetVersionId || node.assetVersionId;
      const rewriteOutputPatch: Partial<NodeData> = node.videoRewritePending
        ? {
            videoRewriteOutputVideoUrl: videoUrl,
            videoRewriteOutputAssetVersionId: nextAssetVersionId,
            videoRewriteOutputReferenceAssetUri: nextReferenceAssetUri,
            videoRewriteViewing: "output",
            videoRewritePending: false,
          }
        : {};
      const previousVersions = Array.isArray(node.generationVersions) ? [...node.generationVersions] : [];
      const priorUrl = node.videoRewritePending ? "" : (node.videoUrl || node.localVideoUrl || "");
      if (priorUrl && !previousVersions.some((item) => item.url === priorUrl)) {
        const priorVersion = previousVersions.reduce((max, item) => Math.max(max, Number(item.version) || 0), 0) + 1;
        previousVersions.push({
          version: priorVersion,
          kind: "video",
          url: priorUrl,
          posterUrl: node.videoPosterUrl,
          createdAt: Date.now(),
          label: `v${priorVersion}`,
          draftTaskId: node.videoDraftTaskId, draftExpiresAt: node.videoDraftExpiresAt,
        });
      }
      const nextVersionNumber = previousVersions.reduce((max, item) => Math.max(max, Number(item.version) || 0), 0) + 1;
      const draftResult = taskData?.draft || taskData?.result?.draft;
      const completedDraft = draftResult?.renderMode === "draft"
        ? { videoDraftTaskId: billingTaskId, videoDraftExpiresAt: Number(draftResult.expiresAt) || undefined }
        : { videoDraftTaskId: undefined, videoDraftExpiresAt: undefined };
      const generationVersions = [...previousVersions, {
        version: nextVersionNumber,
        kind: "video" as const,
        url: videoUrl,
        createdAt: Date.now(),
        label: `v${nextVersionNumber}`,
        draftTaskId: completedDraft.videoDraftTaskId, draftExpiresAt: completedDraft.videoDraftExpiresAt,
      }];
      applyNodeMediaGeometry(node.id, meta.width || node.mediaNaturalWidth || 0, meta.height || node.mediaNaturalHeight || 0, {
        videoUrl,
        mediaAssetId,
        mediaAssetUrl: mediaAssetId ? videoUrl : undefined,
        referenceAssetUri: nextReferenceAssetUri,
        assetVersionId: nextAssetVersionId,
        mediaDurationMs: meta.durationMs,
        ...(node.videoRenderMode === "draft" ? completedDraft : {}),
        isGenerating: false,
        generationState: "idle",
        taskId: billingReconciliationRequired && billingTaskId ? billingTaskId : undefined,
        taskKind: billingReconciliationRequired ? billingTaskKind : undefined,
        taskStatus: "success",
        videoGenerationAttemptId: undefined,
        videoEnhanceAttemptId:
          billingReconciliationRequired && billingTaskKind === "video_enhance" && billingAttemptId
            ? billingAttemptId
            : undefined,
        generationProgress: 0,
        generationVersions,
        activeGenerationVersion: generationVersions.at(-1)?.version,
        ...rewriteOutputPatch,
      });
      stopNodeProgressTimer(node.id);
      finishNodeGenerationSession(node.id, sessionId);
      void createAndUploadVideoPoster(node.id, videoUrl, `${node.title || node.id}-poster-source.mp4`).then((ok) => {
        if (ok) void persistCanvas();
      });
      // Persist the task result independently from poster extraction so a
      // failed thumbnail cannot lose the output AssetVersion or rewrite lineage.
      setTimeout(() => void persistCanvas(), 500);
      void loadHistoryItems();
      canvasBalance.refresh();
      return true;
    }

    // 寮哄埗鎻愬彇璞嗗寘鍥剧墖URL锛屼繚璇?00%鎷垮埌
    const generatedImages = pickGeneratedImageChoices(taskData);
    // Prefer the generated-images list for this attempt over a stale generic asset.
    let imageUrl = generatedImages[0]?.url || pickImageResult(taskData);
    // 鍏滃簳閫昏緫锛氱洿鎺ヤ粠璞嗗寘杩斿洖缁撴瀯閲屽彇
    if (!imageUrl && taskData?.raw?.data && Array.isArray(taskData.raw.data) && taskData.raw.data[0]?.url) {
      imageUrl = taskData.raw.data[0].url;
    }
    if (!imageUrl && taskData?.result?.raw?.data && Array.isArray(taskData.result.raw.data) && taskData.result.raw.data[0]?.url) {
      imageUrl = taskData.result.raw.data[0].url;
    }
    if (!imageUrl) {
      if (sessionId && !isNodeGenerationSessionCurrent(node.id, sessionId)) return false;
        setNodePatch(node.id, {
          isGenerating: false,
          generationState: "idle",
          taskId: undefined,
          taskKind: undefined,
          taskStatus: "failed",
          imageGenerationAttemptId: undefined,
          videoEnhanceAttemptId: undefined,
        });
      finishNodeGenerationSession(node.id, sessionId);
      showNodeStatusChip(node.id, "生成失败", "error", 2600);
      setStatus("生成成功但未解析到图片地址");
      return false;
    }
    const primaryGeneratedImage = generatedImages.find((item) => item.url === imageUrl) || generatedImages[0];
    const meta = await readRemoteMediaMeta(imageUrl, "image").catch(() => ({ width: 1024, height: 1024 }));
    if (sessionId && !isNodeGenerationSessionCurrent(node.id, sessionId)) return false;
    const currentNode = nodesRef.current.find((item) => item.id === node.id);
    if (sessionId && (!currentNode || !patchLooksActivelyGenerating(currentNode))) return false;
    const currentResultNode = currentNode || node;
    const generatedAssetVersionId = Number(primaryGeneratedImage?.assetVersionId || currentResultNode.assetVersionId);
    const generatedReferenceAssetUri = primaryGeneratedImage?.assetId
      ? `asset://${primaryGeneratedImage.assetId}`
      : currentResultNode.referenceAssetUri;
    localResultPendingPersistenceRef.current[node.id] = imageUrl;
    applyNodeMediaGeometry(node.id, meta.width || currentResultNode.mediaNaturalWidth || 0, meta.height || currentResultNode.mediaNaturalHeight || 0, {
      imageUrl,
      primaryImageUrl: imageUrl,
      imageResultVersion: nextCanvasImageResultVersion(currentResultNode.imageResultVersion),
      referenceAssetUri: generatedReferenceAssetUri,
      assetVersionId: Number.isSafeInteger(generatedAssetVersionId) && generatedAssetVersionId > 0
        ? generatedAssetVersionId
        : currentResultNode.assetVersionId,
      generatedImages: generatedImages.length > 1 ? generatedImages : [],
      imageChoicesCollapsed: generatedImages.length > 1 ? false : undefined,
      localPreviewUrl: undefined,
      uploadState: "idle",
      uploadProgress: undefined,
      isGenerating: false,
      generationState: "idle",
      taskId: undefined,
      taskKind: undefined,
      taskStatus: "success",
      imageGenerationAttemptId: undefined,
      imageRequestAttempt: undefined,
      imagePendingMessage: undefined,
      imagePendingCode: undefined,
      videoEnhanceAttemptId: undefined,
      generationProgress: 0,
    });
    const artifactTarget = currentResultNode.artifactImageTarget;
    if (artifactTarget && Number.isSafeInteger(generatedAssetVersionId) && generatedAssetVersionId > 0) {
      const sourceNode = nodesRef.current.find((item) => item.id === artifactTarget.sourceNodeId);
      const targetArtifact = allArtifactCards(sourceNode?.textArtifacts).find((entry) => entry.card.id === artifactTarget.cardId);
      if (sourceNode && targetArtifact && targetArtifact.kind !== "shots" && !targetArtifact.card.reference) {
        editCanvasArtifact(sourceNode.id, targetArtifact.kind, targetArtifact.card.id, {
          reference: {
            nodeId: currentResultNode.id,
            assetVersionId: generatedAssetVersionId,
            imageUrl,
            referenceAssetUri: generatedReferenceAssetUri,
          },
        });
      }
    }
    stopNodeProgressTimer(node.id);
    finishNodeGenerationSession(node.id, sessionId);
    void loadHistoryItems();
    canvasBalance.refresh();
    // 生成完成后再次保存画布，确保结果状态落盘。
    void persistCanvas(nodesRef.current, edges);
    return true;
  }

  return applyTaskResultToNode;
}
