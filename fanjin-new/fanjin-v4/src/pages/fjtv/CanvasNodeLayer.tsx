import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { getDraggedMediaFiles } from "./canvasUploadMedia";
import type { ViewportState, NodeData, EdgeData, GroupData, NodeDragState, TextResizeState, CanvasHistorySnapshot, CanvasUploadRetry, CanvasNodeUploadResult } from "./canvasDataTypes";

import { buildImageTransformStyle } from "./canvasMediaGeometry";

import ReferencePreviewImage from "@/features/quick-create/attachments/ReferencePreviewImage";
import { ReferencePreviewVideo } from "@/features/quick-create/attachments/AuthenticatedReferenceMedia";


import { Expand, Play } from "lucide-react";
import { getCanvasImagePreviewUrl, getNodeImageDisplayUrl, getNodeImagePreviewUrl, nodeDimensionText, nodeHasMedia } from "./canvasAssetPresentation";
import { findGroupByNode } from "./canvasGeometry";


export interface CanvasNodeLayerDependencies {
  visibleNodes: NodeData[];
  visibleNodeIdSet: Set<string>;
  interactionPerformanceMode: boolean;
  viewportVisualScale: (nextViewport?: ViewportState) => number;
  editingNodeTitleId: string | null;
  editingTextNodeId: string | null;
  findStoryboardGroupByNodeId: (nodeId: string) => GroupData | null;
  singleSelectedNodeId: string | null;
  nodes: NodeData[];
  formatDurationLabel: (seconds: number) => string;
  activeNodeId: string | null;
  renderNodeMediaToolbar: (node: NodeData) => JSX.Element | null;
  renderTextNodeDownloadButton: (node: NodeData) => ReactNode;
  renderRichTextNodeEditorToolbar: (node: NodeData) => JSX.Element;
  beginNodeMove: (node: NodeData, event: React.MouseEvent<HTMLElement>) => void;
  renderCanvasNodeGlyph: (type: NodeData["type"], variant?: "node" | "header") => ReactNode;
  editingNodeTitleDraft: string;
  setEditingNodeTitleDraft: Dispatch<SetStateAction<string>>;
  commitNodeTitle: (nodeId: string, fallbackTitle: string) => void;
  cancelNodeTitleEdit: () => void;
  startEditNodeTitle: (node: NodeData) => void;
  dragNode: NodeDragState;
  NODE_RADIUS: 12;
  selectedNodeIdSet: Set<string>;
  NODE_SELECTION_BORDER: "#d0d0d2";
  NODE_SELECTION_GLOW: "0 0 0 1px rgba(255,255,255,0.72), 0 0 36px rgba(255,255,255,0.08)";
  ensureApiKeyReady: () => boolean;
  canvasContextEpochRef: RefObject<number>;
  uploadFileIntoNode: (nodeId: string, file: File, type: "image" | "video", options?: CanvasUploadRetry["options"]) => Promise<CanvasNodeUploadResult | null>;
  createMediaNodeFromFile: (file: File, worldX: number, worldY: number) => Promise<void>;
  setHoverTextNodeId: Dispatch<SetStateAction<string | null>>;
  toWorld: (clientX: number, clientY: number) => { x: number; y: number; };
  createDuplicateFromNodeIds: (sourceIds: string[], offsetX?: number, offsetY?: number) => { duplicatedNodes: NodeData[]; duplicatedEdges: EdgeData[]; idMap: Map<string, string>; } | null;
  edges: EdgeData[];
  recordCanvasHistoryMutation: (snapshot: CanvasHistorySnapshot, previousSnapshot?: CanvasHistorySnapshot) => void;
  buildHistorySnapshot: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextGroups?: GroupData[], nextViewport?: ViewportState) => CanvasHistorySnapshot;
  groups: GroupData[];
  viewport: ViewportState;
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveGroupId: Dispatch<SetStateAction<string | null>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  setDragNode: Dispatch<SetStateAction<NodeDragState>>;
  selectedNodeIds: string[];
  closePromptMenus: () => void;
  setLayoutDropdownOpen: Dispatch<SetStateAction<boolean>>;
  setColorPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setSelectionLayoutMenuOpen: Dispatch<SetStateAction<boolean>>;
  beginNodeConnectionHold: (node: NodeData, event: React.MouseEvent<HTMLElement>) => void;
  commitTextNodeEditing: () => void;
  openComposeEditor: (nodeId: string) => Promise<void>;
  startTextNodeEditing: (node: NodeData) => void;
  renderVirtualizedNodePlaceholder: (node: NodeData) => ReactNode;
  renderLightweightMediaNode: (node: NodeData, previewSide: number) => ReactNode;
  renderProductScriptNode: (node: NodeData) => JSX.Element;
  canvasColorMode: "dark" | "light";
  getNodeVideoPosterUrl: (node: NodeData) => string;
  videoNodePlaying: Record<string, boolean>;
  canvasPerformanceMode: boolean;
  nodeVideoRefs: RefObject<Record<string, HTMLVideoElement | null>>;
  setVideoNodeDurations: Dispatch<SetStateAction<Record<string, number>>>;
  applyNodeMediaGeometry: (nodeId: string, mediaWidth: number, mediaHeight: number, patch?: Partial<NodeData>) => void;
  primeVideoPreviewFrame: (node: NodeData, target: HTMLVideoElement) => void;
  setVideoNodeCurrentTimes: Dispatch<SetStateAction<Record<string, number>>>;
  setVideoNodeMuted: Dispatch<SetStateAction<Record<string, boolean>>>;
  setVideoNodePlaying: Dispatch<SetStateAction<Record<string, boolean>>>;
  renderInlineVideoControls: (node: NodeData) => JSX.Element | null;
  renderNodePlaceholder: (node: NodeData) => JSX.Element;
  renderNodeUploadOverlay: (node: NodeData) => ReactNode;
  renderNodeGenerationOverlay: (_node: NodeData) => null;
  renderNodeProgressChip: (node: NodeData) => JSX.Element | null;
  renderImageGridSplitOverlay: (node: NodeData) => ReactNode;
  renderImageOutpaintOverlay: (node: NodeData) => ReactNode;
  renderImageCropOverlay: (node: NodeData) => ReactNode;
  renderVideoEraseRegionOverlay: (node: NodeData) => JSX.Element | null;
  renderVideoSubtitleEraseBar: (node: NodeData) => ReactNode;
  renderImageGridSplitToolbar: (node: NodeData) => ReactNode;
  renderImageTransformEditor: (node: NodeData) => ReactNode;
  renderVideoTrimEditor: (node: NodeData) => JSX.Element | null;
  renderVideoStoryPanel: (node: NodeData) => ReactNode;
  setTextResize: Dispatch<SetStateAction<TextResizeState>>;
}

