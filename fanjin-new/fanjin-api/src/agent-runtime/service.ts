import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { db } from "@/utils/db";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import {
  resolveAgentChatRunModel,
  settleAgentChatBillingOnTerminalRun,
  type ResolvedAgentChatRunModel,
} from "@/agent-runtime/agentChatBilling";
import { appendAgentEvent } from "@/agent-runtime/eventStore";
import {
  DelegationCancellationService,
  isDelegationRootCancellationCandidate,
} from "@/agent-runtime/delegationCancellationService";
import { DelegationGrantService } from "@/agent-runtime/delegationGrantService";
import { requireAgentRuntimeDelegationSigningSecret } from "@/agent-runtime/featureFlags";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import {
  resolveAgentMessageContextSnapshot,
  type AgentMessageContextInput,
} from "@/agent-runtime/messageContextSnapshot";
import { toSafeAgentApprovalDto } from "@/agent-runtime/approvalDto";
import { revokePendingAgentApprovalInTransaction } from "@/agent-runtime/approvalService";
import {
  findAgentMessageByClientId,
  findAgentRunByTriggerMessage,
  getAgentRun,
  getAgentThread,
  mapAgentMessage,
  mapAgentRun,
  mapAgentThread,
} from "@/agent-runtime/repository";
import { assertRunTransition, isTerminalRunStatus, type RunStatus } from "@/agent-runtime/stateMachine";
import {
  AGENT_SKILL_PREFERENCE_LIMIT,
  findAgentSkillDefinition,
  type AgentSkillPreferenceSnapshotRef,
} from "@/agent-runtime/runtimeConfigRegistry";
import type { AgentContentPart, AgentMessage, AgentRun, AgentThread } from "@/agent-runtime/types";
import { AGENT_RUNTIME_WORKER_DEFAULTS } from "@/agent-runtime/worker";
import {
  ensureCreationSession,
  getCreationSession,
  getCurrentCreationSession,
  type CreationSession,
  type CreationSessionDraft,
} from "@/lib/creationSessionService";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_CONTENT_PARTS = 50;
const MAX_MESSAGE_TEXT_LENGTH = 32_000;
const MAX_MESSAGE_CONTENT_BYTES = 64 * 1024;

/**
 * REVAMP-PLAN 4.4(真附件)限额:图片 ≤4、文件 ≤2、单图 ≤10MB。
 * URL 形式的图片无法在后端量体,10MB 由既有资产上传通道在上传时强制;
 * 本层对 URL 形式做长度校验(见 MAX_ATTACHMENT_URL_LENGTH)。
 */
const MAX_MESSAGE_IMAGE_ATTACHMENTS = 4;
const MAX_MESSAGE_FILE_ATTACHMENTS = 2;
const MAX_MESSAGE_ATTACHMENTS = MAX_MESSAGE_IMAGE_ATTACHMENTS + MAX_MESSAGE_FILE_ATTACHMENTS;
const MAX_ATTACHMENT_NAME_LENGTH = 200;
const MAX_ATTACHMENT_URL_LENGTH = 2_048;
const MAX_ATTACHMENT_ASSET_REF_LENGTH = 200;
const ATTACHMENT_URL_PATTERN = /^https?:\/\/\S+$/i;
const CANCELLED_MESSAGE_ERROR = {
  code: "run_cancelled",
  message: "Agent 运行已取消",
} as const;

function cleanTitle(value: string | null | undefined): string {
  const title = String(value || "").trim().replace(/\s+/g, " ");
  return (title || "新 Agent 对话").slice(0, 120);
}

function cleanProjectName(value: string | null | undefined): string {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  return (name || "未命名 Agent 项目").slice(0, 120);
}

function cleanReason(value: string | null | undefined): string | null {
  const reason = String(value || "").trim();
  return reason ? reason.slice(0, 500) : null;
}

function recoveryMaxAttempts(value: number | undefined): number {
  const resolved = value ?? AGENT_RUNTIME_WORKER_DEFAULTS.maxAttempts;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new AgentRuntimeError(500, "agent_recovery_budget_invalid", "Agent Run 恢复预算配置无效");
  }
  return resolved;
}

function validateMessageContent(content: AgentContentPart[]): void {
  if (!Array.isArray(content) || content.length === 0) {
    throw new AgentRuntimeError(400, "message_content_required", "消息内容不能为空");
  }
  if (content.length > MAX_MESSAGE_CONTENT_PARTS) {
    throw new AgentRuntimeError(400, "message_content_parts_exceeded", `消息内容块不能超过 ${MAX_MESSAGE_CONTENT_PARTS} 个`);
  }

  let imageParts = 0;
  for (const part of content) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw new AgentRuntimeError(400, "message_content_invalid", "消息内容块必须是对象");
    }
    if (typeof part.type !== "string" || !part.type.trim() || part.type.length > 64) {
      throw new AgentRuntimeError(400, "message_content_invalid", "消息内容块 type 必填且不能超过 64 字符");
    }
    if (part.type === "image_url") {
      // 真附件(REVAMP-PLAN 4.4):图片转多模态 image part,结构在此兜底校验;
      // 无 http(s) URL 的 part(仅 assetRef)在模型侧降级为文本占位。
      imageParts += 1;
      if (imageParts > MAX_MESSAGE_IMAGE_ATTACHMENTS) {
        throw new AgentRuntimeError(400, "message_image_parts_exceeded", `图片附件最多 ${MAX_MESSAGE_IMAGE_ATTACHMENTS} 个`);
      }
      if (part.name !== undefined && (typeof part.name !== "string" || part.name.length > MAX_ATTACHMENT_NAME_LENGTH)) {
        throw new AgentRuntimeError(400, "message_content_invalid", "图片附件 name 必须是 200 字符内的字符串");
      }
      if (part.assetRef !== undefined
        && (typeof part.assetRef !== "string" || !part.assetRef.trim() || part.assetRef.length > MAX_ATTACHMENT_ASSET_REF_LENGTH)) {
        throw new AgentRuntimeError(400, "message_content_invalid", "图片附件 assetRef 无效");
      }
      if (part.image_url !== undefined) {
        const imageUrl = part.image_url as Record<string, unknown> | null;
        const url = imageUrl && typeof imageUrl === "object" ? imageUrl.url : undefined;
        if (typeof url !== "string" || !ATTACHMENT_URL_PATTERN.test(url) || url.length > MAX_ATTACHMENT_URL_LENGTH) {
          throw new AgentRuntimeError(400, "message_content_invalid", "图片附件 url 必须是 2048 字符内的 http(s) 链接");
        }
      }
      continue;
    }
    if (part.type !== "text") {
      throw new AgentRuntimeError(400, "message_content_type_unsupported", "消息内容块仅支持 text 与 image_url 类型");
    }
    if (typeof part.text !== "string") {
      throw new AgentRuntimeError(400, "message_text_required", "text 内容块必须包含字符串 text");
    }
    if (part.text.length > MAX_MESSAGE_TEXT_LENGTH) {
      throw new AgentRuntimeError(413, "message_text_too_large", `单个文本内容块不能超过 ${MAX_MESSAGE_TEXT_LENGTH} 字符`);
    }
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(content);
  } catch {
    throw new AgentRuntimeError(400, "message_content_invalid", "消息内容必须可以序列化为 JSON");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_MESSAGE_CONTENT_BYTES) {
    throw new AgentRuntimeError(413, "message_content_too_large", `消息内容不能超过 ${MAX_MESSAGE_CONTENT_BYTES} 字节`);
  }
}

