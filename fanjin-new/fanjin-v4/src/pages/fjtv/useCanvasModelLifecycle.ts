import { useEffect, type DependencyList, type Dispatch, type SetStateAction, type RefObject, type ReactNode, type JSX } from "react";
import type { ModelCatalogState, NodeData } from "./canvasDataTypes";
import type { NodeType, RatioKey } from "./canvasMediaTypes";
import { requiredVideoRatio } from "../../features/quick-create/videoOutputContract";
import { getPortraitVideoRoutePolicy, type PortraitVideoRoutePolicy } from "../../features/portrait-admission/api";
import { CANVAS_REAL_CAPABILITIES, resolveCanvasRealCapabilities, type CanvasActionDirectory, type CanvasRealCapabilities } from "./canvasCapabilities";
import { getCanvasCatalogAspectRatios, getCanvasCatalogVideoDefaultOutputFormat, getCanvasCatalogVideoOutputFormats, getCanvasCatalogVideoModes, isCanvasCatalogVideoModeSupported, normalizeCanvasCatalogVideoDuration, normalizeCanvasCatalogVideoAudio, normalizeCanvasCatalogVideoResolution, type CanvasCatalogImageQuality, type CanvasCatalogVideoMode } from "./canvasCatalogContract";
import { isCanvasSourceVideoMode } from "./canvasVideoExtension";
import { api, type AiModelOption } from "@/lib/api";
import { toApiErrorView } from "@/api/http";
import { normalizeProjectId } from "@/stores/projectStore";
import { loadModelCatalogFromApi, pickDefaultCatalogModel } from "./modelCatalog";
import { catalogModelPriceText } from "./canvasPricing";

interface UseCanvasCapabilitiesContext {
  setCanvasCapabilities: Dispatch<SetStateAction<CanvasRealCapabilities>>;
}

export function useCanvasCapabilities(readContext: () => UseCanvasCapabilitiesContext, dependencies: DependencyList) {
  useEffect(() => {
    const { setCanvasCapabilities } = readContext();

    let current = true;
    void api.canvasCapabilities()
      .then((directory) => {
        if (!current) return;
        setCanvasCapabilities(resolveCanvasRealCapabilities(
          directory as CanvasActionDirectory,
        ));
      })
      .catch(() => {
        if (current) setCanvasCapabilities({ ...CANVAS_REAL_CAPABILITIES });
      });
    return () => {
      current = false;
    };

  }, dependencies);
}

interface UseCanvasVideoModelNormalizationContext {
  activeNode: NodeData | null;
  activeNodeModelOption: AiModelOption | undefined;
  normalizeVideoResolutionForModel: (modelId: string | undefined, value: string | undefined, model?: AiModelOption) => string;
  normalizeNodeRatioForModel: (model: AiModelOption | null | undefined, ratio: RatioKey) => RatioKey;
  parseDurationSecondsValue: (raw?: string) => number;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
}

