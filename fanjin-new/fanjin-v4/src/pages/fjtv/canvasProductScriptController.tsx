import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { CanvasModelType, VideoStoryShot, ProductScriptStep, ProductScriptStage, ProductScriptAssetKind, ProductScriptAsset, ProductStoryboardShot, ProductScriptWorkflow, NodeData, EdgeData, GroupData, CanvasMetaState } from "./canvasDataTypes";
import type { NodeType, RatioKey } from "./canvasMediaTypes";
import { submitAfterPortraitPreparation } from "../../features/quick-create/portraitPreparation";
import { generationPreparationPatch } from "../../features/quick-create/generationPreparation";
import { normalizeCanvasCatalogVideoAudio } from "./canvasCatalogContract";
import { api, resolveCanvasVideoGenerationAttemptId, type AiModelOption } from "@/lib/api";
import { normalizeProjectId } from "@/stores/projectStore";
import { isCanvasUploadAbortError } from "./canvasUploadRuntime";

export interface CanvasProductScriptControllerDependencies {
  normalizeProductScriptWorkflow: (input?: Partial<ProductScriptWorkflow> | null) => ProductScriptWorkflow;
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  edges: EdgeData[];
  productScriptProgressTimerRef: RefObject<Record<string, number>>;
  PRODUCT_SCRIPT_ASSETS: { kind: ProductScriptAssetKind; label: string; placeholder: string; }[];
  setProductScriptVideoUploadTargetNodeId: Dispatch<SetStateAction<string | null>>;
  productScriptVideoUploadInputRef: RefObject<HTMLInputElement | null>;
  setProductScriptAssetUploadTarget: Dispatch<SetStateAction<{ nodeId: string; kind: ProductScriptAssetKind; } | null>>;
  productScriptAssetUploadInputRef: RefObject<HTMLInputElement | null>;
  productScriptVideoUploadTargetNodeId: string | null;
  ensureApiKeyReady: () => boolean;
  canvasContextEpochRef: RefObject<number>;
  uploadMediaFileToRemote: (file: File, type: "image" | "video", nodeId?: string) => Promise<{ url: string; width: number; height: number; ratio: RatioKey; fileName: string; assetId: string; assetVersionId: number | undefined; }>;
  assertCanvasOperationActive: (expectedEpoch: number, signal?: AbortSignal) => void;
  setStatus: Dispatch<SetStateAction<string>>;
  productScriptAssetUploadTarget: { nodeId: string; kind: ProductScriptAssetKind; } | null;
  nodeMap: Map<string, NodeData>;
  createDefaultProductScriptWorkflow: () => ProductScriptWorkflow;
  canvasMeta: CanvasMetaState;
  preflightCanvasModel: (modelType: CanvasModelType, requestedModelId?: string, options?: { allowCatalogDefault?: boolean; openPicker?: boolean; }) => AiModelOption | null;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  activeProjectContextId: string | null;
  beginNodeGenerationSession: (nodeId: string) => string;
  parseDurationSeconds: (raw?: string) => number;
  normalizeVideoResolutionForModel: (modelId: string | undefined, value: string | undefined, model?: AiModelOption) => string;
  isNodeGenerationSessionCurrent: (nodeId: string, sessionId: string) => boolean;
  beginNodeProgressSimulation: (nodeId: string, phase: "upload" | "generation") => void;
  pollTaskUntilDone: (taskId: string, node: NodeData, sessionId: string, startedAt?: number, options?: { kind?: "generation" | "video_enhance"; queryFailures?: number; }) => Promise<boolean>;
  applyTaskResultToNode: (node: NodeData, taskData: any, sessionId?: string) => Promise<boolean>;
  finishNodeGenerationSession: (nodeId: string, sessionId?: string) => void;
  createNode: (id: string, type: NodeType, centerX: number, centerY: number) => NodeData;
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  setNodeSerialCounter: Dispatch<SetStateAction<Record<NodeType, number>>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
}

