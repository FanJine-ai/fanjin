import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { CANVAS_ASSET_DRAG_MIME } from "./canvasPageConstants";
import { isAssetUri, baseModel, createNode } from "./canvasNodeDefaults";
import { readVideoPosterFile, getDraggedMediaFiles } from "./canvasUploadMedia";
import { defaultNodeTitle } from "./canvasSnapshotCodec";
import type { NodeData, EdgeData, GroupData, HistoryAssetItem, CreationMenuState, CanvasMetaState, CanvasUploadRetry, CanvasNodeUploadResult } from "./canvasDataTypes";
import type { NodeType } from "./canvasMediaTypes";
import { getCanvasUsableLayout } from "./canvasAdaptiveLayout";
import { api } from "@/lib/api";
import { type AssetCatalogItem } from "@/features/assets/assetCatalog";
import { type CanvasGenerationDebugSnapshot } from "./canvasGenerationDebug";
import { isCanvasUploadAbortError } from "./canvasUploadRuntime";
import { triggerBrowserDownload } from "./canvasAssetPresentation";
import { isRemoteGenerationUrl, normalizeReferenceUrlForRequest } from "./canvasTaskResults";

export interface CanvasReferenceUploadControllerDependencies {
  activeNode: NodeData | null;
  ensureApiKeyReady: () => boolean;
  canvasContextEpochRef: RefObject<number>;
  setUploading: Dispatch<SetStateAction<boolean>>;
  setStatus: Dispatch<SetStateAction<string>>;
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  showNodeStatusChip: (nodeId: string, text: string, tone?: "neutral" | "success" | "error", durationMs?: number) => void;
  imageToImageUploadPresetRef: RefObject<string | null>;
  uploadFileIntoNode: (nodeId: string, file: File, type: "image" | "video", options?: CanvasUploadRetry["options"]) => Promise<CanvasNodeUploadResult | null>;
  createImageToImagePresetGroup: (sourceNodeId: string, uploadedUrl: string, naturalWidth: number, naturalHeight: number, baseNodes?: NodeData[] | null) => { nodes: NodeData[]; edges: EdgeData[]; groups: GroupData[]; } | undefined;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  canvasMeta: CanvasMetaState;
  bindUploadedImageToArtifact: (nodeId: string) => boolean;
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  nodeRemoteAssetUrlRef: RefObject<Record<string, string>>;
  localAssetRemoteUrlRef: RefObject<Record<string, string>>;
  nodeUploadPromiseRef: RefObject<Partial<Record<string, Promise<string>>>>;
  setGenerateDebug: (snapshot: CanvasGenerationDebugSnapshot | null) => void;
  nodeSerialCounter: Record<NodeType, number>;
  setNodeSerialCounter: Dispatch<SetStateAction<Record<NodeType, number>>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  creationMenu: CreationMenuState;
  setQuickUploadPos: Dispatch<SetStateAction<{ x: number; y: number; } | null>>;
  quickUploadInputRef: RefObject<HTMLInputElement | null>;
  quickUploadPos: { x: number; y: number; } | null;
  closeBottomPanels: () => void;
  assetCatalogEntries: AssetCatalogItem[];
  closePromptMenus: () => void;
  setCreationMenu: Dispatch<SetStateAction<CreationMenuState>>;
  applyAssetCatalogItem: (item: AssetCatalogItem, targetWorld?: { x: number; y: number; }) => void;
  toWorld: (clientX: number, clientY: number) => { x: number; y: number; };
  storyboardHistoryTargetNodeId: string | null;
  nodeMap: Map<string, NodeData>;
  setStoryboardHistoryTargetNodeId: Dispatch<SetStateAction<string | null>>;
  nodes: NodeData[];
  setHistoryPreviewItem: Dispatch<SetStateAction<HistoryAssetItem | null>>;
  setHistoryPanelOpen: Dispatch<SetStateAction<boolean>>;
  edges: EdgeData[];
  rootRef: RefObject<HTMLDivElement | null>;
  assetManagerOpen: boolean;
  storyboardSlotUploadTargetNodeId: string | null;
  setStoryboardSlotUploadTargetNodeId: Dispatch<SetStateAction<string | null>>;
  setStoryboardSlotMenuNodeId: Dispatch<SetStateAction<string | null>>;
  setStoryboardSlotMenuPosition: Dispatch<SetStateAction<{ x: number; y: number; } | null>>;
}

