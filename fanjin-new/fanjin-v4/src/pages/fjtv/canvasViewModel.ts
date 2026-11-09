import type { GroupData, NodeData } from "./canvasDataTypes";
import type { AssetCatalogItem } from "@/features/assets/assetCatalog";
import type { HistoryAssetItem } from "./canvasDataTypes";
import { resolvePendingGenerationProgress } from "./canvasGenerationProgress";
import type { PortraitAdmissionAsset } from "../../features/portrait-admission/PortraitAdmissionPanel";
import { ratioToNodeDimensions } from "./canvasMediaGeometry";

export function buildCanvasScaleMetrics(visualScale: number) {
  const frameScale = Math.max(0.2, visualScale);
  const dotScale = Math.max(0.08, visualScale);
  return {
    frameScale,
    frameStrokeWidth: 1 / frameScale,
    frameDash: 3 / frameScale,
    frameGap: 3 / frameScale,
    dotSpacing: 22 * dotScale,
    dotRadius: Math.max(0.28, 0.95 * dotScale),
  };
}

export function buildCanvasSelectionMetrics(
  selectedBounds: { left: number; right: number } | null,
  groupBounds: { left: number; right: number } | null,
) {
  return {
    selectionToolbarCenterX: selectedBounds ? (selectedBounds.left + selectedBounds.right) / 2 : null,
    groupToolbarCenterX: groupBounds ? (groupBounds.left + groupBounds.right) / 2 : null,
  };
}

export function filterCanvasNodes(nodes: NodeData[], keyword: string, includeType = false) {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return nodes;
  return nodes.filter((node) => `${node.title} ${includeType ? `${node.type} ` : ""}${node.fileName || ""}`.toLowerCase().includes(normalized));
}

export function getRootCanvasNodes(nodes: NodeData[], edges: { toNodeId: string }[]) {
  const downstream = new Set(edges.map((edge) => edge.toNodeId));
  return nodes.filter((node) => !downstream.has(node.id));
}

export function buildSidebarGroups(groups: GroupData[], nodes: NodeData[]) {
  return groups.map((group) => ({
    group,
    nodes: group.nodeIds.map((id) => nodes.find((node) => node.id === id)).filter((node): node is NodeData => Boolean(node)),
  })).filter((entry) => entry.nodes.length > 0);
}

export function filterAssetCatalogEntries(entries: AssetCatalogItem[], keyword: string) {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return entries;
  return entries.filter((asset) => `${asset.name} ${asset.description} ${asset.kind}`.toLowerCase().includes(normalized));
}

export function getWorkflowCoverCandidates(group: GroupData | null | undefined, nodes: NodeData[]) {
  if (!group) return [];
  return nodes.filter((node) => group.nodeIds.includes(node.id) && (node.type === "image" || node.type === "video") && Boolean(node.imageUrl || node.localPreviewUrl || node.videoUrl || node.localVideoUrl));
}

export function buildPendingHistoryItems(
  nodes: NodeData[],
  pendingProgressStarted: Record<string, number>,
): HistoryAssetItem[] {
  return nodes
    .filter((node) => {
      if (node.type !== "image" && node.type !== "video" && node.type !== "audio") return false;
      return Boolean(
        node.isGenerating
        || node.generationState === "submitting"
        || node.generationState === "processing"
        || node.taskStatus === "processing",
      );
    })
    .map((node) => {
      const type = node.type === "video" ? "video" : node.type === "audio" ? "audio" : "image";
      const startedAt = pendingProgressStarted[node.id] ?? Date.now();
      return {
        id: `pending-${node.id}`,
        taskId: node.taskId || node.videoGenerationAttemptId || node.imageGenerationAttemptId || node.id,
        type,
        url: "",
        model: node.model || "",
        prompt: node.prompt?.trim() || node.title || "生成中",
        createdAt: new Date(startedAt).toISOString(),
        dateGroup: "进行中",
        status: node.taskStatus,
        pending: true,
        progress: resolvePendingGenerationProgress(node, pendingProgressStarted),
        preparationStage: node.preparationStage,
        statusMessage: node.statusMessage,
      } satisfies HistoryAssetItem;
    });
}

export function filterProjectsByFolder<T extends { projectId: string }>(
  projects: T[],
  folders: Array<{ id: string; projectIds: string[] }>,
  folderId: string | null | undefined,
) {
  if (!folderId) return projects;
  const folder = folders.find((item) => item.id === folderId);
  if (!folder) return projects;
  const projectIds = new Set(folder.projectIds);
  return projects.filter((project) => projectIds.has(project.projectId));
}

export function buildPortraitAdmissionAssets(nodes: NodeData[]): PortraitAdmissionAsset[] {
  const unique = new Map<number, PortraitAdmissionAsset>();
  for (const node of nodes) {
    if (node.type !== "image" && node.type !== "video") continue;
    const assetVersionId = Number(node.assetVersionId);
    if (!Number.isSafeInteger(assetVersionId) || assetVersionId <= 0) continue;
    if (!node.imageUrl && !node.videoUrl && !node.localPreviewUrl && !node.localVideoUrl) continue;
    unique.set(assetVersionId, {
      assetVersionId,
      name: node.title || node.fileName || `参考素材 ${assetVersionId}`,
      previewUrl: node.imageUrl || node.videoUrl || node.localPreviewUrl || node.localVideoUrl,
      mediaType: node.type,
    });
  }
  return [...unique.values()];
}

export function buildTextNodeTogglePatch(node: NodeData, expanded: boolean) {
  const base = ratioToNodeDimensions(node.ratio || "1:1", "text");
  const width = expanded ? Math.max(node.width, 900) : base.width;
  const height = expanded ? Math.max(node.height, 480) : base.height;
  return {
    textExpanded: expanded,
    width,
    height,
    x: node.x + node.width / 2 - width / 2,
    y: node.y + node.height / 2 - height / 2,
  } satisfies Partial<NodeData>;
}
