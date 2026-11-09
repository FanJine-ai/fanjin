import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { getNodeModelType, normalizeNodeRatioForModel, normalizeImageResolutionForModel, isAiModelSelectable, getAiModelUnavailableMessage, normalizeVideoResolutionForModel, parseDurationSecondsValue, getVideoModeForTab } from "./canvasModelDefinitions";
import type { CanvasModelType, ModelCatalogState, NodeData, EdgeData, GroupData, VideoGenerationMode } from "./canvasDataTypes";
import type { RatioKey } from "./canvasMediaTypes";
import { ratioToNodeDimensions, nearestRatio, mediaToNodeDimensions } from "./canvasMediaGeometry";
import { requiredVideoRatio, type VideoOutputFormat } from "../../features/quick-create/videoOutputContract";
import { getPortraitAdmission, registerPortraitAsset } from "../../features/portrait-admission/api";
import { normalizeNodeMaxImages } from "./canvasImageOutputCount";
import { getCanvasCatalogAspectRatios, getCanvasCatalogVideoDefaultOutputFormat, getCanvasCatalogVideoOutputFormats, getCanvasCatalogVideoModes, isCanvasCatalogVideoModeSupported, normalizeCanvasCatalogVideoDuration, normalizeCanvasCatalogVideoAudio, type CanvasCatalogVideoMode } from "./canvasCatalogContract";
import { isCanvasSourceVideoMode } from "./canvasVideoExtension";
import { type AiModelOption } from "@/lib/api";
import { normalizeProjectId } from "@/stores/projectStore";
import { pickDefaultCatalogModel } from "./modelCatalog";
import { catalogModelPriceText } from "./canvasPricing";

export interface CanvasModelSettingsControllerDependencies {
  edges: EdgeData[];
  nodeMap: Map<string, NodeData>;
  activeNode: NodeData | null;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  activeNodeModelOption: AiModelOption | undefined;
  localGeometryEditUntilRef: RefObject<Record<string, number>>;
  nodes: NodeData[];
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  selectedNodeIds: string[];
  videoPromptTab: "文生视频" | "全能参考" | "图生视频" | "首尾帧" | "图片参考" | "延长视频" | "修改视频";
  setStatus: Dispatch<SetStateAction<string>>;
  modelCatalogState: ModelCatalogState;
  models: AiModelOption[];
  setModelOpen: Dispatch<SetStateAction<boolean>>;
  modelCatalogError: string;
  activeProjectContextId: string | null;
  nodesRef: RefObject<NodeData[]>;
}

