import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { patchLooksActivelyGenerating } from "./canvasTaskState";
import type { NodeData, EdgeData, GroupData } from "./canvasDataTypes";
import { fetchCanvasMediaBlob } from "./canvasMediaDownload";
import { planCanvasGroupExecution } from "./canvasGroupExecution";
import { inferExtByType, triggerBrowserDownload } from "./canvasAssetPresentation";
import { rectContainsRect, rectFromNode, type CanvasRect as Rect } from "./canvasGeometry";

export interface CanvasGroupExecutionControllerDependencies {
  selectedNodeIds: string[];
  groupBoundsMap: Map<string, Rect>;
  nodes: NodeData[];
  setStatus: Dispatch<SetStateAction<string>>;
  edges: EdgeData[];
  groupExecutionOpenerRef: RefObject<HTMLButtonElement | null>;
  setActiveGroupId: Dispatch<SetStateAction<string | null>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  setLayoutDropdownOpen: Dispatch<SetStateAction<boolean>>;
  setColorPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setSelectionLayoutMenuOpen: Dispatch<SetStateAction<boolean>>;
  setGroupExecutionDialog: Dispatch<SetStateAction<{ groupId: string; } | null>>;
  groupExecutionDialog: { groupId: string; } | null;
  groupExecutionRunning: boolean;
  groups: GroupData[];
  setGroupExecutionRunning: Dispatch<SetStateAction<boolean>>;
  nodesRef: RefObject<NodeData[]>;
  generateWithActiveNode: (targetOverride?: NodeData) => Promise<boolean>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
}

