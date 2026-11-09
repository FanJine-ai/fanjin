import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { StoryboardGroupType, NodeData, ImageGridSplitEditorState, ImageGridSplitDragState, EdgeData, GroupData, CanvasMetaState } from "./canvasDataTypes";
import type { NodeType, RatioKey } from "./canvasMediaTypes";
import { nearestRatio } from "./canvasMediaGeometry";
import { type CanvasGenerationDebugSnapshot } from "./canvasGenerationDebug";
import { isCanvasUploadAbortError } from "./canvasUploadRuntime";

export interface CanvasImageGridControllerDependencies {
  setStatus: Dispatch<SetStateAction<string>>;
  setImageNineGridMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridCustomMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setImageGridCustomPreview: Dispatch<SetStateAction<{ nodeId: string; rows: number; cols: number; } | null>>;
  setVideoEnhanceResolutionOpen: Dispatch<SetStateAction<boolean>>;
  setImageGridSplitEditor: Dispatch<SetStateAction<ImageGridSplitEditorState | null>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  buildGridPresetLabel: (rows: number, cols: number) => string;
  imageGridSplitDragRef: RefObject<ImageGridSplitDragState | null>;
  imageGridSplitSuppressClickRef: RefObject<boolean>;
  createNode: (id: string, type: NodeType, centerX: number, centerY: number) => NodeData;
  buildGridCellLabel: (row: number, col: number) => string;
  buildGridCellKey: (row: number, col: number) => string;
  imageGridSplitEditor: ImageGridSplitEditorState | null;
  canvasContextEpochRef: RefObject<number>;
  nodeMap: Map<string, NodeData>;
  showNodeStatusChip: (nodeId: string, text: string, tone?: "neutral" | "success" | "error", durationMs?: number) => void;
  buildStoryboardGroupNodes: (sourceNode: NodeData, selectedCellKeys: string[], rows: number, cols: number, ratio: RatioKey, stamp: number) => NodeData[];
  buildStoryboardGroupData: (stamp: number, nodeIds: string[], title: string, groupType: StoryboardGroupType, rows: number, cols: number, ratio: RatioKey) => GroupData;
  nodes: NodeData[];
  edges: EdgeData[];
  groups: GroupData[];
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  setGroups: Dispatch<SetStateAction<GroupData[]>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveGroupId: Dispatch<SetStateAction<string | null>>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  canvasMeta: CanvasMetaState;
  parseGridCellKey: (key: string) => { row: number; col: number; };
  assertCanvasOperationActive: (expectedEpoch: number, signal?: AbortSignal) => void;
  uploadMediaFileToRemote: (file: File, type: "image" | "video", nodeId?: string) => Promise<{ url: string; width: number; height: number; ratio: RatioKey; fileName: string; assetId: string; assetVersionId: number | undefined; }>;
  setGenerateDebug: (snapshot: CanvasGenerationDebugSnapshot | null) => void;
}