export function createCanvasModelSettingsController(deps: CanvasModelSettingsControllerDependencies) {
  const { edges, nodeMap, activeNode, setNodePatch, activeNodeModelOption, localGeometryEditUntilRef, nodes, setNodes, persistCanvas, selectedNodeIds, videoPromptTab, setStatus, modelCatalogState, models, setModelOpen, modelCatalogError, activeProjectContextId, nodesRef } = deps;
function collectUpstreamImageUrls(nodeId: string) {
    return edges
      .filter((edge) => edge.toNodeId === nodeId)
      .map((edge) => nodeMap.get(edge.fromNodeId))
      .filter((node): node is NodeData => Boolean(node))
      .map((node) => node.imageUrl || "")
      .filter((url) => Boolean(url));
  }

function inferVideoRatioFromImageReferences(referenceNodes: NodeData[]): RatioKey | null {
    const imageReference = referenceNodes.find((node) => node.type === "image" && (node.mediaNaturalWidth || node.width) && (node.mediaNaturalHeight || node.height));
    if (!imageReference) return null;
    return nearestRatio(
      Math.max(1, Number(imageReference.mediaNaturalWidth || imageReference.width)),
      Math.max(1, Number(imageReference.mediaNaturalHeight || imageReference.height)),
    );
  }

function getImageNodeGeometry(node: NodeData | null | undefined) {
    if (!node || node.type !== "image") return null;
    const width = Math.max(1, Number(node.mediaNaturalWidth || node.width || 0));
    const height = Math.max(1, Number(node.mediaNaturalHeight || node.height || 0));
    if (!width || !height) return null;
    const dims = mediaToNodeDimensions(width, height);
    return {
      width,
      height,
      ratio: nearestRatio(width, height),
      nodeWidth: dims.width,
      nodeHeight: dims.height,
    };
  }

function inferImageReferenceGeometry(referenceNodes: NodeData[]) {
    const imageReference = referenceNodes.find((node) => node.type === "image" && (node.mediaNaturalWidth || node.width) && (node.mediaNaturalHeight || node.height));
    return getImageNodeGeometry(imageReference);
  }

function shouldInheritVideoRatioFromReference(mode: VideoGenerationMode, node: NodeData, inferredRatio: RatioKey | null) {
    if (!inferredRatio || inferredRatio === "auto") return false;
    if (node.type !== "video") return false;
    if (!["image_to_video", "image_reference", "omni_reference"].includes(mode)) return false;
    return node.ratio === "auto";
  }

function parseDurationSeconds(raw?: string) {
    return parseDurationSecondsValue(raw);
  }

function formatDurationLabel(seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
    if (Math.abs(seconds - Math.round(seconds)) < 0.001) return `${Math.round(seconds)}s`;
    return `${seconds.toFixed(2).replace(/\.?0+$/, "")}s`;
  }

function setActiveNodeResolution(next: "1K" | "2K" | "4K") {
    if (!activeNode) return;
    setNodePatch(activeNode.id, { resolution: next });
  }

function setActiveNodeResolutionGeneric(next: string) {
    if (!activeNode) return;
    setNodePatch(activeNode.id, { resolution: normalizeVideoResolutionForModel(activeNode.model, next, activeNodeModelOption) });
  }

function setActiveNodeRatio(nextRatio: RatioKey) {
    if (!activeNode) return;
    // Videos with a result still get a matching frame — never keep a landscape
    // box under a 9:16 clip.
    const nextDims = ratioToNodeDimensions(nextRatio, activeNode.type);
    localGeometryEditUntilRef.current[activeNode.id] = Date.now() + 5000;
    const nextNodes = nodes.map((node) =>
        node.id === activeNode.id
          ? {
              ...node,
              ratio: nextRatio,
              x: node.x + (node.width - nextDims.width) / 2,
              y: node.y + (node.height - nextDims.height) / 2,
              width: nextDims.width,
              height: nextDims.height,
            }
          : node,
      );
    setNodes(nextNodes);
    void persistCanvas(nextNodes, edges);
  }

function resetSelectedExpandedTextNodes() {
    if (!selectedNodeIds.length) return false;
    const selected = new Set(selectedNodeIds);
    let changed = false;
    const nextNodes = nodes.map((node) => {
      if (node.type !== "text" || !selected.has(node.id)) return node;
      if (node.textExpanded) return node;
      const dims = ratioToNodeDimensions(node.ratio || "1:1", "text");
      if (node.width <= dims.width + 1 && node.height <= dims.height + 1) return node;
      changed = true;
      const centerX = node.x + node.width / 2;
      const centerY = node.y + node.height / 2;
      return {
        ...node,
        width: dims.width,
        height: dims.height,
        x: centerX - dims.width / 2,
        y: centerY - dims.height / 2,
      };
    });
    if (!changed) return false;
    setNodes(nextNodes);
    void persistCanvas(nextNodes, edges);
    return true;
  }

function setActiveNodeDuration(nextSeconds: number) {
    if (!activeNode || activeNode.type !== "video" || !activeNodeModelOption) return;
    const persistedMode = activeNode.videoMode as CanvasCatalogVideoMode;
    const mode = isCanvasCatalogVideoModeSupported(activeNodeModelOption, persistedMode)
      ? persistedMode
      : getVideoModeForTab(videoPromptTab);
    const normalized = normalizeCanvasCatalogVideoDuration(
      activeNodeModelOption,
      mode,
      nextSeconds,
    );
    if (normalized === null) {
      setStatus("所选模型目录未声明当前模式的视频时长");
      return;
    }
    setNodePatch(activeNode.id, { duration: String(normalized) });
  }

function setActiveNodeGenerateAudio(enabled: boolean) {
    if (!activeNode) return;
    setNodePatch(activeNode.id, { videoGenerateAudio: normalizeCanvasCatalogVideoAudio(activeNodeModelOption, enabled) });
  }

function findSelectableCatalogModel(modelType: CanvasModelType, modelId?: string) {
    if (modelCatalogState !== "ready") return undefined;
    const normalizedId = String(modelId || "").trim();
    if (!normalizedId) return undefined;
    return models.find(
      (model) => model.type === modelType && model.id === normalizedId && isAiModelSelectable(model),
    );
  }

function preflightCanvasModel(
    modelType: CanvasModelType,
    requestedModelId?: string,
    options: { allowCatalogDefault?: boolean; openPicker?: boolean } = {},
  ): AiModelOption | null {
    const openPicker = () => {
      if (options.openPicker) setModelOpen(true);
    };
    if (modelCatalogState === "loading") {
      setStatus("模型目录仍在加载，请稍后再试");
      openPicker();
      return null;
    }
    if (modelCatalogState === "failed") {
      setStatus(modelCatalogError || "模型目录不可用，已阻止生成任务");
      openPicker();
      return null;
    }
    if (modelCatalogState === "empty") {
      setStatus("当前工作区尚未配置可用模型，已阻止生成任务");
      openPicker();
      return null;
    }

    const normalizedId = String(requestedModelId || "").trim();
    if (normalizedId) {
      const catalogModel = models.find((model) => model.type === modelType && model.id === normalizedId);
      if (!catalogModel) {
        setStatus("当前模型不在可用目录中，请先重新选择模型");
        openPicker();
        return null;
      }
      if (!isAiModelSelectable(catalogModel)) {
        setStatus(getAiModelUnavailableMessage(catalogModel));
        openPicker();
        return null;
      }
      return catalogModel;
    }

    if (options.allowCatalogDefault) {
      const catalogDefault = pickDefaultCatalogModel(models.filter((model) => isAiModelSelectable(model)), modelType);
      if (catalogDefault) return catalogDefault;
    }

    setStatus("没有可提交的目录模型，请先配置或选择模型");
    openPicker();
    return null;
  }

function setActiveNodeModel(model: AiModelOption) {
    if (!activeNode) return;
    if (isCanvasSourceVideoMode(activeNode.videoMode) && !isCanvasCatalogVideoModeSupported(model, activeNode.videoMode!)) {
      setStatus("请选择支持当前原生视频操作的模型");
      return;
    }
    const catalogModel = preflightCanvasModel(getNodeModelType(activeNode.type), model.id);
    if (!catalogModel) return;
    const patch: Partial<NodeData> = {
      model: catalogModel.id,
      price: catalogModelPriceText(catalogModel),
    };
    if (activeNode.type === "video") {
      patch.resolution = normalizeVideoResolutionForModel(catalogModel.id, activeNode.resolution, catalogModel);
      patch.ratio = normalizeNodeRatioForModel(catalogModel, activeNode.ratio);
      patch.videoOutputFormat = getCanvasCatalogVideoOutputFormats(catalogModel).includes(activeNode.videoOutputFormat as VideoOutputFormat)
        ? activeNode.videoOutputFormat : getCanvasCatalogVideoDefaultOutputFormat(catalogModel);
      const supportedModes = getCanvasCatalogVideoModes(catalogModel);
      const nextMode = isCanvasCatalogVideoModeSupported(catalogModel, activeNode.videoMode || "")
        ? activeNode.videoMode as CanvasCatalogVideoMode
        : supportedModes[0];
      if (nextMode) {
        patch.videoMode = nextMode;
        if (requiredVideoRatio(catalogModel.id, nextMode) && getCanvasCatalogAspectRatios(catalogModel).includes("adaptive")) patch.ratio = "auto";
        const duration = normalizeCanvasCatalogVideoDuration(
          catalogModel,
          nextMode,
          parseDurationSeconds(activeNode.duration),
        );
        if (duration !== null) patch.duration = String(duration);
      }
    }
    if (activeNode.type === "image") {
      patch.resolution = normalizeImageResolutionForModel(catalogModel, activeNode.resolution);
      patch.ratio = normalizeNodeRatioForModel(catalogModel, activeNode.ratio);
      patch.maxImages = normalizeNodeMaxImages(activeNode.maxImages, catalogModel);
      patch.quantity = `${patch.maxImages}x`;
    }
    setNodePatch(activeNode.id, patch);
    if (activeNode.type === "video") {
      const projectId = normalizeProjectId(activeProjectContextId);
      if (projectId !== null) {
        const nodeById = new Map(nodesRef.current.map((node) => [node.id, node]));
        const assetVersionIds = Array.from(new Set(edges
          .filter((edge) => edge.toNodeId === activeNode.id && edge.relationship !== "draft_final")
          .map((edge) => Number(nodeById.get(edge.fromNodeId)?.assetVersionId))
          .filter((id) => Number.isSafeInteger(id) && id > 0)));
        // Model selection prewarms that channel's existing portrait bindings.
        // The submit gate repeats the check and resumes automatically if sync
        // is still running; no provider IDs or asset-library choice reach UI.
        void Promise.allSettled(assetVersionIds.map(async (assetVersionId) => {
          const admission = await getPortraitAdmission(projectId, assetVersionId);
          if (!["real_person", "virtual_person", "trusted_output", "detected_person"]
            .includes(admission.subjectKind) || admission.complianceState !== "allowed") return;
          await registerPortraitAsset({
            projectId,
            assetVersionId,
            revision: admission.revision,
            model: catalogModel.id,
          });
        }));
      }
    }
  }
  return { collectUpstreamImageUrls, inferVideoRatioFromImageReferences, getImageNodeGeometry, inferImageReferenceGeometry, shouldInheritVideoRatioFromReference, parseDurationSeconds, formatDurationLabel, setActiveNodeResolution, setActiveNodeResolutionGeneric, setActiveNodeRatio, resetSelectedExpandedTextNodes, setActiveNodeDuration, setActiveNodeGenerateAudio, findSelectableCatalogModel, preflightCanvasModel, setActiveNodeModel };
}
