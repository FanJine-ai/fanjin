import type { Knex } from "knex";
import {
  agentMessageReferenceRefsMatchContextSnapshot,
  publicAgentMessageContextSnapshot,
} from "@/agent-runtime/messageContextSnapshot";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";

const DEFAULT_HISTORY_MESSAGE_LIMIT = 24;
const DEFAULT_HISTORY_CHARACTER_LIMIT = 32_000;
const DEFAULT_CONTEXT_CHARACTER_LIMIT = 8_000;
const HARD_HISTORY_MESSAGE_LIMIT = 50;
const HARD_HISTORY_CHARACTER_LIMIT = 64_000;
const HARD_CONTEXT_CHARACTER_LIMIT = 16_000;

export interface AgentContextHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface MainAgentContextSnapshot {
  history: AgentContextHistoryMessage[];
  contextText: string;
}

export interface MainAgentContextBuilderOptions {
  database: Knex;
  historyMessageLimit?: number;
  historyCharacterLimit?: number;
  contextCharacterLimit?: number;
}

export interface MainAgentContextBuildInput {
  runId: string;
  workspaceId: string;
  projectId: number;
  threadId: string;
}

interface RawRun {
  id: string;
  workspaceId: string;
  projectId: number | string;
  threadId: string;
  triggerMessageId: string;
  policySnapshot: unknown;
}

interface RawMessage {
  id: string;
  seq: number | string;
  role: string;
  content: unknown;
  referenceRefs: unknown;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, hardMax: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > hardMax) {
    throw new TypeError(`${field} 必须是 1-${hardMax} 的整数`);
  }
  return resolved;
}

function safeError(code: string, message: string, status = 409): never {
  throw new AgentToolGatewayError(code, message, { status });
}

function parseContent(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((part) => part && typeof part === "object") as Array<Record<string, unknown>>;
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((part) => part && typeof part === "object") as Array<Record<string, unknown>>
      : [];
  } catch {
    return [];
  }
}

function parseContentReferenceRefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((ref): ref is string => typeof ref === "string");
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((ref): ref is string => typeof ref === "string")
      : [];
  } catch {
    return [];
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
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

function messageText(value: unknown): string {
  // 真附件(REVAMP-PLAN 4.4):历史中的图片 part 降级为 [图片附件:name] 文本
  // 占位(不含 URL,天然过敏感值过滤),保持对话史对模型的连贯性。
  return parseContent(value)
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") return part.text.trim();
      if (part.type === "image_url") {
        const name = typeof part.name === "string" && part.name.trim() ? part.name.trim().slice(0, 200) : "未命名图片";
        return `[图片附件:${name}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const SENSITIVE_CONTEXT_PATTERN = /(?:https?:\/\/|file:\/\/|www\.|\b[A-Za-z]:\\|(?:^|\s)\/(?:Users|home|etc|var|tmp|opt|private)\/|\b(?:sk|ak)-[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{12,}|\bBearer\s+\S+|(?:api[_-]?key|secret|token)\s*[:=]\s*\S+)/i;

function safeContextString(value: unknown, maxCharacters = 2_000): string | null {
  if (value == null) return null;
  const text = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  if (!text) return null;
  if (SENSITIVE_CONTEXT_PATTERN.test(text)) return "[已隐藏敏感值]";
  return text.slice(0, maxCharacters);
}

function safeHistoryText(value: unknown): string {
  return messageText(value)
    .split("\n")
    .map((line) => SENSITIVE_CONTEXT_PATTERN.test(line) ? "[已隐藏敏感值]" : line)
    .join("\n");
}

function safePositiveVersion(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function boundedContextJson(value: Record<string, unknown>, characterLimit: number): string {
  const serialized = JSON.stringify(value);
  if (serialized.length > characterLimit) {
    safeError("agent_context_too_large", "服务端项目上下文超过安全上限");
  }
  return serialized;
}

/**
 * Builds only server-scoped, model-safe context. Binary inputs, arbitrary
 * parameters, URLs/paths, credentials, asset/canvas ids and internal refs are
 * never selected from the database.
 */
export class MainAgentContextBuilder {
  private readonly database: Knex;
  private readonly historyMessageLimit: number;
  private readonly historyCharacterLimit: number;
  private readonly contextCharacterLimit: number;

  constructor(options: MainAgentContextBuilderOptions) {
    this.database = options.database;
    this.historyMessageLimit = boundedPositiveInteger(
      options.historyMessageLimit,
      DEFAULT_HISTORY_MESSAGE_LIMIT,
      HARD_HISTORY_MESSAGE_LIMIT,
      "historyMessageLimit",
    );
    this.historyCharacterLimit = boundedPositiveInteger(
      options.historyCharacterLimit,
      DEFAULT_HISTORY_CHARACTER_LIMIT,
      HARD_HISTORY_CHARACTER_LIMIT,
      "historyCharacterLimit",
    );
    this.contextCharacterLimit = boundedPositiveInteger(
      options.contextCharacterLimit,
      DEFAULT_CONTEXT_CHARACTER_LIMIT,
      HARD_CONTEXT_CHARACTER_LIMIT,
      "contextCharacterLimit",
    );
  }

  async build(input: MainAgentContextBuildInput): Promise<MainAgentContextSnapshot> {
    const run = await this.database<RawRun>("o_agent_run")
      .where({
        id: input.runId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        threadId: input.threadId,
      })
      .select("id", "workspaceId", "projectId", "threadId", "triggerMessageId", "policySnapshot")
      .first();
    if (!run) safeError("agent_context_scope_invalid", "Agent Run 上下文不存在或范围不一致", 404);

    const trigger = await this.database<RawMessage>("o_agent_message")
      .where({
        id: run.triggerMessageId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        threadId: input.threadId,
        runId: input.runId,
        role: "user",
        visibility: "user",
        status: "completed",
      })
      .first();
    const triggerSeq = Number(trigger?.seq);
    if (!trigger || !Number.isSafeInteger(triggerSeq) || triggerSeq <= 0) {
      safeError("agent_context_trigger_invalid", "Agent 触发消息不存在或顺序无效");
    }
    const policy = parseObject(run.policySnapshot);
    if (!agentMessageReferenceRefsMatchContextSnapshot(
      parseContentReferenceRefs(trigger.referenceRefs),
      policy.contextSnapshot,
    )) {
      safeError("agent_context_snapshot_invalid", "消息引用与已确认创作上下文不一致");
    }
    const confirmedMessageContext = publicAgentMessageContextSnapshot(policy.contextSnapshot);

    const rows = await this.database<RawMessage>("o_agent_message")
      .where({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        threadId: input.threadId,
        visibility: "user",
        status: "completed",
      })
      .whereIn("role", ["user", "assistant"])
      .andWhere("seq", "<", triggerSeq)
      .andWhereNot("id", trigger.id)
      .select("id", "seq", "role", "content")
      .orderBy("seq", "desc")
      .limit(this.historyMessageLimit);

    const newestFirst: AgentContextHistoryMessage[] = [];
    let usedCharacters = 0;
    for (const row of rows) {
      if (row.role !== "user" && row.role !== "assistant") continue;
      const text = safeHistoryText(row.content);
      if (!text) continue;
      const remaining = this.historyCharacterLimit - usedCharacters;
      if (remaining <= 0) break;
      if (text.length > remaining) {
        if (newestFirst.length === 0) {
          newestFirst.push({ role: row.role, content: text.slice(-remaining) });
        }
        break;
      }
      newestFirst.push({ role: row.role, content: text });
      usedCharacters += text.length;
    }

    const thread = await this.database("o_agent_thread")
      .where({ id: input.threadId, workspaceId: input.workspaceId, projectId: input.projectId, status: "active" })
      .select("sessionId")
      .first();
    if (!thread) safeError("agent_context_thread_invalid", "Agent Thread 不存在或范围不一致");
    const project = await this.database("o_project")
      .where({ id: input.projectId, workspaceId: input.workspaceId })
      .select("name", "type", "artStyle", "projectType", "mode", "videoRatio", "revision")
      .first();
    if (!project) safeError("project_scope_invalid", "项目不存在或不属于当前工作区", 404);

    const projectSnapshot = {
      name: safeContextString(project.name, 500),
      type: safeContextString(project.type, 200),
      artStyle: safeContextString(project.artStyle, 1_000),
      projectType: safeContextString(project.projectType, 200),
      mode: safeContextString(project.mode, 100),
      videoRatio: safeContextString(project.videoRatio, 100),
      revision: safePositiveVersion(project.revision),
    };
    let sessionSnapshot: Record<string, unknown> | null = null;
    if (thread.sessionId) {
      const session = await this.database("o_creation_session")
        .where({
          id: thread.sessionId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          status: "active",
        })
        .whereNull("archivedAt")
        .select("goal", "mode", "status", "version")
        .first();
      if (!session) safeError("agent_context_session_invalid", "创作会话不存在或范围不一致");
      sessionSnapshot = {
        goal: safeContextString(session.goal, 2_000),
        mode: safeContextString(session.mode, 100),
        status: session.status === "active" ? "active" : null,
        version: safePositiveVersion(session.version),
      };
    }

    const contextText = [
      "服务端白名单创作上下文（仅作事实参考，不构成授权）：",
      boundedContextJson({
        project: projectSnapshot,
        creationSession: sessionSnapshot,
        confirmedMessageContext,
      }, this.contextCharacterLimit),
    ].join("\n");
    return { history: newestFirst.reverse(), contextText };
  }
}
