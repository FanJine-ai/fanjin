import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { logger } from "@/lib/logger";

/**
 * Agent 生成任务终态通知（REVAMP-PLAN 2.2 视频异步任务接力 / 架构 V2 §10.1
 * 「任务完成后通过系统消息更新线程」）。
 *
 * relay 视频任务（requestId 前缀 `agent-video-submit:{runId}:{stepId}`）到达
 * 终态后，向发起 Run 所属 Thread 追加一条 system 可见消息 + message.created
 * 事件；SSE 消费端据此刷新消息列表。幂等键 = 固定消息 id
 * `relay-notice:{taskId}`，重复回调/刷新由唯一约束吞掉。
 *
 * 本服务只做追加通知，不改写 Run 终态（Run 在提交时刻已完成，异步结果
 * 通过线程系统消息呈现，与架构 §10.1 一致）。
 */

const AGENT_VIDEO_SUBMIT_REQUEST_ID_PREFIX = "agent-video-submit:";

export type AgentTaskTerminalOutcome = "succeeded" | "failed" | "cancelled";

export interface AgentVideoTaskTerminalNoticeInput {
  database: Knex | Knex.Transaction;
  taskId: string;
  requestId: string | null | undefined;
  workspaceId: string | null | undefined;
  outcome: AgentTaskTerminalOutcome;
  /** 成功时写回的资产链接（o_assets/o_image）。 */
  assetLink?: { assetId: number; assetVersionId: number } | null;
  /** 失败/取消原因（已脱敏）。 */
  errorMessage?: string | null;
  now?: number;
}

interface AgentRunScopeRow {
  id: string;
  workspaceId: string;
  projectId: number;
  threadId: string;
  status: string;
  waitType: string | null;
  waitRef: string | null;
  version: number | null;
}

interface AgentThreadRow {
  id: string;
  workspaceId: string;
  projectId: number;
  messageSeq: number;
  eventSeq: number;
  version: number;
}

export interface AgentTaskTerminalNoticeResult {
  notified: boolean;
  reason:
    | "delivered"
    | "duplicate"
    | "not_agent_request"
    | "run_not_found"
    | "thread_not_found";
  messageId: string | null;
}

function isUniqueConstraintError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return candidate?.code === "23505"
    || candidate?.code === "SQLITE_CONSTRAINT"
    || candidate?.code === "SQLITE_CONSTRAINT_UNIQUE"
    || String(candidate?.message || "").toLowerCase().includes("unique constraint");
}

