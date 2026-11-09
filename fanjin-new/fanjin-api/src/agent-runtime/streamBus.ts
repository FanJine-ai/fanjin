/**
 * Agent 增量正文进程内直推总线(REVAMP-PLAN 4.1)。
 *
 * message.delta 属于瞬态 UI 预览:不进 o_agent_event(避免每个 token 一行的
 * 表膨胀与 Thread eventSeq CAS 争用),只在本进程内推给活跃的 SSE 连接。
 * 持久真相仍是 finalize 写入的完整正文 + message.completed;750ms DB 轮询
 * 作为兜底通道原样保留。API/Worker 分进程部署时由 pending 消息的累计
 * 快照桥接，避免依赖仅存在于 Worker 进程内的订阅者。
 */

export interface AgentMessageStreamDelta {
  threadId: string;
  runId: string;
  messageId: string;
  turn: number;
  /** 单个上游 chunk 的增量正文(非累计值),发布前按 MAX_DELTA_TEXT_CHARS 截断。 */
  delta: string;
  createdAt: number;
}

export type AgentMessageStreamDeltaListener = (delta: AgentMessageStreamDelta) => void;

/** 防御性上限:单个增量事件正文字符数,异常上游也不放大推送面。 */
const MAX_DELTA_TEXT_CHARS = 4_096;
/** 防御性上限:单 Thread 并发 SSE 订阅数,超出部分直接丢弃(轮询兜底)。 */
const MAX_SUBSCRIBERS_PER_THREAD = 64;

const subscribers = new Map<string, Set<AgentMessageStreamDeltaListener>>();

export function publishAgentMessageDelta(input: AgentMessageStreamDelta): void {
  const listeners = subscribers.get(input.threadId);
  if (!listeners || listeners.size === 0) return;
  const delta: AgentMessageStreamDelta = input.delta.length > MAX_DELTA_TEXT_CHARS
    ? { ...input, delta: input.delta.slice(0, MAX_DELTA_TEXT_CHARS) }
    : input;
  for (const listener of [...listeners]) {
    try {
      listener(delta);
    } catch {
      // 订阅方(SSE 写盘)异常绝不能回灌模型 Turn;连接清理由路由侧负责。
    }
  }
}

export function subscribeAgentMessageDeltas(
  threadId: string,
  listener: AgentMessageStreamDeltaListener,
): (() => void) | null {
  let listeners = subscribers.get(threadId);
  if (!listeners) {
    listeners = new Set();
    subscribers.set(threadId, listeners);
  }
  if (listeners.size >= MAX_SUBSCRIBERS_PER_THREAD) {
    if (listeners.size === 0) subscribers.delete(threadId);
    return null;
  }
  listeners.add(listener);
  return () => {
    const current = subscribers.get(threadId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) subscribers.delete(threadId);
  };
}

/** 测试/诊断用:当前订阅数。 */
export function getAgentMessageDeltaSubscriberCount(threadId?: string): number {
  if (threadId !== undefined) return subscribers.get(threadId)?.size ?? 0;
  let total = 0;
  for (const listeners of subscribers.values()) total += listeners.size;
  return total;
}
