import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { MenuSource, LayoutMode, ViewportState, NodeData, EdgeData, GroupData, GroupDragState, EdgeHoverState, PendingConnection, CanvasMetaState, ArrangeSnapshot, CanvasHistorySnapshot } from "./canvasDataTypes";
import { remapCanvasArtifactNode } from "./canvasTextArtifacts";
import { consolidateCanvasAssets, restoreCanvasAssetArrangement } from "./canvasAssetConsolidation";
import { getCanvasFitViewport, getCanvasSidebarNodePlacement } from "./canvasAdaptiveLayout";
import { rectFromNode, unionRects, type CanvasRect as Rect } from "./canvasGeometry";

export interface CanvasNodeOperationsControllerDependencies {
  setEditingNodeTitleId: Dispatch<SetStateAction<string | null>>;
  setEditingNodeTitleDraft: Dispatch<SetStateAction<string>>;
  editingNodeTitleDraft: string;
  nodes: NodeData[];
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  edges: EdgeData[];
  setEditingGroupTitleId: Dispatch<SetStateAction<string | null>>;
  setEditingGroupTitleDraft: Dispatch<SetStateAction<string>>;
  editingGroupTitleDraft: string;
  setGroups: Dispatch<SetStateAction<GroupData[]>>;
  setGroupDrag: Dispatch<SetStateAction<GroupDragState>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  setActiveGroupId: Dispatch<SetStateAction<string | null>>;
  setSidebarRenamingNodeId: Dispatch<SetStateAction<string | null>>;
  setSidebarRenameDraft: Dispatch<SetStateAction<string>>;
  setOpenNodeMenuId: Dispatch<SetStateAction<string | null>>;
  sidebarRenameDraft: string;
  nodeMap: Map<string, NodeData>;
  recordCanvasHistoryMutation: (snapshot: CanvasHistorySnapshot, previousSnapshot?: CanvasHistorySnapshot) => void;
  buildHistorySnapshot: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextGroups?: GroupData[], nextViewport?: ViewportState) => CanvasHistorySnapshot;
  groups: GroupData[];
  viewport: ViewportState;
  focusNodeInViewport: (nodeId: string) => void;
  selectedNodeIds: string[];
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  setSelectionLayoutMenuOpen: Dispatch<SetStateAction<boolean>>;
  GROUP_THEME_COLORS: string[];
  canvasMeta: CanvasMetaState;
  activeGroupId: string | null;
  setLayoutDropdownOpen: Dispatch<SetStateAction<boolean>>;
  setColorPaletteOpen: Dispatch<SetStateAction<boolean>>;
  activeGroup: GroupData | null;
  activeGroupBounds: { left: number; top: number; right: number; bottom: number; } | null;
  selectedBounds: { left: number; top: number; right: number; bottom: number; } | null;
  arrangeConfirmOpen: boolean;
  setStatus: Dispatch<SetStateAction<string>>;
  rootRef: RefObject<HTMLDivElement | null>;
  assetManagerOpen: boolean;
  CANVAS_VISUAL_SCALE: 1.25;
  locallyDeletedNodeIdsRef: RefObject<Set<string>>;
  applyHistorySnapshot: (snapshot: CanvasHistorySnapshot) => void;
  setArrangeSnapshot: Dispatch<SetStateAction<ArrangeSnapshot | null>>;
  setArrangeConfirmOpen: Dispatch<SetStateAction<boolean>>;
  arrangeSnapshot: ArrangeSnapshot | null;
  toWorld: (clientX: number, clientY: number) => { x: number; y: number; };
  openCreationMenuAtWorld: (x: number, y: number, source: MenuSource, nextPending?: PendingConnection | null) => void;
  setEdgeHoverState: Dispatch<SetStateAction<EdgeHoverState | null>>;
}

