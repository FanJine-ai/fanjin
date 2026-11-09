import { type AiModelOption } from "@/lib/api";
import type {
  CanvasHistorySnapshot,
  CanvasModelType,
  EdgeData,
  GroupData,
  ImageEraseKind,
  MenuSource,
  NodeData,
  PendingConnection,
  ProductScriptAssetKind,
  ProductScriptWorkflow,
  ProductStoryboardShot,
  Side,
  VideoGenerationMode,
  VideoStoryAnalysis,
  VideoStoryShot,
  VideoSubtitleEraseType,
} from "./canvasDataTypes";
import { createCanvasEmptyLauncherActions } from "./canvasEmptyLauncherActions";
import { type CanvasRect as Rect } from "./canvasGeometry";
import {
  buildGridCellKey,
  buildGridCellLabel,
  parseGridCellKey,
} from "./canvasGridDefinitions";
import { createCanvasGroupExecutionController } from "./canvasGroupExecutionController";
import { createCanvasInteractionController } from "./canvasInteractionController";
import type { NodeType, RatioKey } from "./canvasMediaTypes";
import { normalizeVideoResolutionForModel } from "./canvasModelDefinitions";
import { createCanvasNodeCreationController } from "./canvasNodeCreationController";
import {
  baseModel,
  createDefaultProductScriptWorkflow,
  createNode,
  normalizeProductScriptWorkflow,
} from "./canvasNodeDefaults";
import { createCanvasNodeMutationController } from "./canvasNodeMutationController";
import { createCanvasNodeOperationsController } from "./canvasNodeOperationsController";
import {
  ALIGN_THRESHOLD_PX,
  CANVAS_VISUAL_SCALE,
  CONNECTION_DRAG_THRESHOLD,
  GROUP_THEME_COLORS,
  PRODUCT_SCRIPT_ASSETS,
  TEXT_PRESET_VIDEO_PROMPT,
} from "./canvasPageConstants";
import { createCanvasPanelActions } from "./canvasPanelActions";
import { createCanvasPresetController } from "./canvasPresetController";
import { createCanvasProductScriptController } from "./canvasProductScriptController";
import { createCanvasProductScriptView } from "./canvasProductScriptView";
import { createCanvasShortcutActions } from "./canvasShortcutActions";
import { createCanvasStoryboardController } from "./canvasStoryboardController";
import { isStoryboardGroup } from "./canvasStoryboardUtils";
import { type CanvasArtifactKind } from "./canvasTextArtifacts";
import { createCanvasViewportController } from "./canvasViewportController";
import type { useCanvasAssetPanelState } from "./useCanvasAssetPanelState";
import type { useCanvasConnectionState } from "./useCanvasConnectionState";
import type { useCanvasGraphState } from "./useCanvasGraphState";
import type { useCanvasGroupState } from "./useCanvasGroupState";
import type { useCanvasPricingDecisions } from "./useCanvasPricingDecisions";
import type { useCanvasProductState } from "./useCanvasProductState";
import type { useCanvasProjectState } from "./useCanvasProjectState";
import type { useCanvasPromptState } from "./useCanvasPromptState";
import type { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import type { useCanvasSelectionState } from "./useCanvasSelectionState";
import type { useCanvasTitleEditorState } from "./useCanvasTitleEditorState";
import type { useCanvasViewportUiState } from "./useCanvasViewportUiState";
import type { useCanvasVisibilityView } from "./useCanvasVisibilityView";
export function bindViewportController(
  readContext: () => {
    nodeMap: Map<string, NodeData>;
    canvasBounds: Rect | null;
    canvasGraphStateModule: ReturnType<
      typeof import("./useCanvasGraphState").useCanvasGraphState
    >;
    canvasRuntimeRefsModule: ReturnType<
      typeof import("./useCanvasRuntimeRefs").useCanvasRuntimeRefs
    >;
    canvasAssetPanelStateModule: ReturnType<
      typeof import("./useCanvasAssetPanelState").useCanvasAssetPanelState
    >;
    canvasSelectionStateModule: ReturnType<
      typeof import("./useCanvasSelectionState").useCanvasSelectionState
    >;
    canvasVisibilityViewModule: ReturnType<
      typeof import("./useCanvasVisibilityView").useCanvasVisibilityView
    >;
  },
) {
  const context = readContext();

  return createCanvasViewportController({
    viewport: context.canvasGraphStateModule.viewport,
    CANVAS_VISUAL_SCALE,
    setCanvasPerformanceMode:
      context.canvasGraphStateModule.setCanvasPerformanceMode,
    canvasInteractionTimerRef:
      context.canvasGraphStateModule.canvasInteractionTimerRef,
    rootRef: context.canvasRuntimeRefsModule.rootRef,
    nodeMap: context.nodeMap,
    assetManagerOpen: context.canvasAssetPanelStateModule.assetManagerOpen,
    setViewport: context.canvasGraphStateModule.setViewport,
    setSelectedNodeIds: context.canvasSelectionStateModule.setSelectedNodeIds,
    setSelectedEdgeIds: context.canvasSelectionStateModule.setSelectedEdgeIds,
    setActiveNodeId: context.canvasSelectionStateModule.setActiveNodeId,
    viewportRef: context.canvasGraphStateModule.viewportRef,
    nodes: context.canvasGraphStateModule.nodes,
    canvasBounds: context.canvasBounds,
    getGroupBoundsMap: () => context.canvasVisibilityViewModule.groupBoundsMap,
    miniMapSurfaceRef: context.canvasRuntimeRefsModule.miniMapSurfaceRef,
  });
}

export function bindNodeCreationController(
  readContext: () => {
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasConnectionStateModule: ReturnType<typeof useCanvasConnectionState>;
    canvasPricingDecisionsModule: ReturnType<typeof useCanvasPricingDecisions>;
    viewportVisualScale: (
      nextViewport?: import("@/pages/fjtv/canvasDataTypes").ViewportState,
    ) => number;
    nodeMap: Map<string, NodeData>;
    studioChrome: boolean;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    nodeSerialCounter: Record<NodeType, number>;
    setNodeSerialCounter: React.Dispatch<
      React.SetStateAction<Record<NodeType, number>>
    >;
    availableModels: AiModelOption[];
    beginNodeGenerationSession: (nodeId: string) => string;
    setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
    finishNodeGenerationSession: (nodeId: string, sessionId?: string) => void;
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
    canvasModelCatalogStateModule: ReturnType<
      typeof import("./useCanvasModelCatalogState").useCanvasModelCatalogState
    >;
    canvasTemplateStateModule: ReturnType<
      typeof import("./useCanvasTemplateState").useCanvasTemplateState
    >;
    canvasProjectRenameStateModule: ReturnType<
      typeof import("./useCanvasProjectRenameState").useCanvasProjectRenameState
    >;
    canvasProjectStateModule: ReturnType<
      typeof import("./useCanvasProjectState").useCanvasProjectState
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
    canvasAssetPanelStateModule: ReturnType<
      typeof import("./useCanvasAssetPanelState").useCanvasAssetPanelState
    >;
  },
) {
  const context = readContext();

  return createCanvasNodeCreationController({
    ...context.canvasRuntimeRefsModule,
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasConnectionStateModule,
    ...context.canvasPricingDecisionsModule,
    viewportVisualScale: context.viewportVisualScale,
    nodeMap: context.nodeMap,
    models: context.canvasModelCatalogStateModule.models,
    setWorkflowPanelOpen:
      context.canvasTemplateStateModule.setWorkflowPanelOpen,
    setHistoryPanelOpen:
      context.canvasProjectRenameStateModule.setHistoryPanelOpen,
    setShortcutPanelOpen:
      context.canvasProjectRenameStateModule.setShortcutPanelOpen,
    studioChrome: context.studioChrome,
    canvasMeta: context.canvasMeta,
    activeProjectContextId:
      context.canvasProjectStateModule.activeProjectContextId,
    setStatus: context.canvasPromptStateModule.setStatus,
    nodeSerialCounter: context.nodeSerialCounter,
    setNodeSerialCounter: context.setNodeSerialCounter,
    assetManagerOpen: context.canvasAssetPanelStateModule.assetManagerOpen,
    availableModels: context.availableModels,
    beginNodeGenerationSession: context.beginNodeGenerationSession,
    setNodePatch: context.setNodePatch,
    finishNodeGenerationSession: context.finishNodeGenerationSession,
    beginNodeProgressSimulation: context.beginNodeProgressSimulation,
    pollTaskUntilDone: context.pollTaskUntilDone,
  });
}

export function bindNodeOperationsController(
  readContext: () => {
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
    canvasTitleEditorStateModule: ReturnType<typeof useCanvasTitleEditorState>;
    canvasAssetPanelStateModule: ReturnType<typeof useCanvasAssetPanelState>;
    canvasViewportUiStateModule: ReturnType<typeof useCanvasViewportUiState>;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    nodeMap: Map<string, NodeData>;
    recordCanvasHistoryMutation: (
      snapshot: CanvasHistorySnapshot,
      previousSnapshot?: CanvasHistorySnapshot,
    ) => any;
    buildHistorySnapshot: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextGroups?: GroupData[],
      nextViewport?: import("@/pages/fjtv/canvasDataTypes").ViewportState,
    ) => CanvasHistorySnapshot;
    focusNodeInViewport: (nodeId: string) => void;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    applyHistorySnapshot: (snapshot: CanvasHistorySnapshot) => any;
    toWorld: (clientX: number, clientY: number) => { x: number; y: number };
    openCreationMenuAtWorld: (
      x: number,
      y: number,
      source: MenuSource,
      nextPending?: PendingConnection | null,
    ) => void;
    canvasLibraryViewModule: ReturnType<
      typeof import("./useCanvasLibraryView").useCanvasLibraryView
    >;
    canvasVisibilityViewModule: ReturnType<
      typeof import("./useCanvasVisibilityView").useCanvasVisibilityView
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
    canvasRuntimeRefsModule: ReturnType<
      typeof import("./useCanvasRuntimeRefs").useCanvasRuntimeRefs
    >;
    canvasConnectionStateModule: ReturnType<
      typeof import("./useCanvasConnectionState").useCanvasConnectionState
    >;
  },
) {
  const context = readContext();

  return createCanvasNodeOperationsController({
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasGroupStateModule,
    ...context.canvasTitleEditorStateModule,
    ...context.canvasAssetPanelStateModule,
    ...context.canvasViewportUiStateModule,
    persistCanvas: context.persistCanvas,
    nodeMap: context.nodeMap,
    recordCanvasHistoryMutation: context.recordCanvasHistoryMutation,
    buildHistorySnapshot: context.buildHistorySnapshot,
    focusNodeInViewport: context.focusNodeInViewport,
    GROUP_THEME_COLORS,
    canvasMeta: context.canvasMeta,
    activeGroup: context.canvasLibraryViewModule.activeGroup,
    activeGroupBounds: context.canvasVisibilityViewModule.activeGroupBounds,
    selectedBounds: context.canvasVisibilityViewModule.selectedBounds,
    setStatus: context.canvasPromptStateModule.setStatus,
    rootRef: context.canvasRuntimeRefsModule.rootRef,
    CANVAS_VISUAL_SCALE,
    locallyDeletedNodeIdsRef:
      context.canvasRuntimeRefsModule.locallyDeletedNodeIdsRef,
    applyHistorySnapshot: context.applyHistorySnapshot,
    toWorld: context.toWorld,
    openCreationMenuAtWorld: context.openCreationMenuAtWorld,
    setEdgeHoverState: context.canvasConnectionStateModule.setEdgeHoverState,
  });
}

