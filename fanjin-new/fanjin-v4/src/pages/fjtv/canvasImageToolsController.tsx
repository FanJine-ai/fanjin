import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { CanvasModelType, ImageEraseKind, ViewportState, NodeData, ImageEnhanceEditorState, ImageTransformEditorState, ImageOutpaintDragState, ImageCropDragState, EdgeData, GroupData, CanvasMetaState } from "./canvasDataTypes";
import type { NodeType, RatioKey, ImageOutpaintDraft, ImageCropDraft } from "./canvasMediaTypes";
import { ratioToNodeDimensions, nearestRatio, mediaToNodeDimensions, normalizeImageRotation, buildImageOutpaintDraftForRatio, getImageOutpaintPreviewMetrics, clampImageCropDraft, buildImageCropDraftForRatio } from "./canvasMediaGeometry";
import { generationPreparationPatch } from "../../features/quick-create/generationPreparation";
import { flushSync } from "react-dom";
import { getCanvasUsableLayout } from "./canvasAdaptiveLayout";
import { type CanvasCatalogImageQuality } from "./canvasCatalogContract";
import { api, type AiModelOption } from "@/lib/api";
import { normalizeProjectId } from "@/stores/projectStore";
import { getNodeTextContent } from "./canvasAssetPresentation";
import { catalogModelPriceText } from "./canvasPricing";
import { buildCharacterSheetPrompt, buildCharacterThreeViewPrompt, buildCinematicLightingPrompt, buildMultiAngleNineGridPrompt, buildProductSheetPrompt, buildSceneSheetPrompt, buildStoryboard25GridPrompt, detectMultiAngleNineGridMode, detectProductSheetMode, type CharacterThreeViewMode, type MultiAngleNineGridMode } from "./canvasPromptTemplates";

export interface CanvasImageToolsControllerDependencies {
  createNode: (id: string, type: NodeType, centerX: number, centerY: number) => NodeData;
  nodes: NodeData[];
  edges: EdgeData[];
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  setStatus: Dispatch<SetStateAction<string>>;
  closePromptMenus: () => void;
  closeImageToolbarMenus: () => void;
  setExpanded: Dispatch<SetStateAction<boolean>>;
  setActiveImageEnhance: Dispatch<SetStateAction<ImageEnhanceEditorState | null>>;
  ensureApiKeyReady: () => boolean;
  nodeMap: Map<string, NodeData>;
  ensureRemoteImageUrlForNode: (node: NodeData) => Promise<string>;
  activeImageEnhance: ImageEnhanceEditorState | null;
  beginNodeGenerationSession: (nodeId: string) => string;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  canvasMeta: CanvasMetaState;
  IMAGE_ENHANCE_MODEL_FALLBACK: "HuoShan-图像画质增强";
  isNodeGenerationSessionCurrent: (nodeId: string, sessionId: string) => boolean;
  beginNodeProgressSimulation: (nodeId: string, phase: "upload" | "generation") => void;
  pollTaskUntilDone: (taskId: string, node: NodeData, sessionId: string, startedAt?: number, options?: { kind?: "generation" | "video_enhance"; queryFailures?: number; }) => Promise<boolean>;
  applyTaskResultToNode: (node: NodeData, taskData: any, sessionId?: string) => Promise<boolean>;
  finishNodeGenerationSession: (nodeId: string, sessionId?: string) => void;
  setActiveImageCrop: Dispatch<SetStateAction<ImageCropDraft | null>>;
  setActiveImageTransform: Dispatch<SetStateAction<ImageTransformEditorState | null>>;
  setImageCropDragging: Dispatch<SetStateAction<ImageCropDragState | null>>;
  setImageOutpaintDragging: Dispatch<SetStateAction<ImageOutpaintDragState | null>>;
  setActiveImageOutpaint: Dispatch<SetStateAction<ImageOutpaintDraft | null>>;
  activeImageOutpaint: ImageOutpaintDraft | null;
  activeImageCrop: ImageCropDraft | null;
  activeProjectContextId: string | null;
  buildCroppedImageFile: (sourceNode: NodeData, x1: number, y1: number, x2: number, y2: number) => Promise<File>;
  activeImageTransform: ImageTransformEditorState | null;
  setImageNineGridMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridCustomMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridCustomPreview: Dispatch<SetStateAction<{ nodeId: string; rows: number; cols: number; } | null>>;
  findSelectableCatalogModel: (modelType: CanvasModelType, modelId?: string) => AiModelOption | undefined;
  preflightCanvasModel: (modelType: CanvasModelType, requestedModelId?: string, options?: { allowCatalogDefault?: boolean; openPicker?: boolean; }) => AiModelOption | null;
  resolveCanvasImageQuality: (model: AiModelOption, nodeResolution: string | undefined) => "" | CanvasCatalogImageQuality;
  getImageRequestRatio: (node: NodeData) => RatioKey;
  resolveNodeRemoteReferenceUrl: (node: NodeData) => Promise<string>;
  baseModel: (type: NodeType) => "" | "timeline-compose";
  setGroups: Dispatch<SetStateAction<GroupData[]>>;
  setActiveGroupId: Dispatch<SetStateAction<string | null>>;
  imageToImageUploadPresetRef: RefObject<string | null>;
  setNodeSerialCounter: Dispatch<SetStateAction<Record<NodeType, number>>>;
  rootRef: RefObject<HTMLDivElement | null>;
  assetManagerOpen: boolean;
  CANVAS_VISUAL_SCALE: 1.25;
  setViewport: Dispatch<SetStateAction<ViewportState>>;
  fileInputRef: RefObject<HTMLInputElement | null>;
}

