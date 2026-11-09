import { type AssetCatalogItem } from "@/features/assets/assetCatalog";
import { type AiModelOption } from "@/lib/api";
import type {
  CanvasModelType,
  CanvasUploadRetry,
  EdgeData,
  GroupData,
  HistoryAssetItem,
  NodeData,
  UpstreamReferenceItem,
  VideoGenerationMode,
} from "./canvasDataTypes";
import { createCanvasGenerationActionsController } from "./canvasGenerationActionsController";
import { createCanvasGenerationSession } from "./canvasGenerationSession";
import type { NodeType, RatioKey } from "./canvasMediaTypes";
import { createCanvasModelSettingsController } from "./canvasModelSettingsController";
import { createCanvasPromptEditingController } from "./canvasPromptEditingController";
import { createCanvasReferencePreviewView } from "./canvasReferencePreviewView";
import { createCanvasReferenceUploadController } from "./canvasReferenceUploadController";
import { createCanvasSubmitButtonView } from "./canvasSubmitButtonView";
import {
  type CanvasArtifactCard,
  type CanvasArtifactKind,
} from "./canvasTextArtifacts";
import { createCanvasUploadController } from "./canvasUploadController";
import type { useCanvasConnectionState } from "./useCanvasConnectionState";
import type { useCanvasGraphState } from "./useCanvasGraphState";
import type { useCanvasImageEditorState } from "./useCanvasImageEditorState";
import type { useCanvasModelCatalogState } from "./useCanvasModelCatalogState";
import type { useCanvasProjectState } from "./useCanvasProjectState";
import type { useCanvasPromptState } from "./useCanvasPromptState";
import type { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import type { useCanvasSelectionState } from "./useCanvasSelectionState";
import type { useCanvasStoryboardState } from "./useCanvasStoryboardState";
export function bindGenerationActionsController(
  readContext: () => {
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
    canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
    setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
    uploadFileIntoNode: (
      nodeId: string,
      file: File,
      type: "image" | "video",
      options?: CanvasUploadRetry["options"],
    ) => any;
    createGenerationSessionController: () => {
      beginNodeGenerationSession: (nodeId: string) => string;
      isNodeGenerationSessionCurrent: (
        nodeId: string,
        sessionId: string,
      ) => boolean;
      finishNodeGenerationSession: (nodeId: string, sessionId?: string) => void;
      cancelNodeGeneration: (nodeId: string) => Promise<boolean>;
    };
    isNodeGenerationSessionCurrent: (
      nodeId: string,
      sessionId: string,
    ) => boolean;
    finishNodeGenerationSession: (nodeId: string, sessionId?: string) => void;
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
    loadHistoryItems: () => Promise<void>;
    applyNodeMediaGeometry: (
      nodeId: string,
      mediaWidth: number,
      mediaHeight: number,
      patch?: Partial<NodeData>,
    ) => void;
    createAndUploadVideoPoster: (
      nodeId: string,
      videoUrl: string,
      fileName: string,
    ) => Promise<boolean>;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    editCanvasArtifact: (
      nodeId: string,
      kind: CanvasArtifactKind,
      cardId: string,
      patch: Partial<CanvasArtifactCard>,
    ) => void;
    beginNodeGenerationSession: (nodeId: string) => string;
    preflightCanvasModel: (
      modelType: CanvasModelType,
      requestedModelId?: string,
      options?: { allowCatalogDefault?: boolean; openPicker?: boolean },
    ) => AiModelOption | null;
    activeNode: NodeData | null;
    submitDraftFinalNode: (node: NodeData) => Promise<boolean>;
    buildReferenceResolutionSnapshot: (node: NodeData | null | undefined) => {
      nodeId: string;
      title: string;
      type: NodeType;
      referenceAssetUri: string;
      referenceAssetKind: string;
      imageUrl: string;
      videoUrl: string;
      localPreviewUrl: string;
      localVideoUrl: string;
      cachedRemoteUrl: string;
      localMappedRemoteUrl: string;
      hasPendingUpload: boolean;
    } | null;
    resolveNodeRemoteReferenceUrl: (node: NodeData) => Promise<string>;
    getImageNodeGeometry: (node: NodeData | null | undefined) => {
      width: number;
      height: number;
      ratio: RatioKey;
      nodeWidth: number;
      nodeHeight: number;
    } | null;
    inferImageReferenceGeometry: (referenceNodes: NodeData[]) => {
      width: number;
      height: number;
      ratio: RatioKey;
      nodeWidth: number;
      nodeHeight: number;
    } | null;
    inferVideoRatioFromImageReferences: (
      referenceNodes: NodeData[],
    ) => RatioKey | null;
    shouldInheritVideoRatioFromReference: (
      mode: VideoGenerationMode,
      node: NodeData,
      inferredRatio: RatioKey | null,
    ) => boolean;
    parseDurationSeconds: (raw?: string) => number;
    executeDraftWithApproval: (
      node: NodeData,
      request: Record<string, unknown>,
      attemptId: string,
    ) => Promise<any>;
    canvasGroupStateModule: ReturnType<
      typeof import("./useCanvasGroupState").useCanvasGroupState
    >;
    canvasGenerationDebugStateModule: ReturnType<
      typeof import("./useCanvasGenerationDebugState").useCanvasGenerationDebugState
    >;
    canvasPlaybackStateModule: ReturnType<
      typeof import("./useCanvasPlaybackState").useCanvasPlaybackState
    >;
    canvasPricingDecisionsModule: ReturnType<
      typeof import("./useCanvasPricingDecisions").useCanvasPricingDecisions
    >;
  },
) {
  const context = readContext();

  return createCanvasGenerationActionsController({
    ...context.canvasRuntimeRefsModule,
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasPromptStateModule,
    ...context.canvasProjectStateModule,
    setNodePatch: context.setNodePatch,
    setGroups: context.canvasGroupStateModule.setGroups,
    setActiveGroupId: context.canvasGroupStateModule.setActiveGroupId,
    uploadFileIntoNode: context.uploadFileIntoNode,
    createGenerationSessionController:
      context.createGenerationSessionController,
    isNodeGenerationSessionCurrent: context.isNodeGenerationSessionCurrent,
    finishNodeGenerationSession: context.finishNodeGenerationSession,
    canvasBalance: context.canvasBalance,
    loadHistoryItems: context.loadHistoryItems,
    applyNodeMediaGeometry: context.applyNodeMediaGeometry,
    createAndUploadVideoPoster: context.createAndUploadVideoPoster,
    persistCanvas: context.persistCanvas,
    editCanvasArtifact: context.editCanvasArtifact,
    beginNodeGenerationSession: context.beginNodeGenerationSession,
    preflightCanvasModel: context.preflightCanvasModel,
    activeNode: context.activeNode,
    submitDraftFinalNode: context.submitDraftFinalNode,
    setGenerateDebug: context.canvasGenerationDebugStateModule.setGenerateDebug,
    buildReferenceResolutionSnapshot: context.buildReferenceResolutionSnapshot,
    resolveNodeRemoteReferenceUrl: context.resolveNodeRemoteReferenceUrl,
    getImageNodeGeometry: context.getImageNodeGeometry,
    inferImageReferenceGeometry: context.inferImageReferenceGeometry,
    inferVideoRatioFromImageReferences:
      context.inferVideoRatioFromImageReferences,
    shouldInheritVideoRatioFromReference:
      context.shouldInheritVideoRatioFromReference,
    parseDurationSeconds: context.parseDurationSeconds,
    videoNodeDurations: context.canvasPlaybackStateModule.videoNodeDurations,
    audioNodeDurations: context.canvasPlaybackStateModule.audioNodeDurations,
    executeDraftWithApproval: context.executeDraftWithApproval,
    requestPricingConfirmation:
      context.canvasPricingDecisionsModule.requestPricingConfirmation,
  });
}

export function bindCanvasSubmitButtonView(
  readContext: () => {
    submitButtonIsPending: (key: string) => boolean;
    runWithSubmitButtonPending: (
      key: string,
      action: () => Promise<void> | void,
    ) => Promise<void>;
  },
) {
  const context = readContext();

  return createCanvasSubmitButtonView({
    submitButtonIsPending: context.submitButtonIsPending,
    runWithSubmitButtonPending: context.runWithSubmitButtonPending,
  });
}

export function bindCreateGenerationSessionController(
  readContext: () => {
    markNodeSubmitting: (nodeId: string) => void;
    clearNodeSubmitting: (nodeId: string) => void;
    setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
    stopNodeProgressTimer: (nodeId: string) => void;
    clearSubmitButtonPendingForNode: (nodeId: string) => void;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    showNodeStatusChip: (
      nodeId: string,
      text: string,
      tone?: "neutral" | "success" | "error",
      durationMs?: number,
    ) => void;
    beginNodeProgressSimulation: (
      nodeId: string,
      phase: "upload" | "generation",
    ) => void;
    canvasRuntimeRefsModule: ReturnType<
      typeof import("./useCanvasRuntimeRefs").useCanvasRuntimeRefs
    >;
    canvasGraphStateModule: ReturnType<
      typeof import("./useCanvasGraphState").useCanvasGraphState
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
  },
) {
  const context = readContext();

  return createCanvasGenerationSession({
    generationSessionRef: context.canvasRuntimeRefsModule.generationSessionRef,
    markNodeSubmitting: context.markNodeSubmitting,
    clearNodeSubmitting: context.clearNodeSubmitting,
    setNodePatch: context.setNodePatch,
    nodesRef: context.canvasGraphStateModule.nodesRef,
    stopNodeProgressTimer: context.stopNodeProgressTimer,
    clearSubmitButtonPendingForNode: context.clearSubmitButtonPendingForNode,
    setGenerateButtonPendingNodeIds:
      context.canvasPromptStateModule.setGenerateButtonPendingNodeIds,
    setStatus: context.canvasPromptStateModule.setStatus,
    persistCanvas: context.persistCanvas,
    showNodeStatusChip: context.showNodeStatusChip,
    beginNodeProgressSimulation: context.beginNodeProgressSimulation,
  });
}

export function bindReferenceUploadController(
  readContext: () => {
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasConnectionStateModule: ReturnType<typeof useCanvasConnectionState>;
    canvasStoryboardStateModule: ReturnType<typeof useCanvasStoryboardState>;
    activeNode: NodeData | null;
    ensureApiKeyReady: () => boolean;
    showNodeStatusChip: (
      nodeId: string,
      text: string,
      tone?: "neutral" | "success" | "error",
      durationMs?: number,
    ) => void;
    uploadFileIntoNode: (
      nodeId: string,
      file: File,
      type: "image" | "video",
      options?: CanvasUploadRetry["options"],
    ) => any;
    createImageToImagePresetGroup: (
      sourceNodeId: string,
      uploadedUrl: string,
      naturalWidth: number,
      naturalHeight: number,
      baseNodes?: NodeData[] | null,
    ) =>
      { nodes: NodeData[]; edges: EdgeData[]; groups: GroupData[] } | undefined;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    bindUploadedImageToArtifact: (nodeId: string) => boolean;
    setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
    nodeSerialCounter: Record<NodeType, number>;
    setNodeSerialCounter: React.Dispatch<
      React.SetStateAction<Record<NodeType, number>>
    >;
    closeBottomPanels: () => void;
    closePromptMenus: () => void;
    applyAssetCatalogItem: (
      item: AssetCatalogItem,
      targetWorld?: { x: number; y: number },
    ) => void;
    toWorld: (clientX: number, clientY: number) => { x: number; y: number };
    nodeMap: Map<string, NodeData>;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
    canvasGenerationDebugStateModule: ReturnType<
      typeof import("./useCanvasGenerationDebugState").useCanvasGenerationDebugState
    >;
    canvasLibraryViewModule: ReturnType<
      typeof import("./useCanvasLibraryView").useCanvasLibraryView
    >;
    canvasHistoryPanelStateModule: ReturnType<
      typeof import("./useCanvasHistoryPanelState").useCanvasHistoryPanelState
    >;
    canvasProjectRenameStateModule: ReturnType<
      typeof import("./useCanvasProjectRenameState").useCanvasProjectRenameState
    >;
    canvasAssetPanelStateModule: ReturnType<
      typeof import("./useCanvasAssetPanelState").useCanvasAssetPanelState
    >;
  },
) {
  const context = readContext();

  return createCanvasReferenceUploadController({
    ...context.canvasRuntimeRefsModule,
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasConnectionStateModule,
    ...context.canvasStoryboardStateModule,
    activeNode: context.activeNode,
    ensureApiKeyReady: context.ensureApiKeyReady,
    setUploading: context.canvasPromptStateModule.setUploading,
    setStatus: context.canvasPromptStateModule.setStatus,
    showNodeStatusChip: context.showNodeStatusChip,
    uploadFileIntoNode: context.uploadFileIntoNode,
    createImageToImagePresetGroup: context.createImageToImagePresetGroup,
    persistCanvas: context.persistCanvas,
    canvasMeta: context.canvasMeta,
    bindUploadedImageToArtifact: context.bindUploadedImageToArtifact,
    setNodePatch: context.setNodePatch,
    setGenerateDebug: context.canvasGenerationDebugStateModule.setGenerateDebug,
    nodeSerialCounter: context.nodeSerialCounter,
    setNodeSerialCounter: context.setNodeSerialCounter,
    closeBottomPanels: context.closeBottomPanels,
    assetCatalogEntries: context.canvasLibraryViewModule.assetCatalogEntries,
    closePromptMenus: context.closePromptMenus,
    applyAssetCatalogItem: context.applyAssetCatalogItem,
    toWorld: context.toWorld,
    nodeMap: context.nodeMap,
    setHistoryPreviewItem:
      context.canvasHistoryPanelStateModule.setHistoryPreviewItem,
    setHistoryPanelOpen:
      context.canvasProjectRenameStateModule.setHistoryPanelOpen,
    assetManagerOpen: context.canvasAssetPanelStateModule.assetManagerOpen,
  });
}

export function bindModelSettingsController(
  readContext: () => {
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
    canvasModelCatalogStateModule: ReturnType<
      typeof useCanvasModelCatalogState
    >;
    nodeMap: Map<string, NodeData>;
    activeNode: NodeData | null;
    setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
    activeNodeModelOption: AiModelOption | undefined;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    canvasRuntimeRefsModule: ReturnType<
      typeof import("./useCanvasRuntimeRefs").useCanvasRuntimeRefs
    >;
    canvasSelectionStateModule: ReturnType<
      typeof import("./useCanvasSelectionState").useCanvasSelectionState
    >;
    canvasProjectStateModule: ReturnType<
      typeof import("./useCanvasProjectState").useCanvasProjectState
    >;
  },
) {
  const context = readContext();

  return createCanvasModelSettingsController({
    ...context.canvasGraphStateModule,
    ...context.canvasPromptStateModule,
    ...context.canvasModelCatalogStateModule,
    nodeMap: context.nodeMap,
    activeNode: context.activeNode,
    setNodePatch: context.setNodePatch,
    activeNodeModelOption: context.activeNodeModelOption,
    localGeometryEditUntilRef:
      context.canvasRuntimeRefsModule.localGeometryEditUntilRef,
    persistCanvas: context.persistCanvas,
    selectedNodeIds: context.canvasSelectionStateModule.selectedNodeIds,
    activeProjectContextId:
      context.canvasProjectStateModule.activeProjectContextId,
  });
}

export function bindPromptEditingController(
  readContext: () => {
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
    canvasImageEditorStateModule: ReturnType<typeof useCanvasImageEditorState>;
    activeNode: NodeData | null;
    setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    canvasRuntimeRefsModule: ReturnType<
      typeof import("./useCanvasRuntimeRefs").useCanvasRuntimeRefs
    >;
    canvasTitleEditorStateModule: ReturnType<
      typeof import("./useCanvasTitleEditorState").useCanvasTitleEditorState
    >;
    canvasVisibilityViewModule: ReturnType<
      typeof import("./useCanvasVisibilityView").useCanvasVisibilityView
    >;
    canvasGroupStateModule: ReturnType<
      typeof import("./useCanvasGroupState").useCanvasGroupState
    >;
  },
) {
  const context = readContext();

  return createCanvasPromptEditingController({
    ...context.canvasGraphStateModule,
    ...context.canvasPromptStateModule,
    ...context.canvasImageEditorStateModule,
    promptTextareaRef: context.canvasRuntimeRefsModule.promptTextareaRef,
    setPromptEditorScroll:
      context.canvasTitleEditorStateModule.setPromptEditorScroll,
    promptSelectionRef: context.canvasRuntimeRefsModule.promptSelectionRef,
    activeNode: context.activeNode,
    setNodePatch: context.setNodePatch,
    upstreamReferences: context.canvasVisibilityViewModule.upstreamReferences,
    persistCanvas: context.persistCanvas,
    canvasMeta: context.canvasMeta,
    groups: context.canvasGroupStateModule.groups,
  });
}

export function bindCanvasReferencePreviewView(
  readContext: () => {
    canvasColorMode: import("@/ui/theme").ThemeMode;
  },
) {
  const context = readContext();

  return createCanvasReferencePreviewView({
    canvasColorMode: context.canvasColorMode,
  });
}

export function bindCreateUploadController(
  readContext: () => {
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
    beginNodeProgressSimulation: (
      nodeId: string,
      phase: "upload" | "generation",
    ) => void;
    stopNodeProgressTimer: (nodeId: string) => void;
    setNodeUploadProgress: (nodeId: string, progress: number) => void;
    finalizeNodeUploadVisual: (nodeId: string, delayMs?: number) => void;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    assertCanvasOperationActive: (
      expectedEpoch: number,
      signal?: AbortSignal,
    ) => void;
    canvasProjectStateModule: ReturnType<
      typeof import("./useCanvasProjectState").useCanvasProjectState
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
    canvasGenerationDebugStateModule: ReturnType<
      typeof import("./useCanvasGenerationDebugState").useCanvasGenerationDebugState
    >;
  },
) {
  const context = readContext();

  return createCanvasUploadController({
    ...context.canvasRuntimeRefsModule,
    ...context.canvasGraphStateModule,
    setNodePatch: context.setNodePatch,
    activeProjectContextId:
      context.canvasProjectStateModule.activeProjectContextId,
    beginNodeProgressSimulation: context.beginNodeProgressSimulation,
    setStatus: context.canvasPromptStateModule.setStatus,
    stopNodeProgressTimer: context.stopNodeProgressTimer,
    setNodeUploadProgress: context.setNodeUploadProgress,
    finalizeNodeUploadVisual: context.finalizeNodeUploadVisual,
    setGenerateDebug: context.canvasGenerationDebugStateModule.setGenerateDebug,
    persistCanvas: context.persistCanvas,
    assertCanvasOperationActive: context.assertCanvasOperationActive,
  });
}
