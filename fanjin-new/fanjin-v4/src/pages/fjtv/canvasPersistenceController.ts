import type { Dispatch, SetStateAction } from "react";
import { api } from "@/lib/api";
import { normalizeProjectId } from "@/stores/projectStore";
import type { NodeData, EdgeData, GroupData, CanvasMetaState, CanvasConflictState, ViewportState } from "./canvasDataTypes";
import { positiveCanvasRevision, positiveCanvasProjectId, canvasConflictFromError } from "./canvasSnapshotCodec";
import { filterCanvasGraphForPersistableNodes } from "./canvasUploadRuntime";
import { getNodeImageDisplayUrl } from "./canvasAssetPresentation";

export function buildCanvasAutosaveSnapshot(
  nodes: NodeData[],
  edges: EdgeData[],
  groups: GroupData[],
  sanitizeNodes: (nodes: NodeData[]) => NodeData[],
) {
  const persistableNodes = sanitizeNodes(nodes);
  const persistableGraph = filterCanvasGraphForPersistableNodes(
    persistableNodes,
    edges,
    groups,
  );
  return {
    nodes: persistableNodes,
    edges: persistableGraph.edges,
    groups: persistableGraph.groups,
  };
}

export function buildCanvasAutosaveFingerprint(
  snapshot: { nodes: NodeData[]; edges: EdgeData[]; groups: GroupData[] },
  name: string,
) {
  return JSON.stringify({ ...snapshot, name });
}

export interface CanvasPersistenceDependencies {
  canvasContextEpochRef: { current: number };
  ensureApiKeyReady: () => boolean;
  canvasConflictRef: { current: boolean };
  canvasMeta: CanvasMetaState;
  currentProjectId: string | null;
  routeProjectContextId: string | number | null | undefined;
  studioChrome: boolean;
  selectedProjectId: number | null;
  setStatus: (value: string) => void;
  canvasServerRevisionRef: { current: number | null };
  routeCanvasId: string | undefined;
  location: { pathname: string };
  navigate: (path: string, options: { replace: boolean }) => void;
  LAST_ACTIVE_CANVAS_KEY: string;
  sanitizeNodesForPersistence: (nodes: NodeData[]) => NodeData[];
  viewportRef: { current: ViewportState };
  canvasCoverUrl: (nodes: NodeData[]) => string;
  setCanvasConflict: (value: CanvasConflictState) => void;
  setCanvasSaveState: (value: "dirty" | "saving" | "saved" | "error") => void;
  localResultPendingPersistenceRef: { current: Record<string, string> };
  setCanvasMeta: Dispatch<SetStateAction<CanvasMetaState>>;
}