export function useCanvasVideoModelNormalization(readContext: () => UseCanvasVideoModelNormalizationContext, dependencies: DependencyList) {
  useEffect(() => {
    const { activeNode, activeNodeModelOption, normalizeVideoResolutionForModel, normalizeNodeRatioForModel, parseDurationSecondsValue, setNodePatch } = readContext();

    if (!activeNode || activeNode.type !== "video" || !activeNodeModelOption) return;
    const normalizedResolution = normalizeVideoResolutionForModel(activeNode.model, activeNode.resolution, activeNodeModelOption);
    const normalizedAudio = normalizeCanvasCatalogVideoAudio(activeNodeModelOption, activeNode.videoGenerateAudio);
    const normalizedRatio = normalizeNodeRatioForModel(activeNodeModelOption, activeNode.ratio);
    const supportedModes = getCanvasCatalogVideoModes(activeNodeModelOption);
    const normalizedMode = isCanvasSourceVideoMode(activeNode.videoMode) || supportedModes.includes(activeNode.videoMode as CanvasCatalogVideoMode)
      ? activeNode.videoMode as CanvasCatalogVideoMode
      : supportedModes[0];
    const requiredRatio = normalizedMode ? requiredVideoRatio(activeNodeModelOption.id, normalizedMode) : null;
    const admittedRatio = requiredRatio && getCanvasCatalogAspectRatios(activeNodeModelOption).includes(requiredRatio)
      ? "auto" : normalizedRatio;
    const outputFormats = getCanvasCatalogVideoOutputFormats(activeNodeModelOption);
    const admittedOutputFormat = activeNode.videoOutputFormat && outputFormats.includes(activeNode.videoOutputFormat)
      ? activeNode.videoOutputFormat : getCanvasCatalogVideoDefaultOutputFormat(activeNodeModelOption);
    const normalizedDuration = normalizedMode
      ? normalizeCanvasCatalogVideoDuration(
          activeNodeModelOption,
          normalizedMode,
          parseDurationSecondsValue(activeNode.duration),
        )
      : null;
    if (
      normalizeCanvasCatalogVideoResolution(activeNode.model, activeNode.resolution) === normalizedResolution
      && activeNode.ratio === admittedRatio
      && activeNode.videoOutputFormat === admittedOutputFormat
      && activeNode.videoGenerateAudio === normalizedAudio
      && (!normalizedMode || activeNode.videoMode === normalizedMode)
      && (normalizedDuration === null || parseDurationSecondsValue(activeNode.duration) === normalizedDuration)
    ) return;
    setNodePatch(activeNode.id, {
      resolution: normalizedResolution,
      ratio: admittedRatio,
      videoOutputFormat: admittedOutputFormat,
      videoGenerateAudio: normalizedAudio,
      ...(normalizedMode ? { videoMode: normalizedMode } : {}),
      ...(normalizedDuration !== null ? { duration: String(normalizedDuration) } : {}),
    });

  }, dependencies);
}

interface UseCanvasImageModelNormalizationContext {
  activeNode: NodeData | null;
  activeNodeModelOption: AiModelOption | undefined;
  normalizeImageResolutionForModel: (model: AiModelOption | null | undefined, resolution: string | undefined) => CanvasCatalogImageQuality | "";
  hasLockedMediaAspect: (node: Partial<NodeData>) => boolean;
  normalizeNodeRatioForModel: (model: AiModelOption | null | undefined, ratio: RatioKey) => RatioKey;
  normalizeNodeResolution: (value: string | undefined) => "720P" | "1080P" | "2K" | "4K" | "1K";
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
}

export function useCanvasImageModelNormalization(readContext: () => UseCanvasImageModelNormalizationContext, dependencies: DependencyList) {
  useEffect(() => {
    const { activeNode, activeNodeModelOption, normalizeImageResolutionForModel, hasLockedMediaAspect, normalizeNodeRatioForModel, normalizeNodeResolution, setNodePatch } = readContext();

    if (!activeNode || activeNode.type !== "image" || !activeNodeModelOption) return;
    const normalizedResolution = normalizeImageResolutionForModel(activeNodeModelOption, activeNode.resolution);
    const normalizedRatio = hasLockedMediaAspect(activeNode)
      ? activeNode.ratio
      : normalizeNodeRatioForModel(activeNodeModelOption, activeNode.ratio);
    if (normalizeNodeResolution(activeNode.resolution) === normalizedResolution && activeNode.ratio === normalizedRatio) return;
    setNodePatch(activeNode.id, { resolution: normalizedResolution, ratio: normalizedRatio });

  }, dependencies);
}

interface UseCanvasDefaultModelContext {
  activeNode: NodeData | null;
  modelCatalogState: ModelCatalogState;
  getNodeModelType: (type: NodeType) => "image" | "video" | "text" | "audio";
  models: AiModelOption[];
  isAiModelSelectable: (model: AiModelOption) => boolean;
  availableModels: AiModelOption[];
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
}

