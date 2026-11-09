import { useMemo } from "react";
import type { NodeData } from "./canvasDataTypes";
import type { createCanvasGraphActionBindings } from "./canvasGraphActionBindings";
import type { createCanvasProjectActionBindings } from "./canvasProjectActionBindings";
import { createCanvasTextEditingController } from "./canvasTextEditingController";
import {
  applyTextListStyle,
  getTextNodeBackground,
  getTextNodeFontSize,
  getTextNodeLineHeight,
} from "./canvasTextNodeUtils";
import type { useCanvasGraphState } from "./useCanvasGraphState";
import type { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import type { useCanvasSelectionState } from "./useCanvasSelectionState";
import type { useCanvasTitleEditorState } from "./useCanvasTitleEditorState";
export function useCanvasTextEditingView({
  canvasTitleEditorStateModule,
  nodeMap,
  canvasGraphStateModule,
  canvasGraphActionBindings,
  canvasSelectionStateModule,
  canvasRuntimeRefsModule,
  canvasProjectActionBindings,
  canvasColorMode,
}: {
  canvasTitleEditorStateModule: ReturnType<typeof useCanvasTitleEditorState>;
  nodeMap: Map<string, NodeData>;
  canvasGraphStateModule: ReturnType<typeof useCanvasGraphState>;
  canvasGraphActionBindings: ReturnType<typeof createCanvasGraphActionBindings>;
  canvasSelectionStateModule: ReturnType<typeof useCanvasSelectionState>;
  canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
  canvasProjectActionBindings: ReturnType<
    typeof createCanvasProjectActionBindings
  >;
  canvasColorMode: import("@/ui/theme").ThemeMode;
}) {
  const editingTextNode = useMemo(
    () =>
      canvasTitleEditorStateModule.editingTextNodeId
        ? (nodeMap.get(canvasTitleEditorStateModule.editingTextNodeId) ?? null)
        : null,
    [canvasTitleEditorStateModule.editingTextNodeId, nodeMap],
  );

  const textEditingController = () =>
    createCanvasTextEditingController({
      editingTextNodeId: canvasTitleEditorStateModule.editingTextNodeId,
      textEditorDraft: canvasTitleEditorStateModule.textEditorDraft,
      nodes: canvasGraphStateModule.nodes,
      edges: canvasGraphStateModule.edges,
      setNodePatch: canvasGraphActionBindings.setNodePatch,
      setEditingTextNodeId: canvasTitleEditorStateModule.setEditingTextNodeId,
      setTextEditorDraft: canvasTitleEditorStateModule.setTextEditorDraft,
      setSelectedNodeIds: canvasSelectionStateModule.setSelectedNodeIds,
      setSelectedEdgeIds: canvasSelectionStateModule.setSelectedEdgeIds,
      setActiveNodeId: canvasSelectionStateModule.setActiveNodeId,
      textEditorTextareaRef: canvasRuntimeRefsModule.textEditorTextareaRef,
      setNodes: canvasGraphStateModule.setNodes,
      persistCanvas: canvasProjectActionBindings.persistCanvas,
    });
  const startTextNodeEditing = (node: NodeData) =>
    textEditingController().start(node);
  const commitTextNodeEditing = () => textEditingController().commit();
  const downloadTextNodeAsTxt = (node: NodeData) =>
    textEditingController().download(node);

  const textNodeBackground = (node: NodeData) =>
    getTextNodeBackground(node.textBackgroundColor, canvasColorMode);
  const textNodeFontSize = (node: NodeData) =>
    getTextNodeFontSize(node.textFontSize, node.textHeading);
  const textNodeLineHeight = (node: NodeData) =>
    getTextNodeLineHeight(node.textFontSize, node.textHeading);
  const applyTextListStyleToValue = applyTextListStyle;

  const setTextNodePatchAndPersist = (
    nodeId: string,
    patch: Partial<NodeData>,
  ) => textEditingController().patch(nodeId, patch);
  const updateTextNodeContentAndStyle = (
    nodeId: string,
    outputText: string,
    patch: Partial<NodeData> = {},
  ) => textEditingController().update(nodeId, outputText, patch);
  const toggleTextNodeExpanded = (node: NodeData) =>
    textEditingController().toggleExpanded(node);
  return {
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
  };
}