export function bindCanvasNodeMutationController(
  readContext: () => {
    canvasGraphStateModule: ReturnType<
      typeof import("./useCanvasGraphState").useCanvasGraphState
    >;
    canvasGenerationDebugStateModule: ReturnType<
      typeof import("./useCanvasGenerationDebugState").useCanvasGenerationDebugState
    >;
  },
) {
  const context = readContext();

  return createCanvasNodeMutationController({
    nodesRef: context.canvasGraphStateModule.nodesRef,
    setGenerateDebug: context.canvasGenerationDebugStateModule.setGenerateDebug,
    setNodes: context.canvasGraphStateModule.setNodes,
  });
}

export function bindCanvasShortcutActions(
  readContext: () => {
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    toWorld: (clientX: number, clientY: number) => { x: number; y: number };
    openCreationMenuAtWorld: (
      x: number,
      y: number,
      source: MenuSource,
      nextPending?: PendingConnection | null,
    ) => void;
    hasDuplicateEdge: (
      fromNodeId: string,
      fromSide: Side,
      toNodeId: string,
      toSide: Side,
    ) => boolean;
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
    canvasAssetPanelStateModule: ReturnType<
      typeof import("./useCanvasAssetPanelState").useCanvasAssetPanelState
    >;
    canvasSelectionStateModule: ReturnType<
      typeof import("./useCanvasSelectionState").useCanvasSelectionState
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
    canvasGroupStateModule: ReturnType<
      typeof import("./useCanvasGroupState").useCanvasGroupState
    >;
  },
) {
  const context = readContext();

  return createCanvasShortcutActions({
    ...context.canvasGraphStateModule,
    rootRef: context.canvasRuntimeRefsModule.rootRef,
    assetManagerOpen: context.canvasAssetPanelStateModule.assetManagerOpen,
    toWorld: context.toWorld,
    openCreationMenuAtWorld: context.openCreationMenuAtWorld,
    selectedNodeIds: context.canvasSelectionStateModule.selectedNodeIds,
    setStatus: context.canvasPromptStateModule.setStatus,
    hasDuplicateEdge: context.hasDuplicateEdge,
    setSelectedEdgeIds: context.canvasSelectionStateModule.setSelectedEdgeIds,
    persistCanvas: context.persistCanvas,
    canvasMeta: context.canvasMeta,
    groups: context.canvasGroupStateModule.groups,
  });
}

