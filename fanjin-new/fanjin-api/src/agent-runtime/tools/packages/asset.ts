import { z } from "zod";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import {
  AssetLibraryError,
  assertAssetLibraryPermission,
  listAuthorizedAssetIds,
} from "@/lib/accountWorkspaceAssetLibrary";
import {
  defineAgentTool,
  type AgentToolAuthorizationContext,
} from "@/agent-runtime/tools/registry";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_SAFE_TEXT = 4_000;
const assetIdSchema = z.number().int().positive();
const cursorSchema = z.number().int().nonnegative().default(0);
const limitSchema = z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);
const assetQuerySchema = z.string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "query 不能包含控制字符");

export const assetSearchInputSchema = z.object({
  query: assetQuerySchema.nullable().default(null),
  type: z.enum(["role", "scene", "tool", "storyboard"]).nullable().default(null),
  afterId: cursorSchema,
  limit: limitSchema,
}).strict();

const assetSummarySchema = z.object({
  id: assetIdSchema,
  name: z.string().max(500).nullable(),
  type: z.string().max(100).nullable(),
  description: z.string().max(MAX_SAFE_TEXT).nullable(),
  prompt: z.string().max(MAX_SAFE_TEXT).nullable(),
  selectedVersionId: assetIdSchema.nullable(),
}).strict();

export const assetSearchOutputSchema = z.object({
  items: z.array(assetSummarySchema).max(MAX_LIMIT),
  nextAfterId: assetIdSchema.nullable(),
}).strict();

export const assetGetInputSchema = z.object({ assetId: assetIdSchema }).strict();
export const assetGetOutputSchema = assetSummarySchema;

export const assetVersionListInputSchema = z.object({
  assetId: assetIdSchema,
  afterId: cursorSchema,
  limit: limitSchema,
}).strict();

const assetVersionSchema = z.object({
  id: assetIdSchema,
  assetId: assetIdSchema,
  type: z.string().max(100).nullable(),
  model: z.string().max(500).nullable(),
  resolution: z.string().max(100).nullable(),
  state: z.string().max(100).nullable(),
  selected: z.boolean(),
}).strict();

export const assetVersionListOutputSchema = z.object({
  items: z.array(assetVersionSchema).max(MAX_LIMIT),
  nextAfterId: assetIdSchema.nullable(),
}).strict();

type AssetSearchInput = z.infer<typeof assetSearchInputSchema>;
type AssetVersionListInput = z.infer<typeof assetVersionListInputSchema>;

function safeId(value: unknown, code = "asset_snapshot_invalid"): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AgentToolGatewayError(code, "资产记录 ID 无效", { status: 409 });
  }
  return id;
}

function nullableId(value: unknown, code = "asset_snapshot_invalid"): number | null {
  if (value == null || value === "") return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AgentToolGatewayError(code, "资产关联记录 ID 无效", { status: 409 });
  }
  return id;
}

function nullableText(value: unknown, maxLength = MAX_SAFE_TEXT): string | null {
  return value == null ? null : String(value).slice(0, maxLength);
}

function literalLikePattern(value: string): string {
  return `%${value.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_")}%`;
}

function mapAsset(row: Record<string, unknown>) {
  return {
    id: safeId(row.id),
    name: nullableText(row.name, 500),
    type: nullableText(row.type, 100),
    description: nullableText(row.describe),
    prompt: nullableText(row.prompt),
    selectedVersionId: nullableId(row.imageId),
  };
}

function assetLibraryFailure(error: unknown): never {
  if (error instanceof AssetLibraryError) {
    if (error.status === 404 || error.status === 403) {
      throw new AgentToolGatewayError(
        "asset_not_found",
        "资产不存在或当前账号无权访问",
        { status: 404 },
      );
    }
    if (error.code === "ASSET_LIBRARY_SCHEMA_UNAVAILABLE") {
      throw new AgentToolGatewayError(
        "asset_library_unavailable",
        "账号与工作区资产库尚未完成数据库升级",
        { status: 503 },
      );
    }
    throw new AgentToolGatewayError(
      "asset_library_access_failed",
      "资产库授权校验失败",
      { status: error.status >= 400 && error.status < 600 ? error.status : 409 },
    );
  }
  throw error;
}

