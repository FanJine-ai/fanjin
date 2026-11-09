import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";

export type CanvasAssetType = "snapshot" | "portrait";

export type CanvasAssetSnapshot = {
  nodes: unknown[];
  edges: unknown[];
  bounds: unknown;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
};

export type CanvasAssetPatch = {
  name?: string;
  saveLocation?: string;
  tag?: string;
  coverUrl?: string;
  assetType?: CanvasAssetType;
  referenceAssetUri?: string | null;
  snapshot?: CanvasAssetSnapshot;
};

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function canonicalSnapshot(input: {
  snapshot: unknown;
  projectId: number;
  assetType: CanvasAssetType;
  referenceAssetUri?: string | null;
}): CanvasAssetSnapshot {
  const raw = parseObject(input.snapshot);
  const rawMeta = parseObject(raw.meta);
  const safeMeta = { ...rawMeta };
  delete safeMeta.projectId;
  delete safeMeta.assetType;
  delete safeMeta.referenceAssetUri;
  const referenceAssetUri = String(input.referenceAssetUri || "").trim();
  return {
    ...raw,
    nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
    edges: Array.isArray(raw.edges) ? raw.edges : [],
    bounds: raw.bounds ?? { left: 0, top: 0, right: 0, bottom: 0 },
    meta: {
      ...safeMeta,
      projectId: input.projectId,
      assetType: input.assetType,
      ...(referenceAssetUri ? { referenceAssetUri } : {}),
    },
  };
}

function isoTime(value: unknown): string {
  const timestamp = Number(value || 0);
  return new Date(Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now()).toISOString();
}

function canvasAssetRow(row: any) {
  return {
    id: String(row.id),
    userId: String(row.createdBy),
    projectId: Number(row.projectId),
    name: String(row.name || "未命名资产"),
    saveLocation: String(row.saveLocation || ""),
    tag: String(row.tag || ""),
    coverUrl: String(row.coverUrl || ""),
    assetType: row.assetType === "portrait" ? "portrait" as const : "snapshot" as const,
    ...(row.referenceAssetUri ? { referenceAssetUri: String(row.referenceAssetUri) } : {}),
    createdAt: isoTime(row.createdAt),
    updatedAt: isoTime(row.updatedAt),
    snapshot: canonicalSnapshot({
      snapshot: row.snapshot,
      projectId: Number(row.projectId),
      assetType: row.assetType === "portrait" ? "portrait" : "snapshot",
      referenceAssetUri: row.referenceAssetUri,
    }),
  };
}

export async function listCanvasAssets(input: { workspaceId: string; projectId: number }) {
  const rows = await db("o_canvas_asset")
    .where({ workspaceId: input.workspaceId, projectId: input.projectId })
    .orderBy([{ column: "updatedAt", order: "desc" }, { column: "id", order: "desc" }]);
  return rows.map(canvasAssetRow);
}

export async function getCanvasAsset(input: {
  id: string;
  workspaceId: string;
  projectId: number;
}) {
  const row = await db("o_canvas_asset")
    .where({
      id: input.id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
    })
    .first();
  return row ? canvasAssetRow(row) : null;
}

export async function createCanvasAsset(input: {
  workspaceId: string;
  projectId: number;
  actorUserId: number;
  name: string;
  saveLocation?: string;
  tag?: string;
  coverUrl?: string;
  assetType?: CanvasAssetType;
  referenceAssetUri?: string | null;
  nodes: unknown[];
  edges?: unknown[];
  bounds?: unknown;
}) {
  const id = uuid();
  const now = Date.now();
  const assetType = input.assetType || "snapshot";
  const snapshot = canonicalSnapshot({
    snapshot: {
      nodes: input.nodes,
      edges: input.edges || [],
      bounds: input.bounds ?? { left: 0, top: 0, right: 0, bottom: 0 },
    },
    projectId: input.projectId,
    assetType,
    referenceAssetUri: input.referenceAssetUri,
  });
  await db("o_canvas_asset").insert({
    id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    createdBy: input.actorUserId,
    name: input.name,
    saveLocation: input.saveLocation || "",
    tag: input.tag || "",
    coverUrl: input.coverUrl || "",
    assetType,
    referenceAssetUri: input.referenceAssetUri || null,
    snapshot: JSON.stringify(snapshot),
    createdAt: now,
    updatedAt: now,
  });
  const row = await db("o_canvas_asset")
    .where({ id, workspaceId: input.workspaceId, projectId: input.projectId })
    .first();
  return canvasAssetRow(row);
}

export async function updateCanvasAsset(input: {
  id: string;
  workspaceId: string;
  projectId: number;
  patch: CanvasAssetPatch;
}) {
  const current = await db("o_canvas_asset")
    .where({ id: input.id, workspaceId: input.workspaceId, projectId: input.projectId })
    .first();
  if (!current) return null;

  const assetType = input.patch.assetType
    ?? (current.assetType === "portrait" ? "portrait" : "snapshot");
  const referenceAssetUri = input.patch.referenceAssetUri !== undefined
    ? input.patch.referenceAssetUri
    : current.referenceAssetUri;
  const snapshot = canonicalSnapshot({
    snapshot: input.patch.snapshot ?? current.snapshot,
    projectId: input.projectId,
    assetType,
    referenceAssetUri,
  });
  const update: Record<string, unknown> = {
    assetType,
    referenceAssetUri: referenceAssetUri || null,
    snapshot: JSON.stringify(snapshot),
    updatedAt: Date.now(),
  };
  for (const field of ["name", "saveLocation", "tag", "coverUrl"] as const) {
    if (input.patch[field] !== undefined) update[field] = input.patch[field];
  }

  await db("o_canvas_asset")
    .where({ id: input.id, workspaceId: input.workspaceId, projectId: input.projectId })
    .update(update);
  const row = await db("o_canvas_asset")
    .where({ id: input.id, workspaceId: input.workspaceId, projectId: input.projectId })
    .first();
  return row ? canvasAssetRow(row) : null;
}
