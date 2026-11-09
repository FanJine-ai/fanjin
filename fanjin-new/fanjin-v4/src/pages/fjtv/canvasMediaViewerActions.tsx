import { type NodeData } from "./canvasDataTypes";

export interface CanvasMediaViewerActionsDependencies {
  getNodeMediaUrl: (node: NodeData | null | undefined) => string;
  setMediaViewerNodeId: React.Dispatch<React.SetStateAction<string | null>>;
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
}

export function createCanvasMediaViewerActions({
  getNodeMediaUrl,
  setMediaViewerNodeId,
  setExpanded,
}: CanvasMediaViewerActionsDependencies) {
function openMediaViewer(node: NodeData | null | undefined) {
    if (!node) return;
    if ((node.type !== "image" && node.type !== "video") || !getNodeMediaUrl(node)) return;
    setMediaViewerNodeId(node.id);
    setExpanded(false);
  }
  return { openMediaViewer };
}