export function createCanvasReferenceUploadController(deps: CanvasReferenceUploadControllerDependencies) {
  const { activeNode, ensureApiKeyReady, canvasContextEpochRef, setUploading, setStatus, setNodes, showNodeStatusChip, imageToImageUploadPresetRef, uploadFileIntoNode, createImageToImagePresetGroup, persistCanvas, canvasMeta, bindUploadedImageToArtifact, setNodePatch, nodeRemoteAssetUrlRef, localAssetRemoteUrlRef, nodeUploadPromiseRef, setGenerateDebug, nodeSerialCounter, setNodeSerialCounter, setSelectedNodeIds, setSelectedEdgeIds, setActiveNodeId, creationMenu, setQuickUploadPos, quickUploadInputRef, quickUploadPos, closeBottomPanels, assetCatalogEntries, closePromptMenus, setCreationMenu, applyAssetCatalogItem, toWorld, storyboardHistoryTargetNodeId, nodeMap, setStoryboardHistoryTargetNodeId, nodes, setHistoryPreviewItem, setHistoryPanelOpen, edges, rootRef, assetManagerOpen, storyboardSlotUploadTargetNodeId, setStoryboardSlotUploadTargetNodeId, setStoryboardSlotMenuNodeId, setStoryboardSlotMenuPosition } = deps;
async function handleUploadChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !activeNode || activeNode.type === "text" || activeNode.type === "script") return;
    if (!ensureApiKeyReady()) return;
    const targetNodeId = activeNode.id;
    const targetNodeType = activeNode.type;
    const operationEpoch = canvasContextEpochRef.current;

    setUploading(true);
    setStatus("");
    try {
      const isVideoNode = targetNodeType === "video";
      const isAudioNode = targetNodeType === "audio";
      if (isAudioNode) {
        if (nodeUploadPromiseRef.current[targetNodeId]) return;
        const localUrl = URL.createObjectURL(file);
        setNodePatch(targetNodeId, { localAudioUrl: localUrl, fileName: file.name,
          uploadState: "uploading", uploadProgress: 1, uploadError: undefined });
        const current = () => canvasContextEpochRef.current === operationEpoch;
        const upload = api.uploadImage(file, {
          projectId: Number(canvasMeta.projectId) || undefined,
          onProgress: (progress) => {
            if (current()) setNodePatch(targetNodeId, { uploadProgress: progress });
          },
        });
        const pendingUrl = upload.then((uploaded) => uploaded.url);
        nodeUploadPromiseRef.current[targetNodeId] = pendingUrl;
        // The reference resolver may observe this promise; also handle failure
        // when no resolver is waiting, without replacing the actual rejection.
        void pendingUrl.catch(() => undefined);
        try {
          const uploaded = await upload;
          if (!current()) return;
          localAssetRemoteUrlRef.current[localUrl] = uploaded.url;
          nodeRemoteAssetUrlRef.current[targetNodeId] = uploaded.url;
          setNodePatch(targetNodeId, { audioUrl: uploaded.url, localAudioUrl: undefined,
            assetVersionId: uploaded.assetVersionId, uploadState: "idle", uploadProgress: undefined });
          window.setTimeout(() => {
            URL.revokeObjectURL(localUrl);
            if (current()) void persistCanvas();
          }, 0);
          showNodeStatusChip(targetNodeId, "上传完成", "success");
          setStatus("上传成功");
        } catch (error) {
          if (current()) setNodePatch(targetNodeId, { uploadState: "failed", uploadProgress: undefined,
            uploadError: error instanceof Error ? error.message : "音频上传失败" });
          throw error;
        } finally {
          if (nodeUploadPromiseRef.current[targetNodeId] === pendingUrl) delete nodeUploadPromiseRef.current[targetNodeId];
          if (!current()) URL.revokeObjectURL(localUrl);
        }
        return;
      }
      let imageToImagePresetCreated = false;
      let imageToImagePresetSnapshot: { edges: EdgeData[]; groups: GroupData[] } | null = null;
      const isImageToImagePresetUpload = !isVideoNode && imageToImageUploadPresetRef.current === targetNodeId;
      const uploaded = await uploadFileIntoNode(targetNodeId, file, isVideoNode ? "video" : "image", {
        skipAutoPersist: isImageToImagePresetUpload,
        onLocalReady: (local) => {
          if (!isVideoNode && imageToImageUploadPresetRef.current === targetNodeId && local.url) {
            imageToImagePresetCreated = true;
            imageToImageUploadPresetRef.current = null;
            const created = createImageToImagePresetGroup(targetNodeId, local.url, local.width, local.height, local.nodes);
            if (created) imageToImagePresetSnapshot = { edges: created.edges, groups: created.groups };
          }
        },
      });
      if (canvasContextEpochRef.current !== operationEpoch) return;
      if (!isVideoNode && imageToImageUploadPresetRef.current === targetNodeId && uploaded?.url) {
        imageToImagePresetCreated = true;
        imageToImageUploadPresetRef.current = null;
        const created = createImageToImagePresetGroup(targetNodeId, uploaded.url, uploaded.width, uploaded.height, uploaded.nodes || undefined);
        if (created) imageToImagePresetSnapshot = { edges: created.edges, groups: created.groups };
      } else if (!imageToImagePresetCreated) {
        void persistCanvas();
      } else {
        const presetSnapshot = imageToImagePresetSnapshot as { edges: EdgeData[]; groups: GroupData[] } | null;
        if (uploaded?.nodes && presetSnapshot) {
          void persistCanvas(uploaded.nodes, presetSnapshot.edges, canvasMeta.name, presetSnapshot.groups);
        }
      }
      if (!isVideoNode && uploaded?.url && bindUploadedImageToArtifact(targetNodeId)) {
        void persistCanvas();
      }
    } catch (error: any) {
      setStatus(error instanceof Error ? error.message : "上传失败");
    } finally {
      if (canvasContextEpochRef.current === operationEpoch) setUploading(false);
      event.target.value = "";
    }
  }