export function useCanvasDefaultModel(readContext: () => UseCanvasDefaultModelContext, dependencies: DependencyList) {
  useEffect(() => {
    const { activeNode, modelCatalogState, getNodeModelType, models, isAiModelSelectable, availableModels, setNodePatch } = readContext();

    if (!activeNode || modelCatalogState !== "ready") return;
    const nodeType = activeNode.type;
    if (nodeType !== "image" && nodeType !== "video" && nodeType !== "text" && nodeType !== "audio") return;
    const modelType = getNodeModelType(nodeType);
    const catalogTyped = models.filter((model) => model.type === modelType && isAiModelSelectable(model) && (
      !isCanvasSourceVideoMode(activeNode.videoMode) || isCanvasCatalogVideoModeSupported(model, activeNode.videoMode!)
    ));
    if (!catalogTyped.length) return;
    const currentId = String(activeNode.model || "").trim();
    const currentKnown = currentId
      ? availableModels.some((model) => (
          model.id === currentId && model.type === modelType && isAiModelSelectable(model)
        ))
      : false;
    if (currentKnown) return;
    const nextDefault = pickDefaultCatalogModel(catalogTyped, modelType);
    if (!nextDefault || nextDefault.id === currentId) return;
    setNodePatch(activeNode.id, {
      model: nextDefault.id,
      price: catalogModelPriceText(nextDefault),
    });

  }, dependencies);
}

interface UseCanvasPortraitRouteContext {
  portraitVideoRouteKey: string;
  activeProjectContextId: string | null;
  activeNode: NodeData | null;
  setPortraitVideoRouteState: Dispatch<SetStateAction<{ key: string; policy?: PortraitVideoRoutePolicy; error?: string; }>>;
}

export function useCanvasPortraitRoute(readContext: () => UseCanvasPortraitRouteContext, dependencies: DependencyList) {
  useEffect(() => {
    const { portraitVideoRouteKey, activeProjectContextId, activeNode, setPortraitVideoRouteState } = readContext();

    if (!portraitVideoRouteKey) return;
    const projectId = normalizeProjectId(activeProjectContextId);
    if (!projectId || !activeNode?.model) return;
    const controller = new AbortController();
    void getPortraitVideoRoutePolicy(projectId, activeNode.model, controller.signal).then(
      (policy) => { if (!controller.signal.aborted) setPortraitVideoRouteState({ key: portraitVideoRouteKey, policy }); },
      () => { if (!controller.signal.aborted) setPortraitVideoRouteState({ key: portraitVideoRouteKey, error: "视频通道检查暂时失败，提交时将重新检查" }); },
    );
    return () => controller.abort();

  }, dependencies);
}

interface UseCanvasModelCatalogContext {
  setModels: Dispatch<SetStateAction<AiModelOption[]>>;
  setModelCatalogError: Dispatch<SetStateAction<string>>;
  setModelCatalogState: Dispatch<SetStateAction<ModelCatalogState>>;
}

export function useCanvasModelCatalog(readContext: () => UseCanvasModelCatalogContext, dependencies: DependencyList) {
  useEffect(() => {
    const { setModels, setModelCatalogError, setModelCatalogState } = readContext();

    let disposed = false;
    setModels([]);
    setModelCatalogError("");
    setModelCatalogState("loading");
    loadModelCatalogFromApi()
      .then((catalogModels) => {
        if (disposed) return;
        const nextModels = catalogModels.filter((item) => Boolean(item?.id && item?.type));
        setModels(nextModels);
        setModelCatalogState(nextModels.length ? "ready" : "empty");
      })
      .catch((error) => {
        if (!disposed) {
          setModels([]);
          setModelCatalogError(toApiErrorView(error).message || "模型目录加载失败");
          setModelCatalogState("failed");
        }
      });
    return () => {
      disposed = true;
    };

  }, dependencies);
}
