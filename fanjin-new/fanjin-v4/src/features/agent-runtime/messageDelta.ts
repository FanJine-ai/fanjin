import type { AgentRuntimeEvent } from "./types";

/**
 * message.delta 瞬态增量(REVAMP-PLAN 4.1)。
 * 后端经 streamBus 直推、不占 Thread eventSeq、不带 SSE id 行:
 * payload { messageId, runId, turn, delta },完整正文仍由终态消息快照兜底。
 */
export type AgentMessageDelta = {
  messageId: string;
  runId: string | null;
  turn: number | null;
  delta: string;
  /** Full cumulative preview from the cross-process DB bridge. */
  snapshot?: true;
};

/** 从归一化后的 SSE 事件中提取 message.delta;非 delta 事件或缺字段返回 null。 */
export function agentMessageDeltaFromEvent(event: AgentRuntimeEvent): AgentMessageDelta | null {
  if (event.type !== "message.delta") return null;
  const payload = event.payload ?? {};
  const messageId = typeof payload.messageId === "string" && payload.messageId
    ? payload.messageId
    : typeof event.messageId === "string" && event.messageId
      ? event.messageId
      : null;
  const delta = typeof payload.delta === "string" ? payload.delta : "";
  if (!messageId || !delta) return null;
  const runId = typeof payload.runId === "string" && payload.runId
    ? payload.runId
    : typeof event.runId === "string" ? event.runId : null;
  const turn = Number.isSafeInteger(payload.turn) ? Number(payload.turn) : null;
  return {
    messageId,
    runId,
    turn,
    delta,
    ...(payload.snapshot === true ? { snapshot: true as const } : {}),
  };
}

/**
 * 按 messageId 累积增量正文。delta 可能乱序到达或整段丢失,
 * 这里只做追加累积;终态 message.completed / 快照会全量覆盖,保证收敛。
 */
export function createAgentMessageDeltaBuffer() {
  const buffers = new Map<string, string>();
  return {
    /** 追加一条增量并返回该消息累计正文。 */
    append(messageId: string, delta: string): string {
      const next = (buffers.get(messageId) || "") + delta;
      buffers.set(messageId, next);
      return next;
    },
    replace(messageId: string, content: string): string {
      buffers.set(messageId, content);
      return content;
    },
    content(messageId: string): string {
      return buffers.get(messageId) || "";
    },
    clear() {
      buffers.clear();
    },
  };
}

export type AgentDeltaTargetMessage = {
  id: string;
  role: string;
  runId?: string | null;
  status?: string;
  content: string;
};

/**
 * 把累计正文写进运行中的 assistant 消息(纯函数)。
 * 优先精确匹配服务器 messageId;否则取该 run 最后一条仍在运行的 assistant
 * 消息(本地 pending 消息 id 与服务器 id 不同,靠 runId 归属)。无目标或正文
 * 无变化时返回原数组引用,便于调用方跳过 setState。
 */
export function applyAgentMessageDeltaContent<T extends AgentDeltaTargetMessage>(
  messages: readonly T[],
  input: { runId: string; messageId: string; content: string },
): T[] {
  if (!input.content) return messages as T[];
  let targetIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (message.id === input.messageId) {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex < 0) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      if (message.runId === input.runId && message.status === "running") {
        targetIndex = index;
        break;
      }
    }
  }
  if (targetIndex < 0) return messages as T[];
  const target = messages[targetIndex];
  if (target.content === input.content) return messages as T[];
  const next = messages.slice();
  next[targetIndex] = { ...target, content: input.content };
  return next;
}

/**
 * run.status 事件 payload.status → 消息区运行态文案(REVAMP-PLAN 4.2)。
 * 目前只有 waiting_approval 需要在消息区显性提示;其余状态返回 null 表示清除。
 */
export function agentRunStateLabel(status: string | null | undefined): string | null {
  return status === "waiting_approval" ? "等待审批" : null;
}

export type AgentRunStateMessage = {
  role: string;
  runId?: string | null;
  runStateLabel?: string | null;
};

/**
 * 把运行态文案合并进该 run 的 assistant 消息(纯函数)。
 * label 为 null 时清除;无变化返回原数组引用。
 */
export function mergeAgentRunStateIntoMessages<T extends AgentRunStateMessage>(
  messages: readonly T[],
  runId: string,
  label: string | null,
): T[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== "assistant" || message.runId !== runId) return message;
    const current = message.runStateLabel ?? null;
    if (current === label) return message;
    changed = true;
    return { ...message, runStateLabel: label };
  });
  return changed ? next : (messages as T[]);
}