/** 真附件(REVAMP-PLAN 4.4)消息入参,与 routes 层 sendSchema 同构。 */
export interface AgentMessageAttachmentInput {
  kind: "image" | "file";
  name: string;
  url?: string;
  assetRef?: string;
}

/** 真技能(REVAMP-PLAN 4.3)消息入参;version 缺省时解析为该 key 的最高版本。 */
export interface AgentMessageSkillRefInput {
  key: string;
  version?: string;
}

function cleanAttachmentText(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

/**
 * 服务端兜底校验附件结构并执行限额(路由层 zod 已先做一轮;service 是内层
 * 边界,必须独立拒绝超额请求)。
 */
export function normalizeAgentMessageAttachments(
  input: readonly AgentMessageAttachmentInput[] | undefined,
): AgentMessageAttachmentInput[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new AgentRuntimeError(400, "message_attachments_invalid", `附件最多 ${MAX_MESSAGE_ATTACHMENTS} 个`);
  }
  const normalized = input.map((attachment, index) => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      throw new AgentRuntimeError(400, "message_attachments_invalid", `attachments[${index}] 必须是对象`);
    }
    if (attachment.kind !== "image" && attachment.kind !== "file") {
      throw new AgentRuntimeError(400, "message_attachments_invalid", `attachments[${index}].kind 必须是 image 或 file`);
    }
    const name = cleanAttachmentText(attachment.name, MAX_ATTACHMENT_NAME_LENGTH);
    if (!name) {
      throw new AgentRuntimeError(400, "message_attachments_invalid", `attachments[${index}].name 必填`);
    }
    const url = cleanAttachmentText(attachment.url, MAX_ATTACHMENT_URL_LENGTH + 1);
    const assetRef = cleanAttachmentText(attachment.assetRef, MAX_ATTACHMENT_ASSET_REF_LENGTH + 1);
    if (!url && !assetRef) {
      throw new AgentRuntimeError(400, "message_attachments_invalid", `attachments[${index}] 必须提供 url 或 assetRef`);
    }
    if (url && (url.length > MAX_ATTACHMENT_URL_LENGTH || !ATTACHMENT_URL_PATTERN.test(url))) {
      throw new AgentRuntimeError(400, "message_attachments_invalid", `attachments[${index}].url 必须是 2048 字符内的 http(s) 链接`);
    }
    if (assetRef.length > MAX_ATTACHMENT_ASSET_REF_LENGTH) {
      throw new AgentRuntimeError(400, "message_attachments_invalid", `attachments[${index}].assetRef 过长`);
    }
    return {
      kind: attachment.kind,
      name,
      ...(url ? { url } : {}),
      ...(assetRef ? { assetRef } : {}),
    };
  });
  const images = normalized.filter((attachment) => attachment.kind === "image").length;
  const files = normalized.filter((attachment) => attachment.kind === "file").length;
  if (images > MAX_MESSAGE_IMAGE_ATTACHMENTS) {
    throw new AgentRuntimeError(400, "message_image_attachments_exceeded", `图片附件最多 ${MAX_MESSAGE_IMAGE_ATTACHMENTS} 个`);
  }
  if (files > MAX_MESSAGE_FILE_ATTACHMENTS) {
    throw new AgentRuntimeError(400, "message_file_attachments_exceeded", `文件附件最多 ${MAX_MESSAGE_FILE_ATTACHMENTS} 个`);
  }
  return normalized;
}

/**
 * 附件转多模态 content parts(REVAMP-PLAN 4.4):图 → {type:"image_url",...}
 * part(带 name/url/assetRef,供模型与前端渲染双用);文件 → [附件:name]
 * 文本块,与现有 text part 共存。
 */
export function buildAgentMessageContent(
  content: AgentContentPart[],
  attachments: readonly AgentMessageAttachmentInput[] | undefined,
): AgentContentPart[] {
  if (!attachments || attachments.length === 0) return content;
  const parts: AgentContentPart[] = [...content];
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      parts.push({
        type: "image_url",
        name: attachment.name,
        ...(attachment.url ? { image_url: { url: attachment.url } } : {}),
        ...(attachment.assetRef ? { assetRef: attachment.assetRef } : {}),
      });
      continue;
    }
    parts.push({ type: "text", text: `[附件:${attachment.name}]` });
  }
  return parts;
}