async function createAndUploadVideoPoster(nodeId: string, videoUrl: string, fileName: string) {
    if (!videoUrl) return false;
    const posterFile = await readVideoPosterFile(videoUrl, fileName);
    if (!posterFile) return false;
    const uploadedPoster = await api.uploadImage(posterFile).catch(() => null);
    if (!uploadedPoster?.url) return false;
    setNodePatch(nodeId, { videoPosterUrl: uploadedPoster.url });
    return true;
  }

function buildReferenceResolutionSnapshot(node: NodeData | null | undefined) {
    if (!node) return null;
    return {
      nodeId: node.id,
      title: node.title,
      type: node.type,
      referenceAssetUri: node.referenceAssetUri || "",
      referenceAssetKind: node.referenceAssetKind || "",
      imageUrl: node.imageUrl || "",
      videoUrl: node.videoUrl || "",
      localPreviewUrl: node.localPreviewUrl || "",
      localVideoUrl: node.localVideoUrl || "",
      cachedRemoteUrl: nodeRemoteAssetUrlRef.current[node.id] || "",
      localMappedRemoteUrl:
        (node.localPreviewUrl && localAssetRemoteUrlRef.current[node.localPreviewUrl]) ||
        (node.localVideoUrl && localAssetRemoteUrlRef.current[node.localVideoUrl]) ||
        (node.localAudioUrl && localAssetRemoteUrlRef.current[node.localAudioUrl]) ||
        "",
      hasPendingUpload: Boolean(nodeUploadPromiseRef.current[node.id]),
    };
  }