export function createCanvasProductScriptController(deps: CanvasProductScriptControllerDependencies) {
  const { normalizeProductScriptWorkflow, setNodes, persistCanvas, edges, productScriptProgressTimerRef, PRODUCT_SCRIPT_ASSETS, setProductScriptVideoUploadTargetNodeId, productScriptVideoUploadInputRef, setProductScriptAssetUploadTarget, productScriptAssetUploadInputRef, productScriptVideoUploadTargetNodeId, ensureApiKeyReady, canvasContextEpochRef, uploadMediaFileToRemote, assertCanvasOperationActive, setStatus, productScriptAssetUploadTarget, nodeMap, createDefaultProductScriptWorkflow, canvasMeta, preflightCanvasModel, setNodePatch, activeProjectContextId, beginNodeGenerationSession, parseDurationSeconds, normalizeVideoResolutionForModel, isNodeGenerationSessionCurrent, beginNodeProgressSimulation, pollTaskUntilDone, applyTaskResultToNode, finishNodeGenerationSession, createNode, setEdges, setNodeSerialCounter, setSelectedNodeIds, setSelectedEdgeIds, setActiveNodeId } = deps;
function getProductScriptWorkflow(node: NodeData): ProductScriptWorkflow {
    return normalizeProductScriptWorkflow(node.scriptWorkflow);
  }

function saveProductScriptWorkflow(
    nodeId: string,
    updater: ProductScriptWorkflow | ((current: ProductScriptWorkflow) => ProductScriptWorkflow),
  ) {
    let nextNodes: NodeData[] | null = null;
    let savedWorkflow: ProductScriptWorkflow | null = null;
    setNodes((prev) => {
      const next = prev.map((node) => {
        if (node.id !== nodeId) return node;
        const current = normalizeProductScriptWorkflow(node.scriptWorkflow);
        const updated = typeof updater === "function" ? updater(current) : updater;
        savedWorkflow = normalizeProductScriptWorkflow(updated);
        return { ...node, scriptWorkflow: savedWorkflow };
      });
      nextNodes = next;
      return next;
    });
    window.setTimeout(() => {
      if (nextNodes) void persistCanvas(nextNodes, edges);
    }, 40);
    return savedWorkflow;
  }

function advanceProductScriptProgress(nodeId: string, progress: number, stage?: ProductScriptStage) {
    saveProductScriptWorkflow(nodeId, (current) => ({
      ...current,
      stage: stage || current.stage,
      progress: Math.max(current.progress || 0, Math.min(99, progress)),
    }));
  }

function stopProductScriptProgressSimulation(nodeId: string) {
    const timer = productScriptProgressTimerRef.current[nodeId];
    if (timer) {
      window.clearInterval(timer);
      delete productScriptProgressTimerRef.current[nodeId];
    }
  }

function startProductScriptProgressSimulation(nodeId: string, target = 92) {
    stopProductScriptProgressSimulation(nodeId);
    productScriptProgressTimerRef.current[nodeId] = window.setInterval(() => {
      saveProductScriptWorkflow(nodeId, (current) => {
        const currentProgress = Math.max(1, current.progress || 1);
        const nextProgress = Math.min(target, currentProgress + (currentProgress < 30 ? 4 : currentProgress < 70 ? 2 : 1));
        if (nextProgress <= currentProgress) return current;
        return { ...current, progress: nextProgress };
      });
    }, 900);
  }

function hasAllProductScriptAssets(workflow: ProductScriptWorkflow) {
    return PRODUCT_SCRIPT_ASSETS.every((def) => Boolean(workflow.assets.find((asset) => asset.kind === def.kind)?.imageUrl));
  }

function openProductScriptVideoUpload(nodeId: string) {
    setProductScriptVideoUploadTargetNodeId(nodeId);
    productScriptVideoUploadInputRef.current?.click();
  }

function openProductScriptAssetUpload(nodeId: string, kind: ProductScriptAssetKind) {
    setProductScriptAssetUploadTarget({ nodeId, kind });
    productScriptAssetUploadInputRef.current?.click();
  }

async function handleProductScriptVideoUploadChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const nodeId = productScriptVideoUploadTargetNodeId;
    event.target.value = "";
    setProductScriptVideoUploadTargetNodeId(null);
    if (!file || !nodeId) return;
    if (!ensureApiKeyReady()) return;
    const operationEpoch = canvasContextEpochRef.current;
    try {
      saveProductScriptWorkflow(nodeId, (current) => ({ ...current, stage: "uploading", progress: Math.max(current.progress || 0, 3), error: undefined }));
      const uploaded = await uploadMediaFileToRemote(file, "video");
      assertCanvasOperationActive(operationEpoch);
      saveProductScriptWorkflow(nodeId, (current) => ({
        ...current,
        sourceVideoUrl: uploaded.url,
        sourceVideoName: uploaded.fileName || file.name,
        stage: "analyzing-viral",
        progress: Math.max(current.progress || 0, 8),
        error: undefined,
      }));
      await submitProductViralAnalysis(nodeId, uploaded.url, uploaded.fileName || file.name);
    } catch (error) {
      if (isCanvasUploadAbortError(error) || canvasContextEpochRef.current !== operationEpoch) return;
      saveProductScriptWorkflow(nodeId, (current) => ({ ...current, stage: "failed", error: error instanceof Error ? error.message : "爆款视频上传失败" }));
      setStatus(error instanceof Error ? error.message : "爆款视频上传失败");
    }
  }

async function handleProductScriptAssetUploadChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const target = productScriptAssetUploadTarget;
    event.target.value = "";
    setProductScriptAssetUploadTarget(null);
    if (!file || !target) return;
    if (!ensureApiKeyReady()) return;
    const operationEpoch = canvasContextEpochRef.current;
    let previousAsset: ProductScriptAsset | undefined;
    let localPreviewUrl = "";
    try {
      localPreviewUrl = URL.createObjectURL(file);
      saveProductScriptWorkflow(target.nodeId, (current) => {
        previousAsset = current.assets.find((asset) => asset.kind === target.kind);
        return {
          ...current,
          assets: current.assets.map((asset) => asset.kind === target.kind
            ? { ...asset, imageUrl: localPreviewUrl, fileName: file.name, uploading: true, progress: 8 }
            : asset),
        };
      });
      setStatus("产品资产上传中...");
      const uploaded = await uploadMediaFileToRemote(file, "image");
      assertCanvasOperationActive(operationEpoch);
      let shouldAutoAnalyze = false;
      saveProductScriptWorkflow(target.nodeId, (current) => {
        const nextAssets = current.assets.map((asset) => asset.kind === target.kind
          ? { ...asset, imageUrl: uploaded.url, fileName: uploaded.fileName || file.name, uploading: false, progress: 100 }
          : asset);
        const nextWorkflow: ProductScriptWorkflow = {
          ...current,
          assets: nextAssets,
          step: 2 as ProductScriptStep,
          stage: (current.stage === "shots-ready" || current.stage === "empty" ? "shots-ready" : current.stage) as ProductScriptStage,
        };
        shouldAutoAnalyze = hasAllProductScriptAssets(nextWorkflow);
        return nextWorkflow;
      });
      setStatus("产品资产上传成功");
      if (shouldAutoAnalyze) {
        window.setTimeout(() => {
          if (canvasContextEpochRef.current === operationEpoch) {
            void submitProductAssetsAnalysis(target.nodeId);
          }
        }, 160);
      }
    } catch (error) {
      if (isCanvasUploadAbortError(error) || canvasContextEpochRef.current !== operationEpoch) return;
      saveProductScriptWorkflow(target.nodeId, (current) => ({
        ...current,
        assets: current.assets.map((asset) => asset.kind === target.kind
          ? { ...(previousAsset || asset), kind: asset.kind, label: asset.label, uploading: false, progress: 0 }
          : asset),
      }));
      setStatus(error instanceof Error ? error.message : "产品资产上传失败");
    } finally {
      if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
    }
  }