export function bindCanvasPanelActions(
  readContext: () => {
    closePromptMenus: () => void;
    closeComposeEditor: () => void;
    closeVideoEditor: () => void;
    canvasConnectionStateModule: ReturnType<
      typeof import("./useCanvasConnectionState").useCanvasConnectionState
    >;
    canvasTemplateStateModule: ReturnType<
      typeof import("./useCanvasTemplateState").useCanvasTemplateState
    >;
    canvasProjectRenameStateModule: ReturnType<
      typeof import("./useCanvasProjectRenameState").useCanvasProjectRenameState
    >;
  },
) {
  const context = readContext();

  return createCanvasPanelActions({
    closePromptMenus: context.closePromptMenus,
    setCreationMenu: context.canvasConnectionStateModule.setCreationMenu,
    setPendingConnection:
      context.canvasConnectionStateModule.setPendingConnection,
    setWorkflowPanelOpen:
      context.canvasTemplateStateModule.setWorkflowPanelOpen,
    setHistoryPanelOpen:
      context.canvasProjectRenameStateModule.setHistoryPanelOpen,
    setShortcutPanelOpen:
      context.canvasProjectRenameStateModule.setShortcutPanelOpen,
    closeComposeEditor: context.closeComposeEditor,
    closeVideoEditor: context.closeVideoEditor,
  });
}