async function resolveNodeRemoteReferenceUrl(node: NodeData): Promise<string> {
    if (node.referenceAssetKind === "portrait" && isAssetUri(node.referenceAssetUri)) {
      nodeRemoteAssetUrlRef.current[node.id] = node.referenceAssetUri;
      return node.referenceAssetUri;
    }
    const cached = nodeRemoteAssetUrlRef.current[node.id];
    const cachedReferenceUrl = normalizeReferenceUrlForRequest(cached);
    if (cachedReferenceUrl) return cachedReferenceUrl;
    const imageReferenceUrl = normalizeReferenceUrlForRequest(node.imageUrl);
    if (imageReferenceUrl) {
      nodeRemoteAssetUrlRef.current[node.id] = imageReferenceUrl;
      return imageReferenceUrl;
    }
    const videoReferenceUrl = normalizeReferenceUrlForRequest(node.videoUrl);
    if (videoReferenceUrl) {
      nodeRemoteAssetUrlRef.current[node.id] = videoReferenceUrl;
      return videoReferenceUrl;
    }
    const audioReferenceUrl = normalizeReferenceUrlForRequest(node.audioUrl);
    if (audioReferenceUrl) {
      nodeRemoteAssetUrlRef.current[node.id] = audioReferenceUrl;
      return audioReferenceUrl;
    }
    const pending = nodeUploadPromiseRef.current[node.id];
    if (pending) {
      const pendingUrl = await pending.catch(() => "");
      const pendingReferenceUrl = normalizeReferenceUrlForRequest(pendingUrl);
      if (pendingReferenceUrl) {
        nodeRemoteAssetUrlRef.current[node.id] = pendingReferenceUrl;
        setNodePatch(node.id, {
          localPreviewUrl: undefined,
          localVideoUrl: undefined,
          localAudioUrl: undefined,
          imageUrl: node.type === "image" ? pendingReferenceUrl : undefined,
          videoUrl: node.type === "video" ? pendingReferenceUrl : undefined,
          audioUrl: node.type === "audio" ? pendingReferenceUrl : undefined,
        });
        return pendingReferenceUrl;
      }
    }
    const localPreviewMapped =
      (node.localPreviewUrl && localAssetRemoteUrlRef.current[node.localPreviewUrl]) ||
      (node.localVideoUrl && localAssetRemoteUrlRef.current[node.localVideoUrl]) ||
      (node.localAudioUrl && localAssetRemoteUrlRef.current[node.localAudioUrl]) ||
      "";
    const localPreviewReferenceUrl = normalizeReferenceUrlForRequest(localPreviewMapped);
    if (localPreviewReferenceUrl) {
      nodeRemoteAssetUrlRef.current[node.id] = localPreviewReferenceUrl;
      if (!isRemoteGenerationUrl(node.imageUrl) && !isRemoteGenerationUrl(node.videoUrl)) {
        setNodePatch(node.id, {
          imageUrl: node.type === "image" ? localPreviewReferenceUrl : undefined,
          videoUrl: node.type === "video" ? localPreviewReferenceUrl : undefined,
          audioUrl: node.type === "audio" ? localPreviewReferenceUrl : undefined,
        });
      }
      return localPreviewReferenceUrl;
    }
    return ensureRemoteImageUrlForNode(node);
  }

async function ensureRemoteImageUrlForNode(node: NodeData): Promise<string> {
    const cached = nodeRemoteAssetUrlRef.current[node.id];
    const cachedReferenceUrl = normalizeReferenceUrlForRequest(cached);
    if (cachedReferenceUrl) return cachedReferenceUrl;
    const imageReferenceUrl = normalizeReferenceUrlForRequest(node.imageUrl);
    if (imageReferenceUrl) {
      nodeRemoteAssetUrlRef.current[node.id] = imageReferenceUrl;
      return imageReferenceUrl;
    }
    const videoReferenceUrl = normalizeReferenceUrlForRequest(node.videoUrl);
    if (videoReferenceUrl) {
      nodeRemoteAssetUrlRef.current[node.id] = videoReferenceUrl;
      return videoReferenceUrl;
    }
    const localMappedRemoteUrl =
      (node.localPreviewUrl && localAssetRemoteUrlRef.current[node.localPreviewUrl]) ||
      (node.localVideoUrl && localAssetRemoteUrlRef.current[node.localVideoUrl]) ||
      "";
    const localMappedReferenceUrl = normalizeReferenceUrlForRequest(localMappedRemoteUrl);
    if (localMappedReferenceUrl) {
      nodeRemoteAssetUrlRef.current[node.id] = localMappedReferenceUrl;
      setNodePatch(node.id, {
        imageUrl: node.type === "video" ? undefined : localMappedReferenceUrl,
        videoUrl: node.type === "video" ? localMappedReferenceUrl : undefined,
      });
      return localMappedReferenceUrl;
    }
    setGenerateDebug({
      phase: "missing-remote-reference",
      payload: {
        nodeId: node.id,
        source: "ensure-remote-image-url",
        title: node.title,
        imageUrl: node.imageUrl || "",
        videoUrl: node.videoUrl || "",
        localPreviewUrl: node.localPreviewUrl || "",
        localVideoUrl: node.localVideoUrl || "",
      },
    });
    setStatus(`参考图尚未完成云端上传：${node.title}`);
    return "";
  }