async function submitProductViralAnalysis(nodeId: string, videoUrl?: string, title?: string) {
    const operationEpoch = canvasContextEpochRef.current;
    const node = nodeMap.get(nodeId);
    const workflow = node ? getProductScriptWorkflow(node) : createDefaultProductScriptWorkflow();
    const sourceUrl = videoUrl || workflow.sourceVideoUrl || "";
    if (!sourceUrl) { setStatus("请先上传爆款视频"); return; }
    try {
      advanceProductScriptProgress(nodeId, 18, "analyzing-viral");
      startProductScriptProgressSimulation(nodeId, 88);
      const result = await api.analyzeProductViralVideo({
        canvasId: canvasMeta.canvasId || undefined,
        nodeId,
        videoUrl: sourceUrl,
        title: title || workflow.sourceVideoName || "爆款视频",
        productCategory: workflow.productCategory,
        brandTone: "产品短视频广告",
      });
      assertCanvasOperationActive(operationEpoch);
      const analysis = (result as any)?.analysis || (result as any)?.data?.analysis;
      if (!analysis || !Array.isArray(analysis.rows)) throw new Error("爆款视频拆解完成但未返回镜头表");
      stopProductScriptProgressSimulation(nodeId);
      saveProductScriptWorkflow(nodeId, (current) => ({ ...current, step: 1, stage: "shots-ready", progress: 100, viralAnalysis: analysis, error: undefined }));
      setStatus("爆款视频拆解完成");
    } catch (error) {
      stopProductScriptProgressSimulation(nodeId);
      if (isCanvasUploadAbortError(error) || canvasContextEpochRef.current !== operationEpoch) return;
      saveProductScriptWorkflow(nodeId, (current) => ({ ...current, stage: "failed", error: error instanceof Error ? error.message : "爆款视频拆解失败" }));
      setStatus(error instanceof Error ? error.message : "爆款视频拆解失败");
    }
  }

async function submitProductAssetsAnalysis(nodeId: string) {
    const operationEpoch = canvasContextEpochRef.current;
    const node = nodeMap.get(nodeId);
    if (!node) return;
    const workflow = getProductScriptWorkflow(node);
    if (!workflow.assets.some((asset) => asset.imageUrl)) { setStatus("请先上传模特图、产品图或上妆效果图"); return; }
    try {
      saveProductScriptWorkflow(nodeId, (current) => ({ ...current, step: 2, stage: "analyzing-product", progress: 24, error: undefined }));
      startProductScriptProgressSimulation(nodeId, 84);
      const result = await api.analyzeProductAssets({
        canvasId: canvasMeta.canvasId || undefined,
        nodeId,
        productName: workflow.productName,
        productCategory: workflow.productCategory,
        assets: workflow.assets.map((asset) => ({ kind: asset.kind, label: asset.label, url: asset.imageUrl || "" })),
      });
      assertCanvasOperationActive(operationEpoch);
      const productAnalysis = (result as any)?.productAnalysis || (result as any)?.data?.productAnalysis;
      if (!productAnalysis) throw new Error("产品解析完成但未返回结果");
      stopProductScriptProgressSimulation(nodeId);
      const mergedAssets = workflow.assets.map((asset) => ({ ...asset, ...((productAnalysis.assets || []).find((item: ProductScriptAsset) => item.kind === asset.kind) || {}), imageUrl: asset.imageUrl }));
      saveProductScriptWorkflow(nodeId, (current) => ({ ...current, step: 2, stage: "assets-ready", progress: 100, productAnalysis: { ...productAnalysis, assets: mergedAssets }, assets: mergedAssets, error: undefined }));
      setStatus("我们的产品解析完成");
    } catch (error) {
      stopProductScriptProgressSimulation(nodeId);
      if (isCanvasUploadAbortError(error) || canvasContextEpochRef.current !== operationEpoch) return;
      saveProductScriptWorkflow(nodeId, (current) => ({ ...current, stage: "failed", error: error instanceof Error ? error.message : "产品解析失败" }));
      setStatus(error instanceof Error ? error.message : "产品解析失败");
    }
  }

async function submitProductStoryboardCompose(nodeId: string) {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    const workflow = getProductScriptWorkflow(node);
    if (!workflow.viralAnalysis?.rows?.length) { setStatus("请先完成爆款拆解"); return; }
    if (!workflow.productAnalysis) { setStatus("请先完成产品解析"); return; }
    try {
      saveProductScriptWorkflow(nodeId, (current) => ({ ...current, step: 3, stage: "composing-storyboard", progress: 35, error: undefined }));
      startProductScriptProgressSimulation(nodeId, 90);
      const result = await api.composeProductStoryboard({
        canvasId: canvasMeta.canvasId || undefined,
        nodeId,
        productName: workflow.productName,
        ratio: "9:16",
        viralAnalysis: workflow.viralAnalysis,
        productAnalysis: workflow.productAnalysis,
      });
      const storyboard = (result as any)?.storyboard || (result as any)?.data?.storyboard;
      if (!storyboard || !Array.isArray(storyboard.rows)) throw new Error("产品分镜合成完成但未返回分镜表");
      stopProductScriptProgressSimulation(nodeId);
      saveProductScriptWorkflow(nodeId, (current) => ({ ...current, step: 3, stage: "storyboard-ready", progress: 100, storyboard, error: undefined }));
      setStatus("产品分镜已生成");
    } catch (error) {
      stopProductScriptProgressSimulation(nodeId);
      saveProductScriptWorkflow(nodeId, (current) => ({ ...current, stage: "failed", error: error instanceof Error ? error.message : "产品分镜生成失败" }));
      setStatus(error instanceof Error ? error.message : "产品分镜生成失败");
    }
  }