/**
 * 真技能(REVAMP-PLAN 4.3):校验用户选择的技能存在(未知 → 400),version
 * 缺省时解析为 Registry 最高版本;返回随 Run policySnapshot 持久化的不可变
 * 引用(含 contentHash,执行期据此校验 Registry 未被替换)。
 */
export function resolveAgentMessageSkillRefs(
  input: readonly AgentMessageSkillRefInput[] | undefined,
): AgentSkillPreferenceSnapshotRef[] {
  if (input === undefined || input.length === 0) return [];
  if (!Array.isArray(input) || input.length > AGENT_SKILL_PREFERENCE_LIMIT) {
    throw new AgentRuntimeError(400, "agent_skill_refs_exceeded", `技能选择最多 ${AGENT_SKILL_PREFERENCE_LIMIT} 个`);
  }
  const seen = new Set<string>();
  return input.map((ref, index) => {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      throw new AgentRuntimeError(400, "agent_skill_invalid", `skillRefs[${index}] 必须是对象`);
    }
    const key = String(ref.key ?? "").trim();
    const version = typeof ref.version === "string" ? ref.version.trim() : "";
    if (!key || key.length > 100 || version.length > 50) {
      throw new AgentRuntimeError(400, "agent_skill_invalid", `skillRefs[${index}] 格式无效`);
    }
    const definition = findAgentSkillDefinition({ key, version: version || undefined });
    if (!definition) {
      throw new AgentRuntimeError(
        400,
        "agent_skill_unknown",
        version ? `技能 ${key}@${version} 不存在` : `技能 ${key} 不存在`,
      );
    }
    if (seen.has(definition.key)) {
      throw new AgentRuntimeError(400, "agent_skill_duplicate", `技能 ${definition.key} 不能重复选择`);
    }
    seen.add(definition.key);
    return {
      key: definition.key,
      version: definition.version,
      contentHash: definition.contentHash,
      displayName: definition.displayName,
    };
  });
}

function isUniqueConstraintError(error: any): boolean {
  return (
    error?.code === "23505" ||
    error?.code === "SQLITE_CONSTRAINT" ||
    error?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    String(error?.message || "").toLowerCase().includes("unique constraint")
  );
}

function parseStoredResponse(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function replayThreadCreation(input: {
  workspaceId: string;
  scopeKey: string;
  idempotencyKey: string;
  requestHash: string;
}): Promise<AgentThread | null> {
  const row = await (db as any)("o_agent_idempotency")
    .where({ scopeKey: input.scopeKey, idempotencyKey: input.idempotencyKey })
    .first();
  if (!row) return null;
  if (String(row.requestHash) !== input.requestHash) {
    throw new AgentRuntimeError(409, "idempotency_conflict", "同一 Idempotency-Key 已被不同请求使用");
  }
  if (row.status !== "completed") {
    throw new AgentRuntimeError(409, "idempotency_in_progress", "相同请求正在处理中，请稍后重试");
  }
  const response = parseStoredResponse(row.responseBody);
  const threadId = String(response.threadId || row.resourceId || "");
  if (!threadId) throw new AgentRuntimeError(500, "idempotency_record_invalid", "幂等记录缺少资源引用");
  return getAgentThread({ id: threadId, workspaceId: input.workspaceId });
}

async function insertAgentThread(
  trx: Knex.Transaction,
  input: {
    id: string;
    workspaceId: string;
    projectId: number;
    sessionId?: string | null;
    title: string;
    createdBy: number;
    now: number;
  },
): Promise<AgentThread> {
  await (trx as any)("o_agent_thread").insert({
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    sessionId: input.sessionId ?? null,
    title: input.title,
    status: "active",
    activeRootRunId: null,
    messageSeq: 0,
    eventSeq: 1,
    lastMessageAt: null,
    version: 1,
    createdBy: input.createdBy,
    metadata: JSON.stringify({}),
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
  });

  await appendAgentEvent(trx, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    threadId: input.id,
    seq: 1,
    type: "thread.created",
    payload: { threadId: input.id, projectId: input.projectId, sessionId: input.sessionId ?? null },
    createdAt: input.now,
  });

  const row = await (trx as any)("o_agent_thread").where({ id: input.id }).first();
  return mapAgentThread(row);
}

const PROJECT_DEFAULT_THREAD_METADATA = Object.freeze({
  kind: "project_default",
  isDefault: true,
  schemaVersion: 1,
});

/**
 * A project owns exactly one eagerly-created default Agent thread.  The
 * identifier is derived from the immutable workspace/project scope so two
 * concurrent callers target the same primary key without requiring a new
 * nullable uniqueness column on every historical thread row.
 */
export function projectDefaultAgentThreadId(input: {
  workspaceId: string;
  projectId: number;
}): string {
  const digest = createHash("sha256")
    .update("fanjin.project-default-agent-thread/v1\0", "utf8")
    .update(input.workspaceId, "utf8")
    .update("\0", "utf8")
    .update(String(input.projectId), "utf8")
    .digest("hex");
  return `project-default-${digest}`;
}

/**
 * Ensure the empty default conversation while the caller still owns the
 * project-creation transaction.  `ON CONFLICT DO NOTHING` makes retries and
 * concurrent repair jobs converge on the deterministic row; only the winner
 * appends the matching thread.created event.
 */
