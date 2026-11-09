import { z } from "zod";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import {
  defineAgentTool,
  type AgentToolAuthorizationContext,
} from "@/agent-runtime/tools/registry";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const DEFAULT_CONTENT_LIMIT = 12_000;
const MAX_CONTENT_LIMIT = 20_000;
const MAX_SCRIPT_NAME_LENGTH = 500;
const MAX_SCRIPT_CONTENT_CHARACTERS = 200_000;

const positiveIdSchema = z.number().int().positive();
const cursorSchema = z.number().int().nonnegative().default(0);
const listLimitSchema = z.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT);
const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Full-content fingerprint bound by script.draft.update as its optimistic CAS token. */
export function scriptContentHash(content: string): string {
  return hashIdempotencyRequest(content);
}

export const scriptListInputSchema = z.object({
  afterId: cursorSchema,
  limit: listLimitSchema,
}).strict();

const scriptListItemSchema = z.object({
  id: positiveIdSchema,
  name: z.string().max(500).nullable(),
  createdAt: z.number().int().nonnegative().nullable(),
}).strict();

export const scriptListOutputSchema = z.object({
  items: z.array(scriptListItemSchema).max(MAX_LIST_LIMIT),
  nextAfterId: positiveIdSchema.nullable(),
}).strict();

export const scriptGetInputSchema = z.object({
  scriptId: positiveIdSchema,
  contentOffset: z.number().int().nonnegative().default(0),
  contentLimit: z.number().int().min(1).max(MAX_CONTENT_LIMIT).default(DEFAULT_CONTENT_LIMIT),
}).strict();

export const scriptGetOutputSchema = z.object({
  id: positiveIdSchema,
  name: z.string().max(500).nullable(),
  content: z.string().max(MAX_CONTENT_LIMIT),
  contentOffset: z.number().int().nonnegative(),
  nextContentOffset: z.number().int().positive().nullable(),
  totalCharacters: z.number().int().nonnegative(),
  // Default keeps pre-migration succeeded Step outputs replayable: they parse
  // with a null fingerprint instead of failing the output contract.
  contentHash: contentHashSchema.nullable().default(null),
  createdAt: z.number().int().nonnegative().nullable(),
}).strict();

export const scriptDraftCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(MAX_SCRIPT_NAME_LENGTH),
  content: z.string().min(1).max(MAX_SCRIPT_CONTENT_CHARACTERS),
}).strict();

export const scriptDraftCreateOutputSchema = z.object({
  id: positiveIdSchema,
  name: z.string().max(MAX_SCRIPT_NAME_LENGTH),
  contentHash: contentHashSchema,
  totalCharacters: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
}).strict();

export const SCRIPT_DRAFT_EDITABLE_FIELDS = ["name", "content"] as const;

export const scriptDraftUpdateInputSchema = z.object({
  scriptId: positiveIdSchema,
  expectedContentHash: contentHashSchema,
  name: z.string().trim().min(1).max(MAX_SCRIPT_NAME_LENGTH).nullable(),
  content: z.string().min(1).max(MAX_SCRIPT_CONTENT_CHARACTERS).nullable(),
}).strict().superRefine((input, context) => {
  if (input.name === null && input.content === null) {
    context.addIssue({
      code: "custom",
      message: "update 至少需要 name 或 content 之一",
    });
  }
});

export const scriptDraftUpdateOutputSchema = z.object({
  id: positiveIdSchema,
  name: z.string().max(MAX_SCRIPT_NAME_LENGTH).nullable(),
  contentHash: contentHashSchema,
  totalCharacters: z.number().int().nonnegative(),
  changedFields: z.array(z.enum(SCRIPT_DRAFT_EDITABLE_FIELDS)).max(SCRIPT_DRAFT_EDITABLE_FIELDS.length),
  createdAt: z.number().int().nonnegative().nullable(),
}).strict();

type ScriptListInput = z.infer<typeof scriptListInputSchema>;
type ScriptGetInput = z.infer<typeof scriptGetInputSchema>;

function nullableText(value: unknown, maxLength: number): string | null {
  if (value == null) return null;
  return String(value).slice(0, maxLength);
}

function nullableTimestamp(value: unknown): number | null {
  if (value == null || value === "") return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function safeId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AgentToolGatewayError("script_snapshot_invalid", "剧本记录 ID 无效", { status: 409 });
  }
  return id;
}

async function listScripts(input: ScriptListInput, context: AgentToolAuthorizationContext) {
  const rows = await context.database("o_script")
    .where({ projectId: context.projectId })
    .andWhere("id", ">", input.afterId)
    .select("id", "name", "createTime")
    .orderBy("id", "asc")
    .limit(input.limit);
  const items = rows.map((row) => ({
    id: safeId(row.id),
    name: nullableText(row.name, 500),
    createdAt: nullableTimestamp(row.createTime),
  }));
  return {
    items,
    nextAfterId: items.length === input.limit ? items.at(-1)!.id : null,
  };
}

