import type { GroupData, NodeData, StoryboardGroupType } from "./canvasDataTypes";

export function isStoryboardGroup(group: GroupData | null | undefined): group is GroupData & { groupType: StoryboardGroupType } {
  return Boolean(group && (group.groupType === "storyboard" || group.groupType === "storyboard-hd"));
}

export function findStoryboardGroupByNodeId(groups: GroupData[], nodeId: string) {
  return groups.find((group) => isStoryboardGroup(group) && group.nodeIds.includes(nodeId)) ?? null;
}

export function getStoryboardGroupSlots(group: GroupData | null | undefined, nodeMap: Map<string, NodeData>) {
  if (!isStoryboardGroup(group)) return [];
  return group.nodeIds.map((id) => nodeMap.get(id)).filter((node): node is NodeData => Boolean(node)).sort((a, b) => {
    const orderA = Number(a.storyboardSlotOrder || 0);
    const orderB = Number(b.storyboardSlotOrder || 0);
    return orderA === orderB ? a.y - b.y || a.x - b.x : orderA - orderB;
  });
}

export function getStoryboardFilledCount(group: GroupData | null | undefined, nodeMap: Map<string, NodeData>) {
  return getStoryboardGroupSlots(group, nodeMap).filter((node) => Boolean(node.imageUrl || node.localPreviewUrl)).length;
}
