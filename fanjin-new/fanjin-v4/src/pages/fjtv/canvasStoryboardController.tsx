import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { MaxImageCount, VideoEnhanceVersion, VideoEnhanceResolution, VideoEnhanceFrameRate, VideoSubtitleEraseType, AudioSeparateRole, ImageEnhanceVersion, ImageEraseKind, StoryboardGroupType, StoryboardStitchResolution, TextNodeHeading, TextNodeListStyle, EraseRatioLocation, CameraSettings, VideoStoryAnalysis, VideoStoryTaskState, ProductScriptWorkflow, NodeData, EdgeData, GroupData, CanvasMetaState, VideoGenerationMode } from "./canvasDataTypes";
import type { NodeType, RatioKey, ImageOutpaintRatioMode, ImageOutpaintResolution } from "./canvasMediaTypes";
import { ratioToNodeDimensions, nearestRatio } from "./canvasMediaGeometry";
import { type VideoOutputFormat } from "../../features/quick-create/videoOutputContract";
import { type CanvasArtifactKind } from "./canvasTextArtifacts";
import { type PersistedComposeClip } from "./canvasComposeTimeline";
import { isCanvasUploadAbortError } from "./canvasUploadRuntime";
import { rectFromNode, unionRects, type CanvasRect as Rect } from "./canvasGeometry";
import { type GeneratedImageChoice } from "./canvasTaskResults";

export interface CanvasStoryboardControllerDependencies {
  createImageGridCellNode: (sourceNode: NodeData, row: number, col: number, rows: number, cols: number, left: number, top: number, slotWidth: number, slotHeight: number, stamp: number, suffix: string) => NodeData;
  buildGridCellLabel: (row: number, col: number) => string;
  getStoryboardFilledCount: (group: GroupData | null | undefined) => number;
  isStoryboardGroup: (group: GroupData | null | undefined) => group is GroupData & { groupType: StoryboardGroupType; };
  buildGridCellKey: (row: number, col: number) => string;
  selectedNodeIds: string[];
  activeGroupId: string | null;
  groups: GroupData[];
  setStatus: Dispatch<SetStateAction<string>>;
  groupBoundsMap: Map<string, Rect>;
  nodeMap: Map<string, NodeData>;
  getStoryboardGroupSlots: (group: GroupData | null | undefined) => NodeData[];
  nodes: NodeData[];
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  setGroups: Dispatch<SetStateAction<GroupData[]>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveGroupId: Dispatch<SetStateAction<string | null>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  setSelectionLayoutMenuOpen: Dispatch<SetStateAction<boolean>>;
  setLayoutDropdownOpen: Dispatch<SetStateAction<boolean>>;
  setColorPaletteOpen: Dispatch<SetStateAction<boolean>>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  edges: EdgeData[];
  canvasMeta: CanvasMetaState;
  canvasContextEpochRef: RefObject<number>;
  uploadMediaFileToRemote: (file: File, type: "image" | "video", nodeId?: string) => Promise<{ url: string; width: number; height: number; ratio: RatioKey; fileName: string; assetId: string; assetVersionId: number | undefined; }>;
  assertCanvasOperationActive: (expectedEpoch: number, signal?: AbortSignal) => void;
  createNode: (id: string, type: NodeType, centerX: number, centerY: number) => NodeData;
}

