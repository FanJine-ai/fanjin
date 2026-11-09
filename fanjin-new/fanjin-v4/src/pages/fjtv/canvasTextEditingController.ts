import type { EdgeData, GroupData, NodeData } from "./canvasDataTypes";
import { canvasTextContent } from "./canvasInteraction";
import { buildTextNodeTogglePatch } from "./canvasViewModel";

export function createCanvasTextEditingController(input: {
  editingTextNodeId: string | null;
  textEditorDraft: string;
  nodes: NodeData[];
  edges: EdgeData[];
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  setEditingTextNodeId: (id: string | null) => void;
  setTextEditorDraft: (value: string) => void;
  setSelectedNodeIds: (ids: string[]) => void;
  setSelectedEdgeIds: (ids: string[]) => void;
  setActiveNodeId: (id: string | null) => void;
  textEditorTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setNodes: (nodes: NodeData[]) => void;
  persistCanvas: (nodes?: NodeData[], edges?: EdgeData[], name?: string, groups?: GroupData[]) => Promise<string | null> | void;
}) {
  const setTextNodePatchAndPersist = (nodeId: string, patch: Partial<NodeData>) => {
    const nextNodes = input.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch, textVisited: true } : node));
    input.setNodes(nextNodes);
    void input.persistCanvas(nextNodes, input.edges);
  };
  return {
    start(node: NodeData) {
      if (node.textArtifactTab && node.textArtifactTab !== "body") input.setNodePatch(node.id, { textArtifactTab: "body" });
      input.setEditingTextNodeId(node.id);
      input.setTextEditorDraft(canvasTextContent(node));
      input.setSelectedNodeIds([node.id]);
      input.setSelectedEdgeIds([]);
      input.setActiveNodeId(node.id);
      window.setTimeout(() => input.textEditorTextareaRef.current?.focus(), 0);
    },
    commit() {
      if (!input.editingTextNodeId) return;
      const nextValue = input.textEditorDraft.replace(/\r/g, "");
      input.setNodePatch(input.editingTextNodeId, { outputText: nextValue, textVisited: true });
      input.setEditingTextNodeId(null);
      input.setTextEditorDraft("");
      void input.persistCanvas(input.nodes, input.edges);
    },
    download(node: NodeData) {
      const blob = new Blob([canvasTextContent(node)], { type: "text/plain;charset=utf-8" });
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${(node.title || "文本节点").replace(/[\\/:*?"<>|]/g, "_")}.txt`;
      anchor.click();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
    },
    update(nodeId: string, outputText: string, patch: Partial<NodeData> = {}) {
      if (input.editingTextNodeId === nodeId) input.setTextEditorDraft(outputText);
      setTextNodePatchAndPersist(nodeId, { ...patch, outputText });
    },
    patch(nodeId: string, patch: Partial<NodeData>) {
      setTextNodePatchAndPersist(nodeId, patch);
    },
    toggleExpanded(node: NodeData) {
      setTextNodePatchAndPersist(node.id, buildTextNodeTogglePatch(node, !node.textExpanded));
    },
  };
}
