import type { EdgeData, NodeData, UpstreamReferenceItem } from "./canvasDataTypes";

export function buildUpstreamReferences(activeNodeId: string | null, edges: EdgeData[], nodeMap: Map<string, NodeData>): UpstreamReferenceItem[] {
  if (!activeNodeId) return [];
  return edges.filter((edge) => edge.toNodeId === activeNodeId).map((edge) => nodeMap.get(edge.fromNodeId)).filter((node): node is NodeData => Boolean(node)).map((node, index) => {
    const badge = index + 1;
    const label = `${node.type === "image" ? "图片" : node.type === "video" ? "视频" : node.type === "audio" ? "音频" : "文本"}${badge}`;
    return {
      id: node.id,
      nodeId: node.id,
      type: node.type,
      label,
      mentionToken: `[@${label}]`,
      thumbnailSrc: node.type === "image" ? node.imageUrl || node.localPreviewUrl || "" : "",
      sourceUrl: node.imageUrl || node.localPreviewUrl || node.videoUrl || node.localVideoUrl || node.audioUrl || node.localAudioUrl || "",
      badge,
    };
  });
}