export function createCanvasImageToolsController(deps: CanvasImageToolsControllerDependencies) {
  const { createNode, nodes, edges, setNodes, setEdges, setSelectedNodeIds, setSelectedEdgeIds, setActiveNodeId, persistCanvas, setStatus, closePromptMenus, closeImageToolbarMenus, setExpanded, setActiveImageEnhance, ensureApiKeyReady, nodeMap, ensureRemoteImageUrlForNode, activeImageEnhance, beginNodeGenerationSession, setNodePatch, canvasMeta, IMAGE_ENHANCE_MODEL_FALLBACK, isNodeGenerationSessionCurrent, beginNodeProgressSimulation, pollTaskUntilDone, applyTaskResultToNode, finishNodeGenerationSession, setActiveImageCrop, setActiveImageTransform, setImageCropDragging, setImageOutpaintDragging, setActiveImageOutpaint, activeImageOutpaint, activeImageCrop, activeProjectContextId, buildCroppedImageFile, activeImageTransform, setImageNineGridMenuNodeId, setImageGridMenuNodeId, setImageGridCustomMenuNodeId, setImageGridCustomPreview, findSelectableCatalogModel, preflightCanvasModel, resolveCanvasImageQuality, getImageRequestRatio, resolveNodeRemoteReferenceUrl, baseModel, setGroups, setActiveGroupId, imageToImageUploadPresetRef, setNodeSerialCounter, rootRef, assetManagerOpen, CANVAS_VISUAL_SCALE, setViewport, fileInputRef } = deps;
async function createDerivedImageNode(sourceNode: NodeData, title: string, patch: Partial<NodeData> = {}) {
    const id = `node_${Date.now()}_image`;
    const centerX = sourceNode.x + sourceNode.width + 220;
    const centerY = sourceNode.y + sourceNode.height / 2;
    const ratio = patch.ratio || "1:1";
    const dims = ratioToNodeDimensions(ratio, "image");
    const nextNode: NodeData = {
      ...createNode(id, "image", centerX, centerY),
      x: patch.x ?? centerX - dims.width / 2,
      y: patch.y ?? centerY - dims.height / 2,
      width: patch.width ?? dims.width,
      height: patch.height ?? dims.height,
      title,
      titleCustomized: true,
      isGenerating: false,
      generationState: "idle",
      taskStatus: "idle",
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
    return nextNode;
  }

function create16x9DerivedImagePatch(sourceNode: NodeData): Partial<NodeData> {
    const width = Math.max(560, Math.min(760, Math.round(Math.max(sourceNode.width || 0, 560))));
    const height = Math.round((width * 9) / 16);
    return {
      ratio: "16:9",
      width,
      height,
      mediaNaturalWidth: 2848,
      mediaNaturalHeight: 1600,
    };
  }

function create2x1DerivedImagePatch(sourceNode: NodeData): Partial<NodeData> {
    const width = Math.max(640, Math.min(880, Math.round(Math.max(sourceNode.width || 0, 640))));
    const height = Math.round(width / 2);
    return {
      ratio: "2:1",
      width,
      height,
      mediaNaturalWidth: 3200,
      mediaNaturalHeight: 1600,
    };
  }

function openImageEnhanceEditor(sourceNode: NodeData) {
    if (sourceNode.type !== "image" || !(sourceNode.imageUrl || sourceNode.localPreviewUrl)) {
      setStatus("当前图片节点还没有可用画面");
      return;
    }
    closePromptMenus();
    closeImageToolbarMenus();
    setExpanded(false);
    void createDerivedImageNode(sourceNode, "高清", {
      ratio: sourceNode.ratio,
      width: sourceNode.width,
      height: sourceNode.height,
      mediaNaturalWidth: sourceNode.mediaNaturalWidth || Math.round(sourceNode.width),
      mediaNaturalHeight: sourceNode.mediaNaturalHeight || Math.round(sourceNode.height),
      imageEnhanceMode: true,
      imageEnhanceVersion: "standard",
      imageEnhanceFactor: 2,
      imageUrl: "",
      localPreviewUrl: undefined,
    }).then((nextNode) => {
      setActiveImageEnhance({ nodeId: nextNode.id, version: "standard", factor: 2 });
      setStatus("已打开图片高清参数面板");
    });
  }

async function submitImageEnhance(node: NodeData) {
    if (!ensureApiKeyReady()) return;
    const sourceNode = edges
      .filter((edge) => edge.toNodeId === node.id)
      .map((edge) => nodeMap.get(edge.fromNodeId))
      .find((item): item is NodeData => Boolean(item && item.type === "image"));
    if (!sourceNode) {
      setStatus("请先连接一个图片节点");
      return;
    }
    let imageUrl = "";
    try {
      imageUrl = await ensureRemoteImageUrlForNode(sourceNode);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "图片素材上传失败");
      return;
    }
    if (!imageUrl) {
      setStatus("请先准备可用的图片素材");
      return;
    }
    const version = activeImageEnhance?.nodeId === node.id ? activeImageEnhance.version : node.imageEnhanceVersion || "standard";
    const factor = activeImageEnhance?.nodeId === node.id ? activeImageEnhance.factor : node.imageEnhanceFactor || 2;
    const sessionId = beginNodeGenerationSession(node.id);
    flushSync(() => {
      setNodePatch(node.id, {
        isGenerating: true,
        generationState: "submitting",
        taskStatus: "processing",
        taskId: undefined,
        imageEnhanceVersion: version,
        imageEnhanceFactor: factor,
      });
      setStatus("图片高清任务提交中...");
    });
    try {
      const result = await api.enhanceImage({
        canvasId: canvasMeta.canvasId || undefined,
        nodeId: node.id,
        imageUrl,
        model: IMAGE_ENHANCE_MODEL_FALLBACK,
        version,
        factor,
        sourceWidth: sourceNode.mediaNaturalWidth || Math.round(sourceNode.width),
        sourceHeight: sourceNode.mediaNaturalHeight || Math.round(sourceNode.height),
      });
      if (!isNodeGenerationSessionCurrent(node.id, sessionId)) return;
      const taskId = (result as any)?.taskId || (result as any)?.id || "";
      const status = String((result as any)?.status || "").toLowerCase();
      if (status === "processing" && taskId) {
        setNodePatch(node.id, { taskId, taskStatus: "processing", generationState: "processing", generationProgress: 3, ...generationPreparationPatch(result) }); beginNodeProgressSimulation(node.id, "generation");
        await pollTaskUntilDone(taskId, node, sessionId);
        return;
      }
      const ok = await applyTaskResultToNode(node, result, sessionId);
      if (!ok && !isNodeGenerationSessionCurrent(node.id, sessionId)) return;
      setNodePatch(node.id, { imageEnhanceMode: false });
      setActiveImageEnhance((prev) => (prev?.nodeId === node.id ? null : prev));
      setStatus(ok ? "图片高清生成完成" : "图片高清生成失败");
    } catch (error) {
      if (!isNodeGenerationSessionCurrent(node.id, sessionId)) return;
      setNodePatch(node.id, { isGenerating: false, generationState: "idle", taskId: undefined, taskStatus: "failed" });
      finishNodeGenerationSession(node.id, sessionId);
      setStatus(error instanceof Error ? error.message : "图片高清任务提交失败");
    }
  }

function openImageOutpaintEditor(node: NodeData) {
    if (node.type !== "image" || !(node.imageUrl || node.localPreviewUrl)) {
      setStatus("当前图片节点还没有可用画面");
      return;
    }
    closePromptMenus();
    closeImageToolbarMenus();
    setExpanded(false);
    setSelectedNodeIds([node.id]);
    setSelectedEdgeIds([]);
    setActiveNodeId(node.id);
    setActiveImageEnhance(null);
    setActiveImageCrop(null);
    setActiveImageTransform(null);
    setImageCropDragging(null);
    setImageOutpaintDragging(null);
    setActiveImageOutpaint(buildImageOutpaintDraftForRatio(node, "original", activeImageOutpaint?.nodeId === node.id ? activeImageOutpaint : null));
    setStatus("已进入扩图编辑");
  }

async function submitImageOutpaint(node: NodeData) {
    if (!ensureApiKeyReady() || !activeImageOutpaint || activeImageOutpaint.nodeId !== node.id) return;
    let imageUrl = "";
    try {
      imageUrl = await ensureRemoteImageUrlForNode(node);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "图片素材上传失败");
      return;
    }
    if (!imageUrl) {
      setStatus("请先准备可用的图片素材");
      return;
    }
    const preview = getImageOutpaintPreviewMetrics(node, activeImageOutpaint);
    const targetNode = await createDerivedImageNode(node, "扩图", {
      width: preview.width,
      height: preview.height,
      ratio: nearestRatio(preview.naturalWidth, preview.naturalHeight),
      mediaNaturalWidth: preview.naturalWidth,
      mediaNaturalHeight: preview.naturalHeight,
      imageOutpaintMode: true,
      imageOutpaintRatioMode: activeImageOutpaint.ratioMode,
      imageOutpaintResolution: activeImageOutpaint.resolution,
      imageOutpaintCount: activeImageOutpaint.count,
      isGenerating: true,
      generationState: "submitting",
      taskStatus: "processing",
      imageUrl: "",
      localPreviewUrl: undefined,
    });
    const sessionId = beginNodeGenerationSession(targetNode.id);
    setActiveImageOutpaint(null);
    try {
      const result = await api.outpaintImage({
        canvasId: canvasMeta.canvasId || undefined,
        nodeId: targetNode.id,
        imageUrl,
        expandLeft: preview.expandLeft,
        expandRight: preview.expandRight,
        expandTop: preview.expandTop,
        expandBottom: preview.expandBottom,
        ratioMode: activeImageOutpaint.ratioMode,
        resolution: activeImageOutpaint.resolution,
        count: activeImageOutpaint.count,
      });
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      const taskId = (result as any)?.taskId || (result as any)?.id || "";
      const status = String((result as any)?.status || "").toLowerCase();
      if (status === "processing" && taskId) {
        setNodePatch(targetNode.id, { taskId, taskStatus: "processing", generationState: "processing", generationProgress: 3, ...generationPreparationPatch(result) }); beginNodeProgressSimulation(targetNode.id, "generation");
        await pollTaskUntilDone(taskId, targetNode, sessionId);
        return;
      }
      const ok = await applyTaskResultToNode(targetNode, result, sessionId);
      if (!ok && !isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      setNodePatch(targetNode.id, { imageOutpaintMode: false });
      setStatus(ok ? "扩图生成完成" : "扩图生成失败");
    } catch (error) {
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      setNodePatch(targetNode.id, { isGenerating: false, generationState: "idle", taskId: undefined, taskStatus: "failed" });
      finishNodeGenerationSession(targetNode.id, sessionId);
      setStatus(error instanceof Error ? error.message : "扩图任务提交失败");
    }
  }

function openImageCropEditor(node: NodeData) {
    if (node.type !== "image" || !(node.imageUrl || node.localPreviewUrl)) {
      setStatus("当前图片节点还没有可用画面");
      return;
    }
    closePromptMenus();
    closeImageToolbarMenus();
    setExpanded(false);
    setSelectedNodeIds([node.id]);
    setSelectedEdgeIds([]);
    setActiveNodeId(node.id);
    setActiveImageEnhance(null);
    setActiveImageOutpaint(null);
    setActiveImageTransform(null);
    setImageOutpaintDragging(null);
    setImageCropDragging(null);
    setActiveImageCrop(buildImageCropDraftForRatio(node, "original", activeImageCrop?.nodeId === node.id ? activeImageCrop : null));
    setStatus("已进入裁剪编辑");
  }

async function submitImageCrop(node: NodeData) {
    if (!ensureApiKeyReady() || !activeImageCrop || activeImageCrop.nodeId !== node.id) return;
    const projectId = normalizeProjectId(activeProjectContextId);
    if (projectId === null) {
      setStatus("请先选择项目，再裁剪图片");
      return;
    }
    const crop = clampImageCropDraft(activeImageCrop);
    const sourceWidth = Math.max(1, node.mediaNaturalWidth || Math.round(node.width));
    const sourceHeight = Math.max(1, node.mediaNaturalHeight || Math.round(node.height));
    const x1 = Math.max(0, Math.round(sourceWidth * crop.x));
    const y1 = Math.max(0, Math.round(sourceHeight * crop.y));
    const x2 = Math.min(sourceWidth, Math.max(x1 + 1, Math.round(sourceWidth * (crop.x + crop.width))));
    const y2 = Math.min(sourceHeight, Math.max(y1 + 1, Math.round(sourceHeight * (crop.y + crop.height))));
    const naturalWidth = Math.max(1, x2 - x1);
    const naturalHeight = Math.max(1, y2 - y1);
    const dims = mediaToNodeDimensions(naturalWidth, naturalHeight);
    let uploaded: Awaited<ReturnType<typeof api.uploadImage>>;
    try {
      setStatus("正在裁剪并写入项目资产...");
      const croppedFile = await buildCroppedImageFile(node, x1, y1, x2, y2);
      uploaded = await api.uploadImage(croppedFile, { projectId });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "裁剪图片写入项目资产失败");
      return;
    }
    const targetNode = await createDerivedImageNode(node, "裁剪", {
      width: dims.width,
      height: dims.height,
      ratio: nearestRatio(naturalWidth, naturalHeight),
      mediaNaturalWidth: naturalWidth,
      mediaNaturalHeight: naturalHeight,
      imageCropMode: true,
      imageCropRatioMode: crop.ratioMode,
      isGenerating: false,
      generationState: "idle",
      taskStatus: "success",
      imageUrl: uploaded.url,
      primaryImageUrl: uploaded.url,
      referenceAssetUri: uploaded.assetId ? `asset://${uploaded.assetId}` : undefined,
      assetVersionId: uploaded.assetVersionId,
      localPreviewUrl: undefined,
    });
    setActiveImageCrop(null);
    setNodePatch(targetNode.id, { imageCropMode: false });
    window.setTimeout(() => void persistCanvas(), 40);
    setStatus("裁剪完成，结果已写入当前项目资产");
  }