export function createCanvasNodeOperationsController(deps: CanvasNodeOperationsControllerDependencies) {
  const { setEditingNodeTitleId, setEditingNodeTitleDraft, editingNodeTitleDraft, nodes, setNodes, persistCanvas, edges, setEditingGroupTitleId, setEditingGroupTitleDraft, editingGroupTitleDraft, setGroups, setGroupDrag, setSelectedNodeIds, setSelectedEdgeIds, setActiveNodeId, setActiveGroupId, setSidebarRenamingNodeId, setSidebarRenameDraft, setOpenNodeMenuId, sidebarRenameDraft, nodeMap, recordCanvasHistoryMutation, buildHistorySnapshot, groups, viewport, focusNodeInViewport, selectedNodeIds, setEdges, setSelectionLayoutMenuOpen, GROUP_THEME_COLORS, canvasMeta, activeGroupId, setLayoutDropdownOpen, setColorPaletteOpen, activeGroup, activeGroupBounds, selectedBounds, arrangeConfirmOpen, setStatus, rootRef, assetManagerOpen, CANVAS_VISUAL_SCALE, locallyDeletedNodeIdsRef, applyHistorySnapshot, setArrangeSnapshot, setArrangeConfirmOpen, arrangeSnapshot, toWorld, openCreationMenuAtWorld, setEdgeHoverState } = deps;
function startEditNodeTitle(node: NodeData) {
    setEditingNodeTitleId(node.id);
    setEditingNodeTitleDraft(node.title || "");
  }

function commitNodeTitle(nodeId: string, fallbackTitle: string) {
    const next = editingNodeTitleDraft.trim();
    const nextNodes = nodes.map((node) => (node.id === nodeId ? { ...node, title: next || fallbackTitle, titleCustomized: true } : node));
    setNodes(nextNodes);
    setEditingNodeTitleId(null);
    setEditingNodeTitleDraft("");
    void persistCanvas(nextNodes, edges);
  }

function cancelNodeTitleEdit() {
    setEditingNodeTitleId(null);
    setEditingNodeTitleDraft("");
  }

function startEditGroupTitle(group: GroupData) {
    setEditingGroupTitleId(group.id);
    setEditingGroupTitleDraft(group.title || "");
  }

function commitGroupTitle(groupId: string, fallbackTitle: string) {
    const nextTitle = editingGroupTitleDraft.trim() || fallbackTitle;
    setGroups((prev) => prev.map((group) => (group.id === groupId ? { ...group, title: nextTitle } : group)));
    setEditingGroupTitleId(null);
    setEditingGroupTitleDraft("");
  }

function cancelGroupTitleEdit() {
    setEditingGroupTitleId(null);
    setEditingGroupTitleDraft("");
  }

function beginGroupDrag(group: GroupData, startWorldX: number, startWorldY: number, startBounds: Rect) {
    const originalPositions: Record<string, { x: number; y: number }> = {};
    nodes.forEach((node) => {
      if (group.nodeIds.includes(node.id)) originalPositions[node.id] = { x: node.x, y: node.y };
    });
    setGroupDrag({
      active: true,
      groupId: group.id,
      startX: startWorldX,
      startY: startWorldY,
      originalPositions,
      startBounds: { ...startBounds },
    });
    setSelectedNodeIds(group.nodeIds);
    setSelectedEdgeIds([]);
    setActiveNodeId(null);
    setActiveGroupId(group.id);
  }

function startSidebarRename(node: NodeData) {
    setSidebarRenamingNodeId(node.id);
    setSidebarRenameDraft(node.title);
    setOpenNodeMenuId(null);
  }

async function commitSidebarRename(nodeId: string, fallbackTitle: string) {
    const nextTitle = sidebarRenameDraft.trim() || fallbackTitle;
    const nextNodes = nodes.map((node) => (node.id === nodeId ? { ...node, title: nextTitle, titleCustomized: true } : node));
    setNodes(nextNodes);
    setSidebarRenamingNodeId(null);
    setSidebarRenameDraft("");
    await persistCanvas(nextNodes, edges);
  }

function cancelSidebarRename() {
    setSidebarRenamingNodeId(null);
    setSidebarRenameDraft("");
  }

async function duplicateNodeFromManager(nodeId: string) {
    const source = nodeMap.get(nodeId);
    if (!source) return;
    const copyId = `node_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const duplicate: NodeData = {
      ...source,
      id: copyId,
      title: `${source.title} - 副本`,
      x: source.x,
      y: source.y + source.height + 36,
      titleCustomized: true,
    };
    const nextNodes = [...nodes, duplicate];
    recordCanvasHistoryMutation(buildHistorySnapshot(nextNodes, edges, groups, viewport));
    setNodes(nextNodes);
    setSelectedNodeIds([copyId]);
    setSelectedEdgeIds([]);
    setActiveNodeId(copyId);
    setOpenNodeMenuId(null);
    await persistCanvas(nextNodes, edges);
    window.setTimeout(() => focusNodeInViewport(copyId), 40);
  }

async function duplicateSelectedNodes() {
    if (selectedNodeIds.length === 0) return;
    const selectedNodes = nodes.filter((node) => selectedNodeIds.includes(node.id));
    if (selectedNodes.length === 0) return;
    const minY = Math.min(...selectedNodes.map((node) => node.y));
    const maxY = Math.max(...selectedNodes.map((node) => node.y + node.height));
    const offsetY = maxY - minY + 48;
    const duplicated = createDuplicateFromNodeIds(selectedNodeIds, 0, offsetY);
    if (!duplicated) return;
    const { duplicatedNodes: nextNodes, duplicatedEdges: nextEdges } = duplicated;

    const mergedNodes = [...nodes, ...nextNodes];
    const mergedEdges = [...edges, ...nextEdges];
    recordCanvasHistoryMutation(buildHistorySnapshot(mergedNodes, mergedEdges, groups, viewport));
    setNodes(mergedNodes);
    setEdges(mergedEdges);
    setSelectedNodeIds(nextNodes.map((node) => node.id));
    setSelectedEdgeIds(nextEdges.map((edge) => edge.id));
    setActiveNodeId(nextNodes.length === 1 ? nextNodes[0].id : null);
    setSelectionLayoutMenuOpen(false);
    await persistCanvas(mergedNodes, mergedEdges);
  }

function createGroupFromSelection() {
    if (selectedNodeIds.length < 2) return;
    const id = `group_${Date.now()}`;
    const nextGroup: GroupData = { id, nodeIds: [...selectedNodeIds], layoutMode: "grid", themeColor: GROUP_THEME_COLORS[0], title: "分组" };
    const nextGroups = [...groups, nextGroup];
    setGroups(nextGroups);
    setActiveGroupId(id);
    setActiveNodeId(null);
    setSelectedEdgeIds([]);
    setSelectionLayoutMenuOpen(false);
    void persistCanvas(nodes, edges, canvasMeta.name, nextGroups);
  }

function ungroupActive() {
    if (!activeGroupId) return;
    const nextGroups = groups.filter((group) => group.id !== activeGroupId);
    setGroups(nextGroups);
    setActiveGroupId(null);
    setLayoutDropdownOpen(false);
    setColorPaletteOpen(false);
    setSelectionLayoutMenuOpen(false);
    void persistCanvas(nodes, edges, canvasMeta.name, nextGroups);
  }

function updateActiveGroup(patch: Partial<GroupData>) {
    if (!activeGroupId) return;
    setGroups((prev) => prev.map((group) => (group.id === activeGroupId ? { ...group, ...patch } : group)));
  }

function applyLayoutToNodeIds(nodeIds: string[], mode: LayoutMode, anchorRect: Rect) {
    const idSet = new Set(nodeIds);
    const groupNodes = nodes.filter((node) => idSet.has(node.id));
    if (groupNodes.length === 0) return;

    const sorted = [...groupNodes].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
    const originX = anchorRect.left + 28;
    const originY = anchorRect.top + 28;
    const gap = 24;
    const next = new Map<string, { x: number; y: number }>();

    if (mode === "horizontal") {
      let x = originX;
      sorted.forEach((node) => {
        next.set(node.id, { x, y: originY });
        x += node.width + gap;
      });
    } else if (mode === "vertical") {
      let y = originY;
      sorted.forEach((node) => {
        next.set(node.id, { x: originX, y });
        y += node.height + gap;
      });
    } else {
      const cols = Math.max(2, Math.min(4, Math.ceil(Math.sqrt(sorted.length))));
      const colWidths = new Array(cols).fill(0);
      sorted.forEach((node, index) => {
        colWidths[index % cols] = Math.max(colWidths[index % cols], node.width);
      });
      const colStarts: number[] = [];
      let x = originX;
      for (let i = 0; i < cols; i += 1) {
        colStarts.push(x);
        x += colWidths[i] + gap;
      }
      let y = originY;
      for (let i = 0; i < sorted.length; i += cols) {
        const row = sorted.slice(i, i + cols);
        const rowHeight = Math.max(...row.map((n) => n.height));
        row.forEach((node, col) => next.set(node.id, { x: colStarts[col], y }));
        y += rowHeight + gap;
      }
    }

    setNodes((prev) => prev.map((node) => (next.has(node.id) ? { ...node, ...next.get(node.id)! } : node)));
  }

function applyGroupLayout(mode: LayoutMode) {
    if (!activeGroup || !activeGroupBounds) return;
    applyLayoutToNodeIds(activeGroup.nodeIds, mode, activeGroupBounds);
    updateActiveGroup({ layoutMode: mode });
    setLayoutDropdownOpen(false);
  }

function applySelectionLayout(mode: LayoutMode) {
    if (!selectedBounds || selectedNodeIds.length < 2) return;
    applyLayoutToNodeIds(selectedNodeIds, mode, selectedBounds);
    setSelectionLayoutMenuOpen(false);
  }

function createDuplicateFromNodeIds(sourceIds: string[], offsetX = 0, offsetY = 48) {
    const sourceSet = new Set(sourceIds);
    const sourceNodes = nodes.filter((node) => sourceSet.has(node.id));
    if (sourceNodes.length === 0) return null;

    const stamp = Date.now();
    const idMap = new Map<string, string>();
    const duplicatedNodes = sourceNodes.map((node, index) => {
      const id = `node_${stamp}_dup_${index}_${Math.floor(Math.random() * 1000)}`;
      idMap.set(node.id, id);
      return {
        ...node,
        id,
        x: node.x + offsetX,
        y: node.y + offsetY,
        title: `${node.title} 副本`,
        titleCustomized: true,
      };
    }).map((node) => remapCanvasArtifactNode(node, idMap));

    const duplicatedEdges = edges
      .filter((edge) => sourceSet.has(edge.fromNodeId) && sourceSet.has(edge.toNodeId))
      .map((edge, index) => {
        const fromNodeId = idMap.get(edge.fromNodeId);
        const toNodeId = idMap.get(edge.toNodeId);
        if (!fromNodeId || !toNodeId) return null;
        return {
          ...edge,
          id: `edge_${stamp}_dup_${index}_${Math.floor(Math.random() * 1000)}`,
          fromNodeId,
          toNodeId,
        };
      })
      .filter((edge): edge is EdgeData => Boolean(edge));

    return { duplicatedNodes, duplicatedEdges, idMap };
  }

function arrangeCanvasLeftPreview() {
    if (nodes.length === 0) return;
    if (arrangeConfirmOpen) {
      setStatus("请先保留或还原当前整理结果");
      return;
    }
    const before = buildHistorySnapshot();
    const consolidated = consolidateCanvasAssets(before);
    const arrangedNodes = consolidated.nodes;
    const nodeById = new Map(arrangedNodes.map((node) => [node.id, node]));

    type Zone = "A" | "B" | "C" | "R";
    type Unit = { key: string; nodeIds: string[]; zone: Zone; order: number };

    const sceneOrderOf = (title: string) => {
      const match = String(title || "").match(/(?:^|[^\d])(\d{2,3})[^\d]/);
      return match ? Number(match[1]) : 9_999;
    };
    const isDocNode = (node: NodeData) =>
      node.type === "text" && /说明|使用说明|待用户批准|待批准|文档|备注/.test(node.title || "");
    const isPublicResourceGroup = (title: string) => /共享|公共|资产|参考库|声线|人物|服装|场景/.test(title);
    const isStoryboard = (title: string, members: NodeData[]) =>
      /全能参考|分镜|多镜头|台词|S\d{2}|场/.test(String(title || ""))
      || members.some((n) => n.type === "text" && /分镜|台词|镜头段|多镜头/.test(n.title || ""));
    const isGenerationNode = (node: NodeData) =>
      node.type === "video"
      && Boolean(
        node.videoUrl || node.localVideoUrl
        || node.isGenerating
        || ["idle", "processing", "success", "failed", "pending_reconcile", "query_failed"].includes(String(node.taskStatus || ""))
      );

    const claimed = new Set<string>();
    const units: Unit[] = [];

    // Every generation clip (done + pending) goes to R, even when it sits
    // inside a scene group — the finals strip must own them all.
    arrangedNodes.forEach((node) => {
      if (!isGenerationNode(node)) return;
      claimed.add(node.id);
      units.push({ key: `gen:${node.id}`, nodeIds: [node.id], zone: "R", order: sceneOrderOf(node.title) });
    });

    consolidated.groups.forEach((group, index) => {
      const ids = group.nodeIds.filter((id) => nodeById.has(id) && !claimed.has(id));
      if (!ids.length) return;
      ids.forEach((id) => claimed.add(id));
      const title = group.title || "";
      const members = ids.map((id) => nodeById.get(id)!);
      const zone: Zone = isPublicResourceGroup(title)
        ? "A"
        : isStoryboard(title, members) || isStoryboard("", members)
          ? "C"
          : members.every(isDocNode) ? "B" : "C";
      units.push({ key: group.id, nodeIds: ids, zone, order: zone === "C" ? sceneOrderOf(title) * 10 + index : index });
    });

    arrangedNodes.filter((node) => !claimed.has(node.id)).forEach((node) => {
      const zone: Zone = node.type === "video" ? "R"
        : isDocNode(node) ? "B"
        : (node.type === "image" || node.type === "audio") ? "A" : "C";
      units.push({
        key: `node:${node.id}`,
        nodeIds: [node.id],
        zone,
        order: zone === "C" || zone === "R" ? sceneOrderOf(node.title) : 10_000 + node.y,
      });
    });

    const gap = 48;
    const pad = 48;
    const COLS = 4;
    const nextPositions = new Map<string, { x: number; y: number }>();

    const cardsOf = (zone: Zone) => {
      const cards: Array<{ id: string; width: number; height: number; order: number }> = [];
      units
        .filter((u) => u.zone === zone)
        .sort((a, b) => a.order - b.order)
        .forEach((unit) => {
          unit.nodeIds
            .map((id) => nodeById.get(id)!)
            .filter(Boolean)
            .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))
            .forEach((node, index) => {
              cards.push({ id: node.id, width: node.width, height: node.height, order: unit.order * 1000 + index });
            });
        });
      return cards;
    };

    // A | B | C | R side by side. Each zone: 4 internal columns.
    const zones: Zone[] = ["A", "B", "C", "R"];
    let zoneX = pad;
    zones.forEach((zone) => {
      const cards = cardsOf(zone);
      if (!cards.length) return;
      const colWidth = Math.max(...cards.map((c) => c.width));
      const colHeights = new Array<number>(COLS).fill(0);
      cards.forEach((card) => {
        let target = 0;
        for (let i = 1; i < COLS; i += 1) {
          if (colHeights[i] < colHeights[target]) target = i;
        }
        const x = zoneX + target * (colWidth + gap);
        const y = pad + colHeights[target];
        nextPositions.set(card.id, { x, y });
        colHeights[target] += card.height + gap;
      });
      zoneX += COLS * (colWidth + gap) + gap * 1.5;
    });

    const nextNodes = arrangedNodes.map((node) => nextPositions.has(node.id) ? { ...node, ...nextPositions.get(node.id)! } : node);
    const bounds = unionRects(nextNodes.map(rectFromNode));
    const rootRect = rootRef.current?.getBoundingClientRect();
    const nextViewport = rootRect && bounds
      ? getCanvasFitViewport(rootRect.width, rootRect.height, bounds, assetManagerOpen, {
          visualScaleMultiplier: CANVAS_VISUAL_SCALE, scaleCap: 0.26, minimumVisualScale: 0.02,
        }) : viewport;
    const after = buildHistorySnapshot(nextNodes, consolidated.edges, consolidated.groups, nextViewport);
    consolidated.removedNodeIds.forEach(id => locallyDeletedNodeIdsRef.current.add(id));
    recordCanvasHistoryMutation(after, before);
    applyHistorySnapshot(after);
    setArrangeSnapshot({ before, after, mergedCount: consolidated.removedNodeIds.length });
    setArrangeConfirmOpen(true);
    setStatus("");
  }

function restoreArrangeSnapshot() {
    if (!arrangeSnapshot) return;
    const restored = restoreCanvasAssetArrangement({
      before: arrangeSnapshot.before, after: arrangeSnapshot.after,
      current: { nodes, edges, groups },
    });
    const snapshot = buildHistorySnapshot(restored.nodes, restored.edges, restored.groups, arrangeSnapshot.before.viewport);
    recordCanvasHistoryMutation(snapshot, buildHistorySnapshot());
    applyHistorySnapshot(snapshot);
    setArrangeSnapshot(null);
    setArrangeConfirmOpen(false);
    setStatus("已还原整理前的节点、连线和位置");
  }

function keepArrangeResult() {
    setArrangeSnapshot(null);
    setArrangeConfirmOpen(false);
    setStatus("已保留整理结果，可通过撤销恢复");
  }



function openSidebarMenu() {
    if (!rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const placement = getCanvasSidebarNodePlacement(
      rect.width,
      rect.height,
      assetManagerOpen,
      nodes.length === 0,
    );
    const world = toWorld(
      rect.left + placement.centerX,
      rect.top + placement.centerY,
    );
    openCreationMenuAtWorld(world.x, world.y, "sidebar");
  }

function removeEdge(edgeId: string) {
    setEdges((prev) => prev.filter((edge) => edge.id !== edgeId));
    setSelectedEdgeIds((prev) => prev.filter((id) => id !== edgeId));
    setEdgeHoverState(null);
  }
  return { startEditNodeTitle, commitNodeTitle, cancelNodeTitleEdit, startEditGroupTitle, commitGroupTitle, cancelGroupTitleEdit, beginGroupDrag, startSidebarRename, commitSidebarRename, cancelSidebarRename, duplicateNodeFromManager, duplicateSelectedNodes, createGroupFromSelection, ungroupActive, updateActiveGroup, applyLayoutToNodeIds, applyGroupLayout, applySelectionLayout, createDuplicateFromNodeIds, arrangeCanvasLeftPreview, restoreArrangeSnapshot, keepArrangeResult, openSidebarMenu, removeEdge };
}
