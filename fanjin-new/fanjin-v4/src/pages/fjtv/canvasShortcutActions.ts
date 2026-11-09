import type * as React from "react";
import type * as Router from "react-router-dom";
import { type Side, type MenuSource, type NodeData, type EdgeData, type GroupData, type PendingConnection, type CanvasMetaState } from "./canvasDataTypes";
import { getCanvasUsableLayout } from "./canvasAdaptiveLayout";

export interface CanvasShortcutActionsDependencies {
  rootRef: React.RefObject<HTMLDivElement | null>;
  assetManagerOpen: boolean;
  toWorld: (clientX: number, clientY: number) => { x: number; y: number; };
  openCreationMenuAtWorld: (x: number, y: number, source: MenuSource, nextPending?: PendingConnection | null) => void;
  nodes: NodeData[];
  selectedNodeIds: string[];
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  edges: EdgeData[];
  hasDuplicateEdge: (fromNodeId: string, fromSide: Side, toNodeId: string, toSide: Side) => boolean;
  setEdges: React.Dispatch<React.SetStateAction<EdgeData[]>>;
  setSelectedEdgeIds: React.Dispatch<React.SetStateAction<string[]>>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  canvasMeta: CanvasMetaState;
  groups: GroupData[];
}

export function createCanvasShortcutActions({
  rootRef,
  assetManagerOpen,
  toWorld,
  openCreationMenuAtWorld,
  nodes,
  selectedNodeIds,
  setStatus,
  edges,
  hasDuplicateEdge,
  setEdges,
  setSelectedEdgeIds,
  persistCanvas,
  canvasMeta,
  groups,
}: CanvasShortcutActionsDependencies) {
function openShortcutCreateMenu() {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const usableLayout = getCanvasUsableLayout(rect.width, assetManagerOpen);
    const world = toWorld(rect.left + usableLayout.centerX, rect.top + rect.height / 2);
    openCreationMenuAtWorld(world.x, world.y, "doubleClick");
  }

function connectSelectedNodesShortcut() {
    const selectedNodes = nodes
      .filter((node) => selectedNodeIds.includes(node.id))
      .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
    if (selectedNodes.length < 2) {
      setStatus("请先选择至少 2 个节点再连线");
      return;
    }
    const nextEdges = [...edges];
    const createdEdgeIds: string[] = [];
    selectedNodes.forEach((node, index) => {
      const nextNode = selectedNodes[index + 1];
      if (!nextNode) return;
      if (hasDuplicateEdge(node.id, "right", nextNode.id, "left")) return;
      const edgeId = `edge_${Date.now()}_${index}_${Math.floor(Math.random() * 1000)}`;
      createdEdgeIds.push(edgeId);
      nextEdges.push({
        id: edgeId,
        fromNodeId: node.id,
        fromSide: "right",
        toNodeId: nextNode.id,
        toSide: "left",
      });
    });
    setEdges(nextEdges);
    setSelectedEdgeIds(createdEdgeIds);
    setStatus(createdEdgeIds.length > 0 ? "已创建连线" : "选中节点之间已存在连线");
    if (createdEdgeIds.length > 0) void persistCanvas(nodes, nextEdges, canvasMeta.name, groups);
  }
  return { openShortcutCreateMenu, connectSelectedNodesShortcut };
}