async function submitRemoveImageBackground(sourceNode: NodeData) {
    if (!ensureApiKeyReady() || sourceNode.type !== "image") return;
    let imageUrl = "";
    try {
      imageUrl = await ensureRemoteImageUrlForNode(sourceNode);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "图片素材上传失败");
      return;
    }
    const targetNode = await createDerivedImageNode(sourceNode, "抠图", {
      width: sourceNode.width,
      height: sourceNode.height,
      ratio: sourceNode.ratio,
      mediaNaturalWidth: sourceNode.mediaNaturalWidth || Math.round(sourceNode.width),
      mediaNaturalHeight: sourceNode.mediaNaturalHeight || Math.round(sourceNode.height),
      imageBackgroundRemoveMode: true,
      isGenerating: true,
      generationState: "submitting",
      taskStatus: "processing",
      imageUrl: "",
      localPreviewUrl: undefined,
    });
    const sessionId = beginNodeGenerationSession(targetNode.id);
    try {
      const result = await api.removeImageBackground({
        canvasId: canvasMeta.canvasId || undefined,
        nodeId: targetNode.id,
        imageUrl,
        scene: "general",
      });
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      const ok = await applyTaskResultToNode(targetNode, result, sessionId);
      if (!ok && !isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      setNodePatch(targetNode.id, { imageBackgroundRemoveMode: false });
      setStatus(ok ? "图像背景移除完成" : "图像背景移除失败");
    } catch (error) {
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      setNodePatch(targetNode.id, { isGenerating: false, generationState: "idle", taskId: undefined, taskStatus: "failed" });
      finishNodeGenerationSession(targetNode.id, sessionId);
      setStatus(error instanceof Error ? error.message : "图像背景移除失败");
    }
  }

