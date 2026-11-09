import { CanvasRedrawProvider } from "./CanvasRedrawProvider";
import { useCanvasPersistenceWorker } from "./useCanvasPersistenceWorker";
import { useCanvasTopologyFit } from "./useCanvasTopologyFit";
import { useCanvasActiveNodeSelection } from "./useCanvasActiveNodeSelection";
import { useCanvasNodeMap } from "./useCanvasNodeMap";
import { useCanvasRouteOptions } from "./useCanvasRouteOptions";
import type { InfiniteCanvasStableProps } from "./canvasDataTypes";
import { createCanvasDeferredContext } from "./canvasDeferredContext";
import { createCanvasGenerationActionBindings } from "./canvasGenerationActionBindings";
import { createCanvasGenerationControllers } from "./canvasGenerationControllers";
import { createCanvasGraphActionBindings } from "./canvasGraphActionBindings";
import { createCanvasGraphControllers } from "./canvasGraphControllers";
import { isEditableCanvasKeyboardTarget } from "./canvasKeyboardTarget";
import { createCanvasMediaActionBindings } from "./canvasMediaActionBindings";
import { createCanvasMediaControllers } from "./canvasMediaControllers";
import { renderCanvasNodeTryIcon } from "./canvasNodeTryIconRenderer";
import { CanvasPageLayout } from "./CanvasPageLayout";
import { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import { createCanvasProjectControllers } from "./canvasProjectControllers";
import { createCanvasChromeRenderComposition } from "./createCanvasChromeRenderComposition";
import { createCanvasMediaRenderComposition } from "./createCanvasMediaRenderComposition";
import { createCanvasNodeRenderComposition } from "./createCanvasNodeRenderComposition";
import { createCanvasPromptRenderComposition } from "./createCanvasPromptRenderComposition";
import { useCanvasActiveModelView } from "./useCanvasActiveModelView";
import { useCanvasAssetManagerNotificationEffects } from "./useCanvasAssetManagerNotificationEffects";
import { useCanvasAssetPanelLayoutEffects } from "./useCanvasAssetPanelLayoutEffects";
import { useCanvasAssetPanelState } from "./useCanvasAssetPanelState";
import { useCanvasAutosaveSnapshot } from "./useCanvasAutosaveSnapshot";
import { useCanvasCapabilityState } from "./useCanvasCapabilityState";
import { useCanvasComposeState } from "./useCanvasComposeState";
import { useCanvasComposeView } from "./useCanvasComposeView";
import { useCanvasConnectionState } from "./useCanvasConnectionState";
import { useCanvasDocumentState } from "./useCanvasDocumentState";
import { useCanvasEnvironment } from "./useCanvasEnvironment";
import { useCanvasGenerationDebugState } from "./useCanvasGenerationDebugState";
import { useCanvasVideoStoryRecovery } from "./useCanvasGenerationLifecycle";
import { useCanvasGraphState } from "./useCanvasGraphState";
import { useCanvasGroupState } from "./useCanvasGroupState";
import { useCanvasHistoryPanelState } from "./useCanvasHistoryPanelState";
import { useCanvasHydrationEffects } from "./useCanvasHydrationEffects";
import { useCanvasImageEditorState } from "./useCanvasImageEditorState";
import { useCanvasInlineEditorView } from "./useCanvasInlineEditorView";
import { useCanvasProjectHeaderPortal } from "./useCanvasLayoutLifecycle";
import { useCanvasLibraryCatalogEffects } from "./useCanvasLibraryCatalogEffects";
import { useCanvasLibraryView } from "./useCanvasLibraryView";
import { useCanvasMediaPlaybackEffects } from "./useCanvasMediaPlaybackEffects";
import { useCanvasModelCatalogState } from "./useCanvasModelCatalogState";
import { useCanvasCapabilities } from "./useCanvasModelLifecycle";
import { useCanvasNodeSerialState } from "./useCanvasNodeSerialState";
import {
  useCanvasProjectBrowserRequest,
  useCanvasTheme,
} from "./useCanvasPanelLifecycle";
import { useCanvasPendingHistory } from "./useCanvasPendingHistory";
import { useCanvasNodesRef } from "./useCanvasPersistenceLifecycle";
import { useCanvasPlaybackState } from "./useCanvasPlaybackState";
import { useCanvasPricingDecisions } from "./useCanvasPricingDecisions";
import { useCanvasProductState } from "./useCanvasProductState";
import { useCanvasProjectDeleteFocusEffects } from "./useCanvasProjectDeleteFocusEffects";
import { useCanvasProjectRenameState } from "./useCanvasProjectRenameState";
import { useCanvasProjectState } from "./useCanvasProjectState";
import { useCanvasPromptScrollResetEffects } from "./useCanvasPromptScrollResetEffects";
import { useCanvasPromptState } from "./useCanvasPromptState";
import { useCanvasPublicationState } from "./useCanvasPublicationState";
import { useCanvasReferencePickerResetEffects } from "./useCanvasReferencePickerResetEffects";
import { useCanvasRouteInvalidationEffects } from "./useCanvasRouteInvalidationEffects";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasSaveHistoryEffects } from "./useCanvasSaveHistoryEffects";
import { useCanvasSelectionState } from "./useCanvasSelectionState";
import { useCanvasShareFocusEffects } from "./useCanvasShareFocusEffects";
import { useCanvasStoryboardState } from "./useCanvasStoryboardState";
import { useCanvasSurfaceView } from "./useCanvasSurfaceView";
import { useCanvasTemplateState } from "./useCanvasTemplateState";
import { useCanvasTextEditingView } from "./useCanvasTextEditingView";
import { useCanvasTitleEditorState } from "./useCanvasTitleEditorState";
import { useCanvasVideoEditorState } from "./useCanvasVideoEditorState";
import { useCanvasVideoModelNormalizationEffects } from "./useCanvasVideoModelNormalizationEffects";
import { useCanvasViewportInteractionEffects } from "./useCanvasViewportInteractionEffects";
import { useCanvasConnectionHoldCleanup } from "./useCanvasViewportLifecycle";
import { useCanvasViewportRefEffects } from "./useCanvasViewportRefEffects";
import { useCanvasViewportUiState } from "./useCanvasViewportUiState";
import { useCanvasVisibilityView } from "./useCanvasVisibilityView";
export type { InfiniteCanvasStableProps } from "./canvasDataTypes";
export { createCanvasBriefNode, createNode } from "./canvasNodeDefaults";
export { CANVAS_WORKFLOW_TEMPLATES_SCHEMA_VERSION } from "./canvasPageConstants";
/*
 * The only formal canvas entry.
 *
 * This file is the stable visual baseline for:
 * - /infinite-canvas-v2
 * - /canvas/:id
 *
 * Domain implementations live in sibling modules; this entry composes them.
 */

