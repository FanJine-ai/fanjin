import type { GroupData, NodeData } from "./canvasDataTypes";

function boundsForNodes(nodes: NodeData[], padding: number) {
  if (nodes.length === 0) return null;
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.width));
  const bottom = Math.max(...nodes.map((node) => node.y + node.height));
  return { left: left - padding, top: top - padding, right: right + padding, bottom: bottom + padding };
}

export function getGroupBounds(group: GroupData | null | undefined, nodes: NodeData[], padding: number) {
  if (!group) return null;
  return boundsForNodes(nodes.filter((node) => group.nodeIds.includes(node.id)), padding);
}

export function buildGroupBoundsMap(groups: GroupData[], nodes: NodeData[], padding: number) {
  const map = new Map<string, NonNullable<ReturnType<typeof boundsForNodes>>>();
  groups.forEach((group) => {
    const bounds = boundsForNodes(nodes.filter((node) => group.nodeIds.includes(node.id)), padding);
    if (bounds) map.set(group.id, bounds);
  });
  return map;
}
