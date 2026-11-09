import type { Dispatch, SetStateAction } from "react";
import type { CanvasMetaState, EdgeData, GroupData, NodeData, ViewportState } from "./canvasDataTypes";
import { positiveCanvasProjectId, positiveCanvasRevision } from "./canvasSnapshotCodec";
import { readLoadedCanvasIdentity } from "./canvasLoadedIdentity";
import { canvasInterruptedSubmissionPatch } from "./canvasGenerationRecovery";
import { createCanvasBriefNode, repairLegacyNodes } from "./canvasNodeDefaults";

export interface CanvasHydrationDependencies {
  routeProjectContextId: string | number | null | undefined;
  initialBrief: string;
  initialBriefConsumedRef: { current: boolean };
  suppressNextAutoSaveRef: { current: boolean };
  resetCanvasRuntimeState: () => void;
  nodesRef: { current: NodeData[] };
  viewportRef: { current: ViewportState };
  canvasServerRevisionRef: { current: number | null };
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  setGroups: Dispatch<SetStateAction<GroupData[]>>;
  setViewport: Dispatch<SetStateAction<ViewportState>>;
  setCurrentProjectId: (value: string | null) => void;
  setCanvasMeta: Dispatch<SetStateAction<CanvasMetaState>>;
  setStatus: (value: string) => void;
  lastActiveCanvasKey: string;
}

export function replaceCanvasFromServer(
  result: any,
  fallbackCanvasId: string,
  deps: CanvasHydrationDependencies,
  options?: { seedBrief?: boolean },
) {
  const identity = readLoadedCanvasIdentity(
    result,
    fallbackCanvasId,
    deps.routeProjectContextId,
    positiveCanvasProjectId,
    positiveCanvasRevision,
  );
  let loadedNodes = repairLegacyNodes(Array.isArray(result?.nodes) ? result.nodes : []);
  let recoveredSubmissions = false;
  loadedNodes = loadedNodes.map((node) => {
    const patch = canvasInterruptedSubmissionPatch(node);
    if (!patch) return node;
    recoveredSubmissions = true;
    return { ...node, ...patch };
  });
  let seededLocalBrief = false;
  if (options?.seedBrief && loadedNodes.length === 0 && !deps.initialBriefConsumedRef.current) {
    const briefNode = createCanvasBriefNode(deps.initialBrief);
    if (briefNode) {
      loadedNodes = [briefNode];
      seededLocalBrief = true;
      deps.initialBriefConsumedRef.current = true;
      deps.setStatus("已将创作 Brief 放入画布");
    }
  }
  const loadedEdges: EdgeData[] = Array.isArray(result?.connections)
    ? result.connections
    : Array.isArray(result?.edges)
      ? result.edges
      : [];
  const loadedGroups: GroupData[] = Array.isArray(result?.groups) ? result.groups : [];
  const loadedViewport: ViewportState = result?.viewport && typeof result.viewport === "object"
    ? {
      scale: Number.isFinite(Number(result.viewport.zoom)) ? Number(result.viewport.zoom) : 1,
      panX: Number.isFinite(Number(result.viewport.x)) ? Number(result.viewport.x) : 0,
      panY: Number.isFinite(Number(result.viewport.y)) ? Number(result.viewport.y) : 0,
    }
    : { scale: 1, panX: 0, panY: 0 };

  deps.suppressNextAutoSaveRef.current = !seededLocalBrief && !recoveredSubmissions;
  deps.resetCanvasRuntimeState();
  deps.nodesRef.current = loadedNodes;
  deps.setNodes(loadedNodes);
  deps.setEdges(loadedEdges);
  deps.setGroups(loadedGroups);
  deps.setViewport(loadedViewport);
  deps.viewportRef.current = loadedViewport;
  deps.canvasServerRevisionRef.current = identity.revision;
  deps.setCurrentProjectId(String(identity.projectId));
  deps.setCanvasMeta({
    canvasId: identity.canvasId,
    projectId: String(identity.projectId),
    revision: identity.revision,
    name: result?.name || "未命名项目",
    loading: false,
    ready: true,
  });
  window.localStorage.setItem(deps.lastActiveCanvasKey, identity.canvasId);
  return identity;
}
