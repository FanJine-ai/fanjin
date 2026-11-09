import {
type AiModelOption
} from "@/lib/api";
import { normalizeProjectId } from "@/stores/projectStore";
import { useMemo,useState } from "react";
import { type PortraitVideoRoutePolicy } from "../../features/portrait-admission/api";
import { getActiveModelCatalogStatusMessage,getActiveNodeModelOptions,getActiveNodeTotalPriceLabel,getActiveNodeUpstreamMediaNodes,getActivePromptModelLabel,resolveActiveNodeModelName,resolveActiveVideoDurationCapability,resolveActiveVideoDurationMode } from "./canvasActiveNodeViewModel";
import {
getCanvasCatalogVideoDuration
} from "./canvasCatalogContract";
import type {
EdgeData,
ModelCatalogState,
NodeData
} from "./canvasDataTypes";
import { getNodeModelType,getVideoModeForTab,summarizeVideoReferenceNodes } from "./canvasModelDefinitions";
import { getNodeCatalogPrice as getNodeCatalogPriceExternal } from "./canvasNodeCatalogPrice";
import {
formatPointPrice
} from "./canvasPricing";
import { resolveCanvasStoryboardVideoInputs } from "./canvasStoryboardVideoPrompt";
import { buildPortraitAdmissionAssets } from "./canvasViewModel";
import {
getCatalogModelPrice,
resolveNodeModelLabel
} from "./modelCatalog";
import { useCanvasPortraitRoute } from "./useCanvasModelLifecycle";
interface Context {
  activeNode: NodeData | null;
  availableModels: AiModelOption[];
  edges: EdgeData[];
  nodeMap: Map<string, NodeData>;
  nodes: NodeData[];
  activeProjectContextId: string | null;
  activeNodeModelOption: AiModelOption | undefined;
  videoPromptTab: "文生视频" | "全能参考" | "图生视频" | "首尾帧" | "图片参考" | "延长视频" | "修改视频";
  modelCatalogState: ModelCatalogState;
  modelCatalogError: string;
}
export function useCanvasActiveModelView({ activeNode, availableModels, edges, nodeMap, nodes, activeProjectContextId, activeNodeModelOption, videoPromptTab, modelCatalogState, modelCatalogError }: Context) {
  const activeNodeModelOptions = useMemo(() => {
    return getActiveNodeModelOptions(activeNode, availableModels);
  }, [activeNode, availableModels]);
  const activeNodeUpstreamReferenceNodes = useMemo(() => {
    return getActiveNodeUpstreamMediaNodes(activeNode, edges, nodeMap);
  }, [activeNode, edges, nodeMap]);
  const activeStoryboardVideoInputs = useMemo(() => resolveCanvasStoryboardVideoInputs({
    images: activeNode?.type === "video" ? activeNodeUpstreamReferenceNodes : [],
    nodes,
    edges,
  }), [activeNode?.type, activeNodeUpstreamReferenceNodes, nodes, edges]);
  const activePortraitAdmissionAssets = useMemo(() => {
    // Generation submits connected upstream media as references. The selected
    // node's saved output is not an input and must not block a new text task.
    return buildPortraitAdmissionAssets(activeNodeUpstreamReferenceNodes);
  }, [activeNodeUpstreamReferenceNodes]);
  const portraitVideoRouteKey = activeNode?.type === "video" && activeNode.model && activePortraitAdmissionAssets.length
    ? `${normalizeProjectId(activeProjectContextId)}:${activeNode.model}` : "";
  const [portraitVideoRouteState, setPortraitVideoRouteState] = useState<{
    key: string; policy?: PortraitVideoRoutePolicy; error?: string;
  }>({ key: "" });
  useCanvasPortraitRoute(() => ({ portraitVideoRouteKey, activeProjectContextId, activeNode, setPortraitVideoRouteState }), [portraitVideoRouteKey]);
  const activePortraitVideoPolicy = portraitVideoRouteState.key === portraitVideoRouteKey
    ? portraitVideoRouteState.policy : undefined;
  const activeNodeVideoReferenceSummary = useMemo(
    () => summarizeVideoReferenceNodes(activeNodeUpstreamReferenceNodes),
    [activeNodeUpstreamReferenceNodes],
  );
  const activeNodeVideoDurationMode = useMemo(() => {
    return resolveActiveVideoDurationMode(activeNode, activeNodeModelOption, getVideoModeForTab(videoPromptTab));
  }, [activeNode, activeNodeModelOption, videoPromptTab]);
  const activeNodeVideoDurationCapability = useMemo(() => (
    resolveActiveVideoDurationCapability(activeNodeModelOption, activeNodeVideoDurationMode, getCanvasCatalogVideoDuration)
  ), [activeNodeModelOption, activeNodeVideoDurationMode]);
  const activeNodeModelName = useMemo(() => {
    return resolveActiveNodeModelName(activeNode, availableModels, resolveNodeModelLabel);
  }, [activeNode, availableModels]);
  const activeModelCatalogStatusMessage = useMemo(() => {
    return getActiveModelCatalogStatusMessage({ node: activeNode, catalogState: modelCatalogState, modelOptionsCount: activeNodeModelOptions.length, error: modelCatalogError });
  }, [activeNode, activeNodeModelOptions.length, modelCatalogError, modelCatalogState]);
  const activePromptModelLabel = useMemo(() => {
    return getActivePromptModelLabel({ node: activeNode, catalogState: modelCatalogState, modelOptionsCount: activeNodeModelOptions.length, modelName: activeNodeModelName });
  }, [activeNode, activeNodeModelName, activeNodeModelOptions.length, modelCatalogState]);
  const activeNodeTotalPriceLabel = useMemo(() => {
    return getActiveNodeTotalPriceLabel(
      activeNode,
      availableModels,
      (node, models) => getNodeCatalogPriceExternal(node, models, getNodeModelType, getCatalogModelPrice),
      formatPointPrice,
    );
  }, [activeNode, availableModels]);

  return {
    activeNodeModelOptions, activeStoryboardVideoInputs, activePortraitAdmissionAssets,
    activePortraitVideoPolicy, activeNodeVideoReferenceSummary, activeNodeVideoDurationMode,
    activeNodeVideoDurationCapability, activeModelCatalogStatusMessage, activePromptModelLabel,
    activeNodeTotalPriceLabel,
  };
}