async function submitImageErase(sourceNode: NodeData, kind: ImageEraseKind) {
    if (!ensureApiKeyReady() || sourceNode.type !== "image") return;
    let imageUrl = "";
    try {
      imageUrl = await ensureRemoteImageUrlForNode(sourceNode);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "图片素材上传失败");
      return;
    }
    let eraseText = "";
    if (kind === "text") {
      eraseText = window.prompt("请输入要擦除的文字", "内部资料")?.trim() || "";
      if (!eraseText) {
        setStatus("已取消文字擦除");
        return;
      }
    }
    const targetNode = await createDerivedImageNode(sourceNode, kind === "icon" ? "擦除图标" : "擦除文字", {
      width: sourceNode.width,
      height: sourceNode.height,
      ratio: sourceNode.ratio,
      mediaNaturalWidth: sourceNode.mediaNaturalWidth || Math.round(sourceNode.width),
      mediaNaturalHeight: sourceNode.mediaNaturalHeight || Math.round(sourceNode.height),
      imageEraseMode: true,
      imageEraseKind: kind,
      imageEraseText: eraseText || undefined,
      isGenerating: true,
      generationState: "submitting",
      taskStatus: "processing",
      imageUrl: "",
      localPreviewUrl: undefined,
    });
    const sessionId = beginNodeGenerationSession(targetNode.id);
    try {
      const result = await api.eraseImage({
        canvasId: canvasMeta.canvasId || undefined,
        nodeId: targetNode.id,
        imageUrl,
        eraseKind: kind,
        eraseText: eraseText || undefined,
      });
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      const ok = await applyTaskResultToNode(targetNode, result, sessionId);
      if (!ok && !isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      setNodePatch(targetNode.id, { imageEraseMode: false });
      setStatus(ok ? "图像擦除修复完成" : "图像擦除修复失败");
    } catch (error) {
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      setNodePatch(targetNode.id, { isGenerating: false, generationState: "idle", taskId: undefined, taskStatus: "failed" });
      finishNodeGenerationSession(targetNode.id, sessionId);
      setStatus(error instanceof Error ? error.message : "图像擦除修复失败");
    }
  }