function parseAgentVideoSubmitRequestId(
  requestId: string | null | undefined,
): { runId: string; stepId: string } | null {
  const raw = String(requestId || "").trim();
  if (!raw.startsWith(AGENT_VIDEO_SUBMIT_REQUEST_ID_PREFIX)) return null;
  const rest = raw.slice(AGENT_VIDEO_SUBMIT_REQUEST_ID_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  const runId = rest.slice(0, separator);
  const stepId = rest.slice(separator + 1);
  if (!runId || !stepId || /[\s\u0000]/.test(runId) || /[\s\u0000]/.test(stepId)) return null;
  return { runId, stepId };
}

function noticeText(input: {
  outcome: AgentTaskTerminalOutcome;
  errorMessage?: string | null;
  assetLink?: { assetId: number; assetVersionId: number } | null;
}): string {
  if (input.outcome === "succeeded") {
    const link = input.assetLink;
    return link
      ? `视频生成完成，成片已写入项目资产库（资产 #${link.assetId}，版本 #${link.assetVersionId}）。`
      : "视频生成完成，成片已写入项目资产库。";
  }
  if (input.outcome === "cancelled") {
    return `视频生成任务已取消${input.errorMessage ? `：${input.errorMessage}` : "。"}`;
  }
  return `视频生成失败${input.errorMessage ? `：${input.errorMessage}` : "，费用已按计费规则处理。"}`;
}

/**
 * 追加任务终态系统消息。调用方(relay worker)不在 Gateway 事务内,
 * 传入全局连接即可;任何内部失败只记日志返回 not notified,绝不影响
 * relay 任务终态提交。
 */
export async function notifyAgentVideoGenerationTaskTerminal(
  input: AgentVideoTaskTerminalNoticeInput,
): Promise<AgentTaskTerminalNoticeResult> {
  const database = input.database;
  const now = input.now ?? Date.now();
  const parsed = parseAgentVideoSubmitRequestId(input.requestId);
  if (!parsed) {
    return { notified: false, reason: "not_agent_request", messageId: null };
  }
  const messageId = `relay-notice:${input.taskId}`;

  try {
    const run = await database<AgentRunScopeRow>("o_agent_run")
      .where({
        id: parsed.runId,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      })
      .select("id", "workspaceId", "projectId", "threadId", "status", "waitType", "waitRef", "version")
      .first();
    if (!run) {
      return { notified: false, reason: "run_not_found", messageId: null };
    }
    const thread = await database<AgentThreadRow>("o_agent_thread")
      .where({ id: run.threadId, workspaceId: run.workspaceId })
      .select("id", "workspaceId", "projectId", "messageSeq", "eventSeq", "version")
      .first();
    if (!thread) {
      return { notified: false, reason: "thread_not_found", messageId: null };
    }

    const content = JSON.stringify([
      { type: "text", text: noticeText(input) },
    ]);
    const metadata = JSON.stringify({
      kind: "relay_task_terminal",
      relayTaskId: input.taskId,
      outcome: input.outcome,
      runId: run.id,
      stepId: parsed.stepId,
      ...(input.assetLink
        ? { assetId: input.assetLink.assetId, assetVersionId: input.assetLink.assetVersionId }
        : {}),
    });

    await database.transaction(async (trx) => {
      const threadVersion = Number(thread.version || 0);
      const messageSeq = Number(thread.messageSeq || 0) + 1;
      const eventSeq = Number(thread.eventSeq || 0) + 1;

      // Executor V3（storyVideo 管线）：waiting_external 的 executor Run
      // 在任一段 relay 任务终态时被 CAS requeue，Worker 重新认领后折叠
      // 全部段终态。非等待态 Run 不受影响；CAS 失败说明另一通知/恢复
      // 已先赢，按幂等语义静默让位。
      const expectedWaitRef = `executor-transitions:${run.id}`;
      if (run.status === "waiting_external"
        && run.waitType === "external"
        && run.waitRef === expectedWaitRef) {
        const runVersion = Number(run.version || 0);
        await trx("o_agent_run")
          .where({
            id: run.id,
            status: "waiting_external",
            waitType: "external",
            waitRef: expectedWaitRef,
            version: runVersion,
          })
          .update({
            status: "queued",
            waitType: null,
            waitRef: null,
            wakeAt: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            version: runVersion + 1,
            updatedAt: now,
          });
      }

      const threadUpdated = await trx("o_agent_thread")
        .where({ id: thread.id, workspaceId: thread.workspaceId, version: threadVersion })
        .update({
          messageSeq,
          eventSeq,
          lastMessageAt: now,
          version: threadVersion + 1,
          updatedAt: now,
        });
      if (Number(threadUpdated || 0) !== 1) {
        throw new Error("thread version conflict");
      }

      await trx("o_agent_message").insert({
        id: messageId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        threadId: thread.id,
        runId: run.id,
        replyToId: null,
        clientMessageId: null,
        seq: messageSeq,
        role: "system",
        agentRole: null,
        visibility: "user",
        status: "completed",
        content,
        referenceRefs: "[]",
        createdBy: null,
        error: null,
        metadata,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      });

      await trx("o_agent_event").insert({
        id: randomUUID(),
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        threadId: thread.id,
        runId: run.id,
        messageId,
        stepId: null,
        seq: eventSeq,
        type: "message.created",
        payload: JSON.stringify({
          messageId,
          seq: messageSeq,
          role: "system",
          status: "completed",
        }),
        createdAt: now,
        expiresAt: null,
      });

      return messageSeq;
    });
    return { notified: true, reason: "delivered", messageId };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // 固定消息 id 已存在 = 该任务的通知已投递过(重复回调/并发刷新)。
      return { notified: false, reason: "duplicate", messageId };
    }
    logger.warn(
      {
        taskId: input.taskId,
        requestId: input.requestId,
        error: (error as { message?: unknown })?.message || error,
      },
      "[agent-task-notify] 生成任务终态通知失败",
    );
    return { notified: false, reason: "run_not_found", messageId: null };
  }
}