async function authorizedAssetIds(context: AgentToolAuthorizationContext): Promise<number[]> {
  try {
    return await listAuthorizedAssetIds({
      database: context.database,
      workspaceId: context.workspaceId,
      actorUserId: context.actorUserId,
      view: "all",
      permission: "view",
    });
  } catch (error) {
    return assetLibraryFailure(error);
  }
}

async function assertAuthorizedAsset(
  assetId: number,
  context: AgentToolAuthorizationContext,
): Promise<void> {
  try {
    await assertAssetLibraryPermission({
      database: context.database,
      workspaceId: context.workspaceId,
      actorUserId: context.actorUserId,
      assetId,
      permission: "view",
    });
  } catch (error) {
    assetLibraryFailure(error);
  }
}

async function assertSelectedVersionsBelongToAssets(
  items: Array<ReturnType<typeof mapAsset>>,
  context: AgentToolAuthorizationContext,
): Promise<void> {
  const selected = items.filter((item) => item.selectedVersionId !== null);
  if (selected.length === 0) return;
  const ids = [...new Set(selected.map((item) => item.selectedVersionId!))];
  const rows = await context.database("o_image")
    .whereIn("id", ids)
    .select("id", "assetsId");
  const owners = new Map(rows.map((row) => [
    safeId(row.id, "asset_version_snapshot_invalid"),
    safeId(row.assetsId, "asset_version_snapshot_invalid"),
  ]));
  if (selected.some((item) => owners.get(item.selectedVersionId!) !== item.id)) {
    throw new AgentToolGatewayError(
      "asset_snapshot_invalid",
      "资产选中版本不存在或不属于该资产",
      { status: 409 },
    );
  }
}

async function searchAssets(input: AssetSearchInput, context: AgentToolAuthorizationContext) {
  const ids = (await authorizedAssetIds(context)).filter((id) => id > input.afterId);
  if (ids.length === 0) return { items: [], nextAfterId: null };
  const query = context.database("o_assets")
    .whereIn("id", ids)
    .andWhere("id", ">", input.afterId);
  if (input.type !== null) query.andWhere("type", input.type);
  if (input.query !== null) {
    const pattern = literalLikePattern(input.query);
    query.andWhere((builder) => builder
      .whereRaw("?? LIKE ? ESCAPE '!'", ["name", pattern])
      .orWhereRaw("?? LIKE ? ESCAPE '!'", ["describe", pattern])
      .orWhereRaw("?? LIKE ? ESCAPE '!'", ["prompt", pattern]));
  }
  const rows = await query
    .select("id", "name", "type", "describe", "prompt", "imageId")
    .orderBy("id", "asc")
    .limit(input.limit);
  const items = rows.map(mapAsset);
  await assertSelectedVersionsBelongToAssets(items, context);
  return {
    items,
    nextAfterId: items.length === input.limit ? items.at(-1)!.id : null,
  };
}

async function loadAsset(assetId: number, context: AgentToolAuthorizationContext) {
  await assertAuthorizedAsset(assetId, context);
  const row = await context.database("o_assets")
    .where({ id: assetId })
    .select("id", "name", "type", "describe", "prompt", "imageId")
    .first();
  if (!row) {
    throw new AgentToolGatewayError("asset_not_found", "资产不存在或当前账号无权访问", { status: 404 });
  }
  const asset = mapAsset(row);
  await assertSelectedVersionsBelongToAssets([asset], context);
  return asset;
}