export async function ensureProjectDefaultAgentThread(input: {
  database: Knex.Transaction;
  workspaceId: string;
  projectId: number;
  sessionId: string;
  title?: string | null;
  createdBy: number;
  now: number;
}): Promise<{ thread: AgentThread; created: boolean }> {
  const id = projectDefaultAgentThreadId(input);
  const metadata = JSON.stringify(PROJECT_DEFAULT_THREAD_METADATA);
  const inserted = await (input.database as any)("o_agent_thread")
    .insert({
      id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      title: cleanTitle(input.title),
      status: "active",
      activeRootRunId: null,
      messageSeq: 0,
      eventSeq: 1,
      lastMessageAt: null,
      version: 1,
      createdBy: input.createdBy,
      metadata,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
    })
    .onConflict("id")
    .ignore()
    .returning("id");
  const created = Array.isArray(inserted) && inserted.length > 0;

  if (created) {
    await appendAgentEvent(input.database, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      threadId: id,
      seq: 1,
      type: "thread.created",
      payload: {
        threadId: id,
        projectId: input.projectId,
        sessionId: input.sessionId,
        isDefault: true,
      },
      createdAt: input.now,
    });
  }

  const row = await (input.database as any)("o_agent_thread").where({ id }).first();
  if (!row) {
    throw new AgentRuntimeError(500, "default_agent_thread_missing", "默认 Agent 对话创建后无法读取");
  }
  const thread = mapAgentThread(row);
  if (
    thread.workspaceId !== input.workspaceId
    || thread.projectId !== input.projectId
    || thread.sessionId !== input.sessionId
    || thread.metadata.kind !== PROJECT_DEFAULT_THREAD_METADATA.kind
    || thread.metadata.isDefault !== true
  ) {
    throw new AgentRuntimeError(
      500,
      "default_agent_thread_scope_mismatch",
      "默认 Agent 对话与项目范围不一致",
    );
  }
  return { thread, created };
}

export async function createAgentThread(input: {
  workspaceId: string;
  projectId: number;
  sessionId?: string | null;
  title?: string | null;
  createdBy: number;
  idempotencyKey: string;
  now?: number;
}): Promise<{ thread: AgentThread; replayed: boolean }> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new AgentRuntimeError(400, "idempotency_key_required", "Idempotency-Key 必填且不能超过 200 字符");
  }

  const title = cleanTitle(input.title);
  const requestPayload = {
    projectId: input.projectId,
    sessionId: input.sessionId ?? null,
    title,
  };
  const requestHash = hashIdempotencyRequest(requestPayload);
  const scopeKey = `agent:thread:create:${input.workspaceId}:${input.createdBy}`;

  const replay = await replayThreadCreation({ workspaceId: input.workspaceId, scopeKey, idempotencyKey, requestHash });
  if (replay) return { thread: replay, replayed: true };

  const now = input.now ?? Date.now();
  const threadId = randomUUID();
  const idempotencyId = randomUUID();

  try {
    const thread = await (db as unknown as Knex).transaction(async (trx) => {
      await (trx as any)("o_agent_idempotency").insert({
        id: idempotencyId,
        workspaceId: input.workspaceId,
        actorUserId: input.createdBy,
        scopeKey,
        idempotencyKey,
        requestHash,
        status: "reserved",
        responseStatus: null,
        responseBody: null,
        resourceType: null,
        resourceId: null,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
        createdAt: now,
        updatedAt: now,
      });

      const project = await (trx as any)("o_project")
        .where({ id: input.projectId, workspaceId: input.workspaceId })
        .first();
      if (!project) throw new AgentRuntimeError(404, "project_not_found", "项目不存在");
      if (input.sessionId) {
        const session = await getCreationSession({
          id: input.sessionId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          database: trx,
        });
        if (!session || session.status !== "active") {
          throw new AgentRuntimeError(404, "creation_session_not_found", "创作会话不存在");
        }
      }

      const thread = await insertAgentThread(trx, {
        id: threadId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        title,
        createdBy: input.createdBy,
        now,
      });

      await (trx as any)("o_agent_idempotency")
        .where({ id: idempotencyId, status: "reserved" })
        .update({
          status: "completed",
          responseStatus: 201,
          responseBody: JSON.stringify({ threadId }),
          resourceType: "agent_thread",
          resourceId: threadId,
          updatedAt: now,
        });

      return thread;
    });
    return { thread, replayed: false };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrentReplay = await replayThreadCreation({ workspaceId: input.workspaceId, scopeKey, idempotencyKey, requestHash });
    if (concurrentReplay) return { thread: concurrentReplay, replayed: true };
    throw error;
  }
}

export interface EnsureAgentThreadResult {
  project: { id: number; name: string; created: boolean };
  session: CreationSession;
  thread: AgentThread;
  replayed: boolean;
}

async function replayThreadEnsure(input: {
  workspaceId: string;
  scopeKey: string;
  idempotencyKey: string;
  requestHash: string;
}): Promise<EnsureAgentThreadResult | null> {
  const row = await (db as any)("o_agent_idempotency")
    .where({ scopeKey: input.scopeKey, idempotencyKey: input.idempotencyKey })
    .first();
  if (!row) return null;
  if (String(row.requestHash) !== input.requestHash) {
    throw new AgentRuntimeError(409, "idempotency_conflict", "同一 Idempotency-Key 已被不同请求使用");
  }
  if (row.status !== "completed") {
    throw new AgentRuntimeError(409, "idempotency_in_progress", "相同请求正在处理中，请稍后重试");
  }
  const response = parseStoredResponse(row.responseBody);
  const projectId = Number(response.projectId || 0);
  const sessionId = String(response.sessionId || "");
  const threadId = String(response.threadId || row.resourceId || "");
  if (!projectId || !sessionId || !threadId) {
    throw new AgentRuntimeError(500, "idempotency_record_invalid", "幂等记录缺少项目、会话或线程引用");
  }
  const [project, session, thread] = await Promise.all([
    (db as any)("o_project").where({ id: projectId, workspaceId: input.workspaceId }).first(),
    getCreationSession({ id: sessionId, workspaceId: input.workspaceId, projectId }),
    getAgentThread({ id: threadId, workspaceId: input.workspaceId }),
  ]);
  if (!project || !session || !thread) {
    throw new AgentRuntimeError(500, "idempotency_resource_missing", "幂等请求关联的资源已不存在");
  }
  if (
    session.projectId !== projectId
    || thread.projectId !== projectId
    || thread.sessionId !== sessionId
  ) {
    throw new AgentRuntimeError(
      500,
      "idempotency_resource_scope_mismatch",
      "幂等请求关联的项目、创作会话与线程范围不一致",
    );
  }
  return {
    project: {
      id: projectId,
      name: String(project.name || ""),
      created: response.createdProject === true,
    },
    session,
    thread,
    replayed: true,
  };
}