export function createCanvasStoryboardController(deps: CanvasStoryboardControllerDependencies) {
  const { createImageGridCellNode, buildGridCellLabel, getStoryboardFilledCount, isStoryboardGroup, buildGridCellKey, selectedNodeIds, activeGroupId, groups, setStatus, groupBoundsMap, nodeMap, getStoryboardGroupSlots, nodes, setNodes, setGroups, setSelectedNodeIds, setSelectedEdgeIds, setActiveGroupId, setActiveNodeId, setSelectionLayoutMenuOpen, setLayoutDropdownOpen, setColorPaletteOpen, persistCanvas, edges, canvasMeta, canvasContextEpochRef, uploadMediaFileToRemote, assertCanvasOperationActive, createNode } = deps;
function buildStoryboardSlotNode(sourceNode: NodeData, row: number, col: number, rows: number, cols: number, left: number, top: number, slotWidth: number, slotHeight: number, stamp: number, suffix: string, filled: boolean, filledByUser = false) {
    const nextNode: NodeData = {
      ...createImageGridCellNode(sourceNode, row, col, rows, cols, left, top, slotWidth, slotHeight, stamp, suffix),
      title: `宫格分镜 ${buildGridCellLabel(row, col)}`,
      imageUrl: filled ? sourceNode.imageUrl || "" : "",
      localPreviewUrl: filled ? sourceNode.localPreviewUrl || undefined : undefined,
      storyboardSlotPlaceholder: !filled,
      storyboardSlotFilledByUser: filledByUser,
    };
    return nextNode;
  }

function storyboardSlotDimensions(ratio: RatioKey) {
    const dims = ratioToNodeDimensions(ratio, "image");
    const scale = ratio === "16:9" ? 0.82 : ratio === "4:3" ? 0.8 : 0.72;
    return {
      width: Math.max(180, Math.round(dims.width * scale)),
      height: Math.max(140, Math.round(dims.height * scale)),
    };
  }

function getStoryboardDisplayTitle(group: GroupData) {
    const filledCount = getStoryboardFilledCount(group);
    const prefix = group.title?.trim() || (group.groupType === "storyboard-hd" ? "高清分镜组" : "宫格分镜组");
    return `${prefix}（${filledCount}张）`;
  }

function getGroupDisplayTitle(group: GroupData) {
    if (isStoryboardGroup(group)) return getStoryboardDisplayTitle(group);
    if (group.title?.trim().startsWith("预设 - ")) return group.title.trim();
    return `${group.title?.trim() || "分组"} ${group.nodeIds.length} 个节点`;
  }

function buildStoryboardGroupNodes(sourceNode: NodeData, selectedCellKeys: string[], rows: number, cols: number, ratio: RatioKey, stamp: number) {
    const { width: slotWidth, height: slotHeight } = storyboardSlotDimensions(ratio);
    const spacing = 0;
    const startX = sourceNode.x + sourceNode.width + 96;
    const startY = sourceNode.y + 26;
    const selectedSet = new Set(selectedCellKeys);
    const createdNodes: NodeData[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const cellKey = buildGridCellKey(row, col);
        const left = startX + col * (slotWidth + spacing);
        const top = startY + row * (slotHeight + spacing);
        const nextNode = buildStoryboardSlotNode(sourceNode, row, col, rows, cols, left, top, slotWidth, slotHeight, stamp, `${row}_${col}`, selectedSet.has(cellKey));
        nextNode.ratio = ratio;
        nextNode.width = slotWidth;
        nextNode.height = slotHeight;
        createdNodes.push(nextNode);
      }
    }
    return createdNodes;
  }

function buildStoryboardGroupData(stamp: number, nodeIds: string[], title: string, groupType: StoryboardGroupType, rows: number, cols: number, ratio: RatioKey): GroupData {
    return {
      id: `group_${stamp}_${groupType}`,
      nodeIds,
      layoutMode: "grid",
      themeColor: "#2d2d30",
      title,
      groupType,
      storyboardRows: rows,
      storyboardCols: cols,
      storyboardRatio: ratio,
      storyboardStitchResolution: "2k",
      storyboardShowOrder: false,
    };
  }