export function bindGroupExecutionController(
  readContext: () => {
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
    generateWithActiveNode: (targetOverride?: NodeData) => Promise<boolean>;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    canvasVisibilityViewModule: ReturnType<
      typeof import("./useCanvasVisibilityView").useCanvasVisibilityView
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
  },
) {
  const context = readContext();

  return createCanvasGroupExecutionController({
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasGroupStateModule,
    groupBoundsMap: context.canvasVisibilityViewModule.groupBoundsMap,
    setStatus: context.canvasPromptStateModule.setStatus,
    generateWithActiveNode: context.generateWithActiveNode,
    persistCanvas: context.persistCanvas,
  });
}

export function bindProductScriptView(
  readContext: () => {
    canvasCapabilities: import("@/pages/fjtv/canvasCapabilities").CanvasRealCapabilities;
    getProductScriptWorkflow: (node: NodeData) => ProductScriptWorkflow;
    openProductScriptVideoUpload: (nodeId: string) => void;
    updateProductScriptShot: (
      nodeId: string,
      rowIndex: number,
      field: keyof VideoStoryShot | string,
      value: string,
    ) => void;
    saveProductScriptWorkflow: (
      nodeId: string,
      updater:
        | ProductScriptWorkflow
        | ((current: ProductScriptWorkflow) => ProductScriptWorkflow),
    ) => null;
    submitProductAssetsAnalysis: (nodeId: string) => Promise<void>;
    openProductScriptAssetUpload: (
      nodeId: string,
      kind: ProductScriptAssetKind,
    ) => void;
    updateProductAnalysisText: (
      nodeId: string,
      field: "overallStyle" | "sellingPoints" | "visualKeywords" | "avoidNotes",
      value: string,
    ) => void;
    submitProductStoryboardCompose: (nodeId: string) => Promise<void>;
    updateProductStoryboardShot: (
      nodeId: string,
      rowIndex: number,
      field: keyof ProductStoryboardShot | string,
      value: string,
    ) => void;
    nodeMap: Map<string, NodeData>;
    generateProductScriptVideos: (nodeId: string) => Promise<void>;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
    canvasProductStateModule: ReturnType<
      typeof import("./useCanvasProductState").useCanvasProductState
    >;
  },
) {
  const context = readContext();

  return createCanvasProductScriptView({
    setStatus: context.canvasPromptStateModule.setStatus,
    canvasCapabilities: context.canvasCapabilities,
    getProductScriptWorkflow: context.getProductScriptWorkflow,
    setProductScriptFullscreenNodeId:
      context.canvasProductStateModule.setProductScriptFullscreenNodeId,
    openProductScriptVideoUpload: context.openProductScriptVideoUpload,
    updateProductScriptShot: context.updateProductScriptShot,
    saveProductScriptWorkflow: context.saveProductScriptWorkflow,
    submitProductAssetsAnalysis: context.submitProductAssetsAnalysis,
    PRODUCT_SCRIPT_ASSETS,
    openProductScriptAssetUpload: context.openProductScriptAssetUpload,
    updateProductAnalysisText: context.updateProductAnalysisText,
    submitProductStoryboardCompose: context.submitProductStoryboardCompose,
    updateProductStoryboardShot: context.updateProductStoryboardShot,
    productScriptFullscreenNodeId:
      context.canvasProductStateModule.productScriptFullscreenNodeId,
    nodeMap: context.nodeMap,
    generateProductScriptVideos: context.generateProductScriptVideos,
  });
}