export function createCanvasPersistenceWorker({
  canvasContextEpochRef, ensureApiKeyReady, canvasConflictRef, canvasMeta, currentProjectId, routeProjectContextId, studioChrome, selectedProjectId, setStatus, canvasServerRevisionRef, routeCanvasId, location, navigate, LAST_ACTIVE_CANVAS_KEY, sanitizeNodesForPersistence, viewportRef, canvasCoverUrl, setCanvasConflict, setCanvasSaveState, localResultPendingPersistenceRef, setCanvasMeta
}: CanvasPersistenceDependencies) {
  async function persistCanvasOnce(
    nextNodes: NodeData[],
    nextEdges: EdgeData[],
    nextName: string,
    nextGroups: GroupData[],
    contextEpoch: number,
  ) {
    const contextIsActive = () => canvasContextEpochRef.current === contextEpoch;
    if (!contextIsActive()) return null;
    if (!ensureApiKeyReady()) return null;
    if (canvasConflictRef.current) return null;
    const explicitProjectId = canvasMeta.projectId
      || currentProjectId
      || (routeProjectContextId ? String(routeProjectContextId) : null)
      || (!studioChrome && normalizeProjectId(selectedProjectId) !== null
        ? String(normalizeProjectId(selectedProjectId))
        : null);
    if (studioChrome && !explicitProjectId) {
      setStatus("请先选择或创建真实项目，再编辑画布");
      return null;
    }
    let nextCanvasId = canvasMeta.canvasId;
    let expectedRevision = canvasServerRevisionRef.current;
    let ownerProjectId = explicitProjectId;
    const createdFromEntry = !nextCanvasId && !routeCanvasId && location.pathname === "/infinite-canvas-v2";
    if (!nextCanvasId) {
      try {
        const created = await api.createCanvas(nextName || "未命名画布", explicitProjectId || undefined);
        if (!contextIsActive()) return null;
        nextCanvasId = (created as any)?.canvasId;
        expectedRevision = positiveCanvasRevision((created as any)?.revision);
      } catch (error) {
        if (!contextIsActive()) return null;
        if (explicitProjectId && !studioChrome) {
          const fallback = await api.createCanvas(nextName || "未命名画布");
          if (!contextIsActive()) return null;
          nextCanvasId = (fallback as any)?.canvasId;
          expectedRevision = positiveCanvasRevision((fallback as any)?.revision);
        } else {
          throw error;
        }
      }
      if (nextCanvasId && contextIsActive()) {
        window.localStorage.setItem(LAST_ACTIVE_CANVAS_KEY, nextCanvasId);
        if (createdFromEntry) {
          navigate(`/canvas/${nextCanvasId}`, { replace: true });
        }
      }
    }
    if (!nextCanvasId) return null;
    if (expectedRevision === null) {
      const latest = await api.loadCanvas(nextCanvasId);
      if (!contextIsActive()) return null;
      expectedRevision = positiveCanvasRevision((latest as any)?.revision);
      ownerProjectId = positiveCanvasProjectId((latest as any)?.projectId) || ownerProjectId;
    }
    if (expectedRevision === null) {
      setStatus("无法读取画布版本，已阻止覆盖保存，请重新加载");
      return null;
    }
    const persistableNodes = sanitizeNodesForPersistence(nextNodes);
    const persistableGraph = filterCanvasGraphForPersistableNodes(
      persistableNodes,
      nextEdges,
      nextGroups,
    );
    let saved: { canvasId?: string; revision?: number };
    try {
      saved = await api.saveCanvas({
        canvasId: nextCanvasId,
        projectId: ownerProjectId || undefined,
        expectedRevision,
        name: nextName || "未命名画布",
        nodes: persistableNodes,
        edges: persistableGraph.edges,
        connections: persistableGraph.edges,
        groups: persistableGraph.groups,
        viewport: {
          x: viewportRef.current.panX,
          y: viewportRef.current.panY,
          zoom: viewportRef.current.scale,
        },
        coverImageUrl: canvasCoverUrl(persistableNodes),
      });
    } catch (error) {
      if (!contextIsActive()) return null;
      const conflict = canvasConflictFromError(error);
      if (!conflict) throw error;
      canvasConflictRef.current = true;
      setCanvasConflict(conflict);
      setCanvasSaveState("error");
      setStatus("画布已在其他标签页或 Agent 中更新，本地修改尚未覆盖服务器，请加载最新版本");
      return null;
    }
    if (!contextIsActive()) return null;
    const nextRevision = positiveCanvasRevision(saved?.revision);
    if (nextRevision === null || nextRevision !== expectedRevision + 1) {
      setStatus("服务器未返回有效画布版本，已停止后续保存，请重新加载");
      setCanvasSaveState("error");
      return null;
    }
    persistableNodes.forEach((persistedNode) => {
      const pendingImageUrl = localResultPendingPersistenceRef.current[persistedNode.id];
      if (pendingImageUrl && getNodeImageDisplayUrl(persistedNode) === pendingImageUrl) {
        delete localResultPendingPersistenceRef.current[persistedNode.id];
      }
    });
    canvasServerRevisionRef.current = nextRevision;
    setCanvasMeta((prev) => ({
      ...prev,
      canvasId: nextCanvasId,
      projectId: ownerProjectId || prev.projectId,
      revision: nextRevision,
      name: nextName || prev.name,
      ready: true,
      loading: false,
    }));
    window.localStorage.setItem(LAST_ACTIVE_CANVAS_KEY, nextCanvasId);
    return nextCanvasId;
  }

  return persistCanvasOnce;
}