function mergeStoryboardGroupsShortcut() {
    const selectedSet = new Set(selectedNodeIds);
    const storyboardGroupIds = new Set<string>();
    if (activeGroupId) storyboardGroupIds.add(activeGroupId);
    groups.forEach((group) => {
      if (!isStoryboardGroup(group)) return;
      if (group.nodeIds.some((nodeId) => selectedSet.has(nodeId))) storyboardGroupIds.add(group.id);
    });

    const storyboardGroups = groups.filter((group): group is GroupData & { groupType: StoryboardGroupType } => isStoryboardGroup(group) && storyboardGroupIds.has(group.id));
    if (storyboardGroups.length < 2) {
      setStatus("请先选择至少 2 个分镜组再合并");
      return;
    }

    const sortRectForGroup = (group: GroupData) => {
      const cached = groupBoundsMap.get(group.id);
      if (cached) return cached;
      const memberRects = group.nodeIds.map((id) => nodeMap.get(id)).filter((node): node is NodeData => Boolean(node)).map(rectFromNode);
      return unionRects(memberRects);
    };
    const orderedGroups = [...storyboardGroups].sort((a, b) => {
      const aRect = sortRectForGroup(a);
      const bRect = sortRectForGroup(b);
      return (aRect?.top ?? 0) - (bRect?.top ?? 0) || (aRect?.left ?? 0) - (bRect?.left ?? 0);
    });
    const orderedSlots = orderedGroups.flatMap((group) => getStoryboardGroupSlots(group));
    if (orderedSlots.length === 0) {
      setStatus("选中的分镜组里没有可合并的分镜格");
      return;
    }

    const firstGroup = orderedGroups[0];
    const groupType = firstGroup.groupType;
    const ratio = firstGroup.storyboardRatio || "16:9";
    const cols = Math.max(1, Math.min(6, ...orderedGroups.map((group) => group.storyboardCols || 2)));
    const rows = Math.max(1, Math.ceil(orderedSlots.length / cols));
    const { width: slotWidth, height: slotHeight } = storyboardSlotDimensions(ratio);
    const startX = Math.min(...orderedSlots.map((node) => node.x));
    const startY = Math.min(...orderedSlots.map((node) => node.y));
    const stamp = Date.now();
    const nextNodeMap = new Map(nodes.map((node) => [node.id, node]));
    const finalIds: string[] = [];

    for (let order = 0; order < rows * cols; order += 1) {
      const row = Math.floor(order / cols);
      const col = order % cols;
      const left = startX + col * slotWidth;
      const top = startY + row * slotHeight;
      const slot = orderedSlots[order];
      if (slot) {
        nextNodeMap.set(slot.id, {
          ...slot,
          x: left,
          y: top,
          width: slotWidth,
          height: slotHeight,
          ratio,
          storyboardCellKey: buildGridCellKey(row, col),
          storyboardSlotOrder: order,
          storyboardSlotPlaceholder: Boolean(slot.storyboardSlotPlaceholder && !slot.imageUrl && !slot.localPreviewUrl),
        });
        finalIds.push(slot.id);
      } else {
        const base = orderedSlots[0];
        const created = buildStoryboardSlotNode(base, row, col, rows, cols, left, top, slotWidth, slotHeight, stamp, `merged_${row}_${col}`, false);
        created.ratio = ratio;
        nextNodeMap.set(created.id, created);
        finalIds.push(created.id);
      }
    }

    const mergedNodeIds = new Set(finalIds);
    const mergedGroupIds = new Set(orderedGroups.map((group) => group.id));
    const nextGroup: GroupData = {
      ...buildStoryboardGroupData(stamp, finalIds, "合并分镜组", groupType, rows, cols, ratio),
      storyboardStitchResolution: firstGroup.storyboardStitchResolution || "2k",
      storyboardShowOrder: firstGroup.storyboardShowOrder,
    };
    const nextGroups = groups
      .filter((group) => !mergedGroupIds.has(group.id))
      .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => !mergedNodeIds.has(id)) }))
      .filter((group) => group.nodeIds.length >= 2)
      .concat(nextGroup);
    const existingNodeIds = new Set(nodes.map((node) => node.id));
    const createdNodes = finalIds
      .map((id) => nextNodeMap.get(id))
      .filter((node): node is NodeData => Boolean(node && !existingNodeIds.has(node.id)));
    const nextNodes = nodes.map((node) => nextNodeMap.get(node.id) || node).concat(createdNodes);

    setNodes(nextNodes);
    setGroups(nextGroups);
    setSelectedNodeIds(finalIds);
    setSelectedEdgeIds([]);
    setActiveGroupId(nextGroup.id);
    setActiveNodeId(null);
    setSelectionLayoutMenuOpen(false);
    setLayoutDropdownOpen(false);
    setColorPaletteOpen(false);
    setStatus(`已合并 ${orderedGroups.length} 个分镜组，共 ${orderedSlots.length} 格`);
    void persistCanvas(nextNodes, edges, canvasMeta.name, nextGroups);
  }