async function listAssetVersions(input: AssetVersionListInput, context: AgentToolAuthorizationContext) {
  await assertAuthorizedAsset(input.assetId, context);
  const asset = await context.database("o_assets")
    .where({ id: input.assetId })
    .select("id", "imageId")
    .first();
  if (!asset) {
    throw new AgentToolGatewayError("asset_not_found", "资产不存在或当前账号无权访问", { status: 404 });
  }
  const rows = await context.database("o_image")
    .where({ assetsId: input.assetId })
    .andWhere("id", ">", input.afterId)
    .select("id", "assetsId", "type", "model", "resolution", "state")
    .orderBy("id", "asc")
    .limit(input.limit);
  const selectedId = nullableId(asset.imageId);
  if (selectedId !== null) {
    const selected = await context.database("o_image")
      .where({ id: selectedId, assetsId: input.assetId })
      .select("id")
      .first();
    if (!selected) {
      throw new AgentToolGatewayError(
        "asset_snapshot_invalid",
        "资产选中版本不存在或不属于该资产",
        { status: 409 },
      );
    }
  }
  const items = rows.map((row) => ({
    id: safeId(row.id, "asset_version_snapshot_invalid"),
    assetId: safeId(row.assetsId, "asset_version_snapshot_invalid"),
    type: nullableText(row.type, 100),
    model: nullableText(row.model, 500),
    resolution: nullableText(row.resolution, 100),
    state: nullableText(row.state, 100),
    selected: safeId(row.id, "asset_version_snapshot_invalid") === selectedId,
  }));
  return {
    items,
    nextAfterId: items.length === input.limit ? items.at(-1)!.id : null,
  };
}

export const ASSET_SEARCH_TOOL = defineAgentTool({
  manifest: {
    name: "asset.search",
    version: "1.0.0",
    displayName: "搜索授权资产库",
    description: "搜索本人、当前工作区和明确分享给当前账号的资产安全摘要。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["asset"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: assetSearchInputSchema,
  outputSchema: assetSearchOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    const result = await searchAssets(input, context);
    return {
      resourceRefs: [
        ...result.items.map((item) => ({ type: "assetIds" as const, id: String(item.id) })),
        ...result.items.flatMap((item) => item.selectedVersionId == null
          ? []
          : [{ type: "assetVersionIds" as const, id: String(item.selectedVersionId) }]),
      ],
      resourceVersions: {
        [`asset_search:${context.projectId}:${input.query ?? "all"}:${input.type ?? "all"}:${input.afterId}:${input.limit}`]: hashIdempotencyRequest(result),
      },
    };
  },
  execute: searchAssets,
});

export const ASSET_GET_TOOL = defineAgentTool({
  manifest: {
    name: "asset.get",
    version: "1.0.0",
    displayName: "读取授权资产",
    description: "读取当前账号获准访问的单个资产安全摘要。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["asset"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: assetGetInputSchema,
  outputSchema: assetGetOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    const asset = await loadAsset(input.assetId, context);
    return {
      resourceRefs: [
        { type: "assetIds", id: String(input.assetId) },
        ...(asset.selectedVersionId == null
          ? []
          : [{ type: "assetVersionIds" as const, id: String(asset.selectedVersionId) }]),
      ],
      resourceVersions: { [`asset:${input.assetId}`]: hashIdempotencyRequest(asset) },
    };
  },
  execute(input, context) {
    return loadAsset(input.assetId, context);
  },
});

export const ASSET_VERSION_LIST_TOOL = defineAgentTool({
  manifest: {
    name: "asset.version.list",
    version: "1.0.0",
    displayName: "列出资产版本",
    description: "列出当前账号获准访问资产的版本元数据，不返回本地路径、供应商错误或凭据。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["asset", "asset_version"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: assetVersionListInputSchema,
  outputSchema: assetVersionListOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    const result = await listAssetVersions(input, context);
    return {
      resourceRefs: [
        { type: "assetIds" as const, id: String(input.assetId) },
        ...result.items.map((item) => ({ type: "assetVersionIds" as const, id: String(item.id) })),
      ],
      resourceVersions: {
        [`asset_versions:${input.assetId}:${input.afterId}:${input.limit}`]: hashIdempotencyRequest(result),
      },
    };
  },
  execute: listAssetVersions,
});

export const ASSET_QUERY_TOOLS = Object.freeze([
  ASSET_SEARCH_TOOL,
  ASSET_GET_TOOL,
  ASSET_VERSION_LIST_TOOL,
]);