async function createMediaNodeFromFile(file: File, worldX: number, worldY: number) {
    if (!ensureApiKeyReady()) return;
    const operationEpoch = canvasContextEpochRef.current;
    const type: NodeType = file.type.startsWith("video/") ? "video" : "image";
    const id = `node_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const nextIndex = (nodeSerialCounter[type] ?? 0) + 1;
    const baseNode = createNode(id, type, worldX, worldY);
    const pendingNode: NodeData = {
      ...baseNode,
      title: defaultNodeTitle(type, nextIndex),
      titleCustomized: false,
      x: worldX - baseNode.width / 2,
      y: worldY - baseNode.height / 2,
      fileName: file.name,
      imageUrl: type === "image" ? "" : undefined,
      videoUrl: type === "video" ? "" : undefined,
      videoPosterUrl: undefined,
      uploadState: "preparing",
      uploadProgress: 1,
      uploadError: undefined,
    };
    setNodes((prev) => [...prev, pendingNode]);
    setNodeSerialCounter((prev) => ({ ...prev, [type]: nextIndex }));
    setSelectedNodeIds([id]);
    setSelectedEdgeIds([]);
    setActiveNodeId(id);
    setUploading(true);
    try {
      await uploadFileIntoNode(id, file, type === "video" ? "video" : "image");
    } catch (error: unknown) {
      if (isCanvasUploadAbortError(error)) return;
      const message = error instanceof Error ? error.message : "上传失败";
      setNodePatch(id, {
        uploadState: "failed",
        uploadProgress: undefined,
        uploadError: message,
      });
      setStatus(`${message}，已保留本地预览，可重试`);
      return;
    } finally {
      if (canvasContextEpochRef.current === operationEpoch) setUploading(false);
    }
  }

function openQuickUploadAtCurrentMenu() {
    if (!creationMenu.open) return;
    setQuickUploadPos({ x: creationMenu.x, y: creationMenu.y });
    quickUploadInputRef.current?.click();
  }

async function handleQuickUploadChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const targetPos = quickUploadPos;
    event.target.value = "";
    if (!file || !targetPos) return;
    closeBottomPanels();
    const operationEpoch = canvasContextEpochRef.current;
    await createMediaNodeFromFile(file, targetPos.x, targetPos.y);
    if (canvasContextEpochRef.current !== operationEpoch) return;
    setQuickUploadPos(null);
  }

function handleCanvasDragOver(event: React.DragEvent<HTMLDivElement>) {
    const transferTypes = Array.from(event.dataTransfer?.types || []);
    if (!transferTypes.includes("Files") && !transferTypes.includes(CANVAS_ASSET_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

function handleCanvasDrop(event: React.DragEvent<HTMLDivElement>) {
    const draggedCatalogId = event.dataTransfer.getData(CANVAS_ASSET_DRAG_MIME);
    if (draggedCatalogId) {
      const draggedAsset = assetCatalogEntries.find((asset) => asset.catalogId === draggedCatalogId);
      if (!draggedAsset) return;
      event.preventDefault();
      event.stopPropagation();
      closeBottomPanels();
      closePromptMenus();
      setCreationMenu({ open: false, x: 0, y: 0, source: "sidebar" });
      applyAssetCatalogItem(draggedAsset, toWorld(event.clientX, event.clientY));
      return;
    }

    const files = getDraggedMediaFiles(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    closeBottomPanels();
    closePromptMenus();
    setCreationMenu({ open: false, x: 0, y: 0, source: "sidebar" });
    const world = toWorld(event.clientX, event.clientY);
    const gapX = 280;
    const gapY = 300;
    void (async () => {
      const operationEpoch = canvasContextEpochRef.current;
      for (let index = 0; index < files.length; index += 1) {
        if (canvasContextEpochRef.current !== operationEpoch) return;
        const col = index % 4;
        const row = Math.floor(index / 4);
        await createMediaNodeFromFile(files[index], world.x + col * gapX, world.y + row * gapY);
        if (canvasContextEpochRef.current !== operationEpoch) return;
      }
    })();
  }

function addHistoryItemToCanvas(item: HistoryAssetItem) {
    if (storyboardHistoryTargetNodeId) {
      if (item.type !== "image") {
        setStatus("分镜空位目前只支持回填图片");
        return;
      }
      const targetNode = nodeMap.get(storyboardHistoryTargetNodeId);
      if (!targetNode) {
        setStoryboardHistoryTargetNodeId(null);
        return;
      }
      const nextNodes = nodes.map((node) =>
        node.id === storyboardHistoryTargetNodeId
          ? {
              ...node,
              imageUrl: item.url,
              localPreviewUrl: undefined,
              prompt: item.prompt,
              model: item.model || node.model,
              storyboardSlotPlaceholder: false,
              storyboardSlotFilledByUser: true,
            }
          : node,
      );
      setNodes(nextNodes);
      setStoryboardHistoryTargetNodeId(null);
      setHistoryPreviewItem(null);
      setHistoryPanelOpen(false);
      setSelectedNodeIds([targetNode.id]);
      setActiveNodeId(targetNode.id);
      void persistCanvas(nextNodes, edges);
      return;
    }
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const usableLayout = getCanvasUsableLayout(rect.width, assetManagerOpen);
    const center = toWorld(rect.left + usableLayout.centerX, rect.top + rect.height / 2);
    const type: NodeType = item.type === "video" ? "video" : "image";
    const id = `node_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const nextIndex = (nodeSerialCounter[type] ?? 0) + 1;
    const nextNode = {
      ...createNode(id, type, center.x, center.y),
      title: defaultNodeTitle(type, nextIndex),
      titleCustomized: false,
      imageUrl: type === "image" ? item.url : undefined,
      videoUrl: type === "video" ? item.url : undefined,
      mediaAssetId: type === "video" ? item.mediaAssetId : undefined,
      mediaAssetUrl: type === "video" && item.mediaAssetId ? item.url : undefined,
      mediaDurationMs: type === "video" && Number(item.durationMs) > 0 ? Number(item.durationMs) : undefined,
      mediaNaturalWidth: Number(item.width) > 0 ? Number(item.width) : undefined,
      mediaNaturalHeight: Number(item.height) > 0 ? Number(item.height) : undefined,
      prompt: item.prompt,
      model: item.model || baseModel(type),
    };
    setNodes((prev) => [...prev, nextNode]);
    setNodeSerialCounter((prev) => ({ ...prev, [type]: nextIndex }));
    setSelectedNodeIds([id]);
    setSelectedEdgeIds([]);
    setActiveNodeId(id);
    setHistoryPreviewItem(null);
    setHistoryPanelOpen(false);
    window.setTimeout(() => void persistCanvas(), 40);
  }

async function handleStoryboardSlotUploadChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const targetNodeId = storyboardSlotUploadTargetNodeId;
    event.target.value = "";
    if (!file || !targetNodeId) return;
    setStoryboardSlotUploadTargetNodeId(null);
    setStoryboardSlotMenuNodeId(null);
    setStoryboardSlotMenuPosition(null);
    const operationEpoch = canvasContextEpochRef.current;
    const uploaded = await uploadFileIntoNode(targetNodeId, file, "image");
    if (!uploaded || canvasContextEpochRef.current !== operationEpoch) return;
    setNodePatch(targetNodeId, {
      storyboardSlotPlaceholder: false,
      storyboardSlotFilledByUser: true,
    });
    void persistCanvas();
  }

function downloadHistoryItem(item: HistoryAssetItem) {
    const ext = item.type === "video" ? "mp4" : item.type === "audio" ? "mp3" : "png";
    const safeName = (item.prompt || item.model || item.id || "asset").replace(/[\\/:*?\"<>|]+/g, "_").slice(0, 48) || "asset";
    triggerBrowserDownload(item.url, `${safeName}.${ext}`);
  }
  return { handleUploadChange, createAndUploadVideoPoster, buildReferenceResolutionSnapshot, resolveNodeRemoteReferenceUrl, ensureRemoteImageUrlForNode, createMediaNodeFromFile, openQuickUploadAtCurrentMenu, handleQuickUploadChange, handleCanvasDragOver, handleCanvasDrop, addHistoryItemToCanvas, handleStoryboardSlotUploadChange, downloadHistoryItem };
}
