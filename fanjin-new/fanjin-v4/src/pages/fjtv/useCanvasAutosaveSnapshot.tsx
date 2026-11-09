import { useMemo,useRef } from "react";
import type {
CanvasMetaState,
EdgeData,
GroupData,
NodeData
} from "./canvasDataTypes";
import { buildCanvasAutosaveFingerprint,buildCanvasAutosaveSnapshot } from "./canvasPersistenceController";
interface Context {
  nodes: NodeData[];
  edges: EdgeData[];
  groups: GroupData[];
  sanitizeNodesForPersistence: (nextNodes: NodeData[]) => any;
  canvasMeta: CanvasMetaState;
}
export function useCanvasAutosaveSnapshot({ nodes, edges, groups, sanitizeNodesForPersistence, canvasMeta }: Context) {
  const canvasAutosaveSnapshot = useMemo(() => {
    return buildCanvasAutosaveSnapshot(nodes, edges, groups, sanitizeNodesForPersistence);
  }, [nodes, edges, groups]);
  const canvasAutosaveFingerprint = useMemo(
    () => buildCanvasAutosaveFingerprint(canvasAutosaveSnapshot, canvasMeta.name),
    [canvasAutosaveSnapshot, canvasMeta.name],
  );
  const canvasAutosaveSnapshotRef = useRef(canvasAutosaveSnapshot);
  canvasAutosaveSnapshotRef.current = canvasAutosaveSnapshot;

  return { canvasAutosaveSnapshot, canvasAutosaveFingerprint, canvasAutosaveSnapshotRef };
}