function updateProductScriptShot(nodeId: string, rowIndex: number, field: keyof VideoStoryShot | string, value: string) {
    saveProductScriptWorkflow(nodeId, (current) => {
      const analysis = current.viralAnalysis;
      if (!analysis) return current;
      const numeric = ["shot", "startTime", "endTime", "duration", "frameTime"].includes(String(field));
      const nextValue = numeric ? Number(value) : value;
      return { ...current, viralAnalysis: { ...analysis, rows: analysis.rows.map((row, index) => index === rowIndex ? { ...row, [field]: nextValue } : row) } };
    });
  }

function updateProductStoryboardShot(nodeId: string, rowIndex: number, field: keyof ProductStoryboardShot | string, value: string) {
    saveProductScriptWorkflow(nodeId, (current) => {
      const storyboard = current.storyboard;
      if (!storyboard) return current;
      const numeric = ["shot", "startTime", "endTime", "duration"].includes(String(field));
      const nextValue = numeric ? Number(value) : value;
      return { ...current, storyboard: { ...storyboard, rows: storyboard.rows.map((row, index) => index === rowIndex ? { ...row, [field]: nextValue } : row) } };
    });
  }

function updateProductAnalysisText(nodeId: string, field: "overallStyle" | "sellingPoints" | "visualKeywords" | "avoidNotes", value: string) {
    saveProductScriptWorkflow(nodeId, (current) => ({
      ...current,
      productAnalysis: {
        ...(current.productAnalysis || {}),
        [field]: field === "overallStyle" ? value : value.split(/[\n,，;；]/).map((item) => item.trim()).filter(Boolean),
      },
    }));
  }

async function submitProductScriptVideoNode(videoNode: NodeData) {
    const catalogModel = preflightCanvasModel("video", videoNode.model);
    if (!catalogModel) {
      setNodePatch(videoNode.id, {
        isGenerating: false,
        generationState: "idle",
        taskId: undefined,
        taskStatus: "failed",
        generationProgress: 0,
      });
      return;
    }
    const projectId = normalizeProjectId(activeProjectContextId);
    if (projectId === null) {
      setNodePatch(videoNode.id, {
        isGenerating: false,
        generationState: "idle",
        taskId: undefined,
        taskStatus: "failed",
        generationProgress: 0,
      });
      setStatus("请先选择项目，再提交视频生成");
      return;
    }
    const sessionId = beginNodeGenerationSession(videoNode.id);
    const videoGenerationAttemptId = resolveCanvasVideoGenerationAttemptId(videoNode.videoGenerationAttemptId);
    const payload: Record<string, any> = {
      mediaType: "video",
      projectId,
      generationAttemptId: videoGenerationAttemptId,
      model: catalogModel.id,
      prompt: videoNode.prompt || "product commercial video",
      mode: "text_to_video",
      ratio: videoNode.ratio,
      duration: parseDurationSeconds(videoNode.duration),
      resolution: normalizeVideoResolutionForModel(
        catalogModel.id,
        videoNode.resolution,
        catalogModel,
      ),
      generateAudio: normalizeCanvasCatalogVideoAudio(catalogModel, videoNode.videoGenerateAudio),
    };
    setNodePatch(videoNode.id, { videoGenerationAttemptId });
    try {
      const result = await submitAfterPortraitPreparation({
        submit: () => api.generateNode(payload),
        isCurrent: () => isNodeGenerationSessionCurrent(videoNode.id, sessionId),
        onProgress: setStatus,
      });
      const taskId = (result as any)?.taskId || (result as any)?.id || "";
      const status = String((result as any)?.status || "").toLowerCase();
      if (!taskId) throw new Error("视频任务创建响应缺少任务编号");
      if (status === "processing" && taskId) {
        setNodePatch(videoNode.id, { taskId, taskStatus: "processing", generationState: "processing", generationProgress: 3, ...generationPreparationPatch(result) });
        beginNodeProgressSimulation(videoNode.id, "generation");
        await pollTaskUntilDone(taskId, videoNode, sessionId);
        return;
      }
      await applyTaskResultToNode(videoNode, result, sessionId);
    } catch {
      setNodePatch(videoNode.id, {
        isGenerating: false,
        generationState: "idle",
        taskId: undefined,
        taskKind: "generation",
        taskStatus: "pending_reconcile",
        videoGenerationAttemptId,
        generationProgress: 0,
      });
      finishNodeGenerationSession(videoNode.id, sessionId);
    }
  }

