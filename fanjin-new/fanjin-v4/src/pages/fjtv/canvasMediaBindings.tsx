import { type AiModelOption } from "@/lib/api";
import { createCanvasArtifactEditingController } from "./canvasArtifactEditingController";
import { createCanvasComposeController } from "./canvasComposeController";
import type {
  CanvasModelType,
  EdgeData,
  GroupData,
  ImageEraseKind,
  NodeData,
  StoryboardGroupType,
} from "./canvasDataTypes";
import {
  buildGridCellKey,
  buildGridCellLabel,
  buildGridPresetLabel,
  parseGridCellKey,
} from "./canvasGridDefinitions";
import { createCanvasImageGridController } from "./canvasImageGridController";
import { createCanvasImageMenuController } from "./canvasImageMenuController";
import { createCanvasImageToolsController } from "./canvasImageToolsController";
import {
  IMAGE_ENHANCE_MODEL_FALLBACK,
  VIDEO_ENHANCE_MODEL,
  VIDEO_ENHANCE_RESOLUTIONS,
  VIDEO_SUBTITLE_ERASE_MODEL,
  buildAudioSeparateNodeTitle,
  buildVideoEnhanceNodeTitle,
  buildVideoFrameNodeTitle,
  buildVideoSubtitleEraseNodeTitle,
  videoEnhanceResolutionRank,
} from "./canvasMediaToolDefinitions";
import type { NodeType, RatioKey } from "./canvasMediaTypes";
import { createCanvasMediaViewerActions } from "./canvasMediaViewerActions";
import {
  getImageRequestRatio,
  normalizeVideoResolutionForModel,
  resolveCanvasImageQuality,
} from "./canvasModelDefinitions";
import { baseModel, createNode } from "./canvasNodeDefaults";
import { CANVAS_VISUAL_SCALE } from "./canvasPageConstants";
import { type CharacterThreeViewMode } from "./canvasPromptTemplates";
import { createCanvasStoryboardVideoPromptView } from "./canvasStoryboardVideoPromptView";
import { createCanvasVideoStoryController } from "./canvasVideoStoryController";
import { createCanvasVideoToolsController } from "./canvasVideoToolsController";
import type { useCanvasComposeState } from "./useCanvasComposeState";
import type { useCanvasComposeView } from "./useCanvasComposeView";
import type { useCanvasGraphState } from "./useCanvasGraphState";
import type { useCanvasGroupState } from "./useCanvasGroupState";
import type { useCanvasImageEditorState } from "./useCanvasImageEditorState";
import type { useCanvasPromptState } from "./useCanvasPromptState";
import type { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import type { useCanvasSelectionState } from "./useCanvasSelectionState";
import type { useCanvasVideoEditorState } from "./useCanvasVideoEditorState";
export function bindArtifactEditingController(
  readContext: () => {
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
    canvasGroupStateModule: ReturnType<
      typeof import("./useCanvasGroupState").useCanvasGroupState
    >;
  },
) {
  const context = readContext();

  return createCanvasArtifactEditingController({
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    setNodePatch: context.setNodePatch,
    setStatus: context.canvasPromptStateModule.setStatus,
    setActiveGroupId: context.canvasGroupStateModule.setActiveGroupId,
    setExpanded: context.canvasPromptStateModule.setExpanded,
    persistCanvas: context.persistCanvas,
  });
}

export function bindCanvasStoryboardVideoPromptView(
  readContext: () => {
    canvasActiveModelViewModule: ReturnType<
      typeof import("./useCanvasActiveModelView").useCanvasActiveModelView
    >;
  },
) {
  const context = readContext();

  return createCanvasStoryboardVideoPromptView({
    activeStoryboardVideoInputs:
      context.canvasActiveModelViewModule.activeStoryboardVideoInputs,
  });
}

export function bindVideoToolsController(
  readContext: () => {
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
    canvasVideoEditorStateModule: ReturnType<typeof useCanvasVideoEditorState>;
    canvasCapabilities: import("@/pages/fjtv/canvasCapabilities").CanvasRealCapabilities;
    resolvePendingVideoBillingBeforeSubmit: (
      node: NodeData,
      options?: { allowIdempotentRetryWithoutTaskId?: boolean },
    ) => Promise<boolean>;
    preflightCanvasModel: (
      modelType: CanvasModelType,
      requestedModelId?: string,
      options?: { allowCatalogDefault?: boolean; openPicker?: boolean },
    ) => AiModelOption | null;
    parseDurationSeconds: (raw?: string) => number;
    beginNodeGenerationSession: (nodeId: string) => string;
    setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
    isNodeGenerationSessionCurrent: (
      nodeId: string,
      sessionId: string,
    ) => boolean;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    beginNodeProgressSimulation: (
      nodeId: string,
      phase: "upload" | "generation",
    ) => void;
    pollTaskUntilDone: (
      taskId: string,
      node: NodeData,
      sessionId: string,
      startedAt?: number,
      options?: {
        kind?: "generation" | "video_enhance";
        queryFailures?: number;
      },
    ) => Promise<boolean>;
    finishNodeGenerationSession: (nodeId: string, sessionId?: string) => void;
    showNodeStatusChip: (
      nodeId: string,
      text: string,
      tone?: "neutral" | "success" | "error",
      durationMs?: number,
    ) => void;
    ensureApiKeyReady: () => boolean;
    resolveNodeRemoteReferenceUrl: (node: NodeData) => Promise<string>;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    applyTaskResultToNode: (
      node: NodeData,
      taskData: any,
      sessionId?: string,
    ) => Promise<boolean>;
    nodeMap: Map<string, NodeData>;
    stopNodeProgressTimer: (nodeId: string) => void;
    createDerivedImageNode: (
      sourceNode: NodeData,
      title: string,
      patch?: Partial<NodeData>,
    ) => Promise<NodeData>;
    canvasProjectStateModule: ReturnType<
      typeof import("./useCanvasProjectState").useCanvasProjectState
    >;
    canvasPlaybackStateModule: ReturnType<
      typeof import("./useCanvasPlaybackState").useCanvasPlaybackState
    >;
    canvasGenerationDebugStateModule: ReturnType<
      typeof import("./useCanvasGenerationDebugState").useCanvasGenerationDebugState
    >;
    canvasRuntimeRefsModule: ReturnType<
      typeof import("./useCanvasRuntimeRefs").useCanvasRuntimeRefs
    >;
  },
) {
  const context = readContext();

  return createCanvasVideoToolsController({
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasPromptStateModule,
    ...context.canvasVideoEditorStateModule,
    canvasCapabilities: context.canvasCapabilities,
    resolvePendingVideoBillingBeforeSubmit:
      context.resolvePendingVideoBillingBeforeSubmit,
    activeProjectContextId:
      context.canvasProjectStateModule.activeProjectContextId,
    preflightCanvasModel: context.preflightCanvasModel,
    parseDurationSeconds: context.parseDurationSeconds,
    videoNodeDurations: context.canvasPlaybackStateModule.videoNodeDurations,
    normalizeVideoResolutionForModel,
    beginNodeGenerationSession: context.beginNodeGenerationSession,
    setNodePatch: context.setNodePatch,
    setGenerateDebug: context.canvasGenerationDebugStateModule.setGenerateDebug,
    isNodeGenerationSessionCurrent: context.isNodeGenerationSessionCurrent,
    persistCanvas: context.persistCanvas,
    beginNodeProgressSimulation: context.beginNodeProgressSimulation,
    pollTaskUntilDone: context.pollTaskUntilDone,
    finishNodeGenerationSession: context.finishNodeGenerationSession,
    showNodeStatusChip: context.showNodeStatusChip,
    nodeVideoRefs: context.canvasRuntimeRefsModule.nodeVideoRefs,
    createNode,
    ensureApiKeyReady: context.ensureApiKeyReady,
    resolveNodeRemoteReferenceUrl: context.resolveNodeRemoteReferenceUrl,
    buildAudioSeparateNodeTitle,
    canvasMeta: context.canvasMeta,
    applyTaskResultToNode: context.applyTaskResultToNode,
    nodeMap: context.nodeMap,
    videoEnhanceResolutionRank,
    VIDEO_ENHANCE_RESOLUTIONS,
    buildVideoEnhanceNodeTitle,
    VIDEO_ENHANCE_MODEL,
    stopNodeProgressTimer: context.stopNodeProgressTimer,
    videoNodeCurrentTimes:
      context.canvasPlaybackStateModule.videoNodeCurrentTimes,
    createDerivedImageNode: context.createDerivedImageNode,
    buildVideoFrameNodeTitle,
    buildVideoSubtitleEraseNodeTitle,
    VIDEO_SUBTITLE_ERASE_MODEL,
  });
}

export function bindComposeController(
  readContext: () => {
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasComposeStateModule: ReturnType<typeof useCanvasComposeState>;
    canvasComposeViewModule: ReturnType<typeof useCanvasComposeView>;
    setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    nodeMap: Map<string, NodeData>;
    canvasBalance: {
      refresh: () => void;
      loading: boolean;
      error: string;
      availableMicros: number;
      reservedMicros: number;
      baselineMicros: number;
      spentMicros: number;
      percent: number;
      lastRechargeAt: number | null;
    };
    canvasRuntimeRefsModule: ReturnType<
      typeof import("./useCanvasRuntimeRefs").useCanvasRuntimeRefs
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
    canvasProjectStateModule: ReturnType<
      typeof import("./useCanvasProjectState").useCanvasProjectState
    >;
  },
) {
  const context = readContext();

  return createCanvasComposeController({
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasComposeStateModule,
    ...context.canvasComposeViewModule,
    setNodePatch: context.setNodePatch,
    persistCanvas: context.persistCanvas,
    composeExportEpochRef:
      context.canvasRuntimeRefsModule.composeExportEpochRef,
    nodeMap: context.nodeMap,
    setStatus: context.canvasPromptStateModule.setStatus,
    composePreviewRef: context.canvasRuntimeRefsModule.composePreviewRef,
    activeProjectContextId:
      context.canvasProjectStateModule.activeProjectContextId,
    canvasBalance: context.canvasBalance,
    createNode,
  });
}

export function bindImageToolsController(
  readContext: () => {
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasImageEditorStateModule: ReturnType<typeof useCanvasImageEditorState>;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    closePromptMenus: () => void;
    closeImageToolbarMenus: () => void;
    ensureApiKeyReady: () => boolean;
    nodeMap: Map<string, NodeData>;
    ensureRemoteImageUrlForNode: (node: NodeData) => Promise<string>;
    beginNodeGenerationSession: (nodeId: string) => string;
    setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    isNodeGenerationSessionCurrent: (
      nodeId: string,
      sessionId: string,
    ) => boolean;
    beginNodeProgressSimulation: (
      nodeId: string,
      phase: "upload" | "generation",
    ) => void;
    pollTaskUntilDone: (
      taskId: string,
      node: NodeData,
      sessionId: string,
      startedAt?: number,
      options?: {
        kind?: "generation" | "video_enhance";
        queryFailures?: number;
      },
    ) => Promise<boolean>;
    applyTaskResultToNode: (
      node: NodeData,
      taskData: any,
      sessionId?: string,
    ) => Promise<boolean>;
    finishNodeGenerationSession: (nodeId: string, sessionId?: string) => void;
    buildCroppedImageFile: (
      sourceNode: NodeData,
      x1: number,
      y1: number,
      x2: number,
      y2: number,
    ) => Promise<File>;
    findSelectableCatalogModel: (
      modelType: CanvasModelType,
      modelId?: string,
    ) => AiModelOption | undefined;
    preflightCanvasModel: (
      modelType: CanvasModelType,
      requestedModelId?: string,
      options?: { allowCatalogDefault?: boolean; openPicker?: boolean },
    ) => AiModelOption | null;
    resolveNodeRemoteReferenceUrl: (node: NodeData) => Promise<string>;
    setNodeSerialCounter: React.Dispatch<
      React.SetStateAction<Record<NodeType, number>>
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
    canvasProjectStateModule: ReturnType<
      typeof import("./useCanvasProjectState").useCanvasProjectState
    >;
    canvasGroupStateModule: ReturnType<
      typeof import("./useCanvasGroupState").useCanvasGroupState
    >;
    canvasAssetPanelStateModule: ReturnType<
      typeof import("./useCanvasAssetPanelState").useCanvasAssetPanelState
    >;
  },
) {
  const context = readContext();

  return createCanvasImageToolsController({
    ...context.canvasRuntimeRefsModule,
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasImageEditorStateModule,
    createNode,
    persistCanvas: context.persistCanvas,
    setStatus: context.canvasPromptStateModule.setStatus,
    closePromptMenus: context.closePromptMenus,
    closeImageToolbarMenus: context.closeImageToolbarMenus,
    setExpanded: context.canvasPromptStateModule.setExpanded,
    ensureApiKeyReady: context.ensureApiKeyReady,
    nodeMap: context.nodeMap,
    ensureRemoteImageUrlForNode: context.ensureRemoteImageUrlForNode,
    beginNodeGenerationSession: context.beginNodeGenerationSession,
    setNodePatch: context.setNodePatch,
    canvasMeta: context.canvasMeta,
    IMAGE_ENHANCE_MODEL_FALLBACK,
    isNodeGenerationSessionCurrent: context.isNodeGenerationSessionCurrent,
    beginNodeProgressSimulation: context.beginNodeProgressSimulation,
    pollTaskUntilDone: context.pollTaskUntilDone,
    applyTaskResultToNode: context.applyTaskResultToNode,
    finishNodeGenerationSession: context.finishNodeGenerationSession,
    activeProjectContextId:
      context.canvasProjectStateModule.activeProjectContextId,
    buildCroppedImageFile: context.buildCroppedImageFile,
    findSelectableCatalogModel: context.findSelectableCatalogModel,
    preflightCanvasModel: context.preflightCanvasModel,
    resolveCanvasImageQuality,
    getImageRequestRatio,
    resolveNodeRemoteReferenceUrl: context.resolveNodeRemoteReferenceUrl,
    baseModel,
    setGroups: context.canvasGroupStateModule.setGroups,
    setActiveGroupId: context.canvasGroupStateModule.setActiveGroupId,
    setNodeSerialCounter: context.setNodeSerialCounter,
    assetManagerOpen: context.canvasAssetPanelStateModule.assetManagerOpen,
    CANVAS_VISUAL_SCALE,
  });
}

export function bindVideoStoryController(
  readContext: () => {
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
    buildStoryboardGroupData: (
      stamp: number,
      nodeIds: string[],
      title: string,
      groupType: StoryboardGroupType,
      rows: number,
      cols: number,
      ratio: RatioKey,
    ) => GroupData;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    ensureApiKeyReady: () => boolean;
    videoStoryAttemptId: () => `${string}-${string}-${string}-${string}-${string}`;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
    canvasVideoEditorStateModule: ReturnType<
      typeof import("./useCanvasVideoEditorState").useCanvasVideoEditorState
    >;
    canvasProjectStateModule: ReturnType<
      typeof import("./useCanvasProjectState").useCanvasProjectState
    >;
  },
) {
  const context = readContext();

  return createCanvasVideoStoryController({
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasGroupStateModule,
    setStatus: context.canvasPromptStateModule.setStatus,
    createNode,
    buildStoryboardGroupData: context.buildStoryboardGroupData,
    persistCanvas: context.persistCanvas,
    canvasMeta: context.canvasMeta,
    videoStoryPollInFlightRef:
      context.canvasVideoEditorStateModule.videoStoryPollInFlightRef,
    ensureApiKeyReady: context.ensureApiKeyReady,
    currentProjectId: context.canvasProjectStateModule.currentProjectId,
    videoStoryAttemptId: context.videoStoryAttemptId,
  });
}

export function bindCanvasMediaViewerActions(
  readContext: () => {
    getNodeMediaUrl: (node: NodeData | null | undefined) => string;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
  },
) {
  const context = readContext();

  return createCanvasMediaViewerActions({
    getNodeMediaUrl: context.getNodeMediaUrl,
    setMediaViewerNodeId: context.canvasPromptStateModule.setMediaViewerNodeId,
    setExpanded: context.canvasPromptStateModule.setExpanded,
  });
}

export function bindImageMenuController(
  readContext: () => {
    canvasImageEditorStateModule: ReturnType<typeof useCanvasImageEditorState>;
    openImageEnhanceEditor: (sourceNode: NodeData) => void;
    openImageOutpaintEditor: (node: NodeData) => void;
    openImageCropEditor: (node: NodeData) => void;
    submitRemoveImageBackground: (sourceNode: NodeData) => Promise<void>;
    submitImageErase: (
      sourceNode: NodeData,
      kind: ImageEraseKind,
    ) => Promise<void>;
    openImageTransformEditor: (sourceNode: NodeData) => void;
    submitMultiAngleNineGrid: (sourceNode: NodeData) => Promise<void>;
    submitProductSheet: (sourceNode: NodeData) => Promise<void>;
    submitSceneSheet: (sourceNode: NodeData) => Promise<void>;
    submitCharacterSheet: (sourceNode: NodeData) => Promise<void>;
    submitCharacterThreeView: (
      sourceNode: NodeData,
      mode: CharacterThreeViewMode,
    ) => Promise<void>;
    submitCinematicLighting: (sourceNode: NodeData) => Promise<void>;
    submitStoryboard25Grid: (sourceNode: NodeData) => Promise<void>;
    canvasVideoEditorStateModule: ReturnType<
      typeof import("./useCanvasVideoEditorState").useCanvasVideoEditorState
    >;
    canvasSelectionStateModule: ReturnType<
      typeof import("./useCanvasSelectionState").useCanvasSelectionState
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
  },
) {
  const context = readContext();

  return createCanvasImageMenuController({
    ...context.canvasImageEditorStateModule,
    setVideoEnhanceResolutionOpen:
      context.canvasVideoEditorStateModule.setVideoEnhanceResolutionOpen,
    setActiveNodeId: context.canvasSelectionStateModule.setActiveNodeId,
    openImageEnhanceEditor: context.openImageEnhanceEditor,
    openImageOutpaintEditor: context.openImageOutpaintEditor,
    openImageCropEditor: context.openImageCropEditor,
    submitRemoveImageBackground: context.submitRemoveImageBackground,
    submitImageErase: context.submitImageErase,
    setStatus: context.canvasPromptStateModule.setStatus,
    openImageTransformEditor: context.openImageTransformEditor,
    submitMultiAngleNineGrid: context.submitMultiAngleNineGrid,
    submitProductSheet: context.submitProductSheet,
    submitSceneSheet: context.submitSceneSheet,
    submitCharacterSheet: context.submitCharacterSheet,
    submitCharacterThreeView: context.submitCharacterThreeView,
    submitCinematicLighting: context.submitCinematicLighting,
    submitStoryboard25Grid: context.submitStoryboard25Grid,
  });
}

export function bindImageGridController(
  readContext: () => {
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
    canvasImageEditorStateModule: ReturnType<typeof useCanvasImageEditorState>;
    nodeMap: Map<string, NodeData>;
    showNodeStatusChip: (
      nodeId: string,
      text: string,
      tone?: "neutral" | "success" | "error",
      durationMs?: number,
    ) => void;
    buildStoryboardGroupNodes: (
      sourceNode: NodeData,
      selectedCellKeys: string[],
      rows: number,
      cols: number,
      ratio: RatioKey,
      stamp: number,
    ) => NodeData[];
    buildStoryboardGroupData: (
      stamp: number,
      nodeIds: string[],
      title: string,
      groupType: StoryboardGroupType,
      rows: number,
      cols: number,
      ratio: RatioKey,
    ) => GroupData;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    assertCanvasOperationActive: (
      expectedEpoch: number,
      signal?: AbortSignal,
    ) => void;
    uploadMediaFileToRemote: (
      file: File,
      type: "image" | "video",
      nodeId?: string,
    ) => Promise<any>;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
    canvasVideoEditorStateModule: ReturnType<
      typeof import("./useCanvasVideoEditorState").useCanvasVideoEditorState
    >;
    canvasGenerationDebugStateModule: ReturnType<
      typeof import("./useCanvasGenerationDebugState").useCanvasGenerationDebugState
    >;
  },
) {
  const context = readContext();

  return createCanvasImageGridController({
    ...context.canvasRuntimeRefsModule,
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasGroupStateModule,
    ...context.canvasImageEditorStateModule,
    setStatus: context.canvasPromptStateModule.setStatus,
    setVideoEnhanceResolutionOpen:
      context.canvasVideoEditorStateModule.setVideoEnhanceResolutionOpen,
    buildGridPresetLabel,
    createNode,
    buildGridCellLabel,
    buildGridCellKey,
    nodeMap: context.nodeMap,
    showNodeStatusChip: context.showNodeStatusChip,
    buildStoryboardGroupNodes: context.buildStoryboardGroupNodes,
    buildStoryboardGroupData: context.buildStoryboardGroupData,
    persistCanvas: context.persistCanvas,
    canvasMeta: context.canvasMeta,
    parseGridCellKey,
    assertCanvasOperationActive: context.assertCanvasOperationActive,
    uploadMediaFileToRemote: context.uploadMediaFileToRemote,
    setGenerateDebug: context.canvasGenerationDebugStateModule.setGenerateDebug,
  });
}