export function createCanvasImageGridController(deps: CanvasImageGridControllerDependencies) {
  const { setStatus, setImageNineGridMenuNodeId, setImageGridMenuNodeId, setImageGridCustomMenuNodeId, setImageGridCustomPreview, setVideoEnhanceResolutionOpen, setImageGridSplitEditor, setActiveNodeId, buildGridPresetLabel, imageGridSplitDragRef, imageGridSplitSuppressClickRef, createNode, buildGridCellLabel, buildGridCellKey, imageGridSplitEditor, canvasContextEpochRef, nodeMap, showNodeStatusChip, buildStoryboardGroupNodes, buildStoryboardGroupData, nodes, edges, groups, setNodes, setEdges, setGroups, setSelectedNodeIds, setSelectedEdgeIds, setActiveGroupId, persistCanvas, canvasMeta, parseGridCellKey, assertCanvasOperationActive, uploadMediaFileToRemote, setGenerateDebug } = deps;
function openImageGridSplitEditor(node: NodeData, rows: number, cols: number) {
    const sourceUrl = node.imageUrl || node.localPreviewUrl;
    if (node.type !== "image" || !sourceUrl) {
      setStatus("当前图片节点还没有可用画面");
      return;
    }
    setImageNineGridMenuNodeId(null);
    setImageGridMenuNodeId(null);
    setImageGridCustomMenuNodeId(null);
    setImageGridCustomPreview(null);
    setVideoEnhanceResolutionOpen(false);
    setImageGridSplitEditor({
      nodeId: node.id,
      rows,
      cols,
      selectedCells: [],
      hoveredCell: null,
      enhanceFactor: 2,
      factorMenuOpen: false,
    });
    setActiveNodeId(node.id);
    setStatus(`已进入 ${buildGridPresetLabel(rows, cols)} 编辑`);
  }

function toggleImageGridSplitSelection(cellKey: string, append = false) {
    setImageGridSplitEditor((prev) => {
      if (!prev) return prev;
      const selectedCells = append
        ? prev.selectedCells.includes(cellKey)
          ? prev.selectedCells.filter((item) => item !== cellKey)
          : [...prev.selectedCells, cellKey]
        : [cellKey];
      return { ...prev, selectedCells };
    });
  }

function beginImageGridSplitDrag(sourceNodeId: string, cellKey: string, rows: number, cols: number, clientX: number, clientY: number) {
    imageGridSplitDragRef.current = {
      sourceNodeId,
      cellKey,
      rows,
      cols,
      startClientX: clientX,
      startClientY: clientY,
      createdNodeId: null,
    };
    imageGridSplitSuppressClickRef.current = false;
  }

function closeImageGridSplitEditor() {
    setImageGridSplitEditor(null);
    setImageGridMenuNodeId(null);
    setImageGridCustomMenuNodeId(null);
    setImageGridCustomPreview(null);
    imageGridSplitDragRef.current = null;
    imageGridSplitSuppressClickRef.current = false;
  }

function buildImageGridSplitSlotMetrics(sourceNode: NodeData, rows: number, cols: number) {
    const spacing = 10;
    const ratio = Math.max(0.4, sourceNode.height / Math.max(1, sourceNode.width));
    const totalWidth = Math.max(420, Math.min(980, sourceNode.width * 1.5));
    const slotWidth = Math.max(132, (totalWidth - spacing * Math.max(0, cols - 1)) / Math.max(1, cols));
    const slotHeight = Math.max(96, slotWidth * ratio);
    const startX = sourceNode.x + sourceNode.width + 72;
    const startY = sourceNode.y;
    return { spacing, ratio, totalWidth, slotWidth, slotHeight, startX, startY };
  }

function createImageGridCellNode(sourceNode: NodeData, row: number, col: number, rows: number, cols: number, left: number, top: number, slotWidth: number, slotHeight: number, stamp: number, suffix: string) {
    const id = `node_${stamp}_grid_${row}_${col}_${suffix}`;
    const baseNode = createNode(id, "image", 0, 0);
    return {
      ...baseNode,
      title: buildGridCellLabel(row, col),
      titleCustomized: true,
      x: left,
      y: top,
      width: slotWidth,
      height: slotHeight,
      ratio: nearestRatio(slotWidth, slotHeight),
      cropX: col / cols,
      cropY: row / rows,
      cropWidth: 1 / cols,
      cropHeight: 1 / rows,
      mediaNaturalWidth: sourceNode.mediaNaturalWidth,
      mediaNaturalHeight: sourceNode.mediaNaturalHeight,
      storyboardCellKey: buildGridCellKey(row, col),
      storyboardSlotOrder: row * cols + col,
    };
  }

function createDetachedImageGridCellNode(sourceNode: NodeData, row: number, col: number, rows: number, cols: number, left: number, top: number, stamp: number) {
    const cropAspect = Math.max(0.28, (sourceNode.width / Math.max(1, cols)) / Math.max(1, sourceNode.height / Math.max(1, rows)));
    const width = Math.max(260, Math.min(420, Math.round((sourceNode.width / Math.max(1, cols)) * 1.18)));
    const height = Math.max(160, Math.round(width / cropAspect));
    return {
      ...createImageGridCellNode(sourceNode, row, col, rows, cols, left, top, width, height, stamp, "detached"),
      title: `宫格分镜 ${buildGridCellLabel(row, col)}`,
      titleCustomized: true,
    } satisfies NodeData;
  }

async function buildCroppedImageFile(
    sourceNode: NodeData,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): Promise<File> {
    const src = sourceNode.localPreviewUrl || sourceNode.imageUrl;
    if (!src) throw new Error("当前图片节点还没有可用画面");
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new window.Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("读取待裁剪图片失败"));
      img.src = src;
    });
    const logicalWidth = Math.max(1, sourceNode.mediaNaturalWidth || image.naturalWidth);
    const logicalHeight = Math.max(1, sourceNode.mediaNaturalHeight || image.naturalHeight);
    const sourceX = Math.max(0, Math.min(image.naturalWidth - 1, Math.round((x1 / logicalWidth) * image.naturalWidth)));
    const sourceY = Math.max(0, Math.min(image.naturalHeight - 1, Math.round((y1 / logicalHeight) * image.naturalHeight)));
    const sourceWidth = Math.max(1, Math.min(
      image.naturalWidth - sourceX,
      Math.round(((x2 - x1) / logicalWidth) * image.naturalWidth),
    ));
    const sourceHeight = Math.max(1, Math.min(
      image.naturalHeight - sourceY,
      Math.round(((y2 - y1) / logicalHeight) * image.naturalHeight),
    ));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, x2 - x1);
    canvas.height = Math.max(1, y2 - y1);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("创建裁剪画布失败");
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((nextBlob) => {
        if (nextBlob) resolve(nextBlob);
        else reject(new Error("导出裁剪图片失败"));
      }, "image/png");
    });
    return new File([blob], `canvas-crop-${Date.now()}.png`, { type: "image/png" });
  }

