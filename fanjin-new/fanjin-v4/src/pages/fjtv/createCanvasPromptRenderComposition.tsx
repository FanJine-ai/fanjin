import { createCanvasDeferredContext } from "./canvasDeferredContext";
import { createCanvasGenerationActionBindings } from "./canvasGenerationActionBindings";
import { createCanvasGraphActionBindings } from "./canvasGraphActionBindings";
import { createCanvasNodeRenderBindings } from "./canvasNodeRenderBindings";
import { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import { createCanvasPromptRenderBindings } from "./canvasPromptRenderBindings";
import { useCanvasActiveModelView } from "./useCanvasActiveModelView";
import { useCanvasAssetPanelState } from "./useCanvasAssetPanelState";
import { useCanvasGraphState } from "./useCanvasGraphState";
import { useCanvasGroupState } from "./useCanvasGroupState";
import { useCanvasImageEditorState } from "./useCanvasImageEditorState";
import { useCanvasInlineEditorView } from "./useCanvasInlineEditorView";
import { useCanvasModelCatalogState } from "./useCanvasModelCatalogState";
import { useCanvasPromptState } from "./useCanvasPromptState";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasTitleEditorState } from "./useCanvasTitleEditorState";
import { useCanvasVideoEditorState } from "./useCanvasVideoEditorState";
import { useCanvasVisibilityView } from "./useCanvasVisibilityView";
export function createCanvasPromptRenderComposition(
  readContext: () => {
    canvasSubmitButtonView: () => {
      renderCompactSubmitButton: (
        key: string,
        action: () => Promise<void> | void,
        className?: string,
        iconClassName?: string,
        blocked?: boolean,
      ) => React.JSX.Element;
    };
    canvasReferencePreviewView: () => {
      renderReferenceVisual: (
        reference: import("@/pages/fjtv/canvasDataTypes").UpstreamReferenceItem,
        sizeClass?: string,
      ) => React.JSX.Element;
    };
    canvasPromptStateModule: ReturnType<typeof useCanvasPromptState>;
    canvasColorMode: import("@/ui/theme").ThemeMode;
    canvasGenerationActionBindings: ReturnType<
      typeof createCanvasGenerationActionBindings
    >;
    activeNode: import("@/pages/fjtv/canvasDataTypes").NodeData | null;
    activeNodeModelOption: import("@/lib/api").AiModelOption | undefined;
    canvasGraphActionBindings: ReturnType<
      typeof createCanvasGraphActionBindings
    >;
    canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
    canvasProjectActionBindings: ReturnType<
      typeof createCanvasProjectActionBindings
    >;
    canvasMeta: import("@/pages/fjtv/canvasDataTypes").CanvasMetaState;
    canvasStoryboardVideoPromptView: () => {
      renderStoryboardVideoPrompt: () => React.JSX.Element | null;
    };
    canvasActiveModelViewModule: ReturnType<typeof useCanvasActiveModelView>;
    canvasNodeRenderBindings: ReturnType<typeof createCanvasNodeRenderBindings>;
    canvasVisibilityViewModule: ReturnType<typeof useCanvasVisibilityView>;
    canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
    canvasTitleEditorStateModule: ReturnType<typeof useCanvasTitleEditorState>;
    canvasGroupStateModule: ReturnType<typeof useCanvasGroupState>;
    canvasModelCatalogStateModule: ReturnType<
      typeof useCanvasModelCatalogState
    >;
    canvasInlineEditorViewModule: ReturnType<typeof useCanvasInlineEditorView>;
    canvasVideoEditorStateModule: ReturnType<typeof useCanvasVideoEditorState>;
    canvasImageEditorStateModule: ReturnType<typeof useCanvasImageEditorState>;
    canvasAssetPanelStateModule: ReturnType<typeof useCanvasAssetPanelState>;
  },
) {
  return createCanvasPromptRenderBindings(
    createCanvasDeferredContext({
      canvasSubmitButtonView: () => readContext().canvasSubmitButtonView,
      canvasReferencePreviewView: () =>
        readContext().canvasReferencePreviewView,
      canvasPromptStateModule: () => readContext().canvasPromptStateModule,
      canvasColorMode: () => readContext().canvasColorMode,
      insertReferenceIntoPrompt: () =>
        readContext().canvasGenerationActionBindings.insertReferenceIntoPrompt,
      activeNode: () => readContext().activeNode,
      bindPromptTextarea: () =>
        readContext().canvasGenerationActionBindings.bindPromptTextarea,
      handlePromptInputChange: () =>
        readContext().canvasGenerationActionBindings.handlePromptInputChange,
      rememberPromptSelection: () =>
        readContext().canvasGenerationActionBindings.rememberPromptSelection,
      handlePromptTextareaKeyDown: () =>
        readContext().canvasGenerationActionBindings
          .handlePromptTextareaKeyDown,
      syncPromptEditorScroll: () =>
        readContext().canvasGenerationActionBindings.syncPromptEditorScroll,
      activeNodeModelOption: () => readContext().activeNodeModelOption,
      setNodePatch: () => readContext().canvasGraphActionBindings.setNodePatch,
      canvasGraphStateModule: () => readContext().canvasGraphStateModule,
      showNodeStatusChip: () =>
        readContext().canvasGenerationActionBindings.showNodeStatusChip,
      persistCanvas: () =>
        readContext().canvasProjectActionBindings.persistCanvas,
      canvasMeta: () => readContext().canvasMeta,
      canvasStoryboardVideoPromptView: () =>
        readContext().canvasStoryboardVideoPromptView,
      nodeHasSubmittingSession: () =>
        readContext().canvasGenerationActionBindings.nodeHasSubmittingSession,
      getModelGenerationUnavailableMessage: () =>
        readContext().canvasGraphActionBindings
          .getModelGenerationUnavailableMessage,
      generateWithActiveNode: () =>
        readContext().canvasGenerationActionBindings.generateWithActiveNode,
      canvasActiveModelViewModule: () =>
        readContext().canvasActiveModelViewModule,
      renderNodeEditorPositionToggle: () =>
        readContext().canvasNodeRenderBindings.renderNodeEditorPositionToggle,
      closePromptMenus: () =>
        readContext().canvasGenerationActionBindings.closePromptMenus,
      renderCanvasArtifactSourcePicker: () =>
        readContext().canvasNodeRenderBindings.renderCanvasArtifactSourcePicker,
      setActiveNodeModel: () =>
        readContext().canvasGenerationActionBindings.setActiveNodeModel,
      setActiveNodeResolution: () =>
        readContext().canvasGenerationActionBindings.setActiveNodeResolution,
      setActiveNodeRatio: () =>
        readContext().canvasGenerationActionBindings.setActiveNodeRatio,
      openCameraPanel: () =>
        readContext().canvasGenerationActionBindings.openCameraPanel,
      renderCanvasArtifactToolbar: () =>
        readContext().canvasNodeRenderBindings.renderCanvasArtifactToolbar,
      setActiveNodeResolutionGeneric: () =>
        readContext().canvasGenerationActionBindings
          .setActiveNodeResolutionGeneric,
      parseDurationSeconds: () =>
        readContext().canvasGenerationActionBindings.parseDurationSeconds,
      setActiveNodeDuration: () =>
        readContext().canvasGenerationActionBindings.setActiveNodeDuration,
      setActiveNodeGenerateAudio: () =>
        readContext().canvasGenerationActionBindings.setActiveNodeGenerateAudio,
      canvasVisibilityViewModule: () =>
        readContext().canvasVisibilityViewModule,
      canvasRuntimeRefsModule: () => readContext().canvasRuntimeRefsModule,
      canvasTitleEditorStateModule: () =>
        readContext().canvasTitleEditorStateModule,
      canvasGroupStateModule: () => readContext().canvasGroupStateModule,
      canvasModelCatalogStateModule: () =>
        readContext().canvasModelCatalogStateModule,
      canvasInlineEditorViewModule: () =>
        readContext().canvasInlineEditorViewModule,
      canvasVideoEditorStateModule: () =>
        readContext().canvasVideoEditorStateModule,
      canvasImageEditorStateModule: () =>
        readContext().canvasImageEditorStateModule,
      canvasAssetPanelStateModule: () =>
        readContext().canvasAssetPanelStateModule,
    }),
  );
}