async function loadScript(input: ScriptGetInput, context: AgentToolAuthorizationContext) {
  const row = await context.database("o_script")
    .where({ id: input.scriptId, projectId: context.projectId })
    .select("id", "name", "content", "createTime")
    .first();
  if (!row) {
    throw new AgentToolGatewayError("script_not_found", "剧本不存在或不属于当前项目", { status: 404 });
  }
  const content = row.content == null ? "" : String(row.content);
  const start = Math.min(input.contentOffset, content.length);
  const end = Math.min(start + input.contentLimit, content.length);
  return {
    id: safeId(row.id),
    name: nullableText(row.name, 500),
    content: content.slice(start, end),
    contentOffset: start,
    nextContentOffset: end < content.length ? end : null,
    totalCharacters: content.length,
    contentHash: scriptContentHash(content),
    createdAt: nullableTimestamp(row.createTime),
  };
}

export const SCRIPT_LIST_TOOL = defineAgentTool({
  manifest: {
    name: "script.list",
    version: "1.0.0",
    displayName: "列出项目剧本",
    description: "按稳定游标列出当前 Agent 项目的剧本安全摘要。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["script"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: scriptListInputSchema,
  outputSchema: scriptListOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    const result = await listScripts(input, context);
    return {
      resourceRefs: result.items.map((item) => ({ type: "scriptIds" as const, id: String(item.id) })),
      resourceVersions: {
        [`script_list:${context.projectId}:${input.afterId}:${input.limit}`]: hashIdempotencyRequest(result),
      },
    };
  },
  execute: listScripts,
});

export const SCRIPT_GET_TOOL = defineAgentTool({
  manifest: {
    name: "script.get",
    version: "1.1.0",
    displayName: "读取项目剧本",
    description: "读取当前 Agent 项目的单个剧本；长正文必须通过 offset 分段读取。contentHash 是全文内容指纹，调用 script.draft.update 前必须读取并原样回传为 expectedContentHash。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["script"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: scriptGetInputSchema,
  outputSchema: scriptGetOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    const result = await loadScript(input, context);
    return {
      resourceRefs: [{ type: "scriptIds", id: String(input.scriptId) }],
      resourceVersions: { [`script:${input.scriptId}`]: hashIdempotencyRequest(result) },
    };
  },
  execute: loadScript,
});

type ScriptDraftCreateInput = z.infer<typeof scriptDraftCreateInputSchema>;
type ScriptDraftUpdateInput = z.infer<typeof scriptDraftUpdateInputSchema>;

async function createScriptDraft(input: ScriptDraftCreateInput, context: AgentToolAuthorizationContext) {
  // A single scoped insert is atomic on its own; unlike the update path there
  // is no CAS pre-read, so no savepoint is required inside the Gateway
  // transaction. Duplicate names are legacy-compatible (the old workbench
  // upserts by name without a uniqueness constraint) and remain allowed.
  const [inserted] = await context.database("o_script").insert({
    projectId: context.projectId,
    name: input.name,
    content: input.content,
    extractState: null,
    createTime: context.now,
    errorReason: null,
  }).returning("id");
  return {
    id: safeId(inserted.id),
    name: input.name,
    contentHash: scriptContentHash(input.content),
    totalCharacters: input.content.length,
    createdAt: context.now,
  };
}

async function updateScriptDraft(input: ScriptDraftUpdateInput, context: AgentToolAuthorizationContext) {
  // The savepoint keeps the CAS read + write atomic while still allowing the
  // outer Gateway transaction to persist a redacted failed Step (same pattern
  // as project.update / session.update).
  return context.database.transaction(async (trx) => {
    const row = await trx("o_script")
      .where({ id: input.scriptId, projectId: context.projectId })
      .select("id", "name", "content", "createTime")
      .forUpdate()
      .first();
    if (!row) {
      throw new AgentToolGatewayError("script_not_found", "剧本不存在或不属于当前项目", { status: 404 });
    }
    const currentContent = row.content == null ? "" : String(row.content);
    const currentHash = scriptContentHash(currentContent);
    if (currentHash !== input.expectedContentHash) {
      throw new AgentToolGatewayError(
        "script_content_conflict",
        `剧本内容已发生变化（期望指纹 ${input.expectedContentHash.slice(0, 12)}…，当前 ${currentHash.slice(0, 12)}…），必须重新读取后再改`,
        { status: 409 },
      );
    }

    const currentName = nullableText(row.name, MAX_SCRIPT_NAME_LENGTH);
    const nextName = input.name === null ? currentName : input.name;
    const nextContent = input.content === null ? currentContent : input.content;
    const changedFields = [
      ...(nextName !== currentName ? ["name" as const] : []),
      ...(nextContent !== currentContent ? ["content" as const] : []),
    ];
    if (changedFields.length === 0) {
      return {
        id: safeId(row.id),
        name: currentName,
        contentHash: currentHash,
        totalCharacters: currentContent.length,
        changedFields,
        createdAt: nullableTimestamp(row.createTime),
      };
    }

    const patch: Record<string, string> = {};
    if (changedFields.includes("name")) patch.name = nextName!;
    if (changedFields.includes("content")) patch.content = nextContent;
    // The row lock above already serializes writers; the scoped update keeps
    // the write inside the current project even if the lock is a no-op.
    const updated = await trx("o_script")
      .where({ id: input.scriptId, projectId: context.projectId })
      .update(patch);
    const affected = typeof updated === "number" ? updated : Number(updated) || 0;
    if (affected !== 1) {
      throw new AgentToolGatewayError(
        "script_content_conflict",
        "剧本在更新过程中发生变化，写入未生效",
        { status: 409 },
      );
    }
    return {
      id: safeId(row.id),
      name: nextName,
      contentHash: scriptContentHash(nextContent),
      totalCharacters: nextContent.length,
      changedFields,
      createdAt: nullableTimestamp(row.createTime),
    };
  });
}

