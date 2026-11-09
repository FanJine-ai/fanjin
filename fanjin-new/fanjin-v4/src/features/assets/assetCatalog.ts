import type { Asset, AssetType } from "../../api/types";

/**
 * Canonical project asset catalog contract.
 *
 * `project-asset` entries are backed by a real `o_assets.id` and may be sent
 * to Agent Runtime. `canvas-snapshot` entries deliberately do not expose an
 * `assetId`: a canvas snapshot is a reusable layout, not an `o_assets` row.
 */
export const PROJECT_ASSET_CATALOG_TYPES = [
  "role",
  "scene",
  "tool",
  "clip",
  "audio",
  "image",
  "video",
] as const satisfies readonly AssetType[];

export type AssetCatalogMediaKind = "image" | "video" | "audio" | "entity" | "unknown";

export type AssetCatalogCapabilities = {
  canvas: true;
  agent: boolean;
  agentUnsupportedReason?: string;
};

type AssetCatalogCommon = {
  catalogId: string;
  projectId: number;
  name: string;
  description: string;
  previewUrl: string | null;
  createdAt: number | null;
  capabilities: AssetCatalogCapabilities;
};

export type ProjectAssetCatalogItem = AssetCatalogCommon & {
  source: "project-asset";
  kind: AssetType;
  mediaKind: AssetCatalogMediaKind;
  /** Real, positive `o_assets.id`. */
  assetId: number;
  /** Current `o_image.id`, when one is selected on the asset. */
  assetVersionId: number | null;
  raw: Asset;
};

export type CanvasSnapshotCatalogKind = "canvas-snapshot" | "canvas-portrait";

export type CanvasSnapshotCatalogItem = AssetCatalogCommon & {
  source: "canvas-snapshot";
  kind: CanvasSnapshotCatalogKind;
  mediaKind: "entity";
  /** Canvas-owned opaque identifier. It must never be submitted as assetId. */
  snapshotId: string;
  referenceAssetUri: string | null;
  snapshot: {
    nodes: unknown[];
    edges: unknown[];
    bounds: unknown;
  };
};

export type AssetCatalogItem = ProjectAssetCatalogItem | CanvasSnapshotCatalogItem;

export type AgentAssetReference = {
  assetId: number;
  assetVersionId?: number;
};

export type CanvasSnapshotCatalogInput = {
  id?: unknown;
  projectId?: unknown;
  name?: unknown;
  tag?: unknown;
  coverUrl?: unknown;
  assetType?: unknown;
  referenceAssetUri?: unknown;
  createdAt?: unknown;
  snapshot?: unknown;
};

const projectAssetTypes = new Set<string>(PROJECT_ASSET_CATALOG_TYPES);

function positiveSafeInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Display URLs may be signed absolute URLs or same-origin `/oss/...` URLs. */
export function normalizeAssetPreviewUrl(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  if (/^(?:javascript|data|blob):/i.test(candidate)) return null;
  if (/^https?:\/\//i.test(candidate) || candidate.startsWith("/")) return candidate;
  return null;
}

function scopedChildAssets(asset: Asset, projectId: number): Asset[] {
  return (Array.isArray(asset.sonAssets) ? asset.sonAssets : []).filter(
    (child) => positiveSafeInteger(child.projectId) === projectId,
  );
}

function previewUrlForAsset(asset: Asset, projectId: number): string | null {
  const direct = normalizeAssetPreviewUrl(asset.src);
  if (direct) return direct;
  for (const child of scopedChildAssets(asset, projectId)) {
    const childPreview = normalizeAssetPreviewUrl(child.src);
    if (childPreview) return childPreview;
  }
  // `filePath` is an internal OSS key, not a browser-safe or authorized URL.
  return null;
}

function mediaKindForAsset(asset: Asset, previewUrl: string | null): AssetCatalogMediaKind {
  if (asset.type === "audio") return "audio";
  if (asset.type === "video") return "video";
  if (asset.type === "image") return "image";
  if (asset.type === "role" || asset.type === "scene" || asset.type === "tool") {
    return previewUrl ? "image" : "entity";
  }
  const mediaUrl = previewUrl?.split(/[?#]/, 1)[0].toLowerCase() || "";
  if (/\.(?:mp4|mov|webm|m4v)$/.test(mediaUrl)) return "video";
  if (/\.(?:mp3|wav|m4a|aac|ogg|flac)$/.test(mediaUrl)) return "audio";
  if (/\.(?:png|jpe?g|webp|gif|avif|bmp)$/.test(mediaUrl)) return "image";
  return "unknown";
}

function assetDescription(asset: Asset): string {
  return text(asset.describe) || text(asset.prompt) || text(asset.remark) || "项目资产";
}

function projectAssetScore(item: ProjectAssetCatalogItem): number {
  return (item.previewUrl ? 8 : 0)
    + (item.assetVersionId ? 4 : 0)
    + (item.description !== "项目资产" ? 2 : 0)
    + scopedChildAssets(item.raw, item.projectId).length;
}

function mergeDuplicateProjectAsset(
  previous: ProjectAssetCatalogItem,
  candidate: ProjectAssetCatalogItem,
): ProjectAssetCatalogItem {
  const primary = projectAssetScore(candidate) > projectAssetScore(previous) ? candidate : previous;
  const secondary = primary === candidate ? previous : candidate;
  return {
    ...primary,
    name: primary.name || secondary.name,
    description: primary.description !== "项目资产" ? primary.description : secondary.description,
    previewUrl: primary.previewUrl || secondary.previewUrl,
    assetVersionId: primary.assetVersionId || secondary.assetVersionId,
  };
}

export function normalizeProjectAssetCatalog(
  projectIdInput: unknown,
  assets: readonly Asset[],
): ProjectAssetCatalogItem[] {
  const projectId = positiveSafeInteger(projectIdInput);
  if (projectId === null) throw new Error("无效的项目 ID，无法读取资产目录");

  const deduped = new Map<number, ProjectAssetCatalogItem>();
  for (const asset of assets) {
    const assetId = positiveSafeInteger(asset?.id);
    const ownerProjectId = positiveSafeInteger(asset?.projectId);
    const reference = record((asset as Asset & { projectReference?: unknown }).projectReference);
    const hasProjectReference = positiveSafeInteger(reference.projectId) === projectId
      && positiveSafeInteger(reference.assetId) === assetId;
    if (
      assetId === null
      || (ownerProjectId !== projectId && !hasProjectReference)
      || !projectAssetTypes.has(String(asset?.type))
    ) continue;

    const previewUrl = previewUrlForAsset(asset, projectId);
    const item: ProjectAssetCatalogItem = {
      catalogId: `project-asset:${projectId}:${assetId}`,
      source: "project-asset",
      projectId,
      kind: asset.type,
      mediaKind: mediaKindForAsset(asset, previewUrl),
      assetId,
      assetVersionId: positiveSafeInteger(asset.imageId),
      name: text(asset.name) || `资产 ${assetId}`,
      description: assetDescription(asset),
      previewUrl,
      createdAt: timestamp(asset.startTime),
      capabilities: { agent: true, canvas: true },
      raw: asset,
    };
    const previous = deduped.get(assetId);
    deduped.set(assetId, previous ? mergeDuplicateProjectAsset(previous, item) : item);
  }

  return [...deduped.values()];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Converts project-scoped canvas snapshots into canvas-only catalog items.
 * Old snapshots without an explicit projectId are intentionally excluded;
 * assigning the currently open project on the client would break isolation.
 */
export function normalizeCanvasSnapshotCatalog(
  projectIdInput: unknown,
  snapshots: readonly CanvasSnapshotCatalogInput[],
): CanvasSnapshotCatalogItem[] {
  const projectId = positiveSafeInteger(projectIdInput);
  if (projectId === null) throw new Error("无效的项目 ID，无法读取画布资产");

  const deduped = new Map<string, CanvasSnapshotCatalogItem>();
  for (const input of snapshots) {
    const snapshot = record(input.snapshot);
    const meta = record(snapshot.meta);
    const ownerProjectId = positiveSafeInteger(input.projectId ?? meta.projectId);
    const snapshotId = text(input.id);
    if (ownerProjectId !== projectId || !snapshotId) continue;

    const isPortrait = input.assetType === "portrait" || meta.assetType === "portrait";
    const item: CanvasSnapshotCatalogItem = {
      catalogId: `canvas-snapshot:${projectId}:${snapshotId}`,
      source: "canvas-snapshot",
      projectId,
      kind: isPortrait ? "canvas-portrait" : "canvas-snapshot",
      mediaKind: "entity",
      snapshotId,
      name: text(input.name) || "未命名画布资产",
      description: text(input.tag) || (isPortrait ? "画布人物资产" : "画布节点快照"),
      previewUrl: normalizeAssetPreviewUrl(input.coverUrl),
      referenceAssetUri: text(input.referenceAssetUri) || text(meta.referenceAssetUri) || null,
      createdAt: timestamp(input.createdAt),
      capabilities: {
        agent: false,
        canvas: true,
        agentUnsupportedReason: "画布快照尚未写入项目资产库，不能作为 Agent assetId 提交",
      },
      snapshot: {
        nodes: Array.isArray(snapshot.nodes) ? snapshot.nodes : [],
        edges: Array.isArray(snapshot.edges) ? snapshot.edges : [],
        bounds: snapshot.bounds ?? null,
      },
    };
    if (!deduped.has(snapshotId)) deduped.set(snapshotId, item);
  }
  return [...deduped.values()];
}

export function mergeProjectAssetCatalog(
  projectIdInput: unknown,
  projectAssets: readonly Asset[],
  canvasSnapshots: readonly CanvasSnapshotCatalogInput[] = [],
): AssetCatalogItem[] {
  return [
    ...normalizeProjectAssetCatalog(projectIdInput, projectAssets),
    ...normalizeCanvasSnapshotCatalog(projectIdInput, canvasSnapshots),
  ];
}

/** The only supported conversion into Agent Runtime's numeric asset contract. */
export function toAgentAssetReference(
  item: AssetCatalogItem,
  expectedProjectId: unknown = item.projectId,
): AgentAssetReference | null {
  const projectId = positiveSafeInteger(expectedProjectId);
  if (
    projectId === null
    || item.projectId !== projectId
    || item.source !== "project-asset"
    || !item.capabilities.agent
  ) return null;
  return {
    assetId: item.assetId,
    ...(item.assetVersionId ? { assetVersionId: item.assetVersionId } : {}),
  };
}
