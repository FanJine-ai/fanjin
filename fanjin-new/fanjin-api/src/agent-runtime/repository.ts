import type { Knex } from "knex";
import db from "@/utils/db";
import type { AgentRole } from "@/agent-runtime/contracts";
import type { RunStatus } from "@/agent-runtime/stateMachine";
import { mapAgentStep } from "@/agent-runtime/stepMapper";
import type {
  AgentContentPart,
  AgentEvent,
  AgentMessage,
  AgentMessageRole,
  AgentMessageStatus,
  AgentMessageVisibility,
  AgentRun,
  AgentRunKind,
  AgentStep,
  AgentThread,
  AgentThreadStatus,
} from "@/agent-runtime/types";

export type AgentDatabase = Knex | Knex.Transaction;

interface AgentThreadCursorValue {
  updatedAt: number;
  id: string;
}

function client(database?: AgentDatabase): AgentDatabase {
  return database ?? (db as unknown as Knex);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function optionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function decodeAgentThreadCursor(value: string): AgentThreadCursorValue {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<AgentThreadCursorValue>;
  if (!Number.isSafeInteger(parsed.updatedAt) || Number(parsed.updatedAt) < 0 || typeof parsed.id !== "string" || !parsed.id) {
    throw new TypeError("无效 Agent Thread 分页游标");
  }
  return { updatedAt: Number(parsed.updatedAt), id: parsed.id };
}

function encodeAgentThreadCursor(value: AgentThreadCursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function isAgentThreadCursor(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 500) return false;
  try {
    decodeAgentThreadCursor(value);
    return true;
  } catch {
    return false;
  }
}

export function mapAgentThread(row: any): AgentThread {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    projectId: Number(row.projectId),
    sessionId: row.sessionId == null ? null : String(row.sessionId),
    title: String(row.title || ""),
    status: String(row.status) as AgentThreadStatus,
    activeRootRunId: row.activeRootRunId == null ? null : String(row.activeRootRunId),
    messageSeq: Number(row.messageSeq || 0),
    eventSeq: Number(row.eventSeq || 0),
    lastMessageAt: optionalNumber(row.lastMessageAt),
    version: Number(row.version || 0),
    createdBy: Number(row.createdBy || 0),
    metadata: parseJson(row.metadata, {}),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
    archivedAt: optionalNumber(row.archivedAt),
  };
}

export function mapAgentMessage(row: any): AgentMessage {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    projectId: Number(row.projectId),
    threadId: String(row.threadId),
    runId: row.runId == null ? null : String(row.runId),
    replyToId: row.replyToId == null ? null : String(row.replyToId),
    clientMessageId: row.clientMessageId == null ? null : String(row.clientMessageId),
    seq: Number(row.seq || 0),
    role: String(row.role) as AgentMessageRole,
    agentRole: row.agentRole == null ? null : (String(row.agentRole) as AgentRole),
    visibility: String(row.visibility) as AgentMessageVisibility,
    status: String(row.status) as AgentMessageStatus,
    content: parseJson<AgentContentPart[]>(row.content, []),
    referenceRefs: parseJson<string[]>(row.referenceRefs, []),
    createdBy: optionalNumber(row.createdBy),
    error: row.error == null ? null : parseJson<Record<string, unknown>>(row.error, {}),
    metadata: parseJson(row.metadata, {}),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
    completedAt: optionalNumber(row.completedAt),
  };
}

