// Assets API：从旧 Vue src/views/assets/index.vue 迁移。
// 资产类型枚举：role=角色(主体)、tool=道具、scene=场景、clip=素材、audio=音频。
import { ApiError, apiDelete, apiGet, apiPost, readApiSettings, readAuthToken, type ApiRequestOptions } from "./http";
import type { Asset, AssetType, Paginated } from "./types";
import {
  normalizeProjectAssetCatalog,
  PROJECT_ASSET_CATALOG_TYPES,
  type ProjectAssetCatalogItem,
} from "../features/assets/assetCatalog";

export type ListAssetsPayload = {
  projectId?: number | null;
  type?: AssetType;
  name?: string;
  page?: number;
  limit?: number;
};

export type AddAssetPayload = {
  name: string;
  describe?: string;
  remark?: string;
  type: AssetType;
  projectId: number;
  prompt?: string;
};

export type UpdateAssetPayload = {
  id: number;
  projectId: number;
  name?: string;
  describe?: string;
  remark?: string;
  prompt?: string;
};

export type AssetUsage = "role" | "scene" | "tool" | "action" | "audio" | "camera" | "style" | "composition" | "other";

export function updateAssetMetadata(payload: {
  projectId: number;
  id: number;
  usage: AssetUsage | null;
}) {
  return apiPost<{ assetIds: number[]; usage: AssetUsage | null }, typeof payload>(
    "/assets/metadata",
    payload,
  );
}

export function createAssetGroup(payload: {
  projectId: number;
  name: string;
  usage: "role" | "scene" | "tool";
  assetIds: number[];
}) {
  return apiPost<{ group: { id: string; name: string; usage: AssetUsage }; assetIds: number[] }, typeof payload>(
    "/assets/groups",
    payload,
  );
}

export type UploadClipPayload = {
  projectId: number;
  base64Data: string; // data:...;base64,....
  name: string;
};

export type AssetLibraryView = "mine" | "workspace" | "shared_with_me" | "project_refs" | "all";

export type AssetLibraryItem = Asset & {
  ownership: {
    ownerType: "user" | "workspace";
    ownerUserId: number | null;
    ownerWorkspaceId: string | null;
    revision: number;
  };
  permissions: { view: boolean; use: boolean; manage: boolean };
  authority: "owner" | "workspace_owner" | "grant" | "none";
  projectReference: {
    id: string;
    projectId?: number;
    assetId: number;
    assetVersionId: string;
    revision: number;
    createdAt: number;
    updatedAt: number;
  } | null;
};

export type AssetGrant = {
  id: string;
  assetId: number;
  workspaceId: string;
  granteeType: "workspace" | "user";
  granteeUserId: number | null;
  canView: boolean;
  canUse: boolean;
  canManage: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
};

export type AssetLibraryResponse = {
  items: AssetLibraryItem[];
  total: number;
  view: AssetLibraryView;
};

export type AssetRecommendation = {
  recommendationId: string;
  assetId: number;
  assetVersionId: string;
  name: string;
  type: string;
  score: number;
  reasons: string[];
  source: "account" | "workspace" | "shared";
  alreadyInProject: boolean;
  expectedOwnershipRevision: number;
  ruleVersion: "asset-metadata-literal-v1";
  billing: { mode: "retrieval_only"; chargeMicros: 0 };
};

export type AssetRecommendationResponse = {
  recommendations: AssetRecommendation[];
  trace: {
    projectId: number;
    ruleVersion: "asset-metadata-literal-v1";
    authorization: "filtered_before_ranking";
    billing: { mode: "retrieval_only"; chargeMicros: 0 };
  };
};

function mutationOptions(idempotencyKey: string): ApiRequestOptions {
  return { headers: { "Idempotency-Key": idempotencyKey } };
}