export function createCanvasNodeLayer(deps: CanvasNodeLayerDependencies) {
  const {
    visibleNodes,
    visibleNodeIdSet,
    interactionPerformanceMode,
    viewportVisualScale,
    editingNodeTitleId,
    editingTextNodeId,
    findStoryboardGroupByNodeId,
    singleSelectedNodeId,
    nodes,
    formatDurationLabel,
    activeNodeId,
    renderNodeMediaToolbar,
    renderTextNodeDownloadButton,
    renderRichTextNodeEditorToolbar,
    beginNodeMove,
    renderCanvasNodeGlyph,
    editingNodeTitleDraft,
    setEditingNodeTitleDraft,
    commitNodeTitle,
    cancelNodeTitleEdit,
    startEditNodeTitle,
    dragNode,
    NODE_RADIUS,
    selectedNodeIdSet,
    NODE_SELECTION_BORDER,
    NODE_SELECTION_GLOW,
    ensureApiKeyReady,
    canvasContextEpochRef,
    uploadFileIntoNode,
    createMediaNodeFromFile,
    setHoverTextNodeId,
    toWorld,
    createDuplicateFromNodeIds,
    edges,
    recordCanvasHistoryMutation,
    buildHistorySnapshot,
    groups,
    viewport,
    setNodes,
    setEdges,
    setSelectedNodeIds,
    setSelectedEdgeIds,
    setActiveGroupId,
    setActiveNodeId,
    setDragNode,
    selectedNodeIds,
    closePromptMenus,
    setLayoutDropdownOpen,
    setColorPaletteOpen,
    setSelectionLayoutMenuOpen,
    beginNodeConnectionHold,
    commitTextNodeEditing,
    openComposeEditor,
    startTextNodeEditing,
    renderVirtualizedNodePlaceholder,
    renderLightweightMediaNode,
    renderProductScriptNode,
    canvasColorMode,
    getNodeVideoPosterUrl,
    videoNodePlaying,
    canvasPerformanceMode,
    nodeVideoRefs,
    setVideoNodeDurations,
    applyNodeMediaGeometry,
    primeVideoPreviewFrame,
    setVideoNodeCurrentTimes,
    setVideoNodeMuted,
    setVideoNodePlaying,
    renderInlineVideoControls,
    renderNodePlaceholder,
    renderNodeUploadOverlay,
    renderNodeGenerationOverlay,
    renderNodeProgressChip,
    renderImageGridSplitOverlay,
    renderImageOutpaintOverlay,
    renderImageCropOverlay,
    renderVideoEraseRegionOverlay,
    renderVideoSubtitleEraseBar,
    renderImageGridSplitToolbar,
    renderImageTransformEditor,
    renderVideoTrimEditor,
    renderVideoStoryPanel,
    setTextResize,
  } = deps;
  function renderCanvasNodeLayer() { return (visibleNodes.map((node) => {
          const renderFullNode = visibleNodeIdSet.has(node.id);
          const mediaPreviewSide = interactionPerformanceMode ? 420 : 960;
          const visualScale = viewportVisualScale();
          const isEditingTitle = editingNodeTitleId === node.id;
          const isEditingTextNode = editingTextNodeId === node.id;
          const hasMedia = nodeHasMedia(node);
          const owningStoryboardGroup = findStoryboardGroupByNodeId(node.id);
          const hideStoryboardNodeHeader = Boolean(owningStoryboardGroup);
          const selectedMediaNode = singleSelectedNodeId === node.id && hasMedia && (node.type === "image" || node.type === "video");
          const selectedTextNode = singleSelectedNodeId === node.id && node.type === "text";
          const lightweightMediaNode =
            (node.type === "image" || node.type === "video") &&
            hasMedia &&
            !selectedMediaNode &&
            !isEditingTitle &&
            !isEditingTextNode &&
            (interactionPerformanceMode || nodes.length > 80 || visualScale < 0.55);
          const topRightText =
            selectedMediaNode && (node.type === "image" || node.type === "video")
              ? `${nodeDimensionText(node)}${
                  node.type === "video" && typeof node.videoTrimStart === "number" && typeof node.videoTrimEnd === "number"
                    ? ` · ${formatDurationLabel(node.videoTrimEnd - node.videoTrimStart)}`
                    : ""
                }`
              : node.videoEnhanceMode && activeNodeId === node.id
                ? `${node.videoEnhanceResolution || "1080P"}`
                : "";
          return (
            <div key={node.id}>
              {selectedMediaNode ? renderNodeMediaToolbar(node) : null}
              {selectedTextNode && !isEditingTextNode && node.outputText ? renderTextNodeDownloadButton(node) : null}
              {isEditingTextNode ? renderRichTextNodeEditorToolbar(node) : null}
              {!hideStoryboardNodeHeader ? (
                <div
                  data-node-drag-handle
                  className="absolute z-20 flex h-7 cursor-grab items-center gap-2 text-[20px] font-normal leading-none text-[#8d8d8f] active:cursor-grabbing"
                  style={{
                    left: node.x,
                    top: node.y - 36,
                    width: Math.max(160, node.width - 80),
                    whiteSpace: "nowrap",
                    writingMode: "horizontal-tb",
                    textOrientation: "mixed",
                  }}
                  onMouseDown={(event) => beginNodeMove(node, event)}
                >
                  {renderCanvasNodeGlyph(node.type, "header")}
                  {isEditingTitle ? (
                    <input
                      value={editingNodeTitleDraft}
                      autoFocus
                      className="h-7 w-[220px] rounded border border-[#3a404a] bg-[#10151f] px-1.5 text-[18px] outline-none"
                      onChange={(event) => setEditingNodeTitleDraft(event.target.value)}
                      onMouseDown={(event) => event.stopPropagation()}
                      onBlur={() => commitNodeTitle(node.id, node.title)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitNodeTitle(node.id, node.title);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelNodeTitleEdit();
                        }
                      }}
                    />
                  ) : (
                    <button
                      className="cursor-grab whitespace-nowrap text-left hover:text-[#d2d2d3] active:cursor-grabbing"
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        startEditNodeTitle(node);
                      }}
                    >
                      {node.title}
                    </button>
                  )}
                </div>
              ) : null}
              {!hideStoryboardNodeHeader && topRightText ? (
                <div
                  className="pointer-events-none absolute z-20 whitespace-nowrap text-[13px] text-[#8792a3]"
                  style={{
                    left: node.x + 120,
                    top: node.y - 34,
                    width: Math.max(0, node.width - 128),
                    textAlign: "right",
                    writingMode: "horizontal-tb",
                    textOrientation: "mixed",
                  }}
                >
                  {topRightText}
                </div>
              ) : null}
              <div
                data-text-editor={isEditingTextNode ? "true" : undefined}
                data-node-card
                data-node-id={node.id}
                data-node-type={node.type}
                data-node-task-status={node.taskStatus || "idle"}
                data-node-generation-state={node.generationState || "idle"}
                data-node-has-asset-version={Number.isSafeInteger(Number(node.assetVersionId)) && Number(node.assetVersionId) > 0 ? "true" : "false"}
                data-node-asset-version-id={node.assetVersionId}
                data-node-source-image-node-id={node.sourceImageNodeId}
                data-node-input-asset-version-id={node.inputAssetVersionId}
                data-node-first-frame-asset-version-id={node.firstFrameAssetVersionId}
                data-node-resolution={node.resolution}
                data-node-ratio={node.ratio}
                data-node-video-mode={node.videoMode}
                className={`absolute border border-[#2a2e36] bg-[#1a1a1a] ${node.type === "text" ? "overflow-hidden" : ""} ${dragNode.active && dragNode.nodeId === node.id ? "cursor-grabbing" : node.type === "text" && isEditingTextNode ? "cursor-text" : "cursor-grab"}`}
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  height: node.height,
                  borderRadius: NODE_RADIUS,
                  zIndex: 10,
                  borderColor: selectedNodeIdSet.has(node.id) ? NODE_SELECTION_BORDER : "#2a2e36",
                  boxShadow: selectedNodeIdSet.has(node.id) ? NODE_SELECTION_GLOW : undefined,
                }}
                onDragOver={(event) => {
                  if ((node.type === "image" || node.type === "video") && Array.from(event.dataTransfer?.types || []).includes("Files")) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = "copy";
                  }
                }}
                onDrop={(event) => {
                  if (node.type !== "image" && node.type !== "video") return;
                  const files = getDraggedMediaFiles(event.dataTransfer).filter((file) =>
                    node.type === "image" ? file.type.startsWith("image/") : file.type.startsWith("video/"),
                  );
                  if (!files.length) return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (!ensureApiKeyReady()) return;
                  const uploadType: "image" | "video" = node.type === "video" ? "video" : "image";
                  void (async () => {
                    const operationEpoch = canvasContextEpochRef.current;
                    const uploaded = await uploadFileIntoNode(node.id, files[0], uploadType);
                    if (!uploaded || canvasContextEpochRef.current !== operationEpoch) return;
                    for (let index = 1; index < files.length; index += 1) {
                      if (canvasContextEpochRef.current !== operationEpoch) return;
                      const offset = index - 1;
                      await createMediaNodeFromFile(files[index], node.x + node.width / 2 + 280 * (offset + 1), node.y + node.height / 2);
                      if (canvasContextEpochRef.current !== operationEpoch) return;
                    }
                  })();
                }}
                onDragStart={(event) => event.preventDefault()}
                onMouseEnter={() => {
                  if (node.type === "text") setHoverTextNodeId(node.id);
                }}
                onMouseLeave={() => {
                  if (node.type === "text") setHoverTextNodeId((prev) => (prev === node.id ? null : prev));
                }}
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  if (node.type === "text" && isEditingTextNode) {
                    event.stopPropagation();
                    return;
                  }
                  if ((event.target as HTMLElement).closest("button, input, textarea, select, a, video, audio, [contenteditable='true'], [data-node-resize-handle], [data-text-resize-handle]")) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  const pointerWorld = toWorld(event.clientX, event.clientY);
                  if (owningStoryboardGroup && getNodeImageDisplayUrl(node) && !node.storyboardSlotPlaceholder) {
                    const duplicated = createDuplicateFromNodeIds([node.id], 0, 0);
                    if (!duplicated) return;
                    const dragTargetId = duplicated.idMap.get(node.id);
                    const duplicatedNode = duplicated.duplicatedNodes.find((item) => item.id === dragTargetId);
                    if (!duplicatedNode) return;
                    const cleanedNode: NodeData = {
                      ...duplicatedNode,
                      title: node.title,
                      storyboardSlotPlaceholder: false,
                      storyboardSlotFilledByUser: false,
                    };
                    const mergedNodes = [...nodes, cleanedNode];
                    const mergedEdges = [...edges, ...duplicated.duplicatedEdges];
                    recordCanvasHistoryMutation(buildHistorySnapshot(mergedNodes, mergedEdges, groups, viewport));
                    setNodes(mergedNodes);
                    setEdges(mergedEdges);
                    setSelectedNodeIds([cleanedNode.id]);
                    setSelectedEdgeIds([]);
                    setActiveGroupId(null);
                    setActiveNodeId(cleanedNode.id);
                    setDragNode({
                      active: true,
                      nodeId: cleanedNode.id,
                      offsetX: pointerWorld.x - cleanedNode.x,
                      offsetY: pointerWorld.y - cleanedNode.y,
                    });
                    return;
                  }
                  if (event.altKey) {
                    const sourceIds = selectedNodeIdSet.has(node.id) && selectedNodeIds.length > 0 ? selectedNodeIds : [node.id];
                    const duplicated = createDuplicateFromNodeIds(sourceIds, 36, 36);
                    if (!duplicated) return;
                    const { duplicatedNodes, duplicatedEdges, idMap } = duplicated;
                    const dragTargetId = idMap.get(node.id);
                    const mergedNodes = [...nodes, ...duplicatedNodes];
                    const mergedEdges = [...edges, ...duplicatedEdges];
                    const dragTarget = duplicatedNodes.find((item) => item.id === dragTargetId);
                    recordCanvasHistoryMutation(buildHistorySnapshot(mergedNodes, mergedEdges, groups, viewport));
                    setNodes(mergedNodes);
                    setEdges(mergedEdges);
                    setSelectedNodeIds(duplicatedNodes.map((item) => item.id));
                    setSelectedEdgeIds(duplicatedEdges.map((item) => item.id));
                    setActiveGroupId(null);
                    setActiveNodeId(duplicatedNodes.length === 1 ? duplicatedNodes[0].id : null);
                    if (dragTarget) {
                      setDragNode({
                        active: true,
                        nodeId: dragTarget.id,
                        offsetX: pointerWorld.x - dragTarget.x,
                        offsetY: pointerWorld.y - dragTarget.y,
                      });
                    }
                    return;
                  }
                  const owningGroup = findGroupByNode(groups, node.id);
                  setActiveGroupId(owningGroup?.id ?? null);
                  setSelectedNodeIds([node.id]);
                  setSelectedEdgeIds([]);
                  setActiveNodeId(node.id);
                  closePromptMenus();
                  setLayoutDropdownOpen(false);
                  setColorPaletteOpen(false);
                  setSelectionLayoutMenuOpen(false);
                  setDragNode({
                    active: true,
                    nodeId: node.id,
                    offsetX: pointerWorld.x - node.x,
                    offsetY: pointerWorld.y - node.y,
                  });
                  beginNodeConnectionHold(node, event);
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (editingTextNodeId && editingTextNodeId !== node.id) commitTextNodeEditing();
                  const owningGroup = findGroupByNode(groups, node.id);
                  if (owningGroup) {
                    setActiveGroupId(owningGroup.id);
                    setSelectedNodeIds([node.id]);
                  } else {
                    setActiveGroupId(null);
                    setSelectedNodeIds([node.id]);
                  }
                  setSelectedEdgeIds([]);
                  setActiveNodeId(node.id);
                  closePromptMenus();
                  setLayoutDropdownOpen(false);
                  setColorPaletteOpen(false);
                  setSelectionLayoutMenuOpen(false);
                  if (node.type === "compose") {
                    void openComposeEditor(node.id);
                  }
                }}
                onDoubleClick={(event) => {
                  if (node.type !== "text") return;
                  event.preventDefault();
                  event.stopPropagation();
                  startTextNodeEditing(node);
                }}
            >
                <div className="relative h-full w-full p-0">
                  {!renderFullNode ? (
                    renderVirtualizedNodePlaceholder(node)
                  ) : lightweightMediaNode ? (
                    renderLightweightMediaNode(node, interactionPerformanceMode ? 260 : 420)
                  ) : node.type === "script" ? (
                    renderProductScriptNode(node)
                  ) : node.type === "image" && getNodeImageDisplayUrl(node) ? (
                    <div className="h-full w-full overflow-hidden rounded-[16px] border border-[#3d4046] bg-[#0f1218] p-[3px]">
                      <div className="relative h-full w-full overflow-hidden rounded-[13px] bg-black">
                        {Array.isArray(node.generatedImages) && node.generatedImages.length > 1 && !node.localPreviewUrl && !(node.cropWidth && node.cropHeight) ? (
                          <div className={`grid h-full w-full gap-[2px] bg-black ${node.generatedImages.length === 2 ? "grid-cols-2" : "grid-cols-2 grid-rows-2"}`}>
                            {node.generatedImages.slice(0, node.generatedImages.length === 2 ? 2 : 4).map((choice) => (
                              <div key={choice.id} className="relative overflow-hidden rounded-[12px] bg-black">
                                <ReferencePreviewImage src={getCanvasImagePreviewUrl(choice.url, mediaPreviewSide)} alt={node.title} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <ReferencePreviewImage
                            src={getNodeImagePreviewUrl(node, mediaPreviewSide)}
                            alt={node.title}
                            loading="lazy"
                            decoding="async"
                            className={node.cropWidth && node.cropHeight ? "absolute left-0 top-0 max-w-none" : "h-full w-full rounded-[13px] object-cover"}
                            style={
                              node.cropWidth && node.cropHeight
                                ? {
                                    width: `${100 / Math.max(0.08, node.cropWidth)}%`,
                                    height: `${100 / Math.max(0.08, node.cropHeight)}%`,
                                    transform: `translate(-${(node.cropX || 0) * 100}%, -${(node.cropY || 0) * 100}%)`,
                                    ...buildImageTransformStyle(node),
                                  }
                                : buildImageTransformStyle(node)
                            }
                          />
                        )}
                      </div>
                    </div>
                  ) : node.type === "video" && (node.videoUrl || node.localVideoUrl) ? (
                    <div className="h-full w-full overflow-hidden rounded-[16px] border border-[#3d4046] bg-[#1a1d22] p-[3px]">
                      <div
                        className="relative h-full w-full overflow-hidden rounded-[13px]"
                        style={{
                          background: canvasColorMode === "light"
                            ? "linear-gradient(160deg,#e8ecf2 0%,#c5ccd6 55%,#9aa3b0 100%)"
                            : "linear-gradient(160deg,#2a2e35 0%,#171a1f 55%,#0d0f12 100%)",
                        }}
                      >
                        {getNodeVideoPosterUrl(node) && !videoNodePlaying[node.id] ? (
                          <ReferencePreviewImage src={getCanvasImagePreviewUrl(getNodeVideoPosterUrl(node), mediaPreviewSide)} alt={node.title} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full rounded-[13px] object-cover" />
                        ) : null}
                        {canvasPerformanceMode && !videoNodePlaying[node.id] && !selectedNodeIdSet.has(node.id) ? null : (
                        <ReferencePreviewVideo
                          ref={(element) => {
                            nodeVideoRefs.current[node.id] = element;
                          }}
                          src={node.localVideoUrl || node.videoUrl}
                          poster={getNodeVideoPosterUrl(node) || undefined}
                          preload={getNodeVideoPosterUrl(node) ? "metadata" : "auto"}
                          controls={false}
                          playsInline
                          onLoadedMetadata={(event) => {
                            const target = event.currentTarget;
                            const duration = Number.isFinite(target.duration) ? target.duration : 0;
                            if (duration > 0) {
                              setVideoNodeDurations((prev) => (Math.abs((prev[node.id] || 0) - duration) < 0.01 ? prev : { ...prev, [node.id]: duration }));
                            }
                            // Frame must follow the clip aspect (9:16 stays portrait).
                            const vw = target.videoWidth || 0;
                            const vh = target.videoHeight || 0;
                            if (vw > 0 && vh > 0) {
                              const nodeAspect = node.width / Math.max(1, node.height);
                              const mediaAspect = vw / vh;
                              if (Math.abs(nodeAspect - mediaAspect) > 0.04) {
                                applyNodeMediaGeometry(node.id, vw, vh);
                              }
                            }
                            primeVideoPreviewFrame(node, target);
                            setVideoNodeCurrentTimes((prev) => ({ ...prev, [node.id]: target.currentTime }));
                            setVideoNodeMuted((prev) => ({ ...prev, [node.id]: target.muted || target.volume <= 0 }));
                          }}
                          onLoadedData={(event) => {
                            primeVideoPreviewFrame(node, event.currentTarget);
                          }}
                          onPlay={(event) => {
                            const target = event.currentTarget;
                            setVideoNodePlaying((prev) => ({ ...prev, [node.id]: true }));
                            if (typeof node.videoTrimStart === "number" && typeof node.videoTrimEnd === "number") {
                              if (target.currentTime < node.videoTrimStart || target.currentTime > node.videoTrimEnd) {
                                target.currentTime = node.videoTrimStart;
                              }
                            }
                          }}
                          onPause={() => {
                            setVideoNodePlaying((prev) => ({ ...prev, [node.id]: false }));
                          }}
                          onVolumeChange={(event) => {
                            const target = event.currentTarget;
                            setVideoNodeMuted((prev) => ({ ...prev, [node.id]: target.muted || target.volume <= 0 }));
                          }}
                          onTimeUpdate={(event) => {
                            const target = event.currentTarget;
                            setVideoNodeCurrentTimes((prev) => ({ ...prev, [node.id]: target.currentTime }));
                            if (typeof node.videoTrimEnd !== "number") return;
                            if (target.currentTime >= node.videoTrimEnd - 0.02) {
                              if (node.videoLoopSelection) {
                                target.currentTime = node.videoTrimStart || 0;
                              } else {
                                target.pause();
                              }
                            }
                          }}
                          className={node.cropWidth && node.cropHeight ? "absolute left-0 top-0 max-w-none" : "h-full w-full rounded-[13px] object-cover"}
                          style={
                            node.cropWidth && node.cropHeight
                              ? {
                                  width: `${100 / Math.max(0.08, node.cropWidth)}%`,
                                  height: `${100 / Math.max(0.08, node.cropHeight)}%`,
                                  transform: `translate(-${(node.cropX || 0) * 100}%, -${(node.cropY || 0) * 100}%)`,
                                }
                              : undefined
                          }
                        />
                        )}
                        {!videoNodePlaying[node.id] && (node.videoUrl || node.localVideoUrl) ? (
                          <button
                            type="button"
                            className="absolute inset-0 z-20 flex items-center justify-center"
                            aria-label="播放视频"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              const video = nodeVideoRefs.current[node.id];
                              if (!video) return;
                              if (typeof node.videoTrimStart === "number" && typeof node.videoTrimEnd === "number"
                                && (video.currentTime < node.videoTrimStart || video.currentTime > node.videoTrimEnd)) {
                                video.currentTime = node.videoTrimStart;
                              }
                              void video.play().catch(() => undefined);
                            }}
                          >
                            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/55 text-white shadow-[0_10px_28px_rgba(0,0,0,0.35)] transition group-hover:scale-105 hover:bg-black/75">
                              <Play className="ml-0.5 h-6 w-6 fill-current" />
                            </span>
                          </button>
                        ) : null}
                        {renderInlineVideoControls(node)}
                      </div>
                    </div>
                  ) : (
                    <div data-node-surface className="h-full w-full">
                      {renderNodePlaceholder(node)}
                    </div>
                  )}
                  {!lightweightMediaNode ? renderNodeUploadOverlay(node) : null}
                  {!lightweightMediaNode ? renderNodeGenerationOverlay(node) : null}
                  {!lightweightMediaNode ? renderNodeProgressChip(node) : null}
                  {(() => {
                    const owningGroup = findStoryboardGroupByNodeId(node.id);
                    if (!owningGroup || !owningGroup.storyboardShowOrder) return null;
                    return (
                      <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-[10px] bg-[#111215]/92 px-3 py-1 text-[14px] font-semibold text-white">
                        {Number(node.storyboardSlotOrder || 0) + 1}
                      </div>
                    );
                  })()}
                  {!lightweightMediaNode && node.type === "image" ? renderImageGridSplitOverlay(node) : null}
                  {!lightweightMediaNode && node.type === "image" ? renderImageOutpaintOverlay(node) : null}
                  {!lightweightMediaNode && node.type === "image" ? renderImageCropOverlay(node) : null}
                  {!lightweightMediaNode && node.type === "video" ? renderVideoEraseRegionOverlay(node) : null}
                  {!lightweightMediaNode && node.type === "video" ? renderVideoSubtitleEraseBar(node) : null}
                </div>
              </div>
              {!lightweightMediaNode && node.type === "image" ? renderImageGridSplitToolbar(node) : null}
              {!lightweightMediaNode && node.type === "image" ? renderImageTransformEditor(node) : null}
              {!lightweightMediaNode && node.type === "video" ? renderVideoTrimEditor(node) : null}
              {!lightweightMediaNode && node.type === "video" ? renderVideoStoryPanel(node) : null}
              {["text", "image", "video", "audio"].includes(node.type) && !isEditingTextNode && selectedNodeIdSet.has(node.id) ? (
                <button
                  data-text-resize-handle={node.type === "text" ? "" : undefined}
                  data-node-resize-handle
                  aria-label={`调整 ${node.title} 大小`}
                  title="拖动调整节点大小"
                  className="absolute z-30 flex h-5 w-5 items-center justify-center text-[#6e7075]"
                  style={{ left: node.x + node.width - 18, top: node.y + node.height - 18 }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const world = toWorld(event.clientX, event.clientY);
                    setTextResize({
                      active: true,
                      nodeId: node.id,
                      startX: world.x,
                      startY: world.y,
                      startWidth: node.width,
                      startHeight: node.height,
                    });
                  }}
                >
                  <Expand className="h-3.5 w-3.5 rotate-45" />
                </button>
              ) : null}
            </div>
          );
        })); }
  return renderCanvasNodeLayer;
}
