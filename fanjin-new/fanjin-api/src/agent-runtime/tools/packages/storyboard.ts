import { z } from "zod";
import type { DelegationResourceRef } from "@/agent-runtime/delegationGrantService";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import {
  defineAgentTool,
  type AgentToolAuthorizationContext,
} from "@/agent-runtime/tools/registry";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_TEXT_LIMIT = 12_000;
const MAX_TEXT_LIMIT = 20_000;
const PREVIEW_LENGTH = 500;
// DelegationGrant accepts at most 500 resourceRefs. storyboard.get also binds
// the storyboard itself and an optional script, leaving 498 slots for assets.
const MAX_LINKED_ASSETS = 498;
const positiveIdSchema = z.number().int().positive();
const cursorSchema = z.number().int().nonnegative().default(0);
const limitSchema = z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);

export const storyboardListInputSchema = z.object({
  scriptId: positiveIdSchema.nullable().default(null),
  afterId: cursorSchema,
  limit: limitSchema,
}).strict();

const storyboardSummarySchema = z.object({
  id: positiveIdSchema,
  scriptId: positiveIdSchema.nullable(),
  promptPreview: z.string().max(PREVIEW_LENGTH),
  videoDescriptionPreview: z.string().max(PREVIEW_LENGTH),
  duration: z.string().max(100).nullable(),
  track: z.string().max(200).nullable(),
  order: z.number().int().nullable(),
  shouldGenerateImage: z.boolean(),
  createdAt: z.number().int().nonnegative().nullable(),
}).strict();

export const storyboardListOutputSchema = z.object({
  items: z.array(storyboardSummarySchema).max(MAX_LIMIT),
  nextAfterId: positiveIdSchema.nullable(),
}).strict();

export const storyboardGetInputSchema = z.object({
  storyboardId: positiveIdSchema,
  promptOffset: z.number().int().nonnegative().default(0),
  videoDescriptionOffset: z.number().int().nonnegative().default(0),
  textLimit: z.number().int().min(1).max(MAX_TEXT_LIMIT).default(DEFAULT_TEXT_LIMIT),
}).strict();

export const storyboardGetOutputSchema = z.object({
  id: positiveIdSchema,
  scriptId: positiveIdSchema.nullable(),
  prompt: z.string().max(MAX_TEXT_LIMIT),
  promptOffset: z.number().int().nonnegative(),
  nextPromptOffset: z.number().int().positive().nullable(),
  promptCharacters: z.number().int().nonnegative(),
  videoDescription: z.string().max(MAX_TEXT_LIMIT),
  videoDescriptionOffset: z.number().int().nonnegative(),
  nextVideoDescriptionOffset: z.number().int().positive().nullable(),
  videoDescriptionCharacters: z.number().int().nonnegative(),
  duration: z.string().max(100).nullable(),
  track: z.string().max(200).nullable(),
  order: z.number().int().nullable(),
  shouldGenerateImage: z.boolean(),
  assetIds: z.array(positiveIdSchema).max(MAX_LINKED_ASSETS),
  createdAt: z.number().int().nonnegative().nullable(),
}).strict();

type StoryboardListInput = z.infer<typeof storyboardListInputSchema>;
type StoryboardGetInput = z.infer<typeof storyboardGetInputSchema>;

function safeId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AgentToolGatewayError("storyboard_snapshot_invalid", "分镜记录 ID 无效", { status: 409 });
  }
  return id;
}

function nullableId(value: unknown): number | null {
  if (value == null || value === "") return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AgentToolGatewayError("storyboard_snapshot_invalid", "分镜关联记录 ID 无效", { status: 409 });
  }
  return id;
}

function nullableText(value: unknown, maxLength: number): string | null {
  return value == null ? null : String(value).slice(0, maxLength);
}