export function assetLibraryMutationKey(prefix: string): string {
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${id}`;
}

export function listAssetLibrary(payload: {
  view?: AssetLibraryView;
  assetIds?: number[];
  assetVersions?: Array<{ assetId: number; assetVersionId: number }>;
  projectId?: number | null;
  type?: AssetType;
  name?: string;
  page?: number;
  limit?: number;
}, options?: ApiRequestOptions): Promise<AssetLibraryResponse> {
  const query = new URLSearchParams();
  payload.assetIds?.forEach((assetId) => query.append("assetId", String(assetId)));
  payload.assetVersions?.forEach(({ assetId, assetVersionId }) => {
    query.append("assetVersion", `${assetId}:${assetVersionId}`);
  });
  if (payload.limit != null) query.set("limit", String(payload.limit));
  if (payload.name) query.set("name", payload.name);
  if (payload.page != null) query.set("page", String(payload.page));
  if (payload.projectId != null) query.set("projectId", String(payload.projectId));
  if (payload.type) query.set("type", payload.type);
  query.set("view", payload.view || "all");
  return apiGet<AssetLibraryResponse>(`/assets/library?${query.toString()}`, undefined, options);
}

export function listAssetRecommendations(payload: {
  projectId: number;
  query?: string;
  context?: string;
  limit?: number;
}, options?: ApiRequestOptions): Promise<AssetRecommendationResponse> {
  const query = new URLSearchParams({ projectId: String(payload.projectId) });
  if (payload.context) query.set("context", payload.context);
  if (payload.limit != null) query.set("limit", String(payload.limit));
  if (payload.query) query.set("query", payload.query);
  return apiGet<AssetRecommendationResponse>(
    `/assets/library/recommendations?${query.toString()}`,
    undefined,
    options,
  );
}

export function shareAsset(payload: {
  assetId: number;
  granteeType: "workspace" | "user";
  granteeUserId?: number | null;
  canView?: boolean;
  canUse?: boolean;
  canManage?: boolean;
  expectedOwnershipRevision?: number;
  idempotencyKey?: string;
}) {
  const { assetId, idempotencyKey = assetLibraryMutationKey("asset-share"), ...body } = payload;
  return apiPost<{ grant: Record<string, unknown> }, typeof body>(
    `/assets/library/${assetId}/grants`,
    body,
    readApiSettings(),
    mutationOptions(idempotencyKey),
  );
}

export function listAssetShares(payload: {
  assetId: number;
  includeRevoked?: boolean;
}, options?: ApiRequestOptions) {
  const query = payload.includeRevoked ? "?includeRevoked=true" : "";
  return apiGet<{ grants: AssetGrant[] }>(
    `/assets/library/${payload.assetId}/grants${query}`,
    undefined,
    options,
  );
}

export function revokeAssetShare(payload: {
  assetId: number;
  grantId: string;
  expectedRevision?: number;
  idempotencyKey?: string;
}) {
  const query = payload.expectedRevision == null
    ? ""
    : `?expectedRevision=${encodeURIComponent(String(payload.expectedRevision))}`;
  return apiDelete<{ grant: Record<string, unknown> }>(
    `/assets/library/${payload.assetId}/grants/${encodeURIComponent(payload.grantId)}${query}`,
    readApiSettings(),
    mutationOptions(payload.idempotencyKey || assetLibraryMutationKey("asset-share-revoke")),
  );
}

export function addAssetToProject(payload: {
  projectId: number;
  assetId: number;
  assetVersionId?: string | null;
  expectedOwnershipRevision?: number;
  idempotencyKey?: string;
}) {
  return apiPost<{
    ref: Record<string, unknown>;
  }, {
    assetId: number;
    assetVersionId?: string | null;
    expectedOwnershipRevision?: number;
  }>(
    `/assets/library/projects/${payload.projectId}/refs`,
    {
      assetId: payload.assetId,
      ...(payload.assetVersionId ? { assetVersionId: payload.assetVersionId } : {}),
      ...(payload.expectedOwnershipRevision == null
        ? {}
        : { expectedOwnershipRevision: payload.expectedOwnershipRevision }),
    },
    readApiSettings(),
    mutationOptions(payload.idempotencyKey || assetLibraryMutationKey("project-asset-ref")),
  );
}

export function removeAssetFromProject(payload: {
  projectId: number;
  refId: string;
  expectedRevision?: number;
  idempotencyKey?: string;
}) {
  const query = payload.expectedRevision == null
    ? ""
    : `?expectedRevision=${encodeURIComponent(String(payload.expectedRevision))}`;
  return apiDelete<{ ref: Record<string, unknown> }>(
    `/assets/library/projects/${payload.projectId}/refs/${encodeURIComponent(payload.refId)}${query}`,
    readApiSettings(),
    mutationOptions(payload.idempotencyKey || assetLibraryMutationKey("project-asset-ref-remove")),
  );
}

export function transferAssetToWorkspace(payload: {
  assetId: number;
  expectedRevision: number;
  idempotencyKey?: string;
}) {
  return apiPost<{
    ownership: AssetLibraryItem["ownership"];
  }, {
    expectedRevision: number;
  }>(
    `/assets/library/${payload.assetId}/transfer-to-workspace`,
    { expectedRevision: payload.expectedRevision },
    readApiSettings(),
    mutationOptions(payload.idempotencyKey || assetLibraryMutationKey("asset-transfer-workspace")),
  );
}

/** GET /assets/getAssetsApi → { data: Asset[], total }。 */
export function listAssets(
  payload: ListAssetsPayload,
  options?: ApiRequestOptions,
): Promise<Paginated<Asset>> {
  const query = new URLSearchParams();
  // Keep the raw browser URL byte-identical to the signed-read registry's
  // canonical alphabetical query projection.
  if (payload.limit != null) query.set("limit", String(payload.limit));
  if (payload.name) query.set("name", payload.name);
  if (payload.page != null) query.set("page", String(payload.page));
  if (payload.projectId != null) query.set("projectId", String(payload.projectId));
  if (payload.type) query.set("type", payload.type);
  return apiGet<Paginated<Asset>>(
    `/assets/getAssetsApi?${query.toString()}`,
    undefined,
    options,
  );
}

export type ListProjectAssetCatalogPayload = {
  projectId: number;
  types?: readonly AssetType[];
  name?: string;
  pageSize?: number;
  /** Defensive request bound for a corrupt/non-advancing legacy paginator. */
  maxPagesPerType?: number;
};

export type ProjectAssetCatalogResponse = {
  projectId: number;
  items: ProjectAssetCatalogItem[];
  assets: Asset[];
};

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Loads the authorized project references used by both Agent and Canvas.
 * A result can belong to another source project while being referenced here.
 */
export async function listProjectAssetCatalog(
  payload: ListProjectAssetCatalogPayload,
  options?: ApiRequestOptions,
): Promise<ProjectAssetCatalogResponse> {
  const projectId = positiveInteger(payload.projectId);
  if (projectId === null) throw new Error("无效的项目 ID，无法读取资产目录");
  const projectAssetCatalogTypes = new Set<AssetType>(PROJECT_ASSET_CATALOG_TYPES);
  const requestedTypes = payload.types?.length
    ? [...new Set(payload.types)].filter((type) => projectAssetCatalogTypes.has(type))
    : [...PROJECT_ASSET_CATALOG_TYPES];
  const pageSize = Math.min(200, Math.max(1, positiveInteger(payload.pageSize) ?? 100));
  const maxPages = Math.min(1000, Math.max(1, positiveInteger(payload.maxPagesPerType) ?? 100));

  const rows: AssetLibraryItem[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await listAssetLibrary({
      view: "project_refs", projectId, name: payload.name, page, limit: pageSize,
    }, options);
    const current = Array.isArray(response?.items) ? response.items : [];
    rows.push(...current);
    if (current.length < pageSize || rows.length >= Number(response.total)) break;
    if (page === maxPages) throw new Error("项目素材目录超出读取上限，请缩小范围");
  }

  const scoped = rows.filter((asset) => Number(asset.projectReference?.projectId) === projectId
    && asset.permissions.use && requestedTypes.includes(asset.type));
  // The asset head can advance after it was added to the project. Resolve the
  // pinned version explicitly instead of silently substituting its latest image.
  const stale = scoped.filter((asset) => /^image:\d+$/.test(asset.projectReference!.assetVersionId)
    && Number(asset.projectReference!.assetVersionId.slice(6)) !== Number(asset.imageId));
  const exact = new Map<number, AssetLibraryItem>();
  for (let index = 0; index < stale.length; index += 8) {
    const response = await listAssetLibrary({
      view: "project_refs", projectId,
      assetVersions: stale.slice(index, index + 8).map((asset) => ({
        assetId: asset.id, assetVersionId: Number(asset.projectReference!.assetVersionId.slice(6)),
      })),
    }, options);
    response.items.forEach((asset) => exact.set(asset.id, asset));
  }
  const staleIds = new Set(stale.map((asset) => asset.id));
  const resolved = scoped.flatMap((asset) => {
    if (!staleIds.has(asset.id)) return [asset];
    const pinned = exact.get(asset.id);
    return pinned && Number(pinned.imageId) === Number(asset.projectReference!.assetVersionId.slice(6))
      ? [{ ...pinned, projectReference: asset.projectReference }] : [];
  });

  const items = normalizeProjectAssetCatalog(projectId, resolved);
  return { projectId, items, assets: items.map((item) => item.raw) };
}


export type ReferenceAssetFile = {
  blob: Blob;
  contentType: string;
};

/**
 * Reads a user-uploaded reference through the authenticated, workspace-scoped
 * API. The raw object-storage path must never be used by browser media or
 * download elements because native navigation cannot attach the bearer token.
 */
export async function getReferenceAssetFile(
  assetId: number,
  disposition: "inline" | "attachment",
  options?: ApiRequestOptions,
): Promise<ReferenceAssetFile> {
  if (!Number.isSafeInteger(assetId) || assetId < 1) throw new Error("无效的云存储资产 ID");
  const settings = readApiSettings();
  const token = settings.token.trim() || readAuthToken();
  const query = new URLSearchParams({ id: String(assetId), disposition });
  const response = await fetch(`${settings.baseUrl}/assets/getReferenceFile?${query.toString()}`, {
    method: "GET",
    credentials: "same-origin",
    signal: options?.signal,
    headers: {
      ...(token ? { Authorization: token } : {}),
      ...(options?.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body?.message || `云存储文件读取失败：${response.status}`, {
      status: response.status,
      code: typeof body?.code === "string" ? body.code : undefined,
      requestId: response.headers.get("X-Request-Id") || undefined,
    });
  }
  return {
    blob: await response.blob(),
    contentType: response.headers.get("Content-Type") || "application/octet-stream",
  };
}

/** POST /assets/addAssets → 新增角色/道具/场景（文本型资产）。 */
export function addAsset(payload: AddAssetPayload): Promise<Asset> {
  return apiPost<Asset, AddAssetPayload>("/assets/addAssets", payload);
}

/** POST /assets/updateAssets。 */
export function updateAsset(payload: UpdateAssetPayload): Promise<unknown> {
  return apiPost<unknown, UpdateAssetPayload>("/assets/updateAssets", payload);
}

/** POST /assets/uploadClip → 上传素材（base64 JSON，非 multipart）。 */
export function uploadClip(payload: UploadClipPayload): Promise<Asset> {
  return apiPost<Asset, UploadClipPayload>("/assets/uploadClip", payload);
}

/** POST /assets/delAssets。 */
export function deleteAsset(id: number): Promise<unknown> {
  return apiPost<unknown, { id: number }>("/assets/delAssets", { id });
}
