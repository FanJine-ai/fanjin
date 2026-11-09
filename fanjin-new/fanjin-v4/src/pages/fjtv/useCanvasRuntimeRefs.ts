import type { NodeData, ImageGridSplitDragState, CanvasHistorySnapshot, CanvasPersistRequest, CanvasUploadRetry, CanvasNodeUploadResult } from "./canvasDataTypes";
import { useCallback, useRef, useState } from "react";
import { clearCanvasTimerRegistry } from "./canvasRuntimeTimers";
import { createKeyedSingleFlight, createLatestWinsAsyncQueue, type LatestWinsAsyncQueue } from "./canvasUploadRuntime";
import { type CanvasRect as Rect } from "./canvasGeometry";

export function useCanvasRuntimeRefs() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [canvasSurfaceWidth, setCanvasSurfaceWidth] = useState(0);
  const [canvasSurfaceHeight, setCanvasSurfaceHeight] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageToImageUploadPresetRef = useRef<string | null>(null);
  const quickUploadInputRef = useRef<HTMLInputElement>(null);
  const storyboardSlotUploadInputRef = useRef<HTMLInputElement>(null);
  const productScriptVideoUploadInputRef = useRef<HTMLInputElement>(null);
  const productScriptAssetUploadInputRef = useRef<HTMLInputElement>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const textEditorTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composePreviewRef = useRef<HTMLVideoElement | null>(null);
  const composeTimelineRef = useRef<HTMLDivElement | null>(null);
  const composeExportEpochRef = useRef(0);
  const nodeVideoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const videoPreviewPrimedRef = useRef<Record<string, string>>({});
  const nodeAudioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const promptSelectionRef = useRef({ start: 0, end: 0 });
  const saveTimerRef = useRef<number | null>(null);
  const saveRevisionRef = useRef(0);
  const canvasServerRevisionRef = useRef<number | null>(null);
  const canvasPersistWorkerRef = useRef<(request: CanvasPersistRequest) => Promise<string | null>>(
    async () => null,
  );
  const canvasSaveQueueRef = useRef<LatestWinsAsyncQueue<CanvasPersistRequest, string | null> | null>(null);
  if (!canvasSaveQueueRef.current) {
    canvasSaveQueueRef.current = createLatestWinsAsyncQueue(
      (request) => canvasPersistWorkerRef.current(request),
      null,
    );
  }
  const canvasConflictRef = useRef(false);
  const suppressNextAutoSaveRef = useRef(false);
  const initialBriefConsumedRef = useRef(false);
  const canvasContextEpochRef = useRef(0);
  const historyTimerRef = useRef<number | null>(null);
  const hydratedRef = useRef(false);
  const locallyDeletedNodeIdsRef = useRef<Set<string>>(new Set());
  const historyReadyRef = useRef(false);
  const historyApplyingRef = useRef(false);
  const historyCurrentRef = useRef<CanvasHistorySnapshot | null>(null);
  const undoStackRef = useRef<CanvasHistorySnapshot[]>([]);
  const redoStackRef = useRef<CanvasHistorySnapshot[]>([]);
  const spacePressedRef = useRef(false);
  const generationSessionRef = useRef<Record<string, string>>({});
  const resumedFailedQueriesRef = useRef(new Set<string>());
  const localGeometryEditUntilRef = useRef<Record<string, number>>({});
  const localResultPendingPersistenceRef = useRef<Record<string, string>>({});
  const nodeRemoteAssetUrlRef = useRef<Record<string, string>>({});
  const nodeUploadPromiseRef = useRef<Partial<Record<string, Promise<string>>>>({});
  const nodeUploadAbortRef = useRef<Record<string, AbortController>>({});
  const canvasUploadAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const nodeUploadRetryRef = useRef<Record<string, CanvasUploadRetry>>({});
  const nodeUploadSingleFlightRef = useRef(createKeyedSingleFlight<string, CanvasNodeUploadResult | null>());
  const canvasStablePersistableNodesRef = useRef<Map<string, NodeData>>(new Map());
  const nodeProgressTimerRef = useRef<Record<string, number>>({});
  const nodeStatusTimerRef = useRef<Record<string, number>>({});
  const productScriptProgressTimerRef = useRef<Record<string, number>>({});
  const localAssetRemoteUrlRef = useRef<Record<string, string>>({});
  const imageGridSplitDragRef = useRef<ImageGridSplitDragState | null>(null);
  const imageGridSplitSuppressClickRef = useRef(false);
  const miniMapSurfaceRef = useRef<HTMLDivElement | null>(null);
  const contentAutoFitCanvasKeyRef = useRef<string | null>(null);
  const canvasBoundsRef = useRef<Rect | null>(null);
  const studioTopologyFitRef = useRef<() => void>(() => undefined);
  const studioTopologyFitTimerRef = useRef<number | null>(null);
  const studioTopologyFitSuppressedUntilRef = useRef(0);

  const clearCanvasNodeTimers = useCallback(() => {
    clearCanvasTimerRegistry(nodeProgressTimerRef.current, (timerId) => window.clearInterval(timerId));
    clearCanvasTimerRegistry(productScriptProgressTimerRef.current, (timerId) => window.clearInterval(timerId));
    clearCanvasTimerRegistry(nodeStatusTimerRef.current, (timerId) => window.clearTimeout(timerId));
  }, []);

  const abortCanvasNodeUploads = useCallback((reason = "画布已关闭，上传已取消") => {
    nodeUploadSingleFlightRef.current.invalidateAll();
    canvasUploadAbortControllersRef.current.forEach((controller) => {
      if (!controller.signal.aborted) {
        const abortError = new Error(reason);
        abortError.name = "AbortError";
        controller.abort(abortError);
      }
    });
    canvasUploadAbortControllersRef.current.clear();
    nodeUploadAbortRef.current = {};
    nodeUploadPromiseRef.current = {};
    nodeUploadRetryRef.current = {};
  }, []);

  return {
    rootRef, canvasSurfaceWidth,
    setCanvasSurfaceWidth, canvasSurfaceHeight,
    setCanvasSurfaceHeight, fileInputRef,
    imageToImageUploadPresetRef, quickUploadInputRef,
    storyboardSlotUploadInputRef, productScriptVideoUploadInputRef,
    productScriptAssetUploadInputRef, promptTextareaRef,
    textEditorTextareaRef, composePreviewRef,
    composeTimelineRef, composeExportEpochRef,
    nodeVideoRefs, videoPreviewPrimedRef,
    nodeAudioRefs, promptSelectionRef,
    saveTimerRef, saveRevisionRef,
    canvasServerRevisionRef, canvasPersistWorkerRef,
    canvasSaveQueueRef, canvasConflictRef,
    suppressNextAutoSaveRef, initialBriefConsumedRef,
    canvasContextEpochRef, historyTimerRef,
    hydratedRef, locallyDeletedNodeIdsRef,
    historyReadyRef, historyApplyingRef,
    historyCurrentRef, undoStackRef,
    redoStackRef, spacePressedRef,
    generationSessionRef, resumedFailedQueriesRef,
    localGeometryEditUntilRef, localResultPendingPersistenceRef,
    nodeRemoteAssetUrlRef, nodeUploadPromiseRef,
    nodeUploadAbortRef, canvasUploadAbortControllersRef,
    nodeUploadRetryRef, nodeUploadSingleFlightRef,
    canvasStablePersistableNodesRef, nodeProgressTimerRef,
    nodeStatusTimerRef, productScriptProgressTimerRef,
    localAssetRemoteUrlRef, imageGridSplitDragRef,
    imageGridSplitSuppressClickRef, miniMapSurfaceRef,
    contentAutoFitCanvasKeyRef, canvasBoundsRef,
    studioTopologyFitRef, studioTopologyFitTimerRef,
    studioTopologyFitSuppressedUntilRef, clearCanvasNodeTimers,
    abortCanvasNodeUploads,
  };
}