function rebuildStoryboardGroupStructure(group: GroupData, rows: number, cols: number, ratio: RatioKey) {
    if (!isStoryboardGroup(group)) return;
    const slots = getStoryboardGroupSlots(group);
    const seedNode = slots[0];
    if (!seedNode) return;
    const fillable = slots.filter((node) => Boolean(node.imageUrl || node.localPreviewUrl));
    const { width: slotWidth, height: slotHeight } = storyboardSlotDimensions(ratio);
    const startX = seedNode.x;
    const startY = seedNode.y;
    const nextNodes = [...nodes];
    const existingByOrder = new Map<number, NodeData>();
    slots.forEach((node) => existingByOrder.set(Number(node.storyboardSlotOrder || 0), node));
    const filledQueue = [...fillable];
    const finalIds: string[] = [];
    const removeIds = new Set<string>();
    const stamp = Date.now();

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const order = row * cols + col;
        const existing = existingByOrder.get(order);
        const base = existing || filledQueue.shift() || seedNode;
        const left = startX + col * slotWidth;
        const top = startY + row * slotHeight;
        if (existing) {
          const idx = nextNodes.findIndex((item) => item.id === existing.id);
          if (idx >= 0) {
            nextNodes[idx] = {
              ...nextNodes[idx],
              x: left,
              y: top,
              width: slotWidth,
              height: slotHeight,
              ratio,
              storyboardCellKey: buildGridCellKey(row, col),
              storyboardSlotOrder: order,
            };
          }
          finalIds.push(existing.id);
        } else {
          const created = buildStoryboardSlotNode(base, row, col, rows, cols, left, top, slotWidth, slotHeight, stamp, `rebuilt_${row}_${col}`, false);
          created.ratio = ratio;
          nextNodes.push(created);
          finalIds.push(created.id);
        }
      }
    }

    slots.forEach((node) => {
      if (!finalIds.includes(node.id)) removeIds.add(node.id);
    });

    const filteredNodes = nextNodes.filter((node) => !removeIds.has(node.id));
    const nextGroups = groups.map((item) =>
      item.id === group.id
        ? {
            ...item,
            nodeIds: finalIds,
            storyboardRows: rows,
            storyboardCols: cols,
            storyboardRatio: ratio,
          }
        : item,
    );
    setNodes(filteredNodes);
    setGroups(nextGroups);
    setSelectedNodeIds(finalIds);
    setActiveGroupId(group.id);
    setActiveNodeId(null);
    void persistCanvas(filteredNodes, edges, canvasMeta.name, nextGroups);
  }