export function mapAgentRun(row: any): AgentRun {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    projectId: Number(row.projectId),
    threadId: String(row.threadId),
    rootRunId: String(row.rootRunId),
    parentRunId: row.parentRunId == null ? null : String(row.parentRunId),
    delegationId: row.delegationId == null ? null : String(row.delegationId),
    blockedByRunId: row.blockedByRunId == null ? null : String(row.blockedByRunId),
    kind: String(row.kind) as AgentRunKind,
    agentRole: String(row.agentRole) as AgentRole,
    triggerMessageId: String(row.triggerMessageId),
    responseMessageId: row.responseMessageId == null ? null : String(row.responseMessageId),
    status: String(row.status) as RunStatus,
    waitType: row.waitType == null ? null : String(row.waitType),
    waitRef: row.waitRef == null ? null : String(row.waitRef),
    wakeAt: optionalNumber(row.wakeAt),
    policySnapshot: parseJson(row.policySnapshot, {}),
    contextVersion: Number(row.contextVersion || 0),
    spendLimitMicros: Number(row.spendLimitMicros || 0),
    actualSpendMicros: Number(row.actualSpendMicros || 0),
    leaseOwner: row.leaseOwner == null ? null : String(row.leaseOwner),
    leaseExpiresAt: optionalNumber(row.leaseExpiresAt),
    heartbeatAt: optionalNumber(row.heartbeatAt),
    attempt: Number(row.attempt || 0),
    maxAttempts: Number(row.maxAttempts || 0),
    recoveryCount: Number(row.recoveryCount || 0),
    checkpointStepSeq: Number(row.checkpointStepSeq || 0),
    sideEffectsCommitted: Boolean(Number(row.sideEffectsCommitted || 0)),
    cancelRequestedAt: optionalNumber(row.cancelRequestedAt),
    cancelRequestedBy: optionalNumber(row.cancelRequestedBy),
    cancelReason: row.cancelReason == null ? null : String(row.cancelReason),
    error: row.error == null ? null : parseJson<Record<string, unknown>>(row.error, {}),
    version: Number(row.version || 0),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
    startedAt: optionalNumber(row.startedAt),
    completedAt: optionalNumber(row.completedAt),
  };
}

export function mapAgentEvent(row: any): AgentEvent {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    projectId: Number(row.projectId),
    threadId: String(row.threadId),
    runId: row.runId == null ? null : String(row.runId),
    messageId: row.messageId == null ? null : String(row.messageId),
    stepId: row.stepId == null ? null : String(row.stepId),
    seq: Number(row.seq || 0),
    type: String(row.type),
    payload: parseJson(row.payload, {}),
    createdAt: Number(row.createdAt || 0),
    expiresAt: optionalNumber(row.expiresAt),
  };
}

export async function getAgentThread(input: {
  id: string;
  workspaceId: string;
  database?: AgentDatabase;
}): Promise<AgentThread | null> {
  const row = await (client(input.database) as any)("o_agent_thread")
    .where({ id: input.id, workspaceId: input.workspaceId })
    .first();
  return row ? mapAgentThread(row) : null;
}

export async function listAgentThreads(input: {
  workspaceId: string;
  projectId: number;
  before?: string | null;
  limit?: number;
  database?: AgentDatabase;
}): Promise<{ data: AgentThread[]; nextCursor: string | null }> {
  const limit = Math.min(100, Math.max(1, Number(input.limit || 30)));
  const query = (client(input.database) as any)("o_agent_thread")
    .where({ workspaceId: input.workspaceId, projectId: input.projectId })
    .orderBy("updatedAt", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1);
  if (input.before) {
    const cursor = decodeAgentThreadCursor(input.before);
    query.andWhere(function (this: Knex.QueryBuilder) {
      this.where("updatedAt", "<", cursor.updatedAt).orWhere(function (this: Knex.QueryBuilder) {
        this.where("updatedAt", cursor.updatedAt).andWhere("id", "<", cursor.id);
      });
    });
  }
  const rows = await query;
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit).map(mapAgentThread);
  return {
    data,
    nextCursor: hasMore && data.length
      ? encodeAgentThreadCursor({ updatedAt: data[data.length - 1].updatedAt, id: data[data.length - 1].id })
      : null,
  };
}

export async function getAgentMessage(input: {
  id: string;
  workspaceId: string;
  database?: AgentDatabase;
}): Promise<AgentMessage | null> {
  const row = await (client(input.database) as any)("o_agent_message")
    .where({ id: input.id, workspaceId: input.workspaceId })
    .first();
  return row ? mapAgentMessage(row) : null;
}