async function buildGridCellImageFile(sourceNode: NodeData, row: number, col: number, rows: number, cols: number): Promise<File> {
    const src = sourceNode.localPreviewUrl || sourceNode.imageUrl;
    if (!src) {
      throw new Error("当前图片节点还没有可用画面");
    }
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new window.Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("读取宫格图片失败"));
      img.src = src;
    });
    const naturalWidth = Math.max(1, sourceNode.mediaNaturalWidth || image.naturalWidth || Math.round(sourceNode.width));
    const naturalHeight = Math.max(1, sourceNode.mediaNaturalHeight || image.naturalHeight || Math.round(sourceNode.height));
    const cropWidth = Math.max(1, Math.round(naturalWidth / cols));
    const cropHeight = Math.max(1, Math.round(naturalHeight / rows));
    const cropX = Math.min(naturalWidth - cropWidth, Math.max(0, Math.round((col / cols) * naturalWidth)));
    const cropY = Math.min(naturalHeight - cropHeight, Math.max(0, Math.round((row / rows) * naturalHeight)));
    const canvas = document.createElement("canvas");
    canvas.width = cropWidth;
    canvas.height = cropHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("创建宫格画布失败");
    context.drawImage(image, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((nextBlob) => {
        if (nextBlob) resolve(nextBlob);
        else reject(new Error("导出宫格图片失败"));
      }, "image/png");
    });
    return new File([blob], `grid-cell-${row + 1}-${col + 1}.png`, { type: "image/png" });
  }