function openImageTransformEditor(sourceNode: NodeData) {
    if (sourceNode.type !== "image" || !(sourceNode.imageUrl || sourceNode.localPreviewUrl)) {
      setStatus("当前图片节点还没有可用画面");
      return;
    }
    closePromptMenus();
    closeImageToolbarMenus();
    setExpanded(false);
    void createDerivedImageNode(sourceNode, sourceNode.title || "旋转与镜像", {
      width: sourceNode.width,
      height: sourceNode.height,
      ratio: sourceNode.ratio,
      mediaNaturalWidth: sourceNode.mediaNaturalWidth || Math.round(sourceNode.width),
      mediaNaturalHeight: sourceNode.mediaNaturalHeight || Math.round(sourceNode.height),
      imageTransformMode: true,
      imageUrl: sourceNode.imageUrl,
      localPreviewUrl: sourceNode.localPreviewUrl,
      imageRotation: normalizeImageRotation(sourceNode.imageRotation || 0),
      imageFlipX: Boolean(sourceNode.imageFlipX),
      imageFlipY: Boolean(sourceNode.imageFlipY),
    }).then((nextNode) => {
      setActiveImageTransform({
        nodeId: nextNode.id,
        rotation: normalizeImageRotation(nextNode.imageRotation || 0),
        flipX: Boolean(nextNode.imageFlipX),
        flipY: Boolean(nextNode.imageFlipY),
        editingAngle: false,
        angleInput: String(normalizeImageRotation(nextNode.imageRotation || 0)),
      });
      setStatus("已进入旋转与镜像编辑");
    });
  }

function saveImageTransform(node: NodeData) {
    if (!activeImageTransform || activeImageTransform.nodeId !== node.id) return;
    setNodePatch(node.id, {
      imageTransformMode: false,
      imageRotation: normalizeImageRotation(activeImageTransform.rotation),
      imageFlipX: activeImageTransform.flipX,
      imageFlipY: activeImageTransform.flipY,
    });
    setActiveImageTransform(null);
    void persistCanvas();
    setStatus("图片变换已保存");
  }

async function tryBuildMultiAngleShotPlan(sourceNode: NodeData, mode: MultiAngleNineGridMode, context: string) {
    void sourceNode;
    void mode;
    void context;
    return "";
  }

async function submitMultiAngleNineGrid(sourceNode: NodeData) {
    if (!ensureApiKeyReady()) return;
    const sourceUrl = sourceNode.imageUrl || sourceNode.localPreviewUrl;
    if (sourceNode.type !== "image" || !sourceUrl) {
      setStatus("请先准备可用的九宫格参考图");
      return;
    }
    const naturalLongEdge = Math.max(sourceNode.mediaNaturalWidth || 0, sourceNode.mediaNaturalHeight || 0);
    if (naturalLongEdge > 0 && naturalLongEdge < 512) {
      setStatus("参考图过小，多机位主体识别不足，请换一张更清晰的参考图");
      return;
    }

    setImageNineGridMenuNodeId(null);
    setImageGridMenuNodeId(null);
    setImageGridCustomMenuNodeId(null);
    setImageGridCustomPreview(null);

    const upstreamTextPrompts = edges
      .filter((edge) => edge.toNodeId === sourceNode.id)
      .map((edge) => nodeMap.get(edge.fromNodeId))
      .filter((node): node is NodeData => Boolean(node && node.type === "text"))
      .map((node) => getNodeTextContent(node))
      .filter(Boolean);
    const contextParts = [sourceNode.title, sourceNode.prompt, sourceNode.fileName, ...upstreamTextPrompts];
    const context = contextParts.filter(Boolean).join("\n");
    const mode = detectMultiAngleNineGridMode(context, sourceNode);
    const selectedSourceModel = findSelectableCatalogModel("image", sourceNode.model);
    const imageCatalogModel = preflightCanvasModel("image", selectedSourceModel?.id, { allowCatalogDefault: true });
    if (!imageCatalogModel) return;
    const imageQuality = resolveCanvasImageQuality(imageCatalogModel, "2K");
    const projectId = normalizeProjectId(activeProjectContextId);
    const sourceAssetVersionId = Number(sourceNode.assetVersionId);
    if (!imageQuality) {
      setStatus(`${imageCatalogModel.name} 未声明可用图片清晰度，已阻止提交`);
      return;
    }
    if (projectId === null || !Number.isSafeInteger(sourceAssetVersionId) || sourceAssetVersionId <= 0) {
      setStatus("九宫格参考图尚未写入当前项目资产版本，请重新上传后再生成");
      return;
    }
    setStatus("多机位九宫格脚本准备中...");
    const shotPlan = await tryBuildMultiAngleShotPlan(sourceNode, mode, context);
    const prompt = buildMultiAngleNineGridPrompt(sourceNode, mode, context, shotPlan);
    const candidateModels = [imageCatalogModel.id];
    const initialModel = imageCatalogModel.id;
    const targetNode = await createDerivedImageNode(sourceNode, "多机位九宫格", {
      ...create16x9DerivedImagePatch(sourceNode),
      prompt,
      model: initialModel,
      resolution: "2K",
      quantity: "1x",
      maxImages: 1,
      price: catalogModelPriceText(imageCatalogModel),
    });

    const sessionId = beginNodeGenerationSession(targetNode.id);
    flushSync(() => {
      setNodePatch(targetNode.id, { isGenerating: true, generationState: "submitting", taskStatus: "processing", taskId: undefined, generationProgress: 1 });
      setStatus(mode === "product" ? "多机位九宫格生成中：产品摄影..." : mode === "scene" ? "多机位九宫格生成中：场景空间..." : "多机位九宫格生成中：人物叙事...");
    });

    const payload: Record<string, any> = {
      mediaType: "image",
      projectId,
      prompt,
      count: 1,
      quality: imageQuality,
      ratio: getImageRequestRatio(targetNode),
      references: [{ assetVersionId: String(sourceAssetVersionId), role: "subject" }],
    };

    try {
      let result: any = null;
      let usedModel = initialModel;
      let lastUnsupportedError: Error | null = null;
      for (const modelId of candidateModels) {
        try {
          usedModel = modelId;
          result = await api.generateNode({ ...payload, model: modelId });
          lastUnsupportedError = null;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error || "");
          if (/unsupported model/i.test(message)) {
            lastUnsupportedError = error instanceof Error ? error : new Error(message);
            continue;
          }
          throw error;
        }
      }
      if (!result) {
        throw lastUnsupportedError || new Error("多机位九宫格生成失败");
      }
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      setNodePatch(targetNode.id, { model: usedModel });
      const taskId = (result as any)?.taskId || (result as any)?.id || "";
      const status = String((result as any)?.status || "").toLowerCase();
      flushSync(() => {
        setNodePatch(targetNode.id, { generationState: "processing", generationProgress: 3, ...generationPreparationPatch(result) });
      });
      beginNodeProgressSimulation(targetNode.id, "generation");

      if (status === "processing" && taskId) {
        setNodePatch(targetNode.id, { taskId, taskStatus: "processing", generationState: "processing", generationProgress: 3, ...generationPreparationPatch(result) }); beginNodeProgressSimulation(targetNode.id, "generation");
        await pollTaskUntilDone(taskId, targetNode, sessionId);
        return;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 260));
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      const ok = await applyTaskResultToNode(targetNode, result, sessionId);
      if (!ok && !isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      setStatus(ok ? "多机位九宫格生成完成" : "多机位九宫格生成失败");
    } catch (error) {
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      setNodePatch(targetNode.id, { isGenerating: false, generationState: "idle", taskId: undefined, taskStatus: "failed" });
      finishNodeGenerationSession(targetNode.id, sessionId);
      setStatus(error instanceof Error ? error.message : "多机位九宫格生成失败");
    }
  }