async function stitchStoryboardGroup(group: GroupData, resolution: StoryboardStitchResolution) {
    if (!isStoryboardGroup(group)) return;
    const operationEpoch = canvasContextEpochRef.current;
    const slots = getStoryboardGroupSlots(group);
    if (slots.length === 0) return;
    const rows = group.storyboardRows || 2;
    const cols = group.storyboardCols || 2;
    const first = slots[0];
    const slotWidth = resolution === "4k" ? 1024 : 768;
    const slotHeight = Math.max(1, Math.round((first.height / Math.max(1, first.width)) * slotWidth));
    const canvas = document.createElement("canvas");
    canvas.width = cols * slotWidth;
    canvas.height = rows * slotHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#2b2b2d";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const node of slots) {
      const row = Math.floor(Number(node.storyboardSlotOrder || 0) / cols);
      const col = Number(node.storyboardSlotOrder || 0) % cols;
      const dx = col * slotWidth;
      const dy = row * slotHeight;
      if (node.imageUrl || node.localPreviewUrl) {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new window.Image();
          image.crossOrigin = "anonymous";
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error("读取分镜图失败"));
          image.src = node.localPreviewUrl || node.imageUrl || "";
        }).catch(() => null);
        if (canvasContextEpochRef.current !== operationEpoch) return;
        if (img) {
          const sx = Math.max(0, Math.round((node.cropX || 0) * img.naturalWidth));
          const sy = Math.max(0, Math.round((node.cropY || 0) * img.naturalHeight));
          const sw = Math.max(1, Math.round((node.cropWidth || 1) * img.naturalWidth));
          const sh = Math.max(1, Math.round((node.cropHeight || 1) * img.naturalHeight));
          ctx.drawImage(img, sx, sy, sw, sh, dx, dy, slotWidth, slotHeight);
        }
      }
      ctx.strokeStyle = "#1f2022";
      ctx.lineWidth = 2;
      ctx.strokeRect(dx, dy, slotWidth, slotHeight);
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((value) => resolve(value), "image/png"));
    if (canvasContextEpochRef.current !== operationEpoch) return;
    if (!blob) return;
    const file = new File([blob], `storyboard-stitch-${resolution}.png`, { type: "image/png" });
    let uploaded: Awaited<ReturnType<typeof uploadMediaFileToRemote>>;
    try {
      uploaded = await uploadMediaFileToRemote(file, "image");
      assertCanvasOperationActive(operationEpoch);
    } catch (error) {
      if (isCanvasUploadAbortError(error) || canvasContextEpochRef.current !== operationEpoch) return;
      setStatus(error instanceof Error ? error.message : "拼接分镜上传失败");
      return;
    }
    const centerX = slots[slots.length - 1].x + slots[slots.length - 1].width + 140;
    const centerY = slots[0].y + (rows * first.height) / 2;
    const id = `node_${Date.now()}_storyboard_stitch`;
    const nextNode: NodeData = {
      ...createNode(id, "image", centerX, centerY),
      title: `拼接分镜 ${resolution}`,
      titleCustomized: true,
      imageUrl: uploaded.url,
      referenceAssetUri: uploaded.assetId ? `asset://${uploaded.assetId}` : undefined,
      assetVersionId: uploaded.assetVersionId,
      width: Math.round(first.width * Math.max(1.2, cols * 0.74)),
      height: Math.round(first.height * Math.max(1.2, rows * 0.74)),
      ratio: nearestRatio(canvas.width, canvas.height),
      mediaNaturalWidth: canvas.width,
      mediaNaturalHeight: canvas.height,
    };
    const nextNodes = [...nodes, nextNode];
    setNodes(nextNodes);
    setSelectedNodeIds([nextNode.id]);
    setSelectedEdgeIds([]);
    setActiveNodeId(nextNode.id);
    void persistCanvas(nextNodes, edges);
    setStatus(`已生成拼接分镜（${resolution}）`);
  }

function clearStoryboardFilledSlots(group: GroupData) {
    if (!isStoryboardGroup(group)) return;
    const targetIds = new Set(getStoryboardGroupSlots(group).filter((node) => node.storyboardSlotFilledByUser).map((node) => node.id));
    const nextNodes = nodes.map((node) =>
      targetIds.has(node.id)
        ? {
            ...node,
            imageUrl: "",
            localPreviewUrl: undefined,
            storyboardSlotFilledByUser: false,
            storyboardSlotPlaceholder: true,
          }
        : node,
    );
    setNodes(nextNodes);
    void persistCanvas(nextNodes, edges);
  }

function convertStoryboardGroupToRegular(group: GroupData) {
    if (!isStoryboardGroup(group)) return;
    const nextGroups = groups.map((item): GroupData =>
      item.id === group.id
        ? {
            id: item.id,
            nodeIds: item.nodeIds,
            layoutMode: "grid",
            themeColor: item.themeColor,
            title: item.title,
            groupType: "default",
          }
        : item,
    );
    setGroups(nextGroups);
    void persistCanvas(nodes, edges, canvasMeta.name, nextGroups);
  }
  return { buildStoryboardSlotNode, storyboardSlotDimensions, getStoryboardDisplayTitle, getGroupDisplayTitle, buildStoryboardGroupNodes, buildStoryboardGroupData, mergeStoryboardGroupsShortcut, rebuildStoryboardGroupStructure, stitchStoryboardGroup, clearStoryboardFilledSlots, convertStoryboardGroupToRegular };
}