async function insertAgentProject(
  trx: Knex.Transaction,
  input: { workspaceId: string; createdBy: number; name: string; goal: string; now: number },
): Promise<{ id: number; name: string }> {
  const inserted = await (trx as any)("o_project")
    .insert({
      workspaceId: input.workspaceId,
      projectType: "agent",
      name: input.name,
      intro: input.goal,
      mode: "agent",
      userId: input.createdBy,
      createTime: input.now,
      updatedAt: input.now,
      revision: 1,
    })
    .returning(["id", "name"]);
  const first = Array.isArray(inserted) ? inserted[0] : inserted;
  const projectId = Number(typeof first === "object" && first !== null ? first.id : first);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new AgentRuntimeError(500, "project_create_failed", "项目创建后未返回有效 ID");
  }
  return { id: projectId, name: input.name };
}

export async function ensureAgentThread(input: {
  workspaceId: string;
  projectId?: number | null;
  projectName?: string | null;
  sessionId?: string | null;
  session?: CreationSessionDraft;
  title?: string | null;
  createdBy: number;
  idempotencyKey: string;
  now?: number;
}): Promise<EnsureAgentThreadResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new AgentRuntimeError(400, "idempotency_key_required", "Idempotency-Key 必填且不能超过 200 字符");
  }

  const title = cleanTitle(input.title || input.session?.goal);
  const projectName = cleanProjectName(input.projectName || input.session?.goal || title);
  const requestPayload = {
    projectId: input.projectId ?? null,
    projectName,
    sessionId: input.sessionId ?? null,
    session: input.session ?? {},
    title,
  };
  const requestHash = hashIdempotencyRequest(requestPayload);
  const scopeKey = `agent:thread:ensure:${input.workspaceId}:${input.createdBy}`;
  const replay = await replayThreadEnsure({ workspaceId: input.workspaceId, scopeKey, idempotencyKey, requestHash });
  if (replay) return replay;

  const now = input.now ?? Date.now();
  const idempotencyId = randomUUID();
  const threadId = randomUUID();

  try {
    return await (db as unknown as Knex).transaction(async (trx) => {
      await (trx as any)("o_agent_idempotency").insert({
        id: idempotencyId,
        workspaceId: input.workspaceId,
        actorUserId: input.createdBy,
        scopeKey,
        idempotencyKey,
        requestHash,
        status: "reserved",
        responseStatus: null,
        responseBody: null,
        resourceType: null,
        resourceId: null,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
        createdAt: now,
        updatedAt: now,
      });

      let project: { id: number; name: string };
      let createdProject = false;
      if (input.projectId) {
        const row = await (trx as any)("o_project")
          .where({ id: input.projectId, workspaceId: input.workspaceId })
          .forUpdate()
          .first();
        if (!row) throw new AgentRuntimeError(404, "project_not_found", "项目不存在");
        project = { id: Number(row.id), name: String(row.name || "") };
      } else {
        project = await insertAgentProject(trx, {
          workspaceId: input.workspaceId,
          createdBy: input.createdBy,
          name: projectName,
          goal: String(input.session?.goal || "").trim(),
          now,
        });
        createdProject = true;
      }

      const currentSession = input.projectId && !input.sessionId
        ? await getCurrentCreationSession({
          workspaceId: input.workspaceId,
          projectId: project.id,
          database: trx,
        })
        : null;
      const ensuredSession = currentSession
        ? { session: currentSession, created: false }
        : await ensureCreationSession({
          workspaceId: input.workspaceId,
          projectId: project.id,
          sessionId: input.sessionId,
          draft: input.session,
          createdBy: input.createdBy,
          now,
          database: trx,
        });
      const thread = await insertAgentThread(trx, {
        id: threadId,
        workspaceId: input.workspaceId,
        projectId: project.id,
        sessionId: ensuredSession.session.id,
        title,
        createdBy: input.createdBy,
        now,
      });

      await (trx as any)("o_agent_idempotency")
        .where({ id: idempotencyId, status: "reserved" })
        .update({
          status: "completed",
          responseStatus: 201,
          responseBody: JSON.stringify({
            projectId: project.id,
            sessionId: ensuredSession.session.id,
            threadId: thread.id,
            createdProject,
          }),
          resourceType: "agent_thread",
          resourceId: thread.id,
          updatedAt: now,
        });

      return {
        project: { ...project, created: createdProject },
        session: ensuredSession.session,
        thread,
        replayed: false,
      };
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrentReplay = await replayThreadEnsure({
      workspaceId: input.workspaceId,
      scopeKey,
      idempotencyKey,
      requestHash,
    });
    if (concurrentReplay) return concurrentReplay;
    throw error;
  }
}

async function replayClientMessage(
  workspaceId: string,
  threadId: string,
  clientMessageId: string,
  content: AgentContentPart[],
  requestDigest: string | null,
  trx?: Knex.Transaction,
): Promise<{ message: AgentMessage; run: AgentRun; replayed: true } | null> {
  const existing = await findAgentMessageByClientId({
    workspaceId,
    threadId,
    clientMessageId,
    database: trx,
  });
  if (!existing) return null;
  const metadata = existing.metadata
    && typeof existing.metadata === "object"
    && !Array.isArray(existing.metadata)
    ? existing.metadata as Record<string, unknown>
    : {};
  const hasStoredRequestDigest = Object.prototype.hasOwnProperty.call(metadata, "requestDigest");
  if (hasStoredRequestDigest
    && (typeof metadata.requestDigest !== "string" || !/^[a-f0-9]{64}$/.test(metadata.requestDigest))) {
    // Only a genuinely absent field denotes a pre-requestDigest message.
    // Treat a present-but-invalid value as stored-state corruption instead of
    // silently weakening replay to the historical content-only contract.
    throw new AgentRuntimeError(
      500,
      "message_request_digest_invalid",
      "消息幂等摘要损坏，请联系管理员处理",
    );
  }
  const storedRequestDigest = hasStoredRequestDigest ? String(metadata.requestDigest) : null;
  // The caller has not resolved current context yet. Only a pre-digest legacy
  // message can be decided at this stage; a v1 message needs the full incoming
  // content + model + context digest below.
  if (storedRequestDigest && requestDigest === null) return null;
  const conflicts = storedRequestDigest
    ? storedRequestDigest !== requestDigest
    // Messages created before requestDigest shipped keep the historical
    // content-only replay contract instead of becoming unreadable.
    : hashIdempotencyRequest(existing.content) !== hashIdempotencyRequest(content);
  if (conflicts) {
    throw new AgentRuntimeError(
      409,
      "client_message_conflict",
      "clientMessageId 已被不同消息、模型或创作上下文使用",
    );
  }
  const run = await findAgentRunByTriggerMessage({
    workspaceId,
    triggerMessageId: existing.id,
    database: trx,
  });
  if (!run) throw new AgentRuntimeError(500, "message_run_missing", "消息缺少对应 Run");
  return { message: existing, run, replayed: true };
}

export async function queueAgentUserMessage(input: {
  workspaceId: string;
  threadId: string;
  clientMessageId: string;
  content: AgentContentPart[];
  createdBy: number;
  policySnapshot?: Record<string, unknown>;
  recoveryMaxAttempts?: number;
  chatModelId?: string | null;
  /** Request-layer resolution reused to keep execution and billing snapshots identical. */
  resolvedChatModel?: ResolvedAgentChatRunModel;
  attachments?: AgentMessageAttachmentInput[];
  skillRefs?: AgentMessageSkillRefInput[];
  contextSnapshot?: AgentMessageContextInput;
  /** Internal safe-retry fence; never accepted from an untrusted HTTP body. */
  requiredContextDigest?: string;
  /** Applied only to a newly created Run, never to an immutable replay. */
  assertNewRunAdmission?: () => void;
  now?: number;
}): Promise<{ message: AgentMessage; run: AgentRun; replayed: boolean }> {
  const clientMessageId = input.clientMessageId.trim();
  if (!clientMessageId || clientMessageId.length > 200) {
    throw new AgentRuntimeError(400, "client_message_id_required", "clientMessageId 必填且不能超过 200 字符");
  }
  // 真附件/真技能(REVAMP-PLAN 4.4/4.3):先校验并展开为持久化形态,再进入
  // 幂等重放比较,保证同一 clientMessageId 的重放哈希覆盖附件与文本合并结果;
  // 未知技能(400)在任何扣费与重放之前快速失败。
  const attachments = normalizeAgentMessageAttachments(input.attachments);
  const content = buildAgentMessageContent(input.content, attachments);
  validateMessageContent(content);

  // Detect a pre-contextSnapshot message before resolving any current model,
  // skill, Session or asset state. Its historical contract was content-only;
  // stale/archived current context must not make that stored replay unreadable.
  const legacyReplay = await replayClientMessage(
    input.workspaceId,
    input.threadId,
    clientMessageId,
    content,
    null,
  );
  if (legacyReplay) return legacyReplay;

  const skillRefs = resolveAgentMessageSkillRefs(input.skillRefs);

  // Resolve the chat-model selection before any replay/charge step so an
  // invalid or unavailable model fails fast with a deterministic error.
  const chatModel = input.resolvedChatModel ?? await resolveAgentChatRunModel({
    workspaceId: input.workspaceId,
    chatModelId: input.chatModelId,
    requireAvailable: input.policySnapshot?.modelEnabled === true,
  });

  const resolvedContext = await resolveAgentMessageContextSnapshot({
    workspaceId: input.workspaceId,
    actorUserId: input.createdBy,
    threadId: input.threadId,
    context: input.contextSnapshot,
    attachments,
    skills: skillRefs,
  });
  if (
    input.requiredContextDigest !== undefined
    && resolvedContext.snapshot.digest !== input.requiredContextDigest
  ) {
    throw new AgentRuntimeError(
      409,
      "agent_safe_retry_context_changed",
      "原运行的持久化创作上下文已变化，禁止创建安全重试",
    );
  }
  const requestDigest = hashIdempotencyRequest({
    content,
    model: chatModel.definition.id,
    context: resolvedContext.snapshot.digest,
    // URL-only file attachments cannot enter the confirmed resource snapshot,
    // but changing one must still conflict under the same clientMessageId.
    attachments,
  });

  const replay = await replayClientMessage(
    input.workspaceId,
    input.threadId,
    clientMessageId,
    content,
    requestDigest,
  );
  if (replay) return replay;

  // A rollout may tighten admission for new Runs without making an immutable
  // historical replay unreadable.
  input.assertNewRunAdmission?.();

  const now = input.now ?? Date.now();
  const runRecoveryMaxAttempts = recoveryMaxAttempts(input.recoveryMaxAttempts);
  const messageId = randomUUID();
  const runId = randomUUID();

  const policySnapshot = {
    ...(input.policySnapshot ?? {}),
    // 真技能(REVAMP-PLAN 4.3):用户选择的技能偏好随 Run 固定,执行期按此
    // 快照注入提示词偏好声明(含 contentHash 防 Registry 替换)。
    ...(skillRefs.length > 0 ? { skillRefs } : {}),
    contextSnapshot: resolvedContext.snapshot,
    contextDigest: resolvedContext.snapshot.digest,
    chatModel: {
      id: chatModel.definition.id,
      displayName: chatModel.definition.displayName,
      modelAlias: chatModel.definition.modelAlias,
      isDefault: chatModel.definition.isDefault,
      billingMode: "token",
      available: chatModel.available,
      reservationMicros: chatModel.reservationMicros,
      estimatedCostMicros: chatModel.estimatedCostMicros,
      estimatedInputTokens: chatModel.estimatedInputTokens,
      estimatedOutputTokens: chatModel.estimatedOutputTokens,
      provider: chatModel.provider,
      pricingRuleId: chatModel.pricingRule?.id ?? null,
    },
    chatBilling: {
      status: "token_metered",
      billingMode: "token",
      reservationMicros: chatModel.reservationMicros,
      settlement: "authoritative_usage",
    },
  };

  try {
    const result = await (db as unknown as Knex).transaction(async (trx) => {
      const transactionReplay = await replayClientMessage(
        input.workspaceId,
        input.threadId,
        clientMessageId,
        content,
        requestDigest,
        trx,
      );
      if (transactionReplay) return transactionReplay;

      const rawThread = await (trx as any)("o_agent_thread")
        .where({ id: input.threadId, workspaceId: input.workspaceId })
        .first();
      if (!rawThread) throw new AgentRuntimeError(404, "thread_not_found", "Agent Thread 不存在");
      const thread = mapAgentThread(rawThread);
      if (thread.status !== "active") throw new AgentRuntimeError(409, "thread_archived", "Agent Thread 已归档");
      if (thread.activeRootRunId) {
        throw new AgentRuntimeError(409, "active_run_exists", "当前 Thread 已有运行中的根 Run");
      }

      const messageSeq = thread.messageSeq + 1;
      const messageEventSeq = thread.eventSeq + 1;
      const runEventSeq = thread.eventSeq + 2;
      const claimed = await (trx as any)("o_agent_thread")
        .where({ id: thread.id, version: thread.version })
        .whereNull("activeRootRunId")
        .update({
          activeRootRunId: runId,
          messageSeq,
          eventSeq: runEventSeq,
          lastMessageAt: now,
          version: thread.version + 1,
          updatedAt: now,
        });
      if (Number(claimed) !== 1) {
        throw new AgentRuntimeError(409, "thread_version_conflict", "Thread 已被其他请求更新，请重试");
      }

      await (trx as any)("o_agent_message").insert({
        id: messageId,
        workspaceId: thread.workspaceId,
        projectId: thread.projectId,
        threadId: thread.id,
        runId,
        replyToId: null,
        clientMessageId,
        seq: messageSeq,
        role: "user",
        agentRole: null,
        visibility: "user",
        status: "completed",
        content: JSON.stringify(content),
        referenceRefs: JSON.stringify(resolvedContext.referenceRefs),
        createdBy: input.createdBy,
        error: null,
        metadata: JSON.stringify({
          contextSnapshot: resolvedContext.snapshot,
          requestDigest,
        }),
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      });

      await (trx as any)("o_agent_run").insert({
        id: runId,
        workspaceId: thread.workspaceId,
        projectId: thread.projectId,
        threadId: thread.id,
        rootRunId: runId,
        parentRunId: null,
        delegationId: null,
        blockedByRunId: null,
        kind: "root",
        agentRole: "main",
        triggerMessageId: messageId,
        responseMessageId: null,
        status: "queued",
        waitType: null,
        waitRef: null,
        wakeAt: null,
        policySnapshot: JSON.stringify(policySnapshot),
        contextVersion: thread.version,
        spendLimitMicros: 0,
        actualSpendMicros: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        // `attempt` is a monotonic claim generation. Recovery exhaustion is
        // governed only by this per-Run snapshot and `recoveryCount`.
        attempt: 0,
        maxAttempts: runRecoveryMaxAttempts,
        recoveryCount: 0,
        checkpointStepSeq: 0,
        sideEffectsCommitted: 0,
        cancelRequestedAt: null,
        cancelRequestedBy: null,
        cancelReason: null,
        error: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
      });

      await appendAgentEvent(trx, {
        workspaceId: thread.workspaceId,
        projectId: thread.projectId,
        threadId: thread.id,
        runId,
        messageId,
        seq: messageEventSeq,
        type: "message.created",
        payload: { messageId, seq: messageSeq, role: "user" },
        createdAt: now,
      });
      await appendAgentEvent(trx, {
        workspaceId: thread.workspaceId,
        projectId: thread.projectId,
        threadId: thread.id,
        runId,
        messageId,
        seq: runEventSeq,
        type: "run.queued",
        payload: { runId, agentRole: "main" },
        createdAt: now,
      });

      const [messageRow, runRow] = await Promise.all([
        (trx as any)("o_agent_message").where({ id: messageId }).first(),
        (trx as any)("o_agent_run").where({ id: runId }).first(),
      ]);
      return { message: mapAgentMessage(messageRow), run: mapAgentRun(runRow), replayed: false };
    });
    return result;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrentReplay = await replayClientMessage(
      input.workspaceId,
      input.threadId,
      clientMessageId,
      content,
      requestDigest,
    );
    if (concurrentReplay) return concurrentReplay;
    throw error;
  }
}

export async function cancelAgentRun(input: {
  workspaceId: string;
  runId: string;
  requestedBy: number;
  reason?: string | null;
  now?: number;
}): Promise<{ run: AgentRun; replayed: boolean }> {
  const now = input.now ?? Date.now();
  const result = await (db as unknown as Knex).transaction(async (trx) => {
    const rawRun = await (trx as any)("o_agent_run")
      .where({ id: input.runId, workspaceId: input.workspaceId })
      .forUpdate()
      .first();
    if (!rawRun) throw new AgentRuntimeError(404, "run_not_found", "Agent Run 不存在");
    if (isDelegationRootCancellationCandidate(rawRun)) {
      const grantService = new DelegationGrantService(db as unknown as Knex, {
        signingSecret: requireAgentRuntimeDelegationSigningSecret(),
        clock: () => now,
      });
      const cancellationService = new DelegationCancellationService(db as unknown as Knex, {
        grantService,
        clock: () => now,
      });
      return cancellationService.cancelLockedInTransaction(trx, {
        workspaceId: input.workspaceId,
        rootRunId: input.runId,
        requestedBy: input.requestedBy,
        reason: input.reason,
        now,
      }, rawRun);
    }
    const run = mapAgentRun(rawRun);
    const currentStatus = run.status as RunStatus;
    if (isTerminalRunStatus(currentStatus) || currentStatus === "cancelling") {
      return { run, replayed: true };
    }

    const isUnleasedApprovalWait = currentStatus === "waiting_approval" && run.leaseOwner === null;
    const nextStatus: RunStatus = currentStatus === "queued" || isUnleasedApprovalWait
      ? "cancelled"
      : "cancelling";
    assertRunTransition(currentStatus, nextStatus);

    const rawThread = await (trx as any)("o_agent_thread")
      .where({ id: run.threadId, workspaceId: input.workspaceId })
      .first();
    if (!rawThread) throw new AgentRuntimeError(500, "run_thread_missing", "Run 对应 Thread 不存在");
    const thread = mapAgentThread(rawThread);

    let revokedApproval: Awaited<ReturnType<typeof revokePendingAgentApprovalInTransaction>> | null = null;
    if (isUnleasedApprovalWait) {
      if (run.waitType !== "approval" || !run.waitRef) {
        throw new AgentRuntimeError(409, "approval_wait_conflict", "Run 缺少精确审批等待引用，请重试");
      }
      revokedApproval = await revokePendingAgentApprovalInTransaction(trx, {
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        runId: run.id,
        approvalId: run.waitRef,
        revokedBy: input.requestedBy,
        now,
      });
    }

    const runUpdated = await (trx as any)("o_agent_run")
      .where({ id: run.id, version: run.version, status: currentStatus })
      .update({
        status: nextStatus,
        cancelRequestedAt: now,
        cancelRequestedBy: input.requestedBy,
        cancelReason: cleanReason(input.reason),
        waitType: nextStatus === "cancelled" ? null : run.waitType,
        waitRef: nextStatus === "cancelled" ? null : run.waitRef,
        wakeAt: nextStatus === "cancelled" ? null : run.wakeAt,
        leaseOwner: nextStatus === "cancelled" ? null : run.leaseOwner,
        leaseExpiresAt: nextStatus === "cancelled" ? null : run.leaseExpiresAt,
        heartbeatAt: nextStatus === "cancelled" ? null : run.heartbeatAt,
        completedAt: nextStatus === "cancelled" ? now : null,
        version: run.version + 1,
        updatedAt: now,
      });
    if (Number(runUpdated) !== 1) {
      throw new AgentRuntimeError(409, "run_version_conflict", "Run 已被其他请求更新，请重试");
    }

    let responseMessageStopped = false;
    if (nextStatus === "cancelled" && run.responseMessageId) {
      const responseUpdated = await (trx as any)("o_agent_message")
        .where({
          id: run.responseMessageId,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          runId: run.id,
          role: "assistant",
        })
        .whereIn("status", ["pending", "streaming"])
        .update({
          status: "stopped",
          error: JSON.stringify(CANCELLED_MESSAGE_ERROR),
          updatedAt: now,
          completedAt: now,
        });
      responseMessageStopped = Number(responseUpdated) === 1;
    }
    if (isUnleasedApprovalWait && !responseMessageStopped) {
      throw new AgentRuntimeError(409, "approval_wait_conflict", "Run 的回复消息已变化，请重试");
    }

    const firstEventSeq = thread.eventSeq + 1;
    const messageEventSeq = firstEventSeq + (revokedApproval ? 1 : 0);
    const terminalEventSeq = messageEventSeq + (responseMessageStopped ? 1 : 0);

    const threadPatch: Record<string, unknown> = {
      eventSeq: terminalEventSeq,
      version: thread.version + 1,
      updatedAt: now,
    };
    if (responseMessageStopped) threadPatch.lastMessageAt = now;
    if (nextStatus === "cancelled" && thread.activeRootRunId === run.id) {
      threadPatch.activeRootRunId = null;
    }
    const threadUpdated = await (trx as any)("o_agent_thread")
      .where({ id: thread.id, version: thread.version })
      .update(threadPatch);
    if (Number(threadUpdated) !== 1) {
      throw new AgentRuntimeError(409, "thread_version_conflict", "Thread 已被其他请求更新，请重试");
    }

    if (revokedApproval) {
      await appendAgentEvent(trx, {
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        threadId: run.threadId,
        runId: run.id,
        stepId: revokedApproval.stepId,
        seq: firstEventSeq,
        type: "approval.revoked",
        payload: { approval: toSafeAgentApprovalDto(revokedApproval) },
        createdAt: now,
      });
    }

    if (responseMessageStopped && run.responseMessageId) {
      await appendAgentEvent(trx, {
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        threadId: run.threadId,
        runId: run.id,
        messageId: run.responseMessageId,
        seq: messageEventSeq,
        type: "message.stopped",
        payload: {
          messageId: run.responseMessageId,
          status: "stopped",
          code: CANCELLED_MESSAGE_ERROR.code,
        },
        createdAt: now,
      });
    }

    await appendAgentEvent(trx, {
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      threadId: run.threadId,
      runId: run.id,
      messageId: run.responseMessageId,
      seq: terminalEventSeq,
      type: nextStatus === "cancelled" ? "run.cancelled" : "run.status",
      payload: { runId: run.id, status: nextStatus },
      createdAt: now,
    });

    const updated = await getAgentRun({ id: run.id, workspaceId: input.workspaceId, database: trx });
    if (!updated) throw new AgentRuntimeError(500, "run_update_missing", "Run 更新后读取失败");
    return { run: updated, replayed: false };
  });

  // 兼容历史已预扣 Run 的自动退款；新的 Token 实结算 Run 没有固定费可退（幂等、尽力而为，不影响取消结果）。
  if (result.run.status === "cancelled") {
    await settleAgentChatBillingOnTerminalRun({ runId: result.run.id }).catch((error) => {
      console.error("[agent-chat-billing] 取消退款失败", {
        runId: result.run.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return result;
}
