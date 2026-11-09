import type { Dispatch, SetStateAction } from "react";
import { api } from "@/lib/api";
import { normalizeProjectId } from "@/stores/projectStore";
import type { NodeData, EdgeData, CanvasUploadRetry, CanvasNodeUploadResult } from "./canvasDataTypes";
import type { CanvasGenerationDebugSnapshot } from "./canvasGenerationDebug";
import { nearestRatio, mediaToNodeDimensions } from "./canvasMediaGeometry";
import { readMediaMeta, createLightweightImagePreviewUrl, readVideoPosterFile } from "./canvasUploadMedia";
import { getCanvasUploadTimeoutMs, startCanvasUploadAttempt, startCanvasMediaPreparationAttempt, isCanvasUploadAbortError, getCanvasUploadFailurePatch, type KeyedSingleFlight, type KeyedSingleFlightAttempt } from "./canvasUploadRuntime";

export interface CanvasUploadDependencies {
  canvasContextEpochRef: { current: number };
  canvasUploadAbortControllersRef: { current: Set<AbortController> };
  nodesRef: { current: NodeData[] };
  setNodePatch: (nodeId: string, patch: Partial<NodeData>) => void;
  activeProjectContextId: string | number | null | undefined;
  nodeUploadSingleFlightRef: { current: KeyedSingleFlight<string, CanvasNodeUploadResult | null> };
  nodeUploadAbortRef: { current: Record<string, AbortController> };
  nodeUploadRetryRef: { current: Record<string, CanvasUploadRetry> };
  beginNodeProgressSimulation: (nodeId: string, phase: "upload" | "generation") => void;
  nodeUploadPromiseRef: { current: Partial<Record<string, Promise<string>>> };
  setStatus: (message: string) => void;
  stopNodeProgressTimer: (nodeId: string) => void;
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  nodes: NodeData[];
  setNodeUploadProgress: (nodeId: string, progress: number) => void;
  nodeRemoteAssetUrlRef: { current: Record<string, string> };
  localAssetRemoteUrlRef: { current: Record<string, string> };
  finalizeNodeUploadVisual: (nodeId: string, delayMs?: number) => void;
  setGenerateDebug: (snapshot: CanvasGenerationDebugSnapshot | null) => void;
  persistCanvas: (nodes: NodeData[], edges: EdgeData[]) => Promise<string | null>;
  edges: EdgeData[];
  assertCanvasOperationActive: (expectedEpoch: number, signal?: AbortSignal) => void;
}