async function generateProductScriptVideos(nodeId: string) {
    const scriptNode = nodeMap.get(nodeId);
    if (!scriptNode) return;
    const workflow = getProductScriptWorkflow(scriptNode);
    const rows = workflow.storyboard?.rows || [];
    if (!rows.length) { setStatus("请先生成产品分镜"); return; }
    const batchVideoModel = preflightCanvasModel("video", undefined, { allowCatalogDefault: true });
    if (!batchVideoModel) return;
    const batchResolution = normalizeVideoResolutionForModel(batchVideoModel.id, "720P", batchVideoModel);
    const stamp = Date.now();
    const startX = scriptNode.x + scriptNode.width + 360;
    const startY = scriptNode.y;
    const createdNodes: NodeData[] = rows.map((row, index) => {
      const id = "node_" + stamp + "_product_video_" + index;
      const base = createNode(id, "video", startX + Math.floor(index / 3) * 280, startY + (index % 3) * 250);
      return {
        ...base,
        title: "产品视频" + (index + 1),
        titleCustomized: true,
        ratio: "9:16",
        width: 180,
        height: 320,
        model: batchVideoModel.id,
        resolution: batchResolution,
        duration: String(Math.max(4, Math.min(15, Math.round(Number(row.duration) || 5)))),
        prompt: row.finalPrompt || row.videoMotionPrompt || row.visualDescription,
        isGenerating: true,
        generationState: "submitting" as const,
        taskStatus: "processing" as const,
        generationProgress: 1,
      };
    });
    const newEdges: EdgeData[] = createdNodes.map((node, index) => ({ id: "edge_" + stamp + "_product_video_" + index, fromNodeId: scriptNode.id, fromSide: "right", toNodeId: node.id, toSide: "left" }));
    setNodes((prev) => [...prev, ...createdNodes]);
    setEdges((prev) => [...prev, ...newEdges]);
    setNodeSerialCounter((prev) => ({ ...prev, video: (prev.video || 0) + createdNodes.length }));
    saveProductScriptWorkflow(nodeId, (current) => ({ ...current, stage: "generating-video", generatedVideoNodeIds: createdNodes.map((node) => node.id) }));
    setSelectedNodeIds(createdNodes.map((node) => node.id));
    setSelectedEdgeIds([]);
    setActiveNodeId(createdNodes[0]?.id || null);
    setStatus(`产品视频任务已提交 · ${batchVideoModel.name}`);
    await Promise.all(createdNodes.map((node) => submitProductScriptVideoNode(node)));
    saveProductScriptWorkflow(nodeId, (current) => ({ ...current, stage: "video-ready", progress: 100, generatedVideoNodeIds: createdNodes.map((node) => node.id) }));
    window.setTimeout(() => void persistCanvas(), 500);
  }
  return { getProductScriptWorkflow, saveProductScriptWorkflow, advanceProductScriptProgress, stopProductScriptProgressSimulation, startProductScriptProgressSimulation, hasAllProductScriptAssets, openProductScriptVideoUpload, openProductScriptAssetUpload, handleProductScriptVideoUploadChange, handleProductScriptAssetUploadChange, submitProductViralAnalysis, submitProductAssetsAnalysis, submitProductStoryboardCompose, updateProductScriptShot, updateProductStoryboardShot, updateProductAnalysisText, submitProductScriptVideoNode, generateProductScriptVideos };
}
