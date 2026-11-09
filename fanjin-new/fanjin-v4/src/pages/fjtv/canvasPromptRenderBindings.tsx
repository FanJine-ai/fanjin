import { type AiModelOption } from "@/lib/api";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Layers3,
  LoaderCircle,
} from "lucide-react";
import { getCanvasCompactNodeEditorLayout } from "./canvasAdaptiveLayout";
import {
  getCanvasCatalogVideoDefaultOutputFormat,
  getCanvasCatalogVideoOutputFormats,
} from "./canvasCatalogContract";
import { CanvasCompactNodeEditorLauncher } from "./CanvasCompactNodeEditorLauncher";
import { renderCompactPromptLauncher } from "./canvasCompactPromptLauncher";
import type {
  EdgeData,
  GroupData,
  NodeData,
  UpstreamReferenceItem,
} from "./canvasDataTypes";
import { renderGenerateButton as renderGenerateButtonExternal } from "./canvasGenerateButton";
import {
  bindCanvasReferencePreviewView,
  bindCanvasSubmitButtonView,
} from "./canvasGenerationBindings";
import {
  getCanvasImageOutputCounts,
  normalizeNodeMaxImages,
} from "./canvasImageOutputCount";
import { renderImageOutputCountSelector as renderImageOutputCountSelectorExternal } from "./canvasImageOutputCountSelector";
import { bindCanvasStoryboardVideoPromptView } from "./canvasMediaBindings";
import type { RatioKey } from "./canvasMediaTypes";
import { renderModelCatalogStatus as renderModelCatalogStatusExternal } from "./canvasModelCatalogStatus";
import {
  buildVideoSettingsSummary,
  getAiModelUnavailableMessage,
  getCatalogRatioPanelItems,
  getModelVisualMeta,
  getVideoResolutionOptions,
  normalizeNodeResolution,
  normalizeVideoResolutionForModel,
} from "./canvasModelDefinitions";
import { shouldHideCanvasPromptShell } from "./canvasNodeDefaults";
import { PROMPT_PANEL_FONT_STACK } from "./canvasPageConstants";
import {
  renderPromptEditorExternal,
  type PromptEditorOptions,
} from "./canvasPromptEditor";
import { renderPromptReferenceCapsuleExternal } from "./canvasPromptReferenceCapsule";
import { createCanvasPromptShell } from "./canvasPromptShell";
import {
  renderReferencePickerExternal,
  renderUpstreamReferenceStripExternal,
} from "./canvasReferenceStrip";
import { patchLooksActivelyGenerating } from "./canvasTaskState";
import { renderVideoOutputFormatPickerExternal } from "./canvasVideoOutputFormatPicker";
import { renderCanvasVideoPromptTabs } from "./CanvasVideoPromptTabs";
import { useCanvasActiveModelView } from "./useCanvasActiveModelView";
import { useCanvasGraphState } from "./useCanvasGraphState";
import { useCanvasPromptState } from "./useCanvasPromptState";
export function createCanvasPromptRenderBindings(context: {
  canvasSubmitButtonView: () => ReturnType<typeof bindCanvasSubmitButtonView>;
  canvasReferencePreviewView: () => ReturnType<
    typeof bindCanvasReferencePreviewView
  >;
  canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
  canvasColorMode: import("@/ui/theme").ThemeMode;
  insertReferenceIntoPrompt: (reference: UpstreamReferenceItem) => void;
  activeNode: NodeData | null;
  bindPromptTextarea: (element: HTMLTextAreaElement | null) => void;
  handlePromptInputChange: (
    value: string,
    element: HTMLTextAreaElement,
  ) => void;
  rememberPromptSelection: (element: HTMLTextAreaElement | null) => void;
  handlePromptTextareaKeyDown: (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => void;
  syncPromptEditorScroll: (element: HTMLTextAreaElement | null) => void;
  activeNodeModelOption: import("@/lib/api").AiModelOption | undefined;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
  showNodeStatusChip: (
    nodeId: string,
    text: string,
    tone?: "neutral" | "success" | "error",
    durationMs?: number,
  ) => void;
  persistCanvas: (
    nextNodes?: NodeData[],
    nextEdges?: EdgeData[],
    nextName?: string,
    nextGroups?: GroupData[],
  ) => Promise<string | null>;
  canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
  canvasStoryboardVideoPromptView: () => ReturnType<
    typeof bindCanvasStoryboardVideoPromptView
  >;
  nodeHasSubmittingSession: (nodeId: string) => boolean;
  getModelGenerationUnavailableMessage: (node: NodeData) => string;
  generateWithActiveNode: (targetOverride?: NodeData) => Promise<boolean>;
  canvasActiveModelViewModule: ReturnType<typeof useCanvasActiveModelView>;
  renderNodeEditorPositionToggle: () => React.ReactNode;
  closePromptMenus: () => void;
  renderCanvasArtifactSourcePicker: (node: NodeData) => React.ReactNode;
  setActiveNodeModel: (model: AiModelOption) => void;
  setActiveNodeResolution: (next: "1K" | "2K" | "4K") => void;
  setActiveNodeRatio: (nextRatio: RatioKey) => void;
  openCameraPanel: () => void;
  renderCanvasArtifactToolbar: (node: NodeData) => React.JSX.Element;
  setActiveNodeResolutionGeneric: (next: string) => void;
  parseDurationSeconds: (raw?: string) => number;
  setActiveNodeDuration: (nextSeconds: number) => void;
  setActiveNodeGenerateAudio: (enabled: boolean) => void;
  canvasVisibilityViewModule: ReturnType<
    typeof import("./useCanvasVisibilityView").useCanvasVisibilityView
  >;
  canvasRuntimeRefsModule: ReturnType<
    typeof import("./useCanvasRuntimeRefs").useCanvasRuntimeRefs
  >;
  canvasTitleEditorStateModule: ReturnType<
    typeof import("./useCanvasTitleEditorState").useCanvasTitleEditorState
  >;
  canvasGroupStateModule: ReturnType<
    typeof import("./useCanvasGroupState").useCanvasGroupState
  >;
  canvasModelCatalogStateModule: ReturnType<
    typeof import("./useCanvasModelCatalogState").useCanvasModelCatalogState
  >;
  canvasInlineEditorViewModule: ReturnType<
    typeof import("./useCanvasInlineEditorView").useCanvasInlineEditorView
  >;
  canvasVideoEditorStateModule: ReturnType<
    typeof import("./useCanvasVideoEditorState").useCanvasVideoEditorState
  >;
  canvasImageEditorStateModule: ReturnType<
    typeof import("./useCanvasImageEditorState").useCanvasImageEditorState
  >;
  canvasAssetPanelStateModule: ReturnType<
    typeof import("./useCanvasAssetPanelState").useCanvasAssetPanelState
  >;
}) {
  function renderCompactSubmitButton(
    key: string,
    action: () => Promise<void> | void,
    className = "flex h-10 w-10 items-center justify-center rounded-[12px] bg-white text-[#1a1b1d] disabled:cursor-wait disabled:opacity-80",
    iconClassName = "h-4.5 w-4.5",
    blocked = false,
  ) {
    return context
      .canvasSubmitButtonView()
      .renderCompactSubmitButton(
        key,
        action,
        className,
        iconClassName,
        blocked,
      );
  }

  function renderReferenceVisual(
    reference: UpstreamReferenceItem,
    sizeClass = "h-full w-full",
  ) {
    return context
      .canvasReferencePreviewView()
      .renderReferenceVisual(reference, sizeClass);
  }

  function renderUpstreamReferenceStrip(options?: {
    showPickerButton?: boolean;
    compact?: boolean;
    marginClassName?: string;
  }) {
    return renderUpstreamReferenceStripExternal(
      {
        ...context.canvasPromptStateModule,
        upstreamReferences:
          context.canvasVisibilityViewModule.upstreamReferences,
        canvasColorMode: context.canvasColorMode,
        renderReferenceVisual,
        insertReferenceIntoPrompt: context.insertReferenceIntoPrompt,
      },
      options,
    );
  }

  function renderReferencePicker() {
    return renderReferencePickerExternal({
      upstreamReferences: context.canvasVisibilityViewModule.upstreamReferences,
      referencePickerOpen: context.canvasPromptStateModule.referencePickerOpen,
      renderReferenceVisual,
      insertReferenceIntoPrompt: context.insertReferenceIntoPrompt,
    });
  }

  function renderPromptReferenceCapsule(referenceLabel: string) {
    return renderPromptReferenceCapsuleExternal(
      {
        upstreamReferenceLabelMap:
          context.canvasVisibilityViewModule.upstreamReferenceLabelMap,
        renderReferenceVisual,
      },
      referenceLabel,
    );
  }

  function renderPromptEditor(options: PromptEditorOptions) {
    return renderPromptEditorExternal(options, {
      expanded: context.canvasPromptStateModule.expanded,
      activeNode: context.activeNode,
      bindPromptTextarea: context.bindPromptTextarea,
      handlePromptInputChange: context.handlePromptInputChange,
      rememberPromptSelection: context.rememberPromptSelection,
      canvasColorMode: context.canvasColorMode,
      promptTextareaRef: context.canvasRuntimeRefsModule.promptTextareaRef,
      promptEditorScroll:
        context.canvasTitleEditorStateModule.promptEditorScroll,
      renderPromptReferenceCapsule,
      handlePromptTextareaKeyDown: context.handlePromptTextareaKeyDown,
      syncPromptEditorScroll: context.syncPromptEditorScroll,
    });
  }

  function renderVideoOutputFormatPicker() {
    return renderVideoOutputFormatPickerExternal({
      activeNode: context.activeNode,
      activeNodeModelOption: context.activeNodeModelOption,
      getCanvasCatalogVideoOutputFormats,
      getCanvasCatalogVideoDefaultOutputFormat,
      setNodePatch: context.setNodePatch,
    });
  }

  function renderVideoPromptTabs() {
    return renderCanvasVideoPromptTabs({
      ...context.canvasGraphStateModule,
      ...context.canvasPromptStateModule,
      activeNodeVideoReferenceSummary:
        context.canvasActiveModelViewModule.activeNodeVideoReferenceSummary,
      activeNode: context.activeNode,
      activeNodeModelOption: context.activeNodeModelOption,
      setNodePatch: context.setNodePatch,
      showNodeStatusChip: context.showNodeStatusChip,
      persistCanvas: context.persistCanvas,
      canvasMeta: context.canvasMeta,
      groups: context.canvasGroupStateModule.groups,
    });
  }

  function renderStoryboardVideoPrompt() {
    return context
      .canvasStoryboardVideoPromptView()
      .renderStoryboardVideoPrompt();
  }

  function renderModelCatalogStatus() {
    return renderModelCatalogStatusExternal(
      context.canvasActiveModelViewModule.activeModelCatalogStatusMessage,
      context.canvasModelCatalogStateModule.modelCatalogState,
      context.canvasModelCatalogStateModule.setModelCatalogReloadToken,
      LoaderCircle,
    );
  }

  function renderGenerateButton(node: NodeData) {
    return renderGenerateButtonExternal(node, {
      generateButtonPendingNodeIds:
        context.canvasPromptStateModule.generateButtonPendingNodeIds,
      nodeHasSubmittingSession: context.nodeHasSubmittingSession,
      patchLooksActivelyGenerating,
      getModelGenerationUnavailableMessage:
        context.getModelGenerationUnavailableMessage,
      setGenerateButtonPendingNodeIds:
        context.canvasPromptStateModule.setGenerateButtonPendingNodeIds,
      generateWithActiveNode: context.generateWithActiveNode,
      LoaderCircle,
      ArrowUp,
    });
  }

  function renderImageOutputCountSelector() {
    return renderImageOutputCountSelectorExternal({
      ...context.canvasPromptStateModule,
      activeNode: context.activeNode,
      activeNodeModelOption: context.activeNodeModelOption,
      getCanvasImageOutputCounts,
      normalizeNodeMaxImages,
      Layers3,
      ChevronDown,
      setNodePatch: context.setNodePatch,
      Check,
    });
  }

  function renderCollapsedPromptShell() {
    return createCanvasPromptShell({
      ...context.canvasPromptStateModule,
      ...context.canvasActiveModelViewModule,
      activeNode: context.activeNode,
      controlsPos: context.canvasInlineEditorViewModule.controlsPos,
      shouldHideCanvasPromptShell,
      activeVideoEditor: context.canvasVideoEditorStateModule.activeVideoEditor,
      imageGridSplitEditor:
        context.canvasImageEditorStateModule.imageGridSplitEditor,
      getInlineNodeEditorStyle:
        context.canvasInlineEditorViewModule.getInlineNodeEditorStyle,
      renderNodeEditorPositionToggle: context.renderNodeEditorPositionToggle,
      closePromptMenus: context.closePromptMenus,
      renderUpstreamReferenceStrip,
      renderCanvasArtifactSourcePicker:
        context.renderCanvasArtifactSourcePicker,
      renderReferencePicker,
      renderPromptEditor,
      renderModelCatalogStatus,
      getModelVisualMeta,
      getAiModelUnavailableMessage,
      setActiveNodeModel: context.setActiveNodeModel,
      normalizeNodeResolution,
      activeNodeModelOption: context.activeNodeModelOption,
      setActiveNodeResolution: context.setActiveNodeResolution,
      getCatalogRatioPanelItems,
      setActiveNodeRatio: context.setActiveNodeRatio,
      renderImageOutputCountSelector,
      openCameraPanel: context.openCameraPanel,
      renderGenerateButton,
      renderCanvasArtifactToolbar: context.renderCanvasArtifactToolbar,
      setNodePatch: context.setNodePatch,
      renderVideoPromptTabs,
      renderStoryboardVideoPrompt,
      buildVideoSettingsSummary,
      getVideoResolutionOptions,
      normalizeVideoResolutionForModel,
      setActiveNodeResolutionGeneric: context.setActiveNodeResolutionGeneric,
      renderVideoOutputFormatPicker,
      parseDurationSeconds: context.parseDurationSeconds,
      setActiveNodeDuration: context.setActiveNodeDuration,
      setActiveNodeGenerateAudio: context.setActiveNodeGenerateAudio,
    })();
  }

  function renderCompactNodeEditorLauncher() {
    return renderCompactPromptLauncher({
      activeNode: context.activeNode,
      controlsPos: context.canvasInlineEditorViewModule.controlsPos,
      shouldHideCanvasPromptShell,
      activeVideoEditor: context.canvasVideoEditorStateModule.activeVideoEditor,
      imageGridSplitEditor:
        context.canvasImageEditorStateModule.imageGridSplitEditor,
      getCanvasCompactNodeEditorLayout,
      canvasSurfaceWidth: context.canvasRuntimeRefsModule.canvasSurfaceWidth,
      canvasSurfaceHeight: context.canvasRuntimeRefsModule.canvasSurfaceHeight,
      rootRef: context.canvasRuntimeRefsModule.rootRef,
      assetManagerOpen: context.canvasAssetPanelStateModule.assetManagerOpen,
      CanvasCompactNodeEditorLauncher,
      promptFontStack: PROMPT_PANEL_FONT_STACK,
      closePromptMenus: context.closePromptMenus,
      setExpanded: context.canvasPromptStateModule.setExpanded,
    });
  }
  return {
    renderCompactSubmitButton,
    renderReferenceVisual,
    renderUpstreamReferenceStrip,
    renderReferencePicker,
    renderPromptReferenceCapsule,
    renderPromptEditor,
    renderVideoOutputFormatPicker,
    renderVideoPromptTabs,
    renderStoryboardVideoPrompt,
    renderModelCatalogStatus,
    renderGenerateButton,
    renderImageOutputCountSelector,
    renderCollapsedPromptShell,
    renderCompactNodeEditorLauncher,
  };
}