export function createCanvasUploadController({
  canvasContextEpochRef,
  canvasUploadAbortControllersRef,
  nodesRef,
  setNodePatch,
  activeProjectContextId,
  nodeUploadSingleFlightRef,
  nodeUploadAbortRef,
  nodeUploadRetryRef,
  beginNodeProgressSimulation,
  nodeUploadPromiseRef,
  setStatus,
  stopNodeProgressTimer,
  setNodes,
  nodes,
  setNodeUploadProgress,
  nodeRemoteAssetUrlRef,
  localAssetRemoteUrlRef,
  finalizeNodeUploadVisual,
  setGenerateDebug,
  persistCanvas,
  edges,
  assertCanvasOperationActive
}: CanvasUploadDependencies) {
  function uploadOptionalVideoPoster(
    nodeId: string,
    posterFile: File,
    projectId: number,
    expectedVideoUrl: string,
  ) {
    const contextEpoch = canvasContextEpochRef.current;
    const posterController = new AbortController();
    canvasUploadAbortControllersRef.current.add(posterController);
    const posterAttempt = startCanvasUploadAttempt(
      (signal) => api.uploadImage(posterFile, { projectId, signal }),
      { controller: posterController, timeoutMs: getCanvasUploadTimeoutMs(posterFile.size) },
    );
    void posterAttempt.promise
      .then((uploadedPoster) => {
        if (canvasContextEpochRef.current !== contextEpoch || posterController.signal.aborted) return;
        const currentNode = nodesRef.current.find((node) => node.id === nodeId);
        if (!currentNode || currentNode.videoUrl !== expectedVideoUrl) return;
        setNodePatch(nodeId, { videoPosterUrl: uploadedPoster.url });
      })
      // Poster extraction/storage is optional presentation metadata. A primary
      // video that already succeeded must never be rolled back or re-uploaded.
      .catch(() => undefined)
      .finally(() => {
        canvasUploadAbortControllersRef.current.delete(posterController);
      });
  }

  function uploadFileIntoNode(
    nodeId: string,
    file: File,
    type: "image" | "video",
    options?: {
      skipAutoPersist?: boolean;
      onLocalReady?: (local: { url: string; width: number; height: number; nodes: NodeData[] }) => void;
    },
  ) {
    const uploadContextEpoch = canvasContextEpochRef.current;
    const ownerProjectId = normalizeProjectId(activeProjectContextId);
    return nodeUploadSingleFlightRef.current.run(nodeId, async (attempt) => {
      if (!attempt.isCurrent() || canvasContextEpochRef.current !== uploadContextEpoch) return null;
      const uploadAbortController = new AbortController();
      canvasUploadAbortControllersRef.current.add(uploadAbortController);
      nodeUploadAbortRef.current[nodeId] = uploadAbortController;
      nodeUploadRetryRef.current[nodeId] = { file, type, options };
      setNodePatch(nodeId, {
        uploadState: "preparing",
        uploadProgress: 1,
        uploadError: undefined,
      });
      beginNodeProgressSimulation(nodeId, "upload");

      let trackedUrlPromise: Promise<string> | null = null;
      try {
        const operation = performUploadFileIntoNode(
          nodeId,
          file,
          type,
          options,
          attempt,
          uploadAbortController,
          uploadContextEpoch,
          ownerProjectId,
        );
        trackedUrlPromise = operation.then((result) => result?.url || "").catch(() => "");
        nodeUploadPromiseRef.current[nodeId] = trackedUrlPromise;
        return await operation;
      } catch (error) {
        if (isCanvasUploadAbortError(error) || !attempt.isCurrent()) return null;
        const failurePatch = getCanvasUploadFailurePatch(error);
        const message = failurePatch?.uploadError || "上传失败";
        if (canvasContextEpochRef.current === uploadContextEpoch) {
          if (failurePatch) setNodePatch(nodeId, failurePatch);
          setStatus(`${message}，可重试或移除素材`);
        }
        return null;
      } finally {
        canvasUploadAbortControllersRef.current.delete(uploadAbortController);
        if (nodeUploadAbortRef.current[nodeId] === uploadAbortController) {
          delete nodeUploadAbortRef.current[nodeId];
          stopNodeProgressTimer(nodeId);
        }
        if (trackedUrlPromise && nodeUploadPromiseRef.current[nodeId] === trackedUrlPromise) {
          delete nodeUploadPromiseRef.current[nodeId];
        }
      }
    });
  }

  async function performUploadFileIntoNode(
    nodeId: string,
    file: File,
    type: "image" | "video",
    options: CanvasUploadRetry["options"],
    attempt: KeyedSingleFlightAttempt<string>,
    uploadAbortController: AbortController,
    uploadContextEpoch: number,
    ownerProjectId: number | null,
  ): Promise<CanvasNodeUploadResult | null> {
    const assertCurrentAttempt = () => {
      if (
        attempt.isCurrent()
        && canvasContextEpochRef.current === uploadContextEpoch
        && nodeUploadAbortRef.current[nodeId] === uploadAbortController
        && !uploadAbortController.signal.aborted
      ) return;
      const reason = uploadAbortController.signal.reason;
      if (reason instanceof Error) throw reason;
      const error = new Error("上传操作已失效");
      error.name = "AbortError";
      throw error;
    };
    const localMeta = await startCanvasMediaPreparationAttempt(
      (signal) => readMediaMeta(file, type === "video", signal),
      uploadAbortController,
    ).promise;
    assertCurrentAttempt();
    const localPreviewUrl = type === "image"
      ? (await startCanvasMediaPreparationAttempt(
          (signal) => createLightweightImagePreviewUrl(file, localMeta.width, localMeta.height, signal),
          uploadAbortController,
        ).promise) || localMeta.localUrl
      : "";
    assertCurrentAttempt();
    const localPosterFile = type === "video"
      ? await startCanvasMediaPreparationAttempt(
          (signal) => readVideoPosterFile(localMeta.localUrl, file.name, signal),
          uploadAbortController,
        ).promise
      : null;
    assertCurrentAttempt();
    const applyLocalUploadPreview = (node: NodeData): NodeData => {
      if (node.id !== nodeId) return node;
      if (node.localVideoUrl) URL.revokeObjectURL(node.localVideoUrl);
      if (node.localPreviewUrl) URL.revokeObjectURL(node.localPreviewUrl);
      const nextRatio = nearestRatio(localMeta.width, localMeta.height);
      const nextDims = mediaToNodeDimensions(localMeta.width, localMeta.height);
      const centerX = node.x + node.width / 2;
      const centerY = node.y + node.height / 2;
      return {
        ...node,
        localPreviewUrl: type === "image" ? localPreviewUrl : undefined,
        localVideoUrl: type === "video" ? localMeta.localUrl : undefined,
        uploadState: "uploading",
        uploadProgress: 1,
        uploadError: undefined,
        imageUrl: type === "image" ? "" : node.imageUrl,
        videoUrl: type === "video" ? "" : node.videoUrl,
        fileName: file.name,
        ratio: nextRatio,
        mediaNaturalWidth: localMeta.width || node.mediaNaturalWidth,
        mediaNaturalHeight: localMeta.height || node.mediaNaturalHeight,
        width: nextDims.width,
        height: nextDims.height,
        x: centerX - nextDims.width / 2,
        y: centerY - nextDims.height / 2,
      };
    };
    let localReadyNodes: NodeData[] | null = null;
    setNodes((prev) =>
      {
        if (!attempt.canCommit() || canvasContextEpochRef.current !== uploadContextEpoch || uploadAbortController.signal.aborted) return prev;
        const nextNodes = prev.map(applyLocalUploadPreview);
        localReadyNodes = nextNodes;
        return nextNodes;
      },
    );
    if (type === "image") {
      options?.onLocalReady?.({
        url: localPreviewUrl || localMeta.localUrl,
        width: localMeta.width,
        height: localMeta.height,
        nodes: localReadyNodes || nodes.map(applyLocalUploadPreview),
      });
    }
    if (ownerProjectId === null) {
      if (attempt.isCurrent()) {
        setNodePatch(nodeId, { uploadState: "failed", uploadProgress: undefined, uploadError: "请先选择项目，再重试上传" });
      }
      setStatus("请先选择项目，再上传参考素材");
      return null;
    }
    const uploadAttempt = startCanvasUploadAttempt(
      (signal) => api.uploadImage(file, {
          projectId: ownerProjectId,
          signal,
          onProgress: (progress) => {
            if (nodeUploadAbortRef.current[nodeId] === uploadAbortController && !signal.aborted) {
              setNodeUploadProgress(nodeId, progress);
            }
          },
        }),
      { controller: uploadAbortController, timeoutMs: getCanvasUploadTimeoutMs(file.size) },
    );
    const uploadPromise = uploadAttempt.promise
      .then((uploaded) => {
        assertCurrentAttempt();
        nodeRemoteAssetUrlRef.current[nodeId] = uploaded.url;
        setNodePatch(nodeId, {
          referenceAssetUri: uploaded.assetId ? `asset://${uploaded.assetId}` : undefined,
          assetVersionId: uploaded.assetVersionId,
        });
        return { url: uploaded.url };
      });
    const uploaded = await uploadPromise.then(
      (result) => result,
      (error) => error as Error,
    );
    if (uploaded instanceof Error && (isCanvasUploadAbortError(uploaded) || !attempt.isCurrent())) return null;
    assertCurrentAttempt();
    if (!(uploaded instanceof Error)) {
      localAssetRemoteUrlRef.current[localMeta.localUrl] = uploaded.url;
      if (localPreviewUrl && localPreviewUrl !== localMeta.localUrl) localAssetRemoteUrlRef.current[localPreviewUrl] = uploaded.url;
    }

    let uploadCompletedNodes: NodeData[] | null = null;
    setNodes((prev) => {
      if (!attempt.canCommit() || canvasContextEpochRef.current !== uploadContextEpoch || uploadAbortController.signal.aborted) return prev;
      const nextNodes = prev.map((node) => {
        if (node.id !== nodeId) return node;
        const didUpload = !(uploaded instanceof Error);
        const nextRatio = nearestRatio(localMeta.width, localMeta.height);
        const nextDims = mediaToNodeDimensions(localMeta.width, localMeta.height);
        const centerX = node.x + node.width / 2;
        const centerY = node.y + node.height / 2;
        return {
          ...node,
          imageUrl: type === "image" && didUpload ? uploaded.url : node.imageUrl,
          primaryImageUrl: type === "image" && didUpload ? uploaded.url : node.primaryImageUrl,
          videoUrl: type === "video" && didUpload ? uploaded.url : node.videoUrl,
          videoPosterUrl: node.videoPosterUrl,
          localPreviewUrl: type === "image" && didUpload ? undefined : node.localPreviewUrl,
          localVideoUrl: type === "video" && didUpload ? undefined : node.localVideoUrl,
          fileName: file.name,
          uploadState: didUpload ? "idle" as const : "failed" as const,
          uploadProgress: undefined,
          uploadError: uploaded instanceof Error ? uploaded.message : undefined,
          ratio: nextRatio,
          mediaNaturalWidth: localMeta.width || node.mediaNaturalWidth,
          mediaNaturalHeight: localMeta.height || node.mediaNaturalHeight,
          width: nextDims.width,
          height: nextDims.height,
          x: centerX - nextDims.width / 2,
          y: centerY - nextDims.height / 2,
        };
      });
      uploadCompletedNodes = nextNodes;
      return nextNodes;
    });
    finalizeNodeUploadVisual(nodeId, 0);
    if (!(uploaded instanceof Error) && type === "image") {
      if (localPreviewUrl) window.setTimeout(() => URL.revokeObjectURL(localPreviewUrl), 1200);
      if (localMeta.localUrl && localMeta.localUrl !== localPreviewUrl) URL.revokeObjectURL(localMeta.localUrl);
    }

    if (uploaded instanceof Error) {
      if (isCanvasUploadAbortError(uploaded)) return null;
      const msg = uploaded.message.toLowerCase();
      setStatus(msg.includes("cos bucket missing")
        ? "服务器未配置云存储，当前仅保留本地预览"
        : `${uploaded.message || "上传失败"}，已保留本地预览，可重试`);
      return null;
    }

    delete nodeUploadRetryRef.current[nodeId];

    if (type === "video" && localPosterFile) {
      uploadOptionalVideoPoster(nodeId, localPosterFile, ownerProjectId, uploaded.url);
    }

    setGenerateDebug({
      phase: "upload-file-into-node-success",
      payload: {
        nodeId,
        uploadedUrl: uploaded.url,
        writeField: type === "image" ? "imageUrl" : "videoUrl",
        fileName: file.name,
      },
    });

    if (!options?.skipAutoPersist) {
      window.setTimeout(() => {
        if (!attempt.canCommit() || canvasContextEpochRef.current !== uploadContextEpoch || uploadAbortController.signal.aborted) return;
        // Never persist the render snapshot captured before the upload. If
        // React has deferred the terminal update, normal canvas autosave will
        // persist it after commit instead of saving a stale uploading node.
        const currentNodes = nodesRef.current;
        const current = currentNodes.find(node => node.id === nodeId);
        if (current?.uploadState !== "idle" || (type === "image" ? current.imageUrl : current.videoUrl) !== uploaded.url) return;
        void persistCanvas(currentNodes, edges);
      }, 40);
    }
    setStatus("上传成功");
    return {
      url: uploaded.url,
      width: localMeta.width,
      height: localMeta.height,
      nodes: uploadCompletedNodes,
    };
  }

  async function uploadMediaFileToRemote(file: File, type: "image" | "video", nodeId?: string) {
    const uploadContextEpoch = canvasContextEpochRef.current;
    const ownerProjectId = normalizeProjectId(activeProjectContextId);
    if (ownerProjectId === null) throw new Error("请先选择项目，再上传参考素材");
    const uploadAbortController = new AbortController();
    canvasUploadAbortControllersRef.current.add(uploadAbortController);
    if (nodeId) {
      nodeUploadAbortRef.current[nodeId] = uploadAbortController;
      beginNodeProgressSimulation(nodeId, "upload");
    }
    try {
      const localMeta = await startCanvasMediaPreparationAttempt(
        (signal) => readMediaMeta(file, type === "video", signal),
        uploadAbortController,
      ).promise;
      assertCanvasOperationActive(uploadContextEpoch, uploadAbortController.signal);
      const uploadAttempt = startCanvasUploadAttempt(
        (signal) => api.uploadImage(file, {
          projectId: ownerProjectId,
          signal,
          onProgress: nodeId
            ? (progress) => {
                if (nodeUploadAbortRef.current[nodeId] === uploadAbortController && !signal.aborted) {
                  setNodeUploadProgress(nodeId, progress);
                }
              }
            : undefined,
        }),
        { controller: uploadAbortController, timeoutMs: getCanvasUploadTimeoutMs(file.size) },
      );
      const uploadPromise = uploadAttempt.promise.then((uploaded) => {
        assertCanvasOperationActive(uploadContextEpoch, uploadAbortController.signal);
        if (nodeId && nodeUploadAbortRef.current[nodeId] === uploadAbortController) {
          setNodePatch(nodeId, {
            referenceAssetUri: uploaded.assetId ? `asset://${uploaded.assetId}` : undefined,
            assetVersionId: uploaded.assetVersionId,
          });
        }
        return uploaded;
      });
      if (nodeId) {
        nodeUploadPromiseRef.current[nodeId] = uploadPromise.then((uploaded) => uploaded.url).catch(() => "");
      }
      const uploaded = await uploadPromise;
      assertCanvasOperationActive(uploadContextEpoch, uploadAbortController.signal);
      const uploadedUrl = uploaded.url;
      if (nodeId) {
        nodeRemoteAssetUrlRef.current[nodeId] = uploadedUrl;
      }
      localAssetRemoteUrlRef.current[localMeta.localUrl] = uploadedUrl;
      return {
        url: uploadedUrl,
        width: localMeta.width,
        height: localMeta.height,
        ratio: nearestRatio(localMeta.width, localMeta.height),
        fileName: file.name,
        assetId: uploaded.assetId,
        assetVersionId: uploaded.assetVersionId,
      };
    } finally {
      canvasUploadAbortControllersRef.current.delete(uploadAbortController);
      if (nodeId && nodeUploadAbortRef.current[nodeId] === uploadAbortController) {
        delete nodeUploadPromiseRef.current[nodeId];
        delete nodeUploadAbortRef.current[nodeId];
        stopNodeProgressTimer(nodeId);
      }
    }
  }

  return { uploadFileIntoNode, uploadMediaFileToRemote };
}