export const SCRIPT_DRAFT_CREATE_TOOL = defineAgentTool({
  manifest: {
    name: "script.draft.create",
    version: "1.0.0",
    displayName: "创建剧本草稿",
    description: "在当前 Agent 项目创建一个新剧本草稿（写入 o_script）并返回全文内容指纹。"
      + "正例：用户或上游 Writer 提案需要落成一个新剧本（新集/新稿）时调用；"
      + "负例：修改已有剧本不要调用（改用 script.draft.update）；同名剧本不去重，创建前先用 script.list 核对；"
      + "创建后如需继续修改，必须使用返回的 contentHash 作为 expectedContentHash。",
    riskClass: "R1",
    availability: { state: "available", sincePhase: "A4" },
    requiredPermissions: ["project:write"],
    resourceTypes: ["script"],
    mutatesState: true,
    metered: false,
  },
  inputSchema: scriptDraftCreateInputSchema,
  outputSchema: scriptDraftCreateOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    // Input-derived evidence stays stable across the legitimate replay of a
    // succeeded create Step; the insert itself has no pre-state to bind.
    return {
      resourceVersions: {
        [`script_draft_create:${context.projectId}`]: hashIdempotencyRequest({
          name: input.name,
          contentHash: scriptContentHash(input.content),
        }),
      },
    };
  },
  execute: createScriptDraft,
});

export const SCRIPT_DRAFT_UPDATE_TOOL = defineAgentTool({
  manifest: {
    name: "script.draft.update",
    version: "1.0.0",
    displayName: "更新剧本草稿",
    description: "以内容指纹乐观锁更新当前项目中一个已有剧本的 name/content。"
      + "调用前必须先用 script.get 读取目标剧本，把返回的 contentHash 原样作为 expectedContentHash 提交，不得伪造或猜测；"
      + "指纹不匹配表示剧本已被其他修改改变，必须重新读取后再改，禁止用陈旧指纹覆盖。"
      + "name 与 content 至少提供一个，未提供的字段保持不变；返回新的 contentHash 供链式修改。"
      + "负例：创建新剧本不要调用（改用 script.draft.create）。",
    riskClass: "R1",
    availability: { state: "available", sincePhase: "A4" },
    requiredPermissions: ["project:write"],
    resourceTypes: ["script"],
    mutatesState: true,
    metered: false,
  },
  inputSchema: scriptDraftUpdateInputSchema,
  outputSchema: scriptDraftUpdateOutputSchema,
  async resolveAuthorizationEvidence(input, context) {
    // The existence check fails closed before policy evaluation; the bound
    // versions are input-derived so replaying the succeeded Step stays stable
    // after the tool's own write changed the row.
    const row = await context.database("o_script")
      .where({ id: input.scriptId, projectId: context.projectId })
      .select("id")
      .first();
    if (!row) {
      throw new AgentToolGatewayError("script_not_found", "剧本不存在或不属于当前项目", { status: 404 });
    }
    return {
      resourceRefs: [{ type: "scriptIds", id: String(input.scriptId) }],
      resourceVersions: {
        [`script:${input.scriptId}`]: input.expectedContentHash,
        [`script_draft_update:${input.scriptId}`]: hashIdempotencyRequest({
          baseContentHash: input.expectedContentHash,
          name: input.name,
          contentHash: input.content === null ? null : scriptContentHash(input.content),
        }),
      },
    };
  },
  execute: updateScriptDraft,
});

export const SCRIPT_QUERY_TOOLS = Object.freeze([SCRIPT_LIST_TOOL, SCRIPT_GET_TOOL]);
export const SCRIPT_DRAFT_TOOLS = Object.freeze([SCRIPT_DRAFT_CREATE_TOOL, SCRIPT_DRAFT_UPDATE_TOOL]);
