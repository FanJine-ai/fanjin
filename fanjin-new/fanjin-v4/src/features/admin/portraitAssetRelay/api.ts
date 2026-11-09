import { apiPost } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";
import type {
  PortraitAssetAction,
  PortraitAssetRow,
  PortraitGroupRow,
  PortraitRelayActionInput,
  PortraitRelayResponse,
  PortraitRelaySnapshot,
  PortraitRelayTime,
} from "./types";

const PORTRAIT_ASSET_RELAY_VERSION = "2024-01-01";
const PAGE_SIZE = 100;
const MAX_LIST_PAGES = 100;

const queryActions = new Set<PortraitAssetAction>([
  "GetAssetGroup",
  "ListAssetGroups",
  "GetAsset",
  "ListAssets",
]);

const livenessActions = new Set<PortraitAssetAction>([
  "CreateVisualValidateSession",
  "GetVisualValidateResult",
]);

function requiredWorkspaceId(value: string): string {
  const workspaceId = value.trim();
  if (!workspaceId) throw new Error("必须指定工作区 ID");
  return workspaceId;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function timeOrNull(value: unknown): PortraitRelayTime {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return stringOrNull(value);
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function resultItems(
  action: "ListAssetGroups" | "ListAssets",
  response: PortraitRelayResponse,
): Record<string, unknown>[] {
  const resultKeys = action === "ListAssetGroups"
    ? ["Items", "AssetGroups", "AssetGroupInfos"]
    : ["Items", "Assets", "AssetInfos", "Data"];
  for (const key of resultKeys) {
    const items = response.Result?.[key];
    if (Array.isArray(items)) {
      const records = items
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => item !== null);
      if (records.length > 0) return records;
    }
  }
  return [];
}

async function listAll(
  action: "ListAssetGroups" | "ListAssets",
  workspaceId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  for (let pageNumber = 1; pageNumber <= MAX_LIST_PAGES; pageNumber += 1) {
    const response = await runPortraitAssetAction({
      Action: action,
      Body: {
        PageNumber: pageNumber,
        PageSize: PAGE_SIZE,
        SortBy: "UpdateTime",
        SortOrder: "Desc",
      },
      workspaceId,
      signal,
    });
    const pageItems = resultItems(action, response);
    items.push(...pageItems);
    const totalCount = finiteCount(response.Result?.TotalCount);
    if (pageItems.length < PAGE_SIZE || (totalCount !== null && items.length >= totalCount)) {
      return items;
    }
  }
  throw new Error(`上游列表超过 ${PAGE_SIZE * MAX_LIST_PAGES} 条，请缩小资产范围后重试`);
}

function mapGroup(item: Record<string, unknown>, workspaceId: string): PortraitGroupRow | null {
  const upstreamGroupId = stringOrNull(item.Id);
  if (!upstreamGroupId) return null;
  return {
    id: upstreamGroupId,
    workspaceId,
    upstreamGroupId,
    groupType: stringOrNull(item.GroupType) || "Unknown",
    name: stringOrNull(item.Name),
    description: stringOrNull(item.Description),
    projectName: stringOrNull(item.ProjectName),
    createTime: timeOrNull(item.CreateTime),
    updateTime: timeOrNull(item.UpdateTime),
  };
}

function mapAsset(item: Record<string, unknown>, workspaceId: string): PortraitAssetRow | null {
  const upstreamAssetId = stringOrNull(item.Id);
  if (!upstreamAssetId) return null;
  const error = asRecord(item.Error);
  return {
    id: upstreamAssetId,
    workspaceId,
    groupId: stringOrNull(item.GroupId) || "",
    upstreamAssetId,
    assetType: stringOrNull(item.AssetType) || "Unknown",
    name: stringOrNull(item.Name),
    upstreamStatus: stringOrNull(item.Status),
    errorMessage: stringOrNull(error?.Message),
    projectName: stringOrNull(item.ProjectName),
    createTime: timeOrNull(item.CreateTime),
    updateTime: timeOrNull(item.UpdateTime),
  };
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `portrait-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

export async function runPortraitAssetAction(
  input: PortraitRelayActionInput,
): Promise<PortraitRelayResponse> {
  const workspaceId = requiredWorkspaceId(input.workspaceId);
  const payload = {
    Action: input.Action,
    Body: input.Body,
    Version: PORTRAIT_ASSET_RELAY_VERSION,
    workspaceId,
    ...(input.consentConfirmed === undefined
      ? {}
      : { consentConfirmed: input.consentConfirmed }),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  };

  if (queryActions.has(input.Action)) {
    return apiPost<PortraitRelayResponse>(
      "/admin/portraitAssetRelay/query",
      payload,
      undefined,
      { signal: input.signal },
    );
  }

  if (livenessActions.has(input.Action)) {
    return apiPostWithStepUp<PortraitRelayResponse>(
      "/admin/portraitAssetRelay/liveness",
      payload,
      "admin.portrait_asset_relay",
      input.Action === "CreateVisualValidateSession"
        ? "创建火山真人认证会话"
        : "查询火山真人认证结果",
      undefined,
      { signal: input.signal },
    );
  }

  if (!input.idempotencyKey) throw new Error("写操作缺少幂等键");
  return apiPostWithStepUp<PortraitRelayResponse>(
    "/admin/portraitAssetRelay/action",
    payload,
    "admin.portrait_asset_relay",
    `操作火山人像资产：${input.Action}`,
    undefined,
    { signal: input.signal },
  );
}

export async function listPortraitAssets(
  workspaceValue: string,
  signal?: AbortSignal,
): Promise<PortraitRelaySnapshot> {
  const workspaceId = requiredWorkspaceId(workspaceValue);
  const [rawGroups, rawAssets] = await Promise.all([
    listAll("ListAssetGroups", workspaceId, signal),
    listAll("ListAssets", workspaceId, signal),
  ]);
  const groups = rawGroups
    .map((item) => mapGroup(item, workspaceId))
    .filter((item): item is PortraitGroupRow => item !== null);
  const assets = rawAssets
    .map((item) => mapAsset(item, workspaceId))
    .filter((item): item is PortraitAssetRow => item !== null);

  return {
    groups,
    assets,
    refreshedAt: Date.now(),
    metrics: {
      groupCount: groups.length,
      assetCount: assets.length,
      activeAssetCount: assets.filter((item) => item.upstreamStatus === "Active").length,
      processingAssetCount: assets.filter((item) => item.upstreamStatus === "Processing").length,
      failedAssetCount: assets.filter((item) => item.upstreamStatus === "Failed").length,
    },
  };
}