export function createCanvasGroupExecutionController(deps: CanvasGroupExecutionControllerDependencies) {
  const { selectedNodeIds, groupBoundsMap, nodes, setStatus, edges, groupExecutionOpenerRef, setActiveGroupId, setSelectedNodeIds, setSelectedEdgeIds, setActiveNodeId, setLayoutDropdownOpen, setColorPaletteOpen, setSelectionLayoutMenuOpen, setGroupExecutionDialog, groupExecutionDialog, groupExecutionRunning, groups, setGroupExecutionRunning, nodesRef, generateWithActiveNode, persistCanvas } = deps;
async function downloadSelectedMedia() {
    await downloadMediaForNodeIds(selectedNodeIds);
  }

function getGroupDownloadNodeIds(group: GroupData) {
    const bounds = groupBoundsMap.get(group.id);
    const fallbackIds = new Set(group.nodeIds);
    if (!bounds) return group.nodeIds;
    const ids = nodes
      .filter((node) => rectContainsRect(bounds, rectFromNode(node)))
      .filter((node) => (node.type === "image" && (node.imageUrl || node.localPreviewUrl)) || (node.type === "video" && (node.videoUrl || node.localVideoUrl)))
      .map((node) => node.id);
    return ids.length > 0 ? ids : nodes.filter((node) => fallbackIds.has(node.id)).map((node) => node.id);
  }

async function downloadNodeMedia(node: NodeData) {
    await downloadMediaForNodeIds([node.id]);
  }

async function downloadMediaForNodeIds(nodeIds: string[]) {
    const idSet = new Set(nodeIds);
    const targets = nodes
      .filter((node) => idSet.has(node.id))
      .map((node) => {
        const mediaType: "image" | "video" | null =
          node.type === "image" && (node.imageUrl || node.localPreviewUrl)
            ? "image"
            : node.type === "video" && (node.videoUrl || node.localVideoUrl)
              ? "video"
              : null;
        if (!mediaType) return null;
        const url = mediaType === "image" ? node.imageUrl || node.localPreviewUrl || "" : node.videoUrl || node.localVideoUrl || "";
        return { node, mediaType, url };
      })
      .filter((item): item is { node: NodeData; mediaType: "image" | "video"; url: string } => Boolean(item && item.url));

    if (targets.length === 0) {
      setStatus("当前框选没有可下载的图片或视频");
      return;
    }

    setStatus(`开始批量下载 ${targets.length} 个文件...`);
    let success = 0;
    let failed = 0;

    for (let i = 0; i < targets.length; i += 1) {
      const item = targets[i];
      const safeTitle = (item.node.title || `media_${i + 1}`).replace(/[\\/:*?"<>|]/g, "_");
      try {
        if (item.url.startsWith("blob:")) {
          const ext = inferExtByType(null, item.url, item.mediaType);
          triggerBrowserDownload(item.url, `${safeTitle}_${i + 1}.${ext}`);
          success += 1;
          continue;
        }
        const blob = await fetchCanvasMediaBlob(item.url);
        const ext = inferExtByType(blob.type, item.url, item.mediaType);
        const href = URL.createObjectURL(blob);
        triggerBrowserDownload(href, `${safeTitle}_${i + 1}.${ext}`);
        window.setTimeout(() => URL.revokeObjectURL(href), 1200);
        success += 1;
      } catch {
        failed += 1;
      }
    }

    setStatus(`批量下载完成：成功 ${success}，失败 ${failed}`);
  }

function getNodesInsideGroupArea(group: GroupData) {
    const bounds = groupBoundsMap.get(group.id);
    const fallbackIds = new Set(group.nodeIds);
    if (!bounds) return nodes.filter((node) => fallbackIds.has(node.id));
    const enclosedNodes = nodes.filter((node) => rectContainsRect(bounds, rectFromNode(node)));
    return enclosedNodes.length > 0 ? enclosedNodes : nodes.filter((node) => fallbackIds.has(node.id));
  }

function isGroupExecutableNode(node: NodeData) {
    if (node.type === "compose" || node.type === "audio") return false;
    if (node.type !== "image" && node.type !== "video") return false;
    if (patchLooksActivelyGenerating(node)) return false;
    const hasPrompt = Boolean(node.prompt.trim());
    const hasIncomingConnection = edges.some((edge) => edge.toNodeId === node.id);
    const hasOwnMedia =
      node.type === "image"
        ? Boolean(node.imageUrl || node.localPreviewUrl || node.referenceAssetUri)
        : node.type === "video"
          ? Boolean(node.videoUrl || node.localVideoUrl || node.referenceAssetUri)
          : false;
    if (node.type === "image" || node.type === "video") {
      return hasPrompt || hasIncomingConnection || !hasOwnMedia;
    }
    return false;
  }

function getGroupExecutionPlan(group: GroupData) {
    return planCanvasGroupExecution(
      getNodesInsideGroupArea(group).filter(isGroupExecutableNode),
      edges,
    );
  }

function openGroupExecutionDialog(group: GroupData, opener?: HTMLButtonElement) {
    if (opener) groupExecutionOpenerRef.current = opener;
    setActiveGroupId(group.id);
    setSelectedNodeIds(group.nodeIds);
    setSelectedEdgeIds([]);
    setActiveNodeId(null);
    setLayoutDropdownOpen(false);
    setColorPaletteOpen(false);
    setSelectionLayoutMenuOpen(false);
    setGroupExecutionDialog({ groupId: group.id });
  }

function closeGroupExecutionDialog({ restoreFocus = true } = {}) {
    setGroupExecutionDialog(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => groupExecutionOpenerRef.current?.focus({ preventScroll: true }));
    }
  }

async function startGroupExecution() {
    if (!groupExecutionDialog || groupExecutionRunning) return;
    const group = groups.find((item) => item.id === groupExecutionDialog.groupId);
    if (!group) {
      setGroupExecutionDialog(null);
      return;
    }
    const executionPlan = getGroupExecutionPlan(group);
    if (executionPlan.cycleNodeIds.length > 0) {
      setStatus("组内存在循环依赖，请先断开循环连线");
      setGroupExecutionDialog(null);
      return;
    }
    if (executionPlan.orderedNodes.length === 0) {
      setStatus("组内没有可执行的生成节点");
      setGroupExecutionDialog(null);
      return;
    }

    setGroupExecutionRunning(true);
    setGroupExecutionDialog(null);
    try {
      nodesRef.current = nodes;
      setStatus("整组执行开始：" + executionPlan.orderedNodes.length + " 个生成节点");
      for (const node of executionPlan.orderedNodes) {
        const latestNode = nodesRef.current.find((candidate) => candidate.id === node.id) ?? node;
        setActiveGroupId(group.id);
        setActiveNodeId(latestNode.id);
        setSelectedNodeIds([latestNode.id]);
        setSelectedEdgeIds([]);
        const succeeded = await generateWithActiveNode(latestNode);
        if (!succeeded) {
          setStatus(`整组执行已停止：节点「${latestNode.title || latestNode.id}」执行失败`);
          return;
        }
      }
      await persistCanvas(nodesRef.current, edges);
      setStatus("整组执行完成 " + executionPlan.orderedNodes.length + " 个生成节点");
    } finally {
      setGroupExecutionRunning(false);
    }
  }
  return { downloadSelectedMedia, getGroupDownloadNodeIds, downloadNodeMedia, downloadMediaForNodeIds, getNodesInsideGroupArea, isGroupExecutableNode, getGroupExecutionPlan, openGroupExecutionDialog, closeGroupExecutionDialog, startGroupExecution };
}