export function bindProductScriptController(
  readContext: () => {
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasProductStateModule: ReturnType<typeof useCanvasProductState>;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    ensureApiKeyReady: () => boolean;
    uploadMediaFileToRemote: (
      file: File,
      type: "image" | "video",
      nodeId?: string,
    ) => Promise<any>;
    assertCanvasOperationActive: (
      expectedEpoch: number,
      signal?: AbortSignal,
    ) => void;
    nodeMap: Map<string, NodeData>;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    preflightCanvasModel: (
      modelType: CanvasModelType,
      requestedModelId?: string,
      options?: { allowCatalogDefault?: boolean; openPicker?: boolean },
    ) => AiModelOption | null;
    setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
    beginNodeGenerationSession: (nodeId: string) => string;
    parseDurationSeconds: (raw?: string) => number;
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
    setNodeSerialCounter: React.Dispatch<
      React.SetStateAction<Record<NodeType, number>>
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

  return createCanvasProductScriptController({
    ...context.canvasRuntimeRefsModule,
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasProductStateModule,
    normalizeProductScriptWorkflow,
    persistCanvas: context.persistCanvas,
    PRODUCT_SCRIPT_ASSETS,
    ensureApiKeyReady: context.ensureApiKeyReady,
    uploadMediaFileToRemote: context.uploadMediaFileToRemote,
    assertCanvasOperationActive: context.assertCanvasOperationActive,
    setStatus: context.canvasPromptStateModule.setStatus,
    nodeMap: context.nodeMap,
    createDefaultProductScriptWorkflow,
    canvasMeta: context.canvasMeta,
    preflightCanvasModel: context.preflightCanvasModel,
    setNodePatch: context.setNodePatch,
    activeProjectContextId:
      context.canvasProjectStateModule.activeProjectContextId,
    beginNodeGenerationSession: context.beginNodeGenerationSession,
    parseDurationSeconds: context.parseDurationSeconds,
    normalizeVideoResolutionForModel,
    isNodeGenerationSessionCurrent: context.isNodeGenerationSessionCurrent,
    beginNodeProgressSimulation: context.beginNodeProgressSimulation,
    pollTaskUntilDone: context.pollTaskUntilDone,
    applyTaskResultToNode: context.applyTaskResultToNode,
    finishNodeGenerationSession: context.finishNodeGenerationSession,
    createNode,
    setNodeSerialCounter: context.setNodeSerialCounter,
  });
}

export function bindStoryboardController(
  readContext: () => {
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
    canvasVisibilityViewModule: ReturnType<typeof useCanvasVisibilityView>;
    createImageGridCellNode: (
      sourceNode: NodeData,
      row: number,
      col: number,
      rows: number,
      cols: number,
      left: number,
      top: number,
      slotWidth: number,
      slotHeight: number,
      stamp: number,
      suffix: string,
    ) => NodeData;
    nodeMap: Map<string, NodeData>;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    uploadMediaFileToRemote: (
      file: File,
      type: "image" | "video",
      nodeId?: string,
    ) => Promise<any>;
    assertCanvasOperationActive: (
      expectedEpoch: number,
      signal?: AbortSignal,
    ) => void;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
    canvasRuntimeRefsModule: ReturnType<
      typeof import("./useCanvasRuntimeRefs").useCanvasRuntimeRefs
    >;
  },
) {
  const context = readContext();

  return createCanvasStoryboardController({
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasGroupStateModule,
    ...context.canvasVisibilityViewModule,
    createImageGridCellNode: context.createImageGridCellNode,
    buildGridCellLabel,
    isStoryboardGroup,
    buildGridCellKey,
    setStatus: context.canvasPromptStateModule.setStatus,
    nodeMap: context.nodeMap,
    persistCanvas: context.persistCanvas,
    canvasMeta: context.canvasMeta,
    canvasContextEpochRef:
      context.canvasRuntimeRefsModule.canvasContextEpochRef,
    uploadMediaFileToRemote: context.uploadMediaFileToRemote,
    assertCanvasOperationActive: context.assertCanvasOperationActive,
    createNode,
  });
}

export function bindPresetController(
  readContext: () => {
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
    nodeMap: Map<string, NodeData>;
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    canvasTitleEditorStateModule: ReturnType<
      typeof import("./useCanvasTitleEditorState").useCanvasTitleEditorState
    >;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
  },
) {
  const context = readContext();

  return createCanvasPresetController({
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasGroupStateModule,
    nodeMap: context.nodeMap,
    TEXT_PRESET_VIDEO_PROMPT,
    baseModel,
    createNode,
    setEditingTextNodeId:
      context.canvasTitleEditorStateModule.setEditingTextNodeId,
    setTextEditorDraft: context.canvasTitleEditorStateModule.setTextEditorDraft,
    persistCanvas: context.persistCanvas,
    canvasMeta: context.canvasMeta,
    setStatus: context.canvasPromptStateModule.setStatus,
  });
}

export function bindInteractionController(
  readContext: () => {
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
    canvasConnectionStateModule: ReturnType<typeof useCanvasConnectionState>;
    canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
    canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
    canvasTitleEditorStateModule: ReturnType<typeof useCanvasTitleEditorState>;
    canvasProjectStateModule: ReturnType<typeof useCanvasProjectState>;
    toWorld: (clientX: number, clientY: number) => { x: number; y: number };
    connectionSideToward: (node: NodeData, targetX: number) => Side;
    closePromptMenus: () => void;
    markCanvasInteraction: () => void;
    viewportVisualScale: (
      nextViewport?: import("@/pages/fjtv/canvasDataTypes").ViewportState,
    ) => number;
    nodeMap: Map<string, NodeData>;
    createDetachedImageGridCellNode: (
      sourceNode: NodeData,
      row: number,
      col: number,
      rows: number,
      cols: number,
      left: number,
      top: number,
      stamp: number,
    ) => {
      title: string;
      titleCustomized: true;
      x: number;
      y: number;
      width: number;
      height: number;
      ratio: RatioKey;
      cropX: number;
      cropY: number;
      cropWidth: number;
      cropHeight: number;
      mediaNaturalWidth: number | undefined;
      mediaNaturalHeight: number | undefined;
      storyboardCellKey: string;
      storyboardSlotOrder: number;
      id: string;
      type: NodeType;
      prompt: string;
      promptPlaceholder?: string;
      model: string;
      quality: string;
      resolution: string;
      cameraControl: string;
      cameraSettings?: import("@/pages/fjtv/canvasDataTypes").CameraSettings;
      panorama: string;
      quantity: string;
      maxImages?: import("@/pages/fjtv/canvasDataTypes").MaxImageCount;
      videoGenerateAudio?: boolean;
      videoMode?: VideoGenerationMode;
      videoRenderMode?: "draft" | "finalize";
      videoOutputFormat?: import("@/features/quick-create/videoOutputContract").VideoOutputFormat;
      videoDraftTaskId?: string;
      videoDraftExpiresAt?: number;
      videoDraftParentNodeId?: string;
      price: string;
      duration?: string;
      outputText?: string;
      isGenerating?: boolean;
      generationState?: "idle" | "submitting" | "processing" | "cancelled";
      taskId?: string;
      taskKind?: "generation" | "video_enhance";
      taskStatus?:
        | "idle"
        | "processing"
        | "pending_reconcile"
        | "query_failed"
        | "success"
        | "failed";
      textGenerationAttemptId?: string;
      imageGenerationAttemptId?: string;
      imageRequestAttempt?: { id: string; payload: Record<string, any> };
      imagePendingMessage?: string;
      imagePendingCode?: string;
      videoGenerationAttemptId?: string;
      videoRequestAttempt?: { id: string; payload: Record<string, any> };
      videoEnhanceAttemptId?: string;
      imageUrl?: string;
      primaryImageUrl?: string;
      imageResultVersion?: number;
      generatedImages?: import("@/pages/fjtv/canvasTaskResults").GeneratedImageChoice[];
      imageChoicesCollapsed?: boolean;
      localPreviewUrl?: string;
      videoUrl?: string;
      localVideoUrl?: string;
      videoPosterUrl?: string;
      generationVersions?: Array<{
        version: number;
        kind: "image" | "video";
        url: string;
        posterUrl?: string;
        createdAt?: number;
        label?: string;
        draftTaskId?: string;
        draftExpiresAt?: number;
      }>;
      activeGenerationVersion?: number;
      suppressEmptyTryActions?: boolean;
      fileName?: string;
      uploadState?: "idle" | "preparing" | "uploading" | "failed";
      uploadProgress?: number;
      uploadError?: string;
      generationProgress?: number;
      reportedGenerationProgress?: number;
      preparationStage?: "portrait_registration";
      statusMessage?: string;
      statusChipText?: string;
      statusChipTone?: "neutral" | "success" | "error";
      mediaAssetId?: string;
      mediaAssetUrl?: string;
      mediaDurationMs?: number;
      videoTrimStart?: number;
      videoTrimEnd?: number;
      videoRewriteSourceVideoUrl?: string;
      videoRewriteSourceAssetVersionId?: number;
      videoRewriteSourceReferenceAssetUri?: string;
      videoRewriteOutputVideoUrl?: string;
      videoRewriteOutputAssetVersionId?: number;
      videoRewriteOutputReferenceAssetUri?: string;
      videoRewriteInstruction?: string;
      videoRewriteStartMs?: number;
      videoRewriteEndMs?: number;
      videoRewriteViewing?: "source" | "output";
      videoRewritePending?: boolean;
      videoLoopSelection?: boolean;
      videoSnapToWholeSecond?: boolean;
      videoEnhanceMode?: boolean;
      videoEnhanceModel?: string;
      videoEnhanceVersion?: import("@/pages/fjtv/canvasDataTypes").VideoEnhanceVersion;
      videoEnhanceResolution?: import("@/pages/fjtv/canvasDataTypes").VideoEnhanceResolution;
      videoEnhanceFrameRate?: import("@/pages/fjtv/canvasDataTypes").VideoEnhanceFrameRate;
      videoEnhanceAvailableResolutions?: import("@/pages/fjtv/canvasDataTypes").VideoEnhanceResolution[];
      videoEnhanceQuoteGu?: Partial<
        Record<
          import("@/pages/fjtv/canvasDataTypes").VideoEnhanceResolution,
          number
        >
      >;
      videoSubtitleEraseMode?: boolean;
      videoSubtitleEraseType?: VideoSubtitleEraseType;
      videoSubtitleEraseAreas?: import("@/pages/fjtv/canvasDataTypes").EraseRatioLocation[];
      videoStoryAnalysis?: VideoStoryAnalysis;
      videoStoryAnalyzing?: boolean;
      videoStoryTaskId?: number;
      videoStoryTaskState?: import("@/pages/fjtv/canvasDataTypes").VideoStoryTaskState;
      videoStoryFailureReason?: string;
      videoStoryAttemptId?: string;
      videoStoryStoryboardGroupId?: string;
      scriptWorkflow?: ProductScriptWorkflow;
      audioSeparateMode?: boolean;
      audioSeparateRole?: import("@/pages/fjtv/canvasDataTypes").AudioSeparateRole;
      imageEnhanceMode?: boolean;
      imageEnhanceVersion?: import("@/pages/fjtv/canvasDataTypes").ImageEnhanceVersion;
      imageEnhanceFactor?: number;
      imageOutpaintMode?: boolean;
      imageOutpaintRatioMode?: import("@/pages/fjtv/canvasMediaTypes").ImageOutpaintRatioMode;
      imageOutpaintResolution?: import("@/pages/fjtv/canvasMediaTypes").ImageOutpaintResolution;
      imageOutpaintCount?: number;
      imageCropMode?: boolean;
      imageCropRatioMode?: import("@/pages/fjtv/canvasMediaTypes").ImageOutpaintRatioMode;
      imageBackgroundRemoveMode?: boolean;
      imageEraseMode?: boolean;
      imageEraseKind?: ImageEraseKind;
      imageEraseText?: string;
      imageTransformMode?: boolean;
      imageRotation?: number;
      imageFlipX?: boolean;
      imageFlipY?: boolean;
      audioUrl?: string;
      localAudioUrl?: string;
      audioVoice?: string;
      audioMood?: string;
      textVisited?: boolean;
      textBackgroundColor?: string;
      textHeading?: import("@/pages/fjtv/canvasDataTypes").TextNodeHeading;
      textFontSize?: number;
      textBold?: boolean;
      textItalic?: boolean;
      textListStyle?: import("@/pages/fjtv/canvasDataTypes").TextNodeListStyle;
      textDivider?: boolean;
      textExpanded?: boolean;
      composeMuted?: boolean;
      composeTimeline?: import("@/pages/fjtv/canvasComposeTimeline").PersistedComposeClip[];
      composeRenderAttemptId?: string;
      referenceAssetUri?: string;
      assetVersionId?: number;
      sourceImageNodeId?: string;
      inputAssetVersionId?: number;
      firstFrameAssetVersionId?: number;
      referenceAssetKind?: "portrait";
      referenceAssetPreviewUrl?: string;
      storyboardSlotFilledByUser?: boolean;
      storyboardSlotPlaceholder?: boolean;
      textArtifacts?: import("@/pages/fjtv/canvasTextArtifacts").CanvasTextArtifacts;
      textArtifactTab?: "body" | CanvasArtifactKind;
      textArtifactInstruction?: string;
      textArtifactBindings?: import("@/pages/fjtv/canvasTextArtifacts").CanvasArtifactBinding[];
      textArtifactSourceModes?: Record<string, "body" | "cards">;
      artifactImageTarget?: import("@/pages/fjtv/canvasTextArtifacts").CanvasArtifactBinding;
      textRequestAttempt?: {
        id: string;
        payload: import("@/pages/fjtv/canvasTextArtifacts").CanvasTextRequest;
      };
      artifactRevision?: number;
      textContentVersion?: number;
    };
    persistCanvas: (
      nextNodes?: NodeData[],
      nextEdges?: EdgeData[],
      nextName?: string,
      nextGroups?: GroupData[],
    ) => any;
    interactionPerformanceMode: boolean;
    detectEdgeDropTarget: (
      worldX: number,
      worldY: number,
      fromNodeId: string,
    ) => { nodeId: string; side: Side } | null;
    nodeSocket: (node: NodeData, side: Side) => { x: number; y: number };
    detectEdgeHover: (
      worldX: number,
      worldY: number,
    ) => {
      edgeId: string;
      point: { x: number; y: number };
      distance: number;
    } | null;
    commitGroupTitle: (groupId: string, fallbackTitle: string) => void;
    cancelGroupTitleEdit: () => void;
    edgeHitToleranceInWorld: () => number;
    removeEdge: (edgeId: string) => void;
    beginGroupDrag: (
      group: GroupData,
      startWorldX: number,
      startWorldY: number,
      startBounds: Rect,
    ) => void;
    commitTextNodeEditing: () => void;
    resetSelectedExpandedTextNodes: () => boolean;
    closeBottomPanels: () => void;
    edgeIntersectsRect: (edge: EdgeData, rect: Rect) => boolean;
    hasDuplicateEdge: (
      fromNodeId: string,
      fromSide: Side,
      toNodeId: string,
      toSide: Side,
    ) => boolean;
    admitCanvasReferenceEdge: (
      fromNodeId: string,
      toNodeId: string,
    ) => { ok: true } | { ok: false; message: string };
    openCreationMenuAtWorld: (
      x: number,
      y: number,
      source: MenuSource,
      nextPending?: PendingConnection | null,
    ) => void;
    canvasViewportUiStateModule: ReturnType<
      typeof import("./useCanvasViewportUiState").useCanvasViewportUiState
    >;
    canvasVisibilityViewModule: ReturnType<
      typeof import("./useCanvasVisibilityView").useCanvasVisibilityView
    >;
    canvasLibraryViewModule: ReturnType<
      typeof import("./useCanvasLibraryView").useCanvasLibraryView
    >;
    canvasStoryboardStateModule: ReturnType<
      typeof import("./useCanvasStoryboardState").useCanvasStoryboardState
    >;
  },
) {
  const context = readContext();

  return createCanvasInteractionController({
    ...context.canvasRuntimeRefsModule,
    ...context.canvasGraphStateModule,
    ...context.canvasSelectionStateModule,
    ...context.canvasConnectionStateModule,
    ...context.canvasGroupStateModule,
    ...context.canvasPromptStateModule,
    ...context.canvasTitleEditorStateModule,
    ...context.canvasProjectStateModule,
    toWorld: context.toWorld,
    connectionSideToward: context.connectionSideToward,
    closePromptMenus: context.closePromptMenus,
    CONNECTION_DRAG_THRESHOLD,
    markCanvasInteraction: context.markCanvasInteraction,
    ALIGN_THRESHOLD_PX,
    viewportVisualScale: context.viewportVisualScale,
    nodeMap: context.nodeMap,
    parseGridCellKey,
    createDetachedImageGridCellNode: context.createDetachedImageGridCellNode,
    persistCanvas: context.persistCanvas,
    gridSnapEnabled: context.canvasViewportUiStateModule.gridSnapEnabled,
    interactionPerformanceMode: context.interactionPerformanceMode,
    visibleNodeIdSet: context.canvasVisibilityViewModule.visibleNodeIdSet,
    detectEdgeDropTarget: context.detectEdgeDropTarget,
    nodeSocket: context.nodeSocket,
    detectEdgeHover: context.detectEdgeHover,
    commitGroupTitle: context.commitGroupTitle,
    cancelGroupTitleEdit: context.cancelGroupTitleEdit,
    edgeHitToleranceInWorld: context.edgeHitToleranceInWorld,
    removeEdge: context.removeEdge,
    activeGroup: context.canvasLibraryViewModule.activeGroup,
    activeGroupBounds: context.canvasVisibilityViewModule.activeGroupBounds,
    beginGroupDrag: context.beginGroupDrag,
    commitTextNodeEditing: context.commitTextNodeEditing,
    resetSelectedExpandedTextNodes: context.resetSelectedExpandedTextNodes,
    closeBottomPanels: context.closeBottomPanels,
    setStoryboardSlotMenuNodeId:
      context.canvasStoryboardStateModule.setStoryboardSlotMenuNodeId,
    setStoryboardSlotMenuPosition:
      context.canvasStoryboardStateModule.setStoryboardSlotMenuPosition,
    canvasPointerMode: context.canvasViewportUiStateModule.canvasPointerMode,
    edgeIntersectsRect: context.edgeIntersectsRect,
    hasDuplicateEdge: context.hasDuplicateEdge,
    admitCanvasReferenceEdge: context.admitCanvasReferenceEdge,
    openCreationMenuAtWorld: context.openCreationMenuAtWorld,
    CANVAS_VISUAL_SCALE,
  });
}

export function bindCanvasEmptyLauncherActions(
  readContext: () => {
    startQuickCharacterThreeView: () => void;
    createNodeAt: (
      type: NodeType,
      worldX: number,
      worldY: number,
    ) => string | undefined;
    canvasPromptStateModule: ReturnType<
      typeof import("./useCanvasPromptState").useCanvasPromptState
    >;
  },
) {
  const context = readContext();

  return createCanvasEmptyLauncherActions({
    startQuickCharacterThreeView: context.startQuickCharacterThreeView,
    createNodeAt: context.createNodeAt,
    setStatus: context.canvasPromptStateModule.setStatus,
  });
}