import { useRef, useState } from "react";
import {
  LEGACY_DEMO_MEDIA_PATTERN,
  sanitizeLegacyDemoNode,
  stripLegacyDemoMedia,
} from "./canvasAssetPresentation";
import { sameProjectIdentity } from "./canvasProjectIdentity";
import {
  getBoundVideoSourceAssetId,
  resolveCanvasVideoSourceResolution,
} from "./canvasTaskResults";

export {
  getBoundVideoSourceAssetId,
  LEGACY_DEMO_MEDIA_PATTERN,
  resolveCanvasVideoSourceResolution,
  sameProjectIdentity,
  sanitizeLegacyDemoNode,
  stripLegacyDemoMedia,
};

// Raw request/response diagnostics are opt-in for local development only.
// Production builds can never enable this panel, even if an env value leaks in.

// The API owns rollout availability: a schema-41 binary can be staged against
// schema 40 without exposing controls before the additive table exists.

// Audio generation is not a live capability. Real uploaded audio can still enter the
// canvas through the asset library, but an empty "audio generation" node must not be
// advertised as a creation mode.

export default function InfiniteCanvasStable({
  studioChrome = false,
  studioMode = "canvas",
  studioProjectHeaderInAgent = false,
  initialBrief = "",
  assetManagerCloseRequest = 0,
  assetManagerToggleRequest = 0,
  projectBrowserToggleRequest = 0,
  onAssetManagerOpenChange,
}: InfiniteCanvasStableProps = {}) {
  const {
    canvasRouteActions,
    projectController,
    persistenceController,
    templateController,
    projectAssetController,
    canvasHistoryController,
    publicationController,
    canvasHistoryLoading,
    canvasConflictActions,
  } = createCanvasProjectControllers(() =>
    createCanvasDeferredContext({
      canvasRuntimeRefsModule: () => canvasRuntimeRefsModule,
      canvasSelectionStateModule: () => canvasSelectionStateModule,
      canvasPromptStateModule: () => canvasPromptStateModule,
      canvasAssetPanelStateModule: () => canvasAssetPanelStateModule,
      canvasProjectStateModule: () => canvasProjectStateModule,
      studioChrome: () => studioChrome,
      navigate: () => navigate,
      location: () => location,
      searchParams: () => searchParams,
      canvasMeta: () => canvasMeta,
      routeCanvasId: () => routeCanvasId,
      canvasGraphStateModule: () => canvasGraphStateModule,
      canvasGroupStateModule: () => canvasGroupStateModule,
      canvasViewportUiStateModule: () => canvasViewportUiStateModule,
      canvasProjectRenameStateModule: () => canvasProjectRenameStateModule,
      canvasProjectActionBindings: () => canvasProjectActionBindings,
      canDelete: () => canDelete,
      setCanvasMeta: () => setCanvasMeta,
      selectedProjectId: () => selectedProjectId,
      boundSessionProjectId: () => boundSessionProjectId,
      removeSelectedProject: () => removeSelectedProject,
      clearSelectedProject: () => clearSelectedProject,
      clearCreationSession: () => clearCreationSession,
      canvasLibraryViewModule: () => canvasLibraryViewModule,
      canvasGenerationActionBindings: () => canvasGenerationActionBindings,
      latestCanvasSaveInputRef: () => latestCanvasSaveInputRef,
      canvasHistoryController: () => canvasHistoryController,
      canvasTemplateStateModule: () => canvasTemplateStateModule,
      canvasGraphActionBindings: () => canvasGraphActionBindings,
      nodeSerialCounter: () => nodeSerialCounter,
      setNodeSerialCounter: () => setNodeSerialCounter,
      canvasVisibilityViewModule: () => canvasVisibilityViewModule,
      canvasHistoryPanelStateModule: () => canvasHistoryPanelStateModule,
      templateController: () => templateController,
      canvasPublicationStateModule: () => canvasPublicationStateModule,
      initialBrief: () => initialBrief,
    }),
  );
  const {
    viewportController,
    nodeCreationController,
    nodeOperationsController,
    canvasNodeMutationController,
    canvasShortcutActions,
    canvasPanelActions,
    groupExecutionController,
    productScriptView,
    productScriptController,
    storyboardController,
    presetController,
    interactionController,
    canvasEmptyLauncherActions,
  } = createCanvasGraphControllers(() =>
    createCanvasDeferredContext({
      nodeMap: () => nodeMap,
      canvasBounds: () => canvasBounds,
      canvasGraphStateModule: () => canvasGraphStateModule,
      canvasRuntimeRefsModule: () => canvasRuntimeRefsModule,
      canvasAssetPanelStateModule: () => canvasAssetPanelStateModule,
      canvasSelectionStateModule: () => canvasSelectionStateModule,
      canvasVisibilityViewModule: () => canvasVisibilityViewModule,
      canvasConnectionStateModule: () => canvasConnectionStateModule,
      canvasPricingDecisionsModule: () => canvasPricingDecisionsModule,
      canvasGraphActionBindings: () => canvasGraphActionBindings,
      studioChrome: () => studioChrome,
      canvasMeta: () => canvasMeta,
      nodeSerialCounter: () => nodeSerialCounter,
      setNodeSerialCounter: () => setNodeSerialCounter,
      availableModels: () => availableModels,
      canvasGenerationActionBindings: () => canvasGenerationActionBindings,
      canvasModelCatalogStateModule: () => canvasModelCatalogStateModule,
      canvasTemplateStateModule: () => canvasTemplateStateModule,
      canvasProjectRenameStateModule: () => canvasProjectRenameStateModule,
      canvasProjectStateModule: () => canvasProjectStateModule,
      canvasPromptStateModule: () => canvasPromptStateModule,
      canvasGroupStateModule: () => canvasGroupStateModule,
      canvasTitleEditorStateModule: () => canvasTitleEditorStateModule,
      canvasViewportUiStateModule: () => canvasViewportUiStateModule,
      canvasProjectActionBindings: () => canvasProjectActionBindings,
      canvasLibraryViewModule: () => canvasLibraryViewModule,
      canvasGenerationDebugStateModule: () => canvasGenerationDebugStateModule,
      canvasMediaActionBindings: () => canvasMediaActionBindings,
      canvasCapabilities: () => canvasCapabilities,
      canvasProductStateModule: () => canvasProductStateModule,
      interactionPerformanceMode: () => interactionPerformanceMode,
      commitTextNodeEditing: () => commitTextNodeEditing,
      canvasStoryboardStateModule: () => canvasStoryboardStateModule,
    }),
  );
  const {
    generationActionsController,
    canvasSubmitButtonView,
    createGenerationSessionController,
    referenceUploadController,
    modelSettingsController,
    promptEditingController,
    canvasReferencePreviewView,
    createUploadController,
  } = createCanvasGenerationControllers(() =>
    createCanvasDeferredContext({
      canvasRuntimeRefsModule: () => canvasRuntimeRefsModule,
      canvasGraphStateModule: () => canvasGraphStateModule,
      canvasSelectionStateModule: () => canvasSelectionStateModule,
      canvasPromptStateModule: () => canvasPromptStateModule,
      canvasProjectStateModule: () => canvasProjectStateModule,
      canvasGraphActionBindings: () => canvasGraphActionBindings,
      canvasGenerationActionBindings: () => canvasGenerationActionBindings,
      createGenerationSessionController: () =>
        createGenerationSessionController,
      canvasBalance: () => canvasBalance,
      canvasProjectActionBindings: () => canvasProjectActionBindings,
      canvasMediaActionBindings: () => canvasMediaActionBindings,
      activeNode: () => activeNode,
      canvasGroupStateModule: () => canvasGroupStateModule,
      canvasGenerationDebugStateModule: () => canvasGenerationDebugStateModule,
      canvasPlaybackStateModule: () => canvasPlaybackStateModule,
      canvasPricingDecisionsModule: () => canvasPricingDecisionsModule,
      canvasConnectionStateModule: () => canvasConnectionStateModule,
      canvasStoryboardStateModule: () => canvasStoryboardStateModule,
      canvasMeta: () => canvasMeta,
      nodeSerialCounter: () => nodeSerialCounter,
      setNodeSerialCounter: () => setNodeSerialCounter,
      nodeMap: () => nodeMap,
      canvasLibraryViewModule: () => canvasLibraryViewModule,
      canvasHistoryPanelStateModule: () => canvasHistoryPanelStateModule,
      canvasProjectRenameStateModule: () => canvasProjectRenameStateModule,
      canvasAssetPanelStateModule: () => canvasAssetPanelStateModule,
      canvasModelCatalogStateModule: () => canvasModelCatalogStateModule,
      activeNodeModelOption: () => activeNodeModelOption,
      canvasImageEditorStateModule: () => canvasImageEditorStateModule,
      canvasTitleEditorStateModule: () => canvasTitleEditorStateModule,
      canvasVisibilityViewModule: () => canvasVisibilityViewModule,
      canvasColorMode: () => canvasColorMode,
    }),
  );
  const {
    artifactEditingController,
    canvasStoryboardVideoPromptView,
    videoToolsController,
    composeController,
    imageToolsController,
    videoStoryController,
    canvasMediaViewerActions,
    imageMenuController,
    imageGridController,
  } = createCanvasMediaControllers(() =>
    createCanvasDeferredContext({
      canvasGraphStateModule: () => canvasGraphStateModule,
      canvasSelectionStateModule: () => canvasSelectionStateModule,
      canvasGraphActionBindings: () => canvasGraphActionBindings,
      canvasProjectActionBindings: () => canvasProjectActionBindings,
      canvasPromptStateModule: () => canvasPromptStateModule,
      canvasGroupStateModule: () => canvasGroupStateModule,
      canvasActiveModelViewModule: () => canvasActiveModelViewModule,
      canvasVideoEditorStateModule: () => canvasVideoEditorStateModule,
      canvasCapabilities: () => canvasCapabilities,
      canvasGenerationActionBindings: () => canvasGenerationActionBindings,
      canvasMeta: () => canvasMeta,
      nodeMap: () => nodeMap,
      canvasMediaActionBindings: () => canvasMediaActionBindings,
      canvasProjectStateModule: () => canvasProjectStateModule,
      canvasPlaybackStateModule: () => canvasPlaybackStateModule,
      canvasGenerationDebugStateModule: () => canvasGenerationDebugStateModule,
      canvasRuntimeRefsModule: () => canvasRuntimeRefsModule,
      canvasComposeStateModule: () => canvasComposeStateModule,
      canvasComposeViewModule: () => canvasComposeViewModule,
      canvasBalance: () => canvasBalance,
      canvasImageEditorStateModule: () => canvasImageEditorStateModule,
      setNodeSerialCounter: () => setNodeSerialCounter,
      canvasAssetPanelStateModule: () => canvasAssetPanelStateModule,
    }),
  );
  const canvasProjectActionBindings = createCanvasProjectActionBindings(
    createCanvasDeferredContext({
      canvasRouteActions: () => canvasRouteActions,
      projectController: () => projectController,
      persistenceController: () => persistenceController,
      latestCanvasSaveInputRef: () => latestCanvasSaveInputRef,
      templateController: () => templateController,
      projectAssetController: () => projectAssetController,
      publicationController: () => publicationController,
      canvasHistoryLoading: () => canvasHistoryLoading,
      canvasConflictActions: () => canvasConflictActions,
      canvasProjectStateModule: () => canvasProjectStateModule,
      canvasGraphStateModule: () => canvasGraphStateModule,
      canvasRuntimeRefsModule: () => canvasRuntimeRefsModule,
      canvasGroupStateModule: () => canvasGroupStateModule,
    }),
  );
  const canvasGraphActionBindings = createCanvasGraphActionBindings(
    createCanvasDeferredContext({
      viewportController: () => viewportController,
      nodeCreationController: () => nodeCreationController,
      nodeOperationsController: () => nodeOperationsController,
      canvasNodeMutationController: () => canvasNodeMutationController,
      canvasShortcutActions: () => canvasShortcutActions,
      canvasPanelActions: () => canvasPanelActions,
      groupExecutionController: () => groupExecutionController,
      productScriptController: () => productScriptController,
      storyboardController: () => storyboardController,
      presetController: () => presetController,
      canvasModelCatalogStateModule: () => canvasModelCatalogStateModule,
      interactionController: () => interactionController,
      canvasEmptyLauncherActions: () => canvasEmptyLauncherActions,
      canvasGraphStateModule: () => canvasGraphStateModule,
      canvasRuntimeRefsModule: () => canvasRuntimeRefsModule,
    }),
  );
  const canvasGenerationActionBindings = createCanvasGenerationActionBindings(
    createCanvasDeferredContext({
      generationActionsController: () => generationActionsController,
      createGenerationSessionController: () =>
        createGenerationSessionController,
      referenceUploadController: () => referenceUploadController,
      modelSettingsController: () => modelSettingsController,
      promptEditingController: () => promptEditingController,
      createUploadController: () => createUploadController,
    }),
  );
  const canvasPromptRenderBindings = createCanvasPromptRenderComposition(() =>
    createCanvasDeferredContext({
      canvasSubmitButtonView: () => canvasSubmitButtonView,
      canvasReferencePreviewView: () => canvasReferencePreviewView,
      canvasPromptStateModule: () => canvasPromptStateModule,
      canvasColorMode: () => canvasColorMode,
      canvasGenerationActionBindings: () => canvasGenerationActionBindings,
      activeNode: () => activeNode,
      activeNodeModelOption: () => activeNodeModelOption,
      canvasGraphActionBindings: () => canvasGraphActionBindings,
      canvasGraphStateModule: () => canvasGraphStateModule,
      canvasProjectActionBindings: () => canvasProjectActionBindings,
      canvasMeta: () => canvasMeta,
      canvasStoryboardVideoPromptView: () => canvasStoryboardVideoPromptView,
      canvasActiveModelViewModule: () => canvasActiveModelViewModule,
      canvasNodeRenderBindings: () => canvasNodeRenderBindings,
      canvasVisibilityViewModule: () => canvasVisibilityViewModule,
      canvasRuntimeRefsModule: () => canvasRuntimeRefsModule,
      canvasTitleEditorStateModule: () => canvasTitleEditorStateModule,
      canvasGroupStateModule: () => canvasGroupStateModule,
      canvasModelCatalogStateModule: () => canvasModelCatalogStateModule,
      canvasInlineEditorViewModule: () => canvasInlineEditorViewModule,
      canvasVideoEditorStateModule: () => canvasVideoEditorStateModule,
      canvasImageEditorStateModule: () => canvasImageEditorStateModule,
      canvasAssetPanelStateModule: () => canvasAssetPanelStateModule,
    }),
  );
  const canvasNodeRenderBindings = createCanvasNodeRenderComposition(() =>
    createCanvasDeferredContext({
      canvasGenerationActionBindings: () => canvasGenerationActionBindings,
      canvasGraphActionBindings: () => canvasGraphActionBindings,
      canvasMediaActionBindings: () => canvasMediaActionBindings,
      productScriptView: () => productScriptView,
      canvasAssetPanelStateModule: () => canvasAssetPanelStateModule,
      canvasImageEditorStateModule: () => canvasImageEditorStateModule,
      canvasCapabilities: () => canvasCapabilities,
      canvasRuntimeRefsModule: () => canvasRuntimeRefsModule,
      canvasPlaybackStateModule: () => canvasPlaybackStateModule,
      canvasTitleEditorStateModule: () => canvasTitleEditorStateModule,
      textNodeBackground: () => textNodeBackground,
      textNodeFontSize: () => textNodeFontSize,
      textNodeLineHeight: () => textNodeLineHeight,
      commitTextNodeEditing: () => commitTextNodeEditing,
      startTextNodeEditing: () => startTextNodeEditing,
      canvasProjectActionBindings: () => canvasProjectActionBindings,
      nodeMap: () => nodeMap,
      canvasColorMode: () => canvasColorMode,
      renderNodeTryIcon: () => renderNodeTryIcon,
      setTextNodePatchAndPersist: () => setTextNodePatchAndPersist,
      applyTextListStyleToValue: () => applyTextListStyleToValue,
      updateTextNodeContentAndStyle: () => updateTextNodeContentAndStyle,
      toggleTextNodeExpanded: () => toggleTextNodeExpanded,
      downloadTextNodeAsTxt: () => downloadTextNodeAsTxt,
      canvasProjectStateModule: () => canvasProjectStateModule,
      canvasGraphStateModule: () => canvasGraphStateModule,
      canvasPromptStateModule: () => canvasPromptStateModule,
      canvasSelectionStateModule: () => canvasSelectionStateModule,
      canvasVideoEditorStateModule: () => canvasVideoEditorStateModule,
      canvasGroupStateModule: () => canvasGroupStateModule,
      canvasStoryboardStateModule: () => canvasStoryboardStateModule,
    }),
  );
  const canvasMediaActionBindings = createCanvasMediaActionBindings(
    createCanvasDeferredContext({
      artifactEditingController: () => artifactEditingController,
      videoToolsController: () => videoToolsController,
      composeController: () => composeController,
      imageToolsController: () => imageToolsController,
      videoStoryController: () => videoStoryController,
      canvasMediaViewerActions: () => canvasMediaViewerActions,
      imageMenuController: () => imageMenuController,
      imageGridController: () => imageGridController,
    }),
  );
  const canvasMediaRenderBindings = createCanvasMediaRenderComposition(() =>
    createCanvasDeferredContext({
      composeController: () => composeController,
      canvasMediaActionBindings: () => canvasMediaActionBindings,
      canvasCapabilities: () => canvasCapabilities,
      canvasMeta: () => canvasMeta,
      nodeMap: () => nodeMap,
      canvasGraphActionBindings: () => canvasGraphActionBindings,
      canvasPromptRenderBindings: () => canvasPromptRenderBindings,
      canvasImageEditorStateModule: () => canvasImageEditorStateModule,
      canvasVideoEditorStateModule: () => canvasVideoEditorStateModule,
      canvasPlaybackStateModule: () => canvasPlaybackStateModule,
      canvasGenerationActionBindings: () => canvasGenerationActionBindings,
      canvasComposeStateModule: () => canvasComposeStateModule,
      canvasComposeViewModule: () => canvasComposeViewModule,
      canvasProjectStateModule: () => canvasProjectStateModule,
      canvasSelectionStateModule: () => canvasSelectionStateModule,
      canvasInlineEditorViewModule: () => canvasInlineEditorViewModule,
      canvasModelCatalogStateModule: () => canvasModelCatalogStateModule,
      canvasRuntimeRefsModule: () => canvasRuntimeRefsModule,
    }),
  );
  const canvasChromeRenderBindings = createCanvasChromeRenderComposition(() =>
    createCanvasDeferredContext({
      canvasGroupStateModule: () => canvasGroupStateModule,
      canvasGraphActionBindings: () => canvasGraphActionBindings,
      canvasColorMode: () => canvasColorMode,
      miniMapPreview: () => miniMapPreview,
      miniMapViewportRect: () => miniMapViewportRect,
      canvasProjectRenameStateModule: () => canvasProjectRenameStateModule,
      studioChrome: () => studioChrome,
      canvasProjectActionBindings: () => canvasProjectActionBindings,
      canvasGenerationActionBindings: () => canvasGenerationActionBindings,
      canvasCapabilities: () => canvasCapabilities,
      canvasProjectStateModule: () => canvasProjectStateModule,
      canvasLibraryViewModule: () => canvasLibraryViewModule,
      canvasMeta: () => canvasMeta,
      navigate: () => navigate,
      canDelete: () => canDelete,
      canvasRuntimeRefsModule: () => canvasRuntimeRefsModule,
      canvasViewportUiStateModule: () => canvasViewportUiStateModule,
      canvasVisibilityViewModule: () => canvasVisibilityViewModule,
      canvasGraphStateModule: () => canvasGraphStateModule,
      canvasSelectionStateModule: () => canvasSelectionStateModule,
      canvasPendingHistoryModule: () => canvasPendingHistoryModule,
      canvasPromptStateModule: () => canvasPromptStateModule,
      canvasHistoryPanelStateModule: () => canvasHistoryPanelStateModule,
    }),
  );

  const {
    navigate,
    location,
    routeCanvasId,
    canvasTheme,
    canvasColorMode,
    switchCanvasColorMode,
    selectedProjectId,
    currentWorkspaceId,
    authenticatedUser,
    authenticatedWorkspace,
    canDelete,
    canvasGenerationDebugVisible,
    canvasBalance,
    removeSelectedProject,
    clearSelectedProject,
    boundSessionProjectId,
    clearCreationSession,
    projectAssetCatalog,
    projectAssetCatalogProjectId,
    projectAssetCatalogLoading,
    projectAssetCatalogError,
    fetchProjectAssetCatalog,
  } = useCanvasEnvironment({});
  const { canvasCapabilities, setCanvasCapabilities } =
    useCanvasCapabilityState({});

  const canvasRuntimeRefsModule = useCanvasRuntimeRefs();
  useCanvasCapabilities(
    () => ({ setCanvasCapabilities }),
    [currentWorkspaceId],
  );

  const canvasGraphStateModule = useCanvasGraphState();
  useCanvasNodesRef(
    () => ({
      nodesRef: canvasGraphStateModule.nodesRef,
      nodes: canvasGraphStateModule.nodes,
    }),
    [canvasGraphStateModule.nodes],
  );
  const canvasSelectionStateModule = useCanvasSelectionState();
  const interactionPerformanceMode =
    canvasGraphStateModule.canvasPerformanceMode ||
    canvasSelectionStateModule.dragNode.active ||
    canvasSelectionStateModule.groupDrag.active ||
    canvasSelectionStateModule.middlePanning.active ||
    canvasSelectionStateModule.selectionBox.active;

  const canvasConnectionStateModule = useCanvasConnectionState();
  const canvasProductStateModule = useCanvasProductState();
  const canvasGroupStateModule = useCanvasGroupState();
  const canvasPromptStateModule = useCanvasPromptState();
  const canvasGenerationDebugStateModule = useCanvasGenerationDebugState({
    canvasGenerationDebugVisible,
  });

  const canvasModelCatalogStateModule = useCanvasModelCatalogState({});

  const canvasComposeStateModule = useCanvasComposeState();
  const canvasPlaybackStateModule = useCanvasPlaybackState();
  const canvasVideoEditorStateModule = useCanvasVideoEditorState();
  const canvasImageEditorStateModule = useCanvasImageEditorState();
  const canvasTemplateStateModule = useCanvasTemplateState();
  const canvasPricingDecisionsModule = useCanvasPricingDecisions();
  useCanvasConnectionHoldCleanup(
    () => ({
      nodeConnectionHoldTimerRef:
        canvasConnectionStateModule.nodeConnectionHoldTimerRef,
    }),
    [],
  );
  const canvasTitleEditorStateModule = useCanvasTitleEditorState();
  const canvasAssetPanelStateModule = useCanvasAssetPanelState({
    studioChrome,
  });
  useCanvasAssetManagerNotificationEffects({
    onAssetManagerOpenChange,
    canvasAssetPanelStateModule,
    assetManagerCloseRequest,
    assetManagerToggleRequest,
  });
  const previousAssetManagerOpenRef = useRef(
    canvasAssetPanelStateModule.assetManagerOpen,
  );
  useCanvasAssetPanelLayoutEffects({
    previousAssetManagerOpenRef,
    canvasAssetPanelStateModule,
    studioChrome,
    canvasRuntimeRefsModule,
    canvasGraphStateModule,
  });
  const [studioProjectHeaderPortalTarget, setStudioProjectHeaderPortalTarget] =
    useState<HTMLElement | null>(null);
  useCanvasProjectHeaderPortal(
    () => ({
      studioChrome,
      studioProjectHeaderInAgent,
      setStudioProjectHeaderPortalTarget,
    }),
    [studioChrome, studioProjectHeaderInAgent],
  );
  const canvasProjectStateModule = useCanvasProjectState({
    studioChrome,
    location,
    routeCanvasId,
    selectedProjectId,
  });
  useCanvasProjectDeleteFocusEffects({ canvasProjectStateModule });
  const canvasProjectRenameStateModule = useCanvasProjectRenameState();
  useCanvasShareFocusEffects({
    canvasProjectRenameStateModule,
    canvasGroupStateModule,
  });
  const canvasPublicationStateModule = useCanvasPublicationState();
  useCanvasTheme(() => ({ canvasColorMode }), [canvasColorMode]);
  const canvasHistoryPanelStateModule = useCanvasHistoryPanelState();
  const canvasStoryboardStateModule = useCanvasStoryboardState();
  const canvasViewportUiStateModule = useCanvasViewportUiState();
  const { canvasMeta, setCanvasMeta } = useCanvasDocumentState({
    routeCanvasId,
  });

  useCanvasVideoStoryRecovery(
    () => ({
      canvasMeta,
      canvasCapabilities,
      currentProjectId: canvasProjectStateModule.currentProjectId,
      nodes: canvasGraphStateModule.nodes,
      videoStoryResumeAttemptedRef:
        canvasVideoEditorStateModule.videoStoryResumeAttemptedRef,
      pollVideoStoryAnalysis: canvasMediaActionBindings.pollVideoStoryAnalysis,
      setStatus: canvasPromptStateModule.setStatus,
    }),
    [
      canvasCapabilities.videoStoryAnalysis,
      canvasMeta.projectId,
      canvasMeta.ready,
      canvasProjectStateModule.currentProjectId,
      canvasGraphStateModule.nodes,
    ],
  );
  const { nodeSerialCounter, setNodeSerialCounter } = useCanvasNodeSerialState(
    {},
  );

  const {
    searchParams,
    forceFreshCanvasEntry,
    openProjectBrowserOnEntry,
    readOnlyProofMode,
  } = useCanvasRouteOptions(location);

  useCanvasRouteInvalidationEffects({
    canvasProjectActionBindings,
    routeCanvasId,
    canvasProjectStateModule,
    forceFreshCanvasEntry,
    location,
    canvasRuntimeRefsModule,
  });

  const previousProjectBrowserToggleRequestRef = useRef(0);
  useCanvasProjectBrowserRequest(
    () => ({
      projectBrowserToggleRequest,
      previousProjectBrowserToggleRequestRef,
      projectBrowserOpen: canvasProjectStateModule.projectBrowserOpen,
      closeProjectBrowser: canvasProjectActionBindings.closeProjectBrowser,
      openProjectBrowser: canvasProjectActionBindings.openProjectBrowser,
    }),
    [canvasProjectStateModule.projectBrowserOpen, projectBrowserToggleRequest],
  );

  const nodeMap = useCanvasNodeMap(canvasGraphStateModule);

  const availableModels = canvasModelCatalogStateModule.models;
  const canvasPendingHistoryModule = useCanvasPendingHistory({
    nodes: canvasGraphStateModule.nodes,
    historyItems: canvasHistoryPanelStateModule.historyItems,
  });

  const { activeNode, activeNodeModelOption } = useCanvasActiveNodeSelection({
    canvasSelectionStateModule,
    nodeMap,
    availableModels,
  });

  useCanvasVideoModelNormalizationEffects({
    activeNode,
    activeNodeModelOption,
    canvasGraphActionBindings,
    canvasProjectActionBindings,
    canvasModelCatalogStateModule,
    availableModels,
  });
  const canvasActiveModelViewModule = useCanvasActiveModelView({
    activeNode,
    availableModels,
    edges: canvasGraphStateModule.edges,
    nodeMap,
    nodes: canvasGraphStateModule.nodes,
    activeProjectContextId: canvasProjectStateModule.activeProjectContextId,
    activeNodeModelOption,
    videoPromptTab: canvasPromptStateModule.videoPromptTab,
    modelCatalogState: canvasModelCatalogStateModule.modelCatalogState,
    modelCatalogError: canvasModelCatalogStateModule.modelCatalogError,
  });

  const canvasLibraryViewModule = useCanvasLibraryView({
    groups: canvasGroupStateModule.groups,
    activeGroupId: canvasGroupStateModule.activeGroupId,
    assetDetailId: canvasTemplateStateModule.assetDetailId,
    assets: canvasTemplateStateModule.assets,
    nodes: canvasGraphStateModule.nodes,
    canvasNodeSearch: canvasAssetPanelStateModule.canvasNodeSearch,
    projects: canvasProjectStateModule.projects,
    currentProjectId: canvasProjectStateModule.currentProjectId,
    projectCanvases: canvasProjectStateModule.projectCanvases,
    canvasMeta,
    canvasBalance,
    setCanvasShareOverlay: canvasProjectRenameStateModule.setCanvasShareOverlay,
    navigate,
    edges: canvasGraphStateModule.edges,
    studioChrome,
    routeProjectContextId: canvasProjectStateModule.routeProjectContextId,
    selectedProjectId,
    projectAssetCatalogProjectId,
    projectAssetCatalog,
    projectFolders: canvasProjectStateModule.projectFolders,
    projectBrowserFolderId: canvasProjectStateModule.projectBrowserFolderId,
  });

  const canvasBounds = useCanvasTopologyFit({
    canvasGraphStateModule,
    canvasRuntimeRefsModule,
    studioChrome,
    canvasMeta,
    canvasGraphActionBindings,
  });

  const canvasVisibilityViewModule = useCanvasVisibilityView({
    nodes: canvasGraphStateModule.nodes,
    selectedNodeIds: canvasSelectionStateModule.selectedNodeIds,
    activeGroup: canvasLibraryViewModule.activeGroup,
    activeNodeId: canvasSelectionStateModule.activeNodeId,
    collectConnectedEdgeIds: canvasGraphActionBindings.collectConnectedEdgeIds,
    edges: canvasGraphStateModule.edges,
    rootRef: canvasRuntimeRefsModule.rootRef,
    viewport: canvasGraphStateModule.viewport,
    viewportVisualScale: canvasGraphActionBindings.viewportVisualScale,
    assetManagerOpen: canvasAssetPanelStateModule.assetManagerOpen,
    interactionPerformanceMode,
    dragNode: canvasSelectionStateModule.dragNode,
    editingTextNodeId: canvasTitleEditorStateModule.editingTextNodeId,
    draftLine: canvasConnectionStateModule.draftLine,
    edgeDropTarget: canvasConnectionStateModule.edgeDropTarget,
    selectedEdgeIds: canvasSelectionStateModule.selectedEdgeIds,
    edgeHoverState: canvasConnectionStateModule.edgeHoverState,
    canvasRenderTick: canvasGraphStateModule.canvasRenderTick,
    groups: canvasGroupStateModule.groups,
    nodeMap,
  });

  useCanvasReferencePickerResetEffects({
    canvasPromptStateModule,
    canvasRuntimeRefsModule,
    canvasSelectionStateModule,
    canvasGraphStateModule,
  });

  const latestCanvasSaveInputRef = useCanvasPersistenceWorker({
    canvasRuntimeRefsModule,
    canvasProjectActionBindings,
    canvasGraphStateModule,
    canvasGroupStateModule,
    canvasMeta,
  });

  const isEditableKeyboardTarget = isEditableCanvasKeyboardTarget;

  useCanvasPromptScrollResetEffects({
    canvasTitleEditorStateModule,
    canvasSelectionStateModule,
    canvasPromptStateModule,
    activeNode,
    canvasRuntimeRefsModule,
    canvasProjectRenameStateModule,
    canvasProjectActionBindings,
    canvasMeta,
    canvasProjectStateModule,
  });

  const canvasInlineEditorViewModule = useCanvasInlineEditorView({
    activeNode,
    toScreen: canvasGraphActionBindings.toScreen,
    viewport: canvasGraphStateModule.viewport,
    canvasSurfaceWidth: canvasRuntimeRefsModule.canvasSurfaceWidth,
    rootRef: canvasRuntimeRefsModule.rootRef,
    canvasSurfaceHeight: canvasRuntimeRefsModule.canvasSurfaceHeight,
    assetManagerOpen: canvasAssetPanelStateModule.assetManagerOpen,
    nodeEditorPinned: canvasPromptStateModule.nodeEditorPinned,
    expanded: canvasPromptStateModule.expanded,
    mediaViewerNodeId: canvasPromptStateModule.mediaViewerNodeId,
    nodeMap,
  });

  const canvasComposeViewModule = useCanvasComposeView({
    composeClips: canvasComposeStateModule.composeClips,
    composeCurrentTime: canvasComposeStateModule.composeCurrentTime,
    composeSelectedClipId: canvasComposeStateModule.composeSelectedClipId,
  });

  useCanvasViewportRefEffects({
    canvasGraphStateModule,
    canvasPromptStateModule,
    canvasVideoEditorStateModule,
    canvasImageEditorStateModule,
    canvasSelectionStateModule,
    canvasRuntimeRefsModule,
    canvasProjectRenameStateModule,
    activeNode,
    canvasActiveModelViewModule,
    activeNodeModelOption,
    canvasGraphActionBindings,
    canvasProjectActionBindings,
    canvasGenerationActionBindings,
  });

  const {
    creationMenuScreen,
    singleSelectedNodeId,
    selectionToolbarCenterX,
    groupToolbarCenterX,
    canvasScaleMetrics,
    canvasFrameScale,
    canvasFrameStrokeWidth,
    canvasFrameDash,
    canvasFrameGap,
    canvasDotSpacing,
    canvasDotRadius,
    studioMiniMapVisible,
    miniMapSurfaceWidth,
    miniMapSurfaceHeight,
    miniMapPreview,
    miniMapViewportRect,
    viewportMissingContent,
    canvasFrameDashStyle,
    canvasDotBackgroundStyle,
  } = useCanvasSurfaceView({
    canvasConnectionStateModule,
    canvasRuntimeRefsModule,
    canvasAssetPanelStateModule,
    canvasGraphActionBindings,
    canvasGraphStateModule,
    canvasSelectionStateModule,
    canvasVisibilityViewModule,
    studioChrome,
    canvasViewportUiStateModule,
    canvasMeta,
    canvasColorMode,
  });
  const {
    editingTextNode,
    textEditingController,
    startTextNodeEditing,
    commitTextNodeEditing,
    downloadTextNodeAsTxt,
    textNodeBackground,
    textNodeFontSize,
    textNodeLineHeight,
    applyTextListStyleToValue,
    setTextNodePatchAndPersist,
    updateTextNodeContentAndStyle,
    toggleTextNodeExpanded,
  } = useCanvasTextEditingView({
    canvasTitleEditorStateModule,
    nodeMap,
    canvasGraphStateModule,
    canvasGraphActionBindings,
    canvasSelectionStateModule,
    canvasRuntimeRefsModule,
    canvasProjectActionBindings,
    canvasColorMode,
  });

  const renderNodeTryIcon = renderCanvasNodeTryIcon;

  useCanvasHydrationEffects({
    canvasRuntimeRefsModule,
    canvasSelectionStateModule,
    canvasGenerationActionBindings,
    routeCanvasId,
    searchParams,
    forceFreshCanvasEntry,
    canvasMeta,
    location,
    setCanvasMeta,
    canvasProjectActionBindings,
    canvasProjectStateModule,
    canvasLibraryViewModule,
    navigate,
    canvasPromptStateModule,
    openProjectBrowserOnEntry,
  });

  // Upload progress is render-only state. Hash only the payload that can
  // actually reach saveCanvas, so 800ms progress ticks never re-arm autosave.
  const canvasAutosaveSnapshotModule = useCanvasAutosaveSnapshot({
    nodes: canvasGraphStateModule.nodes,
    edges: canvasGraphStateModule.edges,
    groups: canvasGroupStateModule.groups,
    sanitizeNodesForPersistence:
      canvasProjectActionBindings.sanitizeNodesForPersistence,
    canvasMeta,
  });

  useCanvasSaveHistoryEffects({
    canvasRuntimeRefsModule,
    canvasMeta,
    readOnlyProofMode,
    studioChrome,
    canvasSelectionStateModule,
    canvasAutosaveSnapshotModule,
    canvasProjectActionBindings,
    canvasProjectStateModule,
    canvasConnectionStateModule,
    canvasGraphStateModule,
    canvasGroupStateModule,
  });
  useCanvasLibraryCatalogEffects({
    canvasRuntimeRefsModule,
    canvasMeta,
    readOnlyProofMode,
    canvasProjectActionBindings,
    canvasProjectStateModule,
    canvasModelCatalogStateModule,
    currentWorkspaceId,
    selectedProjectId,
    fetchProjectAssetCatalog,
    canvasTemplateStateModule,
    canvasLibraryViewModule,
    canvasPromptStateModule,
  });
  useCanvasViewportInteractionEffects({
    canvasRuntimeRefsModule,
    canvasMeta,
    studioChrome,
    canvasSelectionStateModule,
    canvasProjectActionBindings,
    canvasProjectStateModule,
    canvasConnectionStateModule,
    canvasGraphStateModule,
    canvasGroupStateModule,
    canvasTemplateStateModule,
    canvasPromptStateModule,
    canvasViewportUiStateModule,
    canvasGraphActionBindings,
    studioMiniMapVisible,
    canvasBounds,
    isEditableKeyboardTarget,
    canvasProjectRenameStateModule,
    canvasGenerationActionBindings,
    canvasVisibilityViewModule,
    nodeMap,
  });
  useCanvasMediaPlaybackEffects({
    canvasRuntimeRefsModule,
    nodeMap,
    canvasComposeViewModule,
    canvasComposeStateModule,
    canvasMediaActionBindings,
    canvasVideoEditorStateModule,
    canvasImageEditorStateModule,
  });

  return (
    <CanvasRedrawProvider {...canvasGraphStateModule} {...canvasSelectionStateModule}
      latestCanvasSaveInputRef={latestCanvasSaveInputRef} availableModels={availableModels}
      setStatus={canvasPromptStateModule.setStatus} persistCanvas={canvasProjectActionBindings.persistCanvas}
      recordMutation={(ns,es)=>canvasProjectActionBindings.recordCanvasHistoryMutation(canvasProjectActionBindings.buildHistorySnapshot(ns,es))}
      closeCreationMenu={canvasGraphActionBindings.closeCreationMenu} studioChrome={studioChrome} canvasMeta={canvasMeta}
      activeProjectContextId={canvasProjectStateModule.activeProjectContextId}
      videoNodeDurations={canvasPlaybackStateModule.videoNodeDurations} canvasColorMode={canvasColorMode}>
    <CanvasPageLayout
      {...{
        canvasRuntimeRefsModule,
        canvasGraphStateModule,
        canvasColorMode,
        canvasAssetPanelStateModule,
        studioChrome,
        canvasSelectionStateModule,
        canvasViewportUiStateModule,
        canvasGraphActionBindings,
        canvasGenerationActionBindings,
        canvasDotBackgroundStyle,
        canvasPricingDecisionsModule,
        canvasMediaRenderBindings,
        canvasNodeRenderBindings,
        studioProjectHeaderInAgent,
        studioProjectHeaderPortalTarget,
        canvasChromeRenderBindings,
        canvasProjectRenameStateModule,
        canvasPublicationStateModule,
        canvasCapabilities,
        canvasProjectActionBindings,
        canvasPromptStateModule,
        canvasLibraryViewModule,
        canvasBalance,
        switchCanvasColorMode,
        viewportMissingContent,
        canvasConnectionStateModule,
        canvasTemplateStateModule,
        canvasPendingHistoryModule,
        canvasHistoryPanelStateModule,
        canDelete,
        navigate,
        canvasMeta,
        projectAssetCatalogError,
        projectAssetCatalogLoading,
        canvasProjectStateModule,
        nodeMap,
        canvasVisibilityViewModule,
        groupToolbarCenterX,
        canvasStoryboardStateModule,
        canvasGroupStateModule,
        selectionToolbarCenterX,
        canvasFrameDashStyle,
        canvasTitleEditorStateModule,
        commitTextNodeEditing,
        interactionPerformanceMode,
        singleSelectedNodeId,
        canvasMediaActionBindings,
        startTextNodeEditing,
        canvasPlaybackStateModule,
        creationMenuScreen,
        availableModels,
        canvasInlineEditorViewModule,
        activeNode,
        canvasImageEditorStateModule,
        canvasPromptRenderBindings,
        canvasActiveModelViewModule,
        activeNodeModelOption,
        canvasGenerationDebugVisible,
        canvasGenerationDebugStateModule,
      }}
    />
    </CanvasRedrawProvider>
  );
}
