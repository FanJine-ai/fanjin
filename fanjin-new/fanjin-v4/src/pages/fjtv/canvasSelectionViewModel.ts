import type { NodeData } from "./canvasDataTypes";

export function getSelectionBounds(nodes: NodeData[], selectedNodeIds: string[], padding: number) {
  if (selectedNodeIds.length < 2) return null;
  const selected = nodes.filter((node) => selectedNodeIds.includes(node.id));
  if (selected.length < 2) return null;
  const left = Math.min(...selected.map((node) => node.x));
  const top = Math.min(...selected.map((node) => node.y));
  const right = Math.max(...selected.map((node) => node.x + node.width));
  const bottom = Math.max(...selected.map((node) => node.y + node.height));
  return { left: left - padding, top: top - padding, right: right + padding, bottom: bottom + padding };
}
