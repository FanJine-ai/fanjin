import type * as React from "react";
import type * as Router from "react-router-dom";
import { LAST_ACTIVE_CANVAS_KEY } from "./canvasPageConstants";
import { replaceCanvasFromServer as hydrateCanvasFromServer } from "./canvasHydration";
import { type ViewportState, type NodeData, type EdgeData, type GroupData, type CanvasMetaState, type CanvasConflictState } from "./canvasDataTypes";
import { api } from "@/lib/api";

export interface CanvasConflictActionsDependencies {
  routeProjectContextId: string | number | null | undefined;
  initialBrief: string;
  initialBriefConsumedRef: React.RefObject<boolean>;
  suppressNextAutoSaveRef: React.RefObject<boolean>;
  resetCanvasRuntimeState: () => void;
  nodesRef: React.RefObject<NodeData[]>;
  viewportRef: React.RefObject<ViewportState>;
  canvasServerRevisionRef: React.RefObject<number | null>;
  setNodes: React.Dispatch<React.SetStateAction<NodeData[]>>;
  setEdges: React.Dispatch<React.SetStateAction<EdgeData[]>>;
  setGroups: React.Dispatch<React.SetStateAction<GroupData[]>>;
  setViewport: React.Dispatch<React.SetStateAction<ViewportState>>;
  setCurrentProjectId: React.Dispatch<React.SetStateAction<string | null>>;
  setCanvasMeta: React.Dispatch<React.SetStateAction<CanvasMetaState>>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  canvasMeta: CanvasMetaState;
  setCanvasSaveState: React.Dispatch<React.SetStateAction<"error" | "dirty" | "saving" | "saved">>;
  canvasConflictRef: React.RefObject<boolean>;
  setCanvasConflict: React.Dispatch<React.SetStateAction<CanvasConflictState | null>>;
  setCanvasSavedAt: React.Dispatch<React.SetStateAction<Date | null>>;
}

export function createCanvasConflictActions({
  routeProjectContextId,
  initialBrief,
  initialBriefConsumedRef,
  suppressNextAutoSaveRef,
  resetCanvasRuntimeState,
  nodesRef,
  viewportRef,
  canvasServerRevisionRef,
  setNodes,
  setEdges,
  setGroups,
  setViewport,
  setCurrentProjectId,
  setCanvasMeta,
  setStatus,
  canvasMeta,
  setCanvasSaveState,
  canvasConflictRef,
  setCanvasConflict,
  setCanvasSavedAt,
}: CanvasConflictActionsDependencies) {
function replaceCanvasFromServer(result: any, fallbackCanvasId: string, options?: { seedBrief?: boolean }) {
    return hydrateCanvasFromServer(result, fallbackCanvasId, {
      routeProjectContextId,
      initialBrief,
      initialBriefConsumedRef,
      suppressNextAutoSaveRef,
      resetCanvasRuntimeState,
      nodesRef,
      viewportRef,
      canvasServerRevisionRef,
      setNodes,
      setEdges,
      setGroups,
      setViewport,
      setCurrentProjectId,
      setCanvasMeta,
      setStatus,
      lastActiveCanvasKey: LAST_ACTIVE_CANVAS_KEY,
    }, options);
  }

async function loadLatestCanvasAfterConflict() {
    const canvasId = canvasMeta.canvasId;
    if (!canvasId) return;
    setCanvasSaveState("saving");
    try {
      const result = await api.loadCanvas(canvasId);
      suppressNextAutoSaveRef.current = true;
      replaceCanvasFromServer(result, canvasId);
      canvasConflictRef.current = false;
      setCanvasConflict(null);
      setCanvasSavedAt(new Date());
      setCanvasSaveState("saved");
      setStatus("已加载服务器最新画布，本地冲突版本未覆盖服务器");
    } catch (error) {
      setCanvasSaveState("error");
      setStatus(error instanceof Error ? error.message : "最新画布加载失败，请重试");
    }
  }
  return { replaceCanvasFromServer, loadLatestCanvasAfterConflict };
}
