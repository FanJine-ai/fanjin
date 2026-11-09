import { createCanvasGraphActionBindings } from "./canvasGraphActionBindings";
import {
  getNodeModelType,
  isAiModelSelectable,
  normalizeImageResolutionForModel,
  normalizeNodeRatioForModel,
  normalizeNodeResolution,
  normalizeVideoResolutionForModel,
  parseDurationSecondsValue,
} from "./canvasModelDefinitions";
import { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import { useCanvasModelCatalogState } from "./useCanvasModelCatalogState";
import {
  useCanvasDefaultModel,
  useCanvasImageModelNormalization,
  useCanvasVideoModelNormalization,
} from "./useCanvasModelLifecycle";
export function useCanvasVideoModelNormalizationEffects({
  activeNode,
  activeNodeModelOption,
  canvasGraphActionBindings,
  canvasProjectActionBindings,
  canvasModelCatalogStateModule,
  availableModels,
}: {
  activeNode: import("@/pages/fjtv/canvasDataTypes").NodeData | null;
  activeNodeModelOption: import("@/lib/api").AiModelOption | undefined;
  canvasGraphActionBindings: ReturnType<typeof createCanvasGraphActionBindings>;
  canvasProjectActionBindings: ReturnType<
    typeof createCanvasProjectActionBindings
  >;
  canvasModelCatalogStateModule: ReturnType<typeof useCanvasModelCatalogState>;
  availableModels: import("@/lib/api").AiModelOption[];
}) {
  useCanvasVideoModelNormalization(
    () => ({
      activeNode,
      activeNodeModelOption,
      normalizeVideoResolutionForModel,
      normalizeNodeRatioForModel,
      parseDurationSecondsValue,
      setNodePatch: canvasGraphActionBindings.setNodePatch,
    }),
    [
      activeNode?.id,
      activeNode?.model,
      activeNode?.resolution,
      activeNode?.ratio,
      activeNode?.duration,
      activeNode?.videoMode,
      activeNode?.videoOutputFormat,
      activeNode?.videoGenerateAudio,
      activeNode?.type,
      activeNodeModelOption,
    ],
  );
  useCanvasImageModelNormalization(
    () => ({
      activeNode,
      activeNodeModelOption,
      normalizeImageResolutionForModel,
      hasLockedMediaAspect: canvasProjectActionBindings.hasLockedMediaAspect,
      normalizeNodeRatioForModel,
      normalizeNodeResolution,
      setNodePatch: canvasGraphActionBindings.setNodePatch,
    }),
    [
      activeNode?.id,
      activeNode?.model,
      activeNode?.resolution,
      activeNode?.ratio,
      activeNode?.type,
      activeNode?.imageUrl,
      activeNode?.primaryImageUrl,
      activeNode?.localPreviewUrl,
      activeNodeModelOption,
    ],
  );
  useCanvasDefaultModel(
    () => ({
      activeNode,
      modelCatalogState: canvasModelCatalogStateModule.modelCatalogState,
      getNodeModelType,
      models: canvasModelCatalogStateModule.models,
      isAiModelSelectable,
      availableModels,
      setNodePatch: canvasGraphActionBindings.setNodePatch,
    }),
    [
      activeNode?.id,
      activeNode?.model,
      activeNode?.type,
      canvasModelCatalogStateModule.modelCatalogState,
      canvasModelCatalogStateModule.models,
      availableModels,
    ],
  );
}
