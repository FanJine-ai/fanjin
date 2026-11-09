import type { CreationSessionDto } from "../../features/quick-create/session/api";
import type { QuickCreateDraftPayload } from "../../features/quick-create/session/sessionDraftOutbox";
import type {
  QuickCreateDirectorPlan,
  QuickCreateImageAsset,
  QuickCreateImageQuality,
  QuickCreateMaterializedProject,
  QuickCreateRatio,
} from "../../features/quick-create/types";

export const QUICK_CREATE_ROUTED_IMAGE_ASSET_LIMIT = 8;

export type RoutedImageAssetIdentity = {
  assetId: number;
  assetVersionId: number;
};

type RecoverableImageLibraryAsset = {
  id: number;
  imageId?: number | null;
  src?: string | null;
  type: string;
  prompt?: string | null;
  startTime?: number | string | null;
};

export function routedImageAssetIdentities(
  params: Pick<URLSearchParams, "getAll">,
): RoutedImageAssetIdentity[] {
  const result: RoutedImageAssetIdentity[] = [];
  const seen = new Set<string>();
  for (const value of params.getAll("asset").flatMap((entry) => entry.split(","))) {
    const match = /^(\d+):(\d+)$/.exec(value.trim());
    if (!match) continue;
    const assetId = Number(match[1]);
    const assetVersionId = Number(match[2]);
    const key = `${assetId}:${assetVersionId}`;
    if (
      !Number.isSafeInteger(assetId)
      || assetId <= 0
      || !Number.isSafeInteger(assetVersionId)
      || assetVersionId <= 0
      || seen.has(key)
    ) continue;
    seen.add(key);
    result.push({ assetId, assetVersionId });
    if (result.length === QUICK_CREATE_ROUTED_IMAGE_ASSET_LIMIT) break;
  }
  return result;
}

export function buildRoutedImageGenerationSearch(input: {
  assets: QuickCreateImageAsset[];
  model?: string;
  ratio?: string;
  quality?: string;
  count?: number;
}): string {
  const params = new URLSearchParams({ generation: "image" });
  if (!input.assets.length || input.assets.length > QUICK_CREATE_ROUTED_IMAGE_ASSET_LIMIT) {
    throw new Error("图片生成结果数量无效，无法创建可恢复链接");
  }
  const identities = input.assets.map((asset) => {
    const assetId = Number(asset.assetId);
    const assetVersionId = Number(asset.assetVersionId);
    if (
      !Number.isSafeInteger(assetId)
      || assetId <= 0
      || !Number.isSafeInteger(assetVersionId)
      || assetVersionId <= 0
    ) {
      throw new Error("图片尚未完成资产入库，无法创建可恢复链接");
    }
    return { assetId, assetVersionId };
  });
  const uniqueIdentities = new Map(identities.map((identity) => [
    `${identity.assetId}:${identity.assetVersionId}`,
    identity,
  ]));
  if (uniqueIdentities.size !== input.assets.length) {
    throw new Error("图片生成结果包含重复资产版本，无法创建可恢复链接");
  }
  for (const identity of uniqueIdentities.values()) {
    params.append("asset", `${identity.assetId}:${identity.assetVersionId}`);
  }
  if (input.model?.trim()) params.set("model", input.model.trim());
  if (isQuickCreateRatio(input.ratio)) params.set("ratio", input.ratio);
  if (isImageQuality(input.quality)) params.set("quality", input.quality);
  params.set("count", String(uniqueIdentities.size));
  return params.toString();
}

export function recoveredImageAssetsFromLibrary(
  items: RecoverableImageLibraryAsset[],
  requestedIdentities: readonly RoutedImageAssetIdentity[],
  model?: string,
): QuickCreateImageAsset[] {
  const byIdentity = new Map(items.map((item) => [
    `${Number(item.id)}:${Number(item.imageId)}`,
    item,
  ]));
  const recovered = requestedIdentities.flatMap(({ assetId, assetVersionId }) => {
    const item = byIdentity.get(`${assetId}:${assetVersionId}`);
    const url = typeof item?.src === "string" ? item.src.trim() : "";
    if (
      !item
      || item.type !== "image"
      || !url
      || /^(?:blob|data):/i.test(url)
    ) return [];
    const createdAt = Number(item.startTime);
    return [{
      id: `asset-library:${assetId}:${assetVersionId}`,
      assetId,
      assetVersionId,
      taskId: `recovered-image:${assetId}`,
      url,
      assetType: "image",
      ...(model?.trim() ? { model: model.trim() } : {}),
      ...(typeof item.prompt === "string" && item.prompt.trim()
        ? { prompt: item.prompt.trim() }
        : {}),
      ...(Number.isFinite(createdAt) && createdAt > 0 ? { createdAt } : {}),
    }];
  });
  if (recovered.length !== requestedIdentities.length) {
    throw new Error("部分图片已删除、版本已变化或当前账号无权查看，请从资产库确认结果");
  }
  return recovered;
}

export function isCreationSessionConflict(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
  return code === "creation_session_conflict_refreshed"
    || code === "creation_session_conflict_pending_recovery"
    || code === "creation_session_conflict_refresh_failed";
}

export function sessionDraftPayload(session: CreationSessionDto): QuickCreateDraftPayload {
  return {
    goal: session.goal,
    mode: "quick_create",
    parameters: session.parameters ?? {},
    selectedAssetVersionIds: session.selectedAssetVersionIds,
  };
}

export function nullableSessionObjectParameter(
  key: "directorPlan" | "structuredTimeline" | "materializedProject",
  value: unknown,
  persistedParameters: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (value !== null) return { [key]: value };
  return Object.prototype.hasOwnProperty.call(persistedParameters ?? {}, key)
    ? { [key]: null }
    : {};
}

export function quickCreateSessionKey(scope: string | null, projectId: number, sessionId: string) {
  return `${scope || "unscoped"}:${projectId}:${sessionId}`;
}

export function isQuickCreateRatio(value: unknown): value is QuickCreateRatio {
  return value === "adaptive" || (typeof value === "string" && /^\d{1,3}:\d{1,3}$/.test(value));
}

export function isImageQuality(value: unknown): value is QuickCreateImageQuality {
  return value === "1K" || value === "2K" || value === "4K";
}

export function isDirectorPlan(value: unknown): value is QuickCreateDirectorPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<QuickCreateDirectorPlan>;
  return typeof plan.title === "string"
    && typeof plan.simpleScript === "string"
    && typeof plan.stylePrompt === "string"
    && isQuickCreateRatio(plan.ratio)
    && typeof plan.duration === "number"
    && Array.isArray(plan.shots);
}

export function isMaterializedProject(value: unknown): value is QuickCreateMaterializedProject {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<QuickCreateMaterializedProject>;
  return Boolean(
    candidate.project
    && Number.isInteger(Number(candidate.project.id))
    && candidate.script
    && Number.isInteger(Number(candidate.script.id))
    && Array.isArray(candidate.shots),
  );
}

export function restoredImageAssets(value: unknown): QuickCreateImageAsset[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is QuickCreateImageAsset => {
    if (!item || typeof item !== "object") return false;
    const asset = item as Partial<QuickCreateImageAsset>;
    return typeof asset.id === "string"
      && Boolean(asset.id.trim())
      && typeof asset.taskId === "string"
      && Boolean(asset.taskId.trim())
      && typeof asset.url === "string"
      && Boolean(asset.url.trim())
      && !/^(?:blob|data):/i.test(asset.url)
      && typeof asset.assetType === "string"
      && Boolean(asset.assetType.trim());
  });
}