function nullableInteger(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function nullableTimestamp(value: unknown): number | null {
  const number = nullableInteger(value);
  return number !== null && number >= 0 ? number : null;
}

function textWindow(value: unknown, requestedOffset: number, limit: number) {
  const text = value == null ? "" : String(value);
  const offset = Math.min(requestedOffset, text.length);
  const end = Math.min(offset + limit, text.length);
  return {
    text: text.slice(offset, end),
    offset,
    nextOffset: end < text.length ? end : null,
    total: text.length,
  };
}

function storyboardBoolean(value: unknown): boolean {
  const number = Number(value);
  if (number !== 0 && number !== 1) {
    throw new AgentToolGatewayError("storyboard_snapshot_invalid", "分镜布尔字段无效", { status: 409 });
  }
  return number === 1;
}

async function assertScriptsBelongToProject(
  scriptIds: readonly number[],
  context: AgentToolAuthorizationContext,
): Promise<void> {
  const uniqueIds = [...new Set(scriptIds)];
  if (uniqueIds.length === 0) return;
  const rows = await context.database("o_script")
    .where({ projectId: context.projectId })
    .whereIn("id", uniqueIds)
    .select("id");
  const found = new Set(rows.map((row) => safeId(row.id)));
  if (uniqueIds.some((id) => !found.has(id))) {
    throw new AgentToolGatewayError(
      "storyboard_snapshot_invalid",
      "分镜关联剧本不存在或不属于当前项目",
      { status: 409 },
    );
  }
}

async function listStoryboards(input: StoryboardListInput, context: AgentToolAuthorizationContext) {
  const query = context.database("o_storyboard")
    .where({ projectId: context.projectId })
    .andWhere("id", ">", input.afterId);
  if (input.scriptId !== null) query.andWhere("scriptId", input.scriptId);
  const rows = await query
    .select("id", "scriptId", "prompt", "videoDesc", "duration", "track", "index", "shouldGenerateImage", "createTime")
    .orderBy("id", "asc")
    .limit(input.limit);
  const items = rows.map((row) => ({
    id: safeId(row.id),
    scriptId: nullableId(row.scriptId),
    promptPreview: String(row.prompt ?? "").slice(0, PREVIEW_LENGTH),
    videoDescriptionPreview: String(row.videoDesc ?? "").slice(0, PREVIEW_LENGTH),
    duration: nullableText(row.duration, 100),
    track: nullableText(row.track, 200),
    order: nullableInteger(row.index),
    shouldGenerateImage: storyboardBoolean(row.shouldGenerateImage),
    createdAt: nullableTimestamp(row.createTime),
  }));
  await assertScriptsBelongToProject(
    items.flatMap((item) => item.scriptId == null ? [] : [item.scriptId]),
    context,
  );
  return {
    items,
    nextAfterId: items.length === input.limit ? items.at(-1)!.id : null,
  };
}

async function loadStoryboard(input: StoryboardGetInput, context: AgentToolAuthorizationContext) {
  const row = await context.database("o_storyboard")
    .where({ id: input.storyboardId, projectId: context.projectId })
    .select("id", "scriptId", "prompt", "videoDesc", "duration", "track", "index", "shouldGenerateImage", "createTime")
    .first();
  if (!row) {
    throw new AgentToolGatewayError("storyboard_not_found", "分镜不存在或不属于当前项目", { status: 404 });
  }
  const scriptId = nullableId(row.scriptId);
  await assertScriptsBelongToProject(scriptId == null ? [] : [scriptId], context);
  const assetRows = await context.database("o_assets2Storyboard as link")
    .join("o_assets as asset", "asset.id", "link.assetId")
    .where({ "link.storyboardId": input.storyboardId, "asset.projectId": context.projectId })
    .select("link.assetId")
    .orderBy("link.sortOrder", "asc")
    .orderBy("link.assetId", "asc")
    .limit(MAX_LINKED_ASSETS);
  const prompt = textWindow(row.prompt, input.promptOffset, input.textLimit);
  const videoDescription = textWindow(row.videoDesc, input.videoDescriptionOffset, input.textLimit);
  return {
    id: safeId(row.id),
    scriptId,
    prompt: prompt.text,
    promptOffset: prompt.offset,
    nextPromptOffset: prompt.nextOffset,
    promptCharacters: prompt.total,
    videoDescription: videoDescription.text,
    videoDescriptionOffset: videoDescription.offset,
    nextVideoDescriptionOffset: videoDescription.nextOffset,
    videoDescriptionCharacters: videoDescription.total,
    duration: nullableText(row.duration, 100),
    track: nullableText(row.track, 200),
    order: nullableInteger(row.index),
    shouldGenerateImage: storyboardBoolean(row.shouldGenerateImage),
    assetIds: [...new Set(assetRows.map((asset) => safeId(asset.assetId)))],
    createdAt: nullableTimestamp(row.createTime),
  };
}

export const STORYBOARD_LIST_TOOL = defineAgentTool({
  manifest: {
    name: "storyboard.list",
    version: "1.0.0",
    displayName: "列出项目分镜",
    description: "按稳定游标列出当前 Agent 项目的分镜安全摘要。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["storyboard"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: storyboardListInputSchema,
  outputSchema: storyboardListOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    const result = await listStoryboards(input, context);
    const refs: DelegationResourceRef[] = [
      ...result.items.map((item) => ({ type: "storyboardIds" as const, id: String(item.id) })),
      ...Array.from(new Set(result.items.flatMap((item) => item.scriptId == null ? [] : [String(item.scriptId)])))
        .map((id) => ({ type: "scriptIds" as const, id })),
    ];
    return {
      resourceRefs: refs,
      resourceVersions: {
        [`storyboard_list:${context.projectId}:${input.scriptId ?? "all"}:${input.afterId}:${input.limit}`]: hashIdempotencyRequest(result),
      },
    };
  },
  execute: listStoryboards,
});

export const STORYBOARD_GET_TOOL = defineAgentTool({
  manifest: {
    name: "storyboard.get",
    version: "1.0.0",
    displayName: "读取项目分镜",
    description: "读取当前项目中的单个分镜；长提示词和画面描述必须分段读取。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["storyboard", "asset"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: storyboardGetInputSchema,
  outputSchema: storyboardGetOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    const result = await loadStoryboard(input, context);
    return {
      resourceRefs: [
        { type: "storyboardIds" as const, id: String(result.id) },
        ...(result.scriptId == null
          ? []
          : [{ type: "scriptIds" as const, id: String(result.scriptId) }]),
        ...result.assetIds.map((id) => ({ type: "assetIds" as const, id: String(id) })),
      ],
      resourceVersions: {
        [`storyboard:${result.id}`]: hashIdempotencyRequest(result),
      },
    };
  },
  execute: loadStoryboard,
});

export const STORYBOARD_QUERY_TOOLS = Object.freeze([STORYBOARD_LIST_TOOL, STORYBOARD_GET_TOOL]);