/** Latest non-terminal assistant preview for cross-process SSE streaming. */
export async function getLatestAgentStreamingMessage(input: {
  threadId: string;
  workspaceId: string;
  database?: AgentDatabase;
}): Promise<AgentMessage | null> {
  const row = await (client(input.database) as any)("o_agent_message")
    .where({
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      role: "assistant",
      visibility: "user",
    })
    .whereIn("status", ["pending", "streaming"])
    .orderBy("seq", "desc")
    .first();
  return row ? mapAgentMessage(row) : null;
}

export async function findAgentMessageByClientId(input: {
  threadId: string;
  clientMessageId: string;
  workspaceId: string;
  database?: AgentDatabase;
}): Promise<AgentMessage | null> {
  const row = await (client(input.database) as any)("o_agent_message")
    .where({
      threadId: input.threadId,
      clientMessageId: input.clientMessageId,
      workspaceId: input.workspaceId,
    })
    .first();
  return row ? mapAgentMessage(row) : null;
}

export async function listAgentMessages(input: {
  threadId: string;
  workspaceId: string;
  visibility: AgentMessageVisibility;
  after?: number;
  limit?: number;
  database?: AgentDatabase;
}): Promise<{ data: AgentMessage[]; nextCursor: number | null }> {
  const limit = Math.min(200, Math.max(1, Number(input.limit || 50)));
  const query = (client(input.database) as any)("o_agent_message")
    .where({ threadId: input.threadId, workspaceId: input.workspaceId, visibility: input.visibility })
    .andWhere("seq", ">", Math.max(0, Number(input.after || 0)))
    .orderBy("seq", "asc")
    .limit(limit + 1);
  const rows = await query;
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit).map(mapAgentMessage);
  return { data, nextCursor: hasMore && data.length ? data[data.length - 1].seq : null };
}

export async function getAgentRun(input: {
  id: string;
  workspaceId: string;
  database?: AgentDatabase;
}): Promise<AgentRun | null> {
  const row = await (client(input.database) as any)("o_agent_run")
    .where({ id: input.id, workspaceId: input.workspaceId })
    .first();
  return row ? mapAgentRun(row) : null;
}

export async function listAgentSteps(input: {
  runId: string;
  workspaceId: string;
  after?: number;
  limit?: number;
  database?: AgentDatabase;
}): Promise<{ data: AgentStep[]; nextCursor: number | null }> {
  const limit = Math.min(200, Math.max(1, Number(input.limit || 50)));
  const rows = await (client(input.database) as any)("o_agent_step")
    .where({ runId: input.runId, workspaceId: input.workspaceId })
    .andWhere("seq", ">", Math.max(0, Number(input.after || 0)))
    .orderBy("seq", "asc")
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit).map(mapAgentStep);
  return { data, nextCursor: hasMore && data.length ? data[data.length - 1].seq : null };
}

export async function findAgentRunByTriggerMessage(input: {
  triggerMessageId: string;
  workspaceId: string;
  database?: AgentDatabase;
}): Promise<AgentRun | null> {
  const row = await (client(input.database) as any)("o_agent_run")
    .where({ triggerMessageId: input.triggerMessageId, workspaceId: input.workspaceId })
    .first();
  return row ? mapAgentRun(row) : null;
}

export async function listAgentEvents(input: {
  threadId: string;
  workspaceId: string;
  after?: number;
  limit?: number;
  database?: AgentDatabase;
}): Promise<AgentEvent[]> {
  const limit = Math.min(500, Math.max(1, Number(input.limit || 100)));
  const rows = await (client(input.database) as any)("o_agent_event")
    .where({ threadId: input.threadId, workspaceId: input.workspaceId })
    .andWhere("seq", ">", Math.max(0, Number(input.after || 0)))
    .orderBy("seq", "asc")
    .limit(limit);
  return rows.map(mapAgentEvent);
}

export async function getAgentThreadForRun(input: {
  runId: string;
  workspaceId: string;
  database?: AgentDatabase;
}): Promise<AgentThread | null> {
  const row = await (client(input.database) as any)("o_agent_run as run")
    .join("o_agent_thread as thread", "thread.id", "run.threadId")
    .where({ "run.id": input.runId, "run.workspaceId": input.workspaceId, "thread.workspaceId": input.workspaceId })
    .select("thread.*")
    .first();
  return row ? mapAgentThread(row) : null;
}