function collectReferenceDesignContext(sourceNode: NodeData) {
    const upstreamTextPrompts = edges
      .filter((edge) => edge.toNodeId === sourceNode.id)
      .map((edge) => nodeMap.get(edge.fromNodeId))
      .filter((node): node is NodeData => Boolean(node && node.type === "text"))
      .map((node) => getNodeTextContent(node))
      .filter(Boolean);
    const contextParts = [sourceNode.title, sourceNode.prompt, sourceNode.fileName, ...upstreamTextPrompts];
    return contextParts.filter(Boolean).join("\n");
  }

async function submitReferenceDesignSheet(
    sourceNode: NodeData,
    title: string,
    prompt: string,
    statusLabel: string,
    emptyStatus: string,
    smallStatus: string,
  ) {
    if (!ensureApiKeyReady()) return;
    const sourceUrl = sourceNode.imageUrl || sourceNode.localPreviewUrl;
    if (sourceNode.type !== "image" || !sourceUrl) {
      setStatus(emptyStatus);
      return;
    }
    const naturalLongEdge = Math.max(sourceNode.mediaNaturalWidth || 0, sourceNode.mediaNaturalHeight || 0);
    if (naturalLongEdge > 0 && naturalLongEdge < 512) {
      setStatus(smallStatus);
      return;
    }

    setImageNineGridMenuNodeId(null);
    setImageGridMenuNodeId(null);
    setImageGridCustomMenuNodeId(null);
    setImageGridCustomPreview(null);

    const selectedSourceModel = findSelectableCatalogModel("image", sourceNode.model);
    const imageCatalogModel = preflightCanvasModel("image", selectedSourceModel?.id, { allowCatalogDefault: true });
    if (!imageCatalogModel) return;
    const imageQuality = resolveCanvasImageQuality(imageCatalogModel, "2K");
    const projectId = normalizeProjectId(activeProjectContextId);
    const sourceAssetVersionId = Number(sourceNode.assetVersionId);
    if (!imageQuality) {
      setStatus(`${imageCatalogModel.name} 未声明可用图片清晰度，已阻止提交`);
      return;
    }
    if (projectId === null || !Number.isSafeInteger(sourceAssetVersionId) || sourceAssetVersionId <= 0) {
      setStatus(`${statusLabel}参考图尚未写入当前项目资产版本，请重新上传后再生成`);
      return;
    }
    const candidateModels = [imageCatalogModel.id];
    const initialModel = imageCatalogModel.id;
    const targetNode = await createDerivedImageNode(sourceNode, title, {
      ...create16x9DerivedImagePatch(sourceNode),
      prompt,
      model: initialModel,
      resolution: "2K",
      quantity: "1x",
      maxImages: 1,
      price: catalogModelPriceText(imageCatalogModel),
    });

    const sessionId = beginNodeGenerationSession(targetNode.id);
    flushSync(() => {
      setNodePatch(targetNode.id, { isGenerating: true, generationState: "submitting", taskStatus: "processing", taskId: undefined, generationProgress: 1 });
      setStatus(`${statusLabel}生成中...`);
    });

    const payload: Record<string, any> = {
      mediaType: "image",
      projectId,
      prompt,
      count: 1,
      quality: imageQuality,
      ratio: getImageRequestRatio(targetNode),
      references: [{ assetVersionId: String(sourceAssetVersionId), role: "subject" }],
    };

    try {
      let result: any = null;
      let usedModel = initialModel;
      let lastUnsupportedError: Error | null = null;
      for (const modelId of candidateModels) {
        try {
          usedModel = modelId;
          result = await api.generateNode({ ...payload, model: modelId });
          lastUnsupportedError = null;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error || "");
          if (/unsupported model/i.test(message)) {
            lastUnsupportedError = error instanceof Error ? error : new Error(message);
            continue;
          }
          throw error;
        }
      }
      if (!result) {
        throw lastUnsupportedError || new Error(`${statusLabel}生成失败`);
      }
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      setNodePatch(targetNode.id, { model: usedModel });
      const taskId = (result as any)?.taskId || (result as any)?.id || "";
      const status = String((result as any)?.status || "").toLowerCase();
      flushSync(() => {
        setNodePatch(targetNode.id, { generationState: "processing" });
      });

      if (status === "processing" && taskId) {
        setNodePatch(targetNode.id, { taskId, taskStatus: "processing", generationState: "processing", generationProgress: 3, ...generationPreparationPatch(result) }); beginNodeProgressSimulation(targetNode.id, "generation");
        await pollTaskUntilDone(taskId, targetNode, sessionId);
        return;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 260));
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      const ok = await applyTaskResultToNode(targetNode, result, sessionId);
      if (!ok && !isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      setStatus(ok ? `${statusLabel}生成完成` : `${statusLabel}生成失败`);
    } catch (error) {
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      setNodePatch(targetNode.id, { isGenerating: false, generationState: "idle", taskId: undefined, taskStatus: "failed" });
      finishNodeGenerationSession(targetNode.id, sessionId);
      setStatus(error instanceof Error ? error.message : `${statusLabel}生成失败`);
    }
  }