async function submitImageGridSplitAssets() {
    if (!imageGridSplitEditor) return;
    const operationEpoch = canvasContextEpochRef.current;
    const sourceNode = nodeMap.get(imageGridSplitEditor.nodeId);
    if (!sourceNode || sourceNode.type !== "image") return;
    if (imageGridSplitEditor.selectedCells.length === 0) {
      setStatus("请先选择至少一个宫格");
      return;
    }

    setStatus("正在裁剪并创建分镜组...");
    showNodeStatusChip(sourceNode.id, "正在裁剪并创建分镜组...", "neutral", 1400);
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    if (canvasContextEpochRef.current !== operationEpoch) return;

    const stamp = Date.now();
    const { rows, cols, selectedCells } = imageGridSplitEditor;
    const storyboardRatio = sourceNode.ratio || "16:9";
    const resultNodes = buildStoryboardGroupNodes(sourceNode, selectedCells, rows, cols, storyboardRatio, stamp);

    const firstNode = resultNodes[0];
    const nextEdge: EdgeData | null = firstNode
      ? {
          id: `edge_${stamp}_grid_assets_source`,
          fromNodeId: sourceNode.id,
          fromSide: "right",
          toNodeId: firstNode.id,
          toSide: "left",
        }
      : null;
    const nextGroup = buildStoryboardGroupData(stamp, resultNodes.map((item) => item.id), "项目分镜组", "storyboard", rows, cols, storyboardRatio);

    const nextNodes = [...nodes, ...resultNodes];
    const nextEdges = nextEdge ? [...edges, nextEdge] : [...edges];
    const nextGroups = [...groups, nextGroup];
    setNodes(nextNodes);
    setEdges(nextEdges);
    setGroups(nextGroups);
    setSelectedNodeIds(nextGroup.nodeIds);
    setSelectedEdgeIds(nextEdge ? [nextEdge.id] : []);
    setActiveGroupId(nextGroup.id);
    setActiveNodeId(null);
    closeImageGridSplitEditor();
    void persistCanvas(nextNodes, nextEdges, canvasMeta.name, nextGroups);

    let resolvedNodes = resultNodes;
    let successCount = 0;
    let failedCount = 0;
    setStatus(`正在拆分并保存项目资产（${selectedCells.length}张）...`);

    for (const cellKey of selectedCells) {
      if (canvasContextEpochRef.current !== operationEpoch) return;
      const { row, col } = parseGridCellKey(cellKey);
      const targetNode = resultNodes.find((item) => item.title === buildGridCellLabel(row, col));
      if (!targetNode) continue;
      try {
        const croppedFile = await buildGridCellImageFile(sourceNode, row, col, rows, cols);
        assertCanvasOperationActive(operationEpoch);
        const uploaded = await uploadMediaFileToRemote(croppedFile, "image");
        assertCanvasOperationActive(operationEpoch);
        const patch: Partial<NodeData> = {
          imageUrl: uploaded.url,
          localPreviewUrl: undefined,
          referenceAssetUri: uploaded.assetId ? `asset://${uploaded.assetId}` : undefined,
          assetVersionId: uploaded.assetVersionId,
          mediaNaturalWidth: uploaded.width,
          mediaNaturalHeight: uploaded.height,
          cropX: 0,
          cropY: 0,
          cropWidth: 1,
          cropHeight: 1,
          storyboardSlotFilledByUser: true,
          storyboardSlotPlaceholder: false,
        };
        resolvedNodes = resolvedNodes.map((item) => item.id === targetNode.id ? { ...item, ...patch } : item);
        setNodes((current) => current.map((item) => item.id === targetNode.id ? { ...item, ...patch } : item));
        successCount += 1;
      } catch (error) {
        if (isCanvasUploadAbortError(error) || canvasContextEpochRef.current !== operationEpoch) return;
        failedCount += 1;
        setGenerateDebug({
          phase: "image-grid-asset-error",
          payload: {
            sourceNodeId: sourceNode.id,
            targetNodeId: targetNode.id,
            cellKey,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    if (canvasContextEpochRef.current !== operationEpoch) return;
    const finalNodes = nextNodes.map((item) => resolvedNodes.find((resolved) => resolved.id === item.id) || item);
    setNodes(finalNodes);
    await persistCanvas(finalNodes, nextEdges, canvasMeta.name, nextGroups);
    if (canvasContextEpochRef.current !== operationEpoch) return;
    if (successCount > 0 && failedCount === 0) {
      setStatus(`宫格拆分完成，已保存 ${successCount} 张项目资产`);
    } else if (successCount > 0) {
      setStatus(`宫格拆分部分完成（已保存 ${successCount} 张，失败 ${failedCount} 张）`);
    } else {
      setStatus("宫格拆分资产保存失败");
    }
  }

async function createImageGridSplitGroup() {
    if (!imageGridSplitEditor) return;
    const sourceNode = nodeMap.get(imageGridSplitEditor.nodeId);
    if (!sourceNode || sourceNode.type !== "image") return;
    const sourceUrl = sourceNode.imageUrl || sourceNode.localPreviewUrl;
    if (!sourceUrl) {
      setStatus("当前图片节点还没有可用画面");
      return;
    }
    if (imageGridSplitEditor.selectedCells.length === 0) {
      setStatus("请先选择至少一个宫格");
      return;
    }

    const stamp = Date.now();
    const rows = imageGridSplitEditor.rows;
    const cols = imageGridSplitEditor.cols;
    const storyboardRatio = sourceNode.ratio || "16:9";
    const createdNodes = buildStoryboardGroupNodes(sourceNode, imageGridSplitEditor.selectedCells, rows, cols, storyboardRatio, stamp);

    const nextEdge: EdgeData | null =
      createdNodes.length > 0
        ? {
            id: `edge_${stamp}_grid_source`,
            fromNodeId: sourceNode.id,
            fromSide: "right",
            toNodeId: createdNodes[0].id,
            toSide: "left",
          }
        : null;

    const nextGroup = buildStoryboardGroupData(stamp, createdNodes.map((item) => item.id), "宫格分镜组", "storyboard", rows, cols, storyboardRatio);

    const nextNodes = [...nodes, ...createdNodes];
    const nextEdges = nextEdge ? [...edges, nextEdge] : [...edges];
    const nextGroups = [...groups, nextGroup];

    setNodes(nextNodes);
    setEdges(nextEdges);
    setGroups(nextGroups);
    setSelectedNodeIds(nextGroup.nodeIds);
    setSelectedEdgeIds(nextEdge ? [nextEdge.id] : []);
    setActiveGroupId(nextGroup.id);
    setActiveNodeId(null);
    closeImageGridSplitEditor();
    void persistCanvas(nextNodes, nextEdges, canvasMeta.name, nextGroups);
    setStatus(`已创建宫格分镜组，共 ${imageGridSplitEditor.selectedCells.length} 张`);
  }
  return { openImageGridSplitEditor, toggleImageGridSplitSelection, beginImageGridSplitDrag, closeImageGridSplitEditor, buildImageGridSplitSlotMetrics, createImageGridCellNode, createDetachedImageGridCellNode, buildCroppedImageFile, buildGridCellImageFile, submitImageGridSplitAssets, createImageGridSplitGroup };
}
