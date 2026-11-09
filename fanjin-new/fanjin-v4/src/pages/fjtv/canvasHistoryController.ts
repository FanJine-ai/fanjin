import type React from "react";
import type { NodeData, EdgeData, GroupData, ViewportState, CanvasHistorySnapshot, ArrangeSnapshot } from "./canvasDataTypes";
import { cloneHistorySnapshot } from "./canvasAssetPresentation";

export interface CanvasHistoryDependencies {
  nodes: NodeData[];
  edges: EdgeData[];
  groups: GroupData[];
  viewport: ViewportState;
  historyCurrentRef: React.RefObject<CanvasHistorySnapshot | null>;
  historyTimerRef: React.RefObject<number | null>;
  undoStackRef: React.RefObject<CanvasHistorySnapshot[]>;
  redoStackRef: React.RefObject<CanvasHistorySnapshot[]>;
  historyApplyingRef: React.RefObject<boolean>;
  locallyDeletedNodeIdsRef: React.RefObject<Set<string>>;
  setNodes: React.Dispatch<React.SetStateAction<NodeData[]>>;
  setEdges: React.Dispatch<React.SetStateAction<EdgeData[]>>;
  setGroups: React.Dispatch<React.SetStateAction<GroupData[]>>;
  setViewport: React.Dispatch<React.SetStateAction<ViewportState>>;
  setSelectedNodeIds: React.Dispatch<React.SetStateAction<string[]>>;
  setSelectedEdgeIds: React.Dispatch<React.SetStateAction<string[]>>;
  setActiveNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  setActiveGroupId: React.Dispatch<React.SetStateAction<string | null>>;
  closePromptMenus: () => void;
  setArrangeSnapshot: React.Dispatch<React.SetStateAction<ArrangeSnapshot | null>>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  setLayoutDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setColorPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectionLayoutMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setArrangeConfirmOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export function createCanvasHistoryController(deps: CanvasHistoryDependencies) {
  const {
    nodes,
    edges,
    groups,
    viewport,
    historyCurrentRef,
    historyTimerRef,
    undoStackRef,
    redoStackRef,
    historyApplyingRef,
    locallyDeletedNodeIdsRef,
    setNodes,
    setEdges,
    setGroups,
    setViewport,
    setSelectedNodeIds,
    setSelectedEdgeIds,
    setActiveNodeId,
    setActiveGroupId,
    closePromptMenus,
    setArrangeSnapshot,
    setStatus,
    setExpanded,
    setLayoutDropdownOpen,
    setColorPaletteOpen,
    setSelectionLayoutMenuOpen,
    setArrangeConfirmOpen,
  } = deps;
  function buildHistorySnapshot(
    nextNodes = nodes,
    nextEdges = edges,
    nextGroups = groups,
    nextViewport = viewport,
  ): CanvasHistorySnapshot {
    return {
      nodes: JSON.parse(JSON.stringify(nextNodes)),
      edges: JSON.parse(JSON.stringify(nextEdges)),
      groups: JSON.parse(JSON.stringify(nextGroups)),
      viewport: { ...nextViewport },
    };
  }

  function recordCanvasHistoryMutation(snapshot: CanvasHistorySnapshot, previousSnapshot?: CanvasHistorySnapshot) {
    const current = previousSnapshot ?? historyCurrentRef.current ?? buildHistorySnapshot();
    if (JSON.stringify(current) === JSON.stringify(snapshot)) return;
    if (historyTimerRef.current) {
      window.clearTimeout(historyTimerRef.current);
      historyTimerRef.current = null;
    }
    undoStackRef.current.push(cloneHistorySnapshot(current));
    if (undoStackRef.current.length > 80) undoStackRef.current.shift();
    redoStackRef.current = [];
    historyCurrentRef.current = cloneHistorySnapshot(snapshot);
    // The following state update is already represented in history. Suppress
    // the debounced observer so Delete followed immediately by Undo remains
    // available and does not add a duplicate entry.
    historyApplyingRef.current = true;
  }

  function applyHistorySnapshot(snapshot: CanvasHistorySnapshot) {
    const current = historyCurrentRef.current ?? buildHistorySnapshot();
    const nextNodeIds = new Set(snapshot.nodes.map((node) => node.id));
    current.nodes.forEach((node) => {
      if (!nextNodeIds.has(node.id)) {
        locallyDeletedNodeIdsRef.current.add(node.id);
      }
    });
    snapshot.nodes.forEach((node) => {
      locallyDeletedNodeIdsRef.current.delete(node.id);
    });
    historyApplyingRef.current = true;
    historyCurrentRef.current = cloneHistorySnapshot(snapshot);
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setGroups(snapshot.groups);
    // Undo changes canvas content while retaining the current viewing position.
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setActiveNodeId(null);
    setActiveGroupId(null);
    closePromptMenus();
    setExpanded(false);
    setLayoutDropdownOpen(false);
    setColorPaletteOpen(false);
    setSelectionLayoutMenuOpen(false);
  }

  function undoCanvas() {
    const previous = undoStackRef.current.pop();
    const current = historyCurrentRef.current ?? buildHistorySnapshot();
    if (!previous) {
      setStatus("没有可撤销的操作");
      return;
    }
    redoStackRef.current.unshift(cloneHistorySnapshot(current));
    setArrangeSnapshot(null);
    setArrangeConfirmOpen(false);
    applyHistorySnapshot(previous);
    setStatus("已撤销");
  }

  function redoCanvas() {
    const next = redoStackRef.current.shift();
    const current = historyCurrentRef.current ?? buildHistorySnapshot();
    if (!next) {
      setStatus("没有可重做的操作");
      return;
    }
    undoStackRef.current.push(cloneHistorySnapshot(current));
    setArrangeSnapshot(null);
    setArrangeConfirmOpen(false);
    applyHistorySnapshot(next);
    setStatus("已重做");
  }


  return { buildHistorySnapshot, recordCanvasHistoryMutation, applyHistorySnapshot, undoCanvas, redoCanvas };
}