async function submitSceneSheet(sourceNode: NodeData) {
    const context = collectReferenceDesignContext(sourceNode);
    await submitReferenceDesignSheet(
      sourceNode,
      "场景设定图",
      buildSceneSheetPrompt(sourceNode, context),
      "场景设定图",
      "请先准备可用的场景参考图",
      "参考图过小，场景主体识别不足，请换一张更清晰的参考图",
    );
  }

async function submitCharacterSheet(sourceNode: NodeData) {
    const context = collectReferenceDesignContext(sourceNode);
    await submitReferenceDesignSheet(
      sourceNode,
      "角色设定图",
      buildCharacterSheetPrompt(sourceNode, context),
      "角色设定图",
      "请先准备可用的人物参考图",
      "参考图过小，人物主体识别不足，请换一张更清晰的参考图",
    );
  }

async function submitProductSheet(sourceNode: NodeData) {
    const context = collectReferenceDesignContext(sourceNode);
    const mode = detectProductSheetMode(context, sourceNode);
    await submitReferenceDesignSheet(
      sourceNode,
      "产品设定图",
      buildProductSheetPrompt(sourceNode, mode, context),
      mode === "appearance" ? "产品设定图：外观卖点型" : mode === "structure" ? "产品设定图：结构工艺型" : "产品设定图",
      "请先准备可用的产品参考图",
      "参考图过小，产品主体识别不足，请换一张更清晰的产品图",
    );
  }

async function submitCinematicLighting(sourceNode: NodeData) {
    const context = collectReferenceDesignContext(sourceNode);
    await submitReferenceDesignSheet(
      sourceNode,
      "电影级光影校正",
      buildCinematicLightingPrompt(sourceNode, context),
      "电影级光影校正",
      "请先准备可用的图片参考图",
      "参考图过小，光影校正主体识别不足，请换一张更清晰的参考图",
    );
  }

async function submitStoryboard25Grid(sourceNode: NodeData) {
    const context = collectReferenceDesignContext(sourceNode);
    const mode = detectMultiAngleNineGridMode(context, sourceNode);
    await submitReferenceDesignSheet(
      sourceNode,
      "25宫格连贯分镜",
      buildStoryboard25GridPrompt(sourceNode, mode, context),
      "25宫格连贯分镜",
      "请先准备可用的25宫格参考图",
      "参考图过小，25宫格主体识别不足，请换一张更清晰的参考图",
    );
  }

