import { z } from "zod";

import type { RelayApiKeyPermission } from "@/lib/relayApiKeyPermissions";

export const PORTRAIT_ASSET_RELAY_VERSION = "2024-01-01" as const;
export const PORTRAIT_ASSET_RELAY_RUNTIME_CAPABILITY = "portrait-asset-relay-v1" as const;
export const portraitAssetRelayActions = [
  "CreateAssetGroup",
  "GetAssetGroup",
  "ListAssetGroups",
  "UpdateAssetGroup",
  "DeleteAssetGroup",
  "CreateAsset",
  "GetAsset",
  "ListAssets",
  "UpdateAsset",
  "DeleteAsset",
  "CreateVisualValidateSession",
  "GetVisualValidateResult",
] as const;

export type PortraitAssetRelayAction = (typeof portraitAssetRelayActions)[number];

export const portraitAssetRelayReadActions = [
  "GetAssetGroup",
  "ListAssetGroups",
  "GetAsset",
  "ListAssets",
  "GetVisualValidateResult",
] as const satisfies readonly PortraitAssetRelayAction[];

export const portraitAssetRelayWriteActions = portraitAssetRelayActions.filter(
  (action) => !(portraitAssetRelayReadActions as readonly string[]).includes(action),
) as PortraitAssetRelayAction[];

const projectName = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional();
const id = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const name = z.string().trim().min(1).max(64);
const description = z.string().trim().max(300);
const pageNumber = z.number().int().min(1).max(1_000_000).optional();
const pageSize = z.number().int().min(1).max(100).optional();
const sortBy = z.enum(["CreateTime", "UpdateTime", "Name"]).optional();
const sortOrder = z.enum(["Asc", "Desc"]).optional();
const httpsUrl = z.string().url().max(2_048).refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, {
  message: "必须使用 HTTPS URL",
});

const groupFilter = z.object({
  GroupIds: z.array(id).max(100).optional(),
  GroupType: z.enum(["AIGC", "LivenessFace"]).optional(),
  Name: z.string().trim().min(1).max(64).optional(),
}).strict();

const assetFilter = z.object({
  AssetIds: z.array(id).max(100).optional(),
  GroupIds: z.array(id).max(100).optional(),
  GroupType: z.enum(["AIGC", "LivenessFace"]).optional(),
  Name: z.string().trim().min(1).max(64).optional(),
  Statuses: z.array(z.enum(["Processing", "Active", "Failed"])).max(3).optional(),
}).strict();

const schemas = {
  CreateAssetGroup: z.object({
    Name: name,
    Description: description.optional(),
    GroupType: z.literal("AIGC"),
    ProjectName: projectName,
  }).strict(),
  GetAssetGroup: z.object({ Id: id, ProjectName: projectName }).strict(),
  ListAssetGroups: z.object({
    Filter: groupFilter.optional(),
    PageNumber: pageNumber,
    PageSize: pageSize,
    ProjectName: projectName,
    SortBy: sortBy,
    SortOrder: sortOrder,
  }).strict(),
  UpdateAssetGroup: z.object({
    Id: id,
    Name: name.optional(),
    Description: description.optional(),
    ProjectName: projectName,
  }).strict().refine((value) => value.Name !== undefined || value.Description !== undefined, {
    message: "Name 和 Description 至少提供一项",
  }),
  DeleteAssetGroup: z.object({ Id: id, ProjectName: projectName }).strict(),
  CreateAsset: z.object({
    AssetType: z.enum(["Image", "Video", "Audio"]),
    GroupId: id,
    Name: name.optional(),
    ProjectName: projectName,
    URL: httpsUrl,
  }).strict(),
  GetAsset: z.object({ Id: id, ProjectName: projectName }).strict(),
  ListAssets: z.object({
    Filter: assetFilter.optional(),
    PageNumber: pageNumber,
    PageSize: pageSize,
    ProjectName: projectName,
    SortBy: sortBy,
    SortOrder: sortOrder,
  }).strict(),
  UpdateAsset: z.object({ Id: id, Name: name, ProjectName: projectName }).strict(),
  DeleteAsset: z.object({ Id: id, ProjectName: projectName }).strict(),
  CreateVisualValidateSession: z.object({
    CallbackURL: httpsUrl,
    ProjectName: projectName,
  }).strict(),
  GetVisualValidateResult: z.object({
    BytedToken: z.string().trim().min(8).max(2_048),
    ProjectName: projectName,
  }).strict(),
} satisfies Record<PortraitAssetRelayAction, z.ZodType>;

export class PortraitAssetRelayContractError extends Error {
  readonly code = "portrait_asset_request_invalid";
  readonly status = 400;

  constructor(message: string, readonly issues: z.core.$ZodIssue[] = []) {
    super(message);
    this.name = "PortraitAssetRelayContractError";
  }
}

export function isPortraitAssetRelayAction(value: unknown): value is PortraitAssetRelayAction {
  return portraitAssetRelayActions.includes(value as PortraitAssetRelayAction);
}

export function parsePortraitAssetRelayRequest(
  action: PortraitAssetRelayAction,
  body: unknown,
): Record<string, unknown> {
  const parsed = schemas[action].safeParse(body ?? {});
  if (!parsed.success) {
    throw new PortraitAssetRelayContractError("人像资产请求参数不符合 Action 契约", parsed.error.issues);
  }
  return parsed.data as Record<string, unknown>;
}

export function portraitAssetRelayPermission(action: PortraitAssetRelayAction): RelayApiKeyPermission {
  if (action === "CreateVisualValidateSession" || action === "GetVisualValidateResult") {
    return "relay:portrait_assets:liveness";
  }
  return (portraitAssetRelayReadActions as readonly string[]).includes(action)
    ? "relay:portrait_assets:read"
    : "relay:portrait_assets:write";
}