async function submitCharacterThreeView(sourceNode: NodeData, mode: CharacterThreeViewMode) {
    if (!ensureApiKeyReady()) return;
    const sourceUrl = sourceNode.imageUrl || sourceNode.localPreviewUrl;
    if (sourceNode.type !== "image" || !sourceUrl) {
      setStatus(mode === "face" ? "请先准备可用的人物参考图" : "请先准备可用的角色参考图");
      return;
    }
    const naturalLongEdge = Math.max(sourceNode.mediaNaturalWidth || 0, sourceNode.mediaNaturalHeight || 0);
    if (naturalLongEdge > 0 && naturalLongEdge < 512) {
      setStatus("参考图过小，角色主体识别不足，请换一张更清晰的角色图");
      return;
    }

    setImageNineGridMenuNodeId(null);
    setImageGridMenuNodeId(null);
    setImageGridCustomMenuNodeId(null);
    setImageGridCustomPreview(null);

    const upstreamTextPrompts = edges
      .filter((edge) => edge.toNodeId === sourceNode.id)
      .map((edge) => nodeMap.get(edge.fromNodeId))
      .filter((node): node is NodeData => Boolean(node && node.type === "text"))
      .map((node) => getNodeTextContent(node))
      .filter(Boolean);
    const contextParts = [sourceNode.title, sourceNode.prompt, sourceNode.fileName, ...upstreamTextPrompts];
    const context = contextParts.filter(Boolean).join("\n");
    const prompt = buildCharacterThreeViewPrompt(sourceNode, mode, context);
    const title = mode === "face" ? "角色脸部三视图" : "角色三视图";
    const selectedSourceModel = findSelectableCatalogModel("image", sourceNode.model);
    const imageCatalogModel = preflightCanvasModel("image", selectedSourceModel?.id, { allowCatalogDefault: true });
    if (!imageCatalogModel) return;
    const imageQuality = resolveCanvasImageQuality(imageCatalogModel, "2K");
    if (!imageQuality) {
      setStatus(`${imageCatalogModel.name} 未声明可用图片清晰度，已阻止提交`);
      return;
    }
    const candidateModels = [imageCatalogModel.id];
    const initialModel = imageCatalogModel.id;
    const layoutPatch = mode === "full" ? create2x1DerivedImagePatch(sourceNode) : create16x9DerivedImagePatch(sourceNode);
    const targetNode = await createDerivedImageNode(sourceNode, title, {
      ...layoutPatch,
      prompt,
      model: initialModel,
      ratio: mode === "full" ? "2:1" : "16:9",
      resolution: "2K",
      quantity: "1x",
      maxImages: 1,
      price: catalogModelPriceText(imageCatalogModel),
    });

    const sessionId = beginNodeGenerationSession(targetNode.id);
    flushSync(() => {
      setNodePatch(targetNode.id, { isGenerating: true, generationState: "submitting", taskStatus: "processing", taskId: undefined, generationProgress: 1 });
      setStatus(mode === "face" ? "角色脸部三视图生成中..." : "角色三视图生成中...");
    });

    let remoteImageUrl = "";
    try {
      remoteImageUrl = await resolveNodeRemoteReferenceUrl(sourceNode);
    } catch (error) {
      setNodePatch(targetNode.id, { isGenerating: false, generationState: "idle", taskId: undefined, taskStatus: "failed" });
      finishNodeGenerationSession(targetNode.id, sessionId);
      setStatus(error instanceof Error ? error.message : "角色参考图上传失败");
      return;
    }
    if (!remoteImageUrl) {
      setNodePatch(targetNode.id, { isGenerating: false, generationState: "idle", taskId: undefined, taskStatus: "failed" });
      finishNodeGenerationSession(targetNode.id, sessionId);
      setStatus("请先准备可用的角色参考图");
      return;
    }
    const projectId = normalizeProjectId(activeProjectContextId);
    const sourceAssetVersionId = Number(sourceNode.assetVersionId);
    if (projectId === null || !Number.isSafeInteger(sourceAssetVersionId) || sourceAssetVersionId <= 0) {
      setNodePatch(targetNode.id, { isGenerating: false, generationState: "idle", taskId: undefined, taskStatus: "failed" });
      finishNodeGenerationSession(targetNode.id, sessionId);
      setStatus("角色参考图尚未写入当前项目资产版本，请重新上传后再生成");
      return;
    }

    const payload: Record<string, any> = {
      mediaType: "image",
      projectId,
      prompt,
      count: 1,
      quality: imageQuality,
      ratio: getImageRequestRatio(targetNode),
      references: [{ assetVersionId: String(sourceAssetVersionId), role: "subject" }],
    };

    try {
      let result: any = null;
      let usedModel = initialModel;
      let lastUnsupportedError: Error | null = null;
      for (const modelId of candidateModels) {
        try {
          usedModel = modelId;
          result = await api.generateNode({ ...payload, model: modelId });
          lastUnsupportedError = null;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error || "");
          if (/unsupported model/i.test(message)) {
            lastUnsupportedError = error instanceof Error ? error : new Error(message);
            continue;
          }
          throw error;
        }
      }
      if (!result) {
        throw lastUnsupportedError || new Error("角色三视图生成失败");
      }
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      setNodePatch(targetNode.id, { model: usedModel });
      const taskId = (result as any)?.taskId || (result as any)?.id || "";
      const status = String((result as any)?.status || "").toLowerCase();
      flushSync(() => {
        setNodePatch(targetNode.id, { generationState: "processing" });
      });

      if (status === "processing" && taskId) {
        setNodePatch(targetNode.id, { taskId, taskStatus: "processing", generationState: "processing", generationProgress: 3, ...generationPreparationPatch(result) }); beginNodeProgressSimulation(targetNode.id, "generation");
        await pollTaskUntilDone(taskId, targetNode, sessionId);
        return;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 260));
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      const ok = await applyTaskResultToNode(targetNode, result, sessionId);
      if (!ok && !isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      setStatus(ok ? `${title}生成完成` : `${title}生成失败`);
    } catch (error) {
      if (!isNodeGenerationSessionCurrent(targetNode.id, sessionId)) return;
      setNodePatch(targetNode.id, { isGenerating: false, generationState: "idle", taskId: undefined, taskStatus: "failed" });
      finishNodeGenerationSession(targetNode.id, sessionId);
      setStatus(error instanceof Error ? error.message : `${title}生成失败`);
    }
  }

function startQuickCharacterThreeView() {
    const portraitId = `character_reference_${Date.now()}`;
    const portrait: NodeData = {
      ...createNode(portraitId, "image", 0, 0),
      title: "角色参考图",
      titleCustomized: true,
      x: -260,
      y: -146,
      width: 520,
      height: 292,
      ratio: "16:9",
      prompt: "",
      model: baseModel("image"),
      resolution: "2K",
    };
    setNodes([portrait]);
    setEdges([]);
    setGroups([]);
    setSelectedNodeIds([portraitId]);
    setSelectedEdgeIds([]);
    setActiveNodeId(portraitId);
    setActiveGroupId(null);
    imageToImageUploadPresetRef.current = null;
    setNodeSerialCounter((prev) => ({ ...prev, image: Math.max(prev.image || 0, 1) }));
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const usableLayout = getCanvasUsableLayout(rect.width, assetManagerOpen);
      const visualScale = Math.min(1, Math.max(0.58, (usableLayout.width * 0.4) / portrait.width));
      const nextScale = visualScale / CANVAS_VISUAL_SCALE;
      const centerX = portrait.x + portrait.width / 2;
      const centerY = portrait.y + portrait.height / 2;
      setViewport({ scale: nextScale, panX: usableLayout.centerX - centerX * visualScale, panY: rect.height / 2 - centerY * visualScale });
    }
    setStatus("请上传真实角色参考图，上传后可生成角色三视图");
    void persistCanvas([portrait], [], canvasMeta.name, []);
    window.setTimeout(() => fileInputRef.current?.click(), 0);
  }
  return { createDerivedImageNode, create16x9DerivedImagePatch, create2x1DerivedImagePatch, openImageEnhanceEditor, submitImageEnhance, openImageOutpaintEditor, submitImageOutpaint, openImageCropEditor, submitImageCrop, submitRemoveImageBackground, submitImageErase, openImageTransformEditor, saveImageTransform, tryBuildMultiAngleShotPlan, submitMultiAngleNineGrid, collectReferenceDesignContext, submitReferenceDesignSheet, submitSceneSheet, submitCharacterSheet, submitProductSheet, submitCinematicLighting, submitStoryboard25Grid, submitCharacterThreeView, startQuickCharacterThreeView };
}
