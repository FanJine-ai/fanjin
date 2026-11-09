import { ApiError, normalizeBaseUrl, readApiSettings } from "../../api/http";
import { agentMessageDeltaFromEvent, type AgentMessageDelta } from "./messageDelta";
import type {
  AgentMessageAttachmentInput,
  AgentMessageContextSnapshotInput,
  AgentMessageSkillRefInput,
  AgentSkillCatalogItem,
  AgentRoleConfigListResult,
  AgentRuntimeEvent,
  AgentRuntimeEnsureResult,
  AgentRuntimeConfigStepUpResult,
  AgentRuntimeMessagePage,
  AgentRuntimeMessageSubmission,
  AgentRuntimeRole,
  AgentRuntimeRun,
  AgentRuntimeStep,
  AgentRuntimeStepPage,
  AgentRuntimeThread,
  AgentRuntimeThreadPage,
  AgentSurfaceAvailability,
  UpdateAgentRoleConfigInput,
  UpdateAgentRoleConfigResult,
} from "./types";

type AgentRequestOptions = {
  method?: "GET" | "POST" | "PUT";
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

type AgentEventStreamOptions = {
  after?: number;
  signal?: AbortSignal;
  onEvent: (event: AgentRuntimeEvent) => void | boolean;
  /**
   * message.delta 专用回调(REVAMP-PLAN 4.1)。delta 是瞬态预览:无 SSE id、
   * 不占 eventSeq,不进入 onEvent 的持久事件流,也不推进游标。
   */
  onMessageDelta?: (delta: AgentMessageDelta) => void;
};

type AgentEventStreamResult = {
  lastSequence: number;
  stopped: boolean;
};

function agentUrl(path: string) {
  const { baseUrl } = readApiSettings();
  return `${normalizeBaseUrl(baseUrl)}/${path.replace(/^\/+/, "")}`;
}

async function responseError(response: Response) {
  const data = await response.json().catch(() => ({}));
  const message = data?.message || data?.error?.message || `请求失败：${response.status}`;
  const nestedCode = typeof data?.data?.code === "string" ? data.data.code : undefined;
  const responseCode = nestedCode
    ?? (typeof data?.code === "string" ? data.code : undefined)
    ?? (typeof data?.error?.code === "string" ? data.error.code : undefined);
  const code = responseCode
    ?? (response.status === 404 && message === "API 404 Not Found"
      ? "agent_runtime_unavailable"
      : response.status >= 500
        ? "internal_error"
        : `http_${response.status}`);
  const bodyRequestId = typeof data?.requestId === "string" ? data.requestId.trim() : "";
  const headerRequestId = response.headers?.get?.("X-Request-Id")?.trim() || "";
  return new ApiError(message, {
    status: response.status,
    code,
    requestId: bodyRequestId || headerRequestId || undefined,
  });
}

async function agentRequest<T>(path: string, options: AgentRequestOptions = {}): Promise<T> {
  const settings = readApiSettings();
  const method = options.method || "GET";
  const response = await fetch(agentUrl(path), {
    method,
    signal: options.signal,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(settings.token ? { Authorization: settings.token } : {}),
      ...(options.headers || {}),
    },
    body: method !== "GET" ? JSON.stringify(options.body ?? {}) : undefined,
  });
  if (!response.ok) throw await responseError(response);
  const data = await response.json().catch(() => ({}));
  return (data?.data ?? data) as T;
}

export function getAgentRoleConfigs(signal?: AbortSignal) {
  return agentRequest<AgentRoleConfigListResult>("agent/config/roles", { signal });
}

export function updateAgentRoleConfig(
  role: AgentRuntimeRole,
  input: UpdateAgentRoleConfigInput,
  stepUpProof: string,
  signal?: AbortSignal,
) {
  return agentRequest<UpdateAgentRoleConfigResult>(
    `agent/config/roles/${encodeURIComponent(role)}`,
    {
      method: "PUT",
      body: input,
      headers: { "X-Fanjin-Step-Up": stepUpProof },
      signal,
    },
  );
}

export function issueAgentRoleConfigStepUp(input: { password: string; code?: string | null }, signal?: AbortSignal) {
  return agentRequest<AgentRuntimeConfigStepUpResult>("account/security/step-up", {
    method: "POST",
    body: {
      password: input.password,
      code: input.code?.trim() || null,
      scope: "admin.agent_runtime_config",
    },
    signal,
  });
}

export function createAgentThread(input: {
  projectId: number;
  title: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}) {
  // A transport failure after dispatch has an unknown server outcome. Even
  // with an idempotency key, the browser must recover with GETs rather than
  // silently issuing a second mutation request.
  return agentRequest<AgentRuntimeThread>("agent/threads", {
    method: "POST",
    signal: input.signal,
    headers: { "Idempotency-Key": input.idempotencyKey },
    body: {
      projectId: input.projectId,
      title: input.title,
    },
  });
}

export function ensureAgentThread(input: {
  projectId?: number | null;
  projectName?: string;
  title: string;
  goal: string;
  parameters?: Record<string, unknown>;
  idempotencyKey: string;
  signal?: AbortSignal;
}) {
  return agentRequest<AgentRuntimeEnsureResult>("agent/threads/ensure", {
    method: "POST",
    signal: input.signal,
    headers: { "Idempotency-Key": input.idempotencyKey },
    body: {
      projectId: input.projectId ?? null,
      projectName: input.projectName,
      title: input.title,
      session: {
        goal: input.goal,
        mode: "agent",
        inputs: [],
        parameters: input.parameters ?? {},
        selectedAssetVersionIds: [],
      },
    },
  });
}

export function getAgentThread(threadId: string, signal?: AbortSignal) {
  return agentRequest<AgentRuntimeThread>(`agent/threads/${encodeURIComponent(threadId)}`, { signal });
}

export function listAgentThreads(projectId: number, options?: { limit?: number; before?: string; signal?: AbortSignal }) {
  const params = new URLSearchParams({
    projectId: String(projectId),
    limit: String(options?.limit ?? 100),
  });
  if (options?.before) params.set("before", options.before);
  return agentRequest<AgentRuntimeThreadPage>(`agent/threads?${params.toString()}`, { signal: options?.signal });
}

export async function listAllAgentThreads(projectId: number, signal?: AbortSignal) {
  const threads: AgentRuntimeThread[] = [];
  let before: string | undefined;
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await listAgentThreads(projectId, { before, limit: 100, signal });
    threads.push(...page.data);
    if (!page.nextCursor || page.nextCursor === before) break;
    before = page.nextCursor;
  }
  return threads;
}

export function listAgentMessages(threadId: string, options?: { after?: number; limit?: number; signal?: AbortSignal }) {
  const params = new URLSearchParams({ limit: String(options?.limit ?? 200) });
  if (options?.after !== undefined) params.set("after", String(options.after));
  return agentRequest<AgentRuntimeMessagePage>(
    `agent/threads/${encodeURIComponent(threadId)}/messages?${params.toString()}`,
    { signal: options?.signal },
  );
}

export async function listAllAgentMessages(threadId: string, signal?: AbortSignal) {
  const messages = [] as AgentRuntimeMessagePage["data"];
  let after = 0;
  for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
    const page = await listAgentMessages(threadId, { after, limit: 200, signal });
    messages.push(...page.data);
    if (page.nextCursor === null || page.nextCursor <= after) break;
    after = page.nextCursor;
  }
  return messages;
}

export function sendAgentTextMessage(input: {
  threadId: string;
  clientMessageId: string;
  retryOfRunId?: string;
  text: string;
  model?: string | null;
  attachments?: AgentMessageAttachmentInput[];
  skillRefs?: AgentMessageSkillRefInput[];
  contextSnapshot?: AgentMessageContextSnapshotInput;
  signal?: AbortSignal;
}) {
  // Exactly one mutation attempt. The caller persists clientMessageId and
  // resolves an unknown transport outcome through message/thread GETs.
  return agentRequest<AgentRuntimeMessageSubmission>(
    `agent/threads/${encodeURIComponent(input.threadId)}/messages`,
    {
      method: "POST",
      signal: input.signal,
      body: {
        clientMessageId: input.clientMessageId,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
        content: [{ type: "text", text: input.text }],
        ...(input.model ? { model: input.model } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.skillRefs?.length ? { skillRefs: input.skillRefs } : {}),
        ...(input.contextSnapshot ? { contextSnapshot: input.contextSnapshot } : {}),
      },
    },
  );
}

/** Public, content-free catalog of canonical Runtime skills selectable by users. */
export function listAgentSkills(signal?: AbortSignal) {
  return agentRequest<{ skills: AgentSkillCatalogItem[] }>("agent/skills", { signal });
}

export function listAgentChatModels(signal?: AbortSignal) {
  return agentRequest<AgentSurfaceAvailability>("agent/chat-models", { signal });
}

export function getAgentRun(runId: string, signal?: AbortSignal) {
  return agentRequest<AgentRuntimeRun>(`agent/runs/${encodeURIComponent(runId)}`, { signal });
}

export function listAgentRunSteps(
  runId: string,
  options?: { after?: number; limit?: number; signal?: AbortSignal },
) {
  const params = new URLSearchParams({ limit: String(options?.limit ?? 200) });
  if (options?.after !== undefined) params.set("after", String(options.after));
  return agentRequest<AgentRuntimeStepPage>(
    `agent/runs/${encodeURIComponent(runId)}/steps?${params.toString()}`,
    { signal: options?.signal },
  );
}

export async function listAllAgentRunSteps(runId: string, signal?: AbortSignal) {
  let steps: AgentRuntimeStep[] = [];
  let after = 0;
  for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
    const page = await listAgentRunSteps(runId, { after, limit: 200, signal });
    if (!page || !Array.isArray(page.data)) {
      throw new ApiError("Agent 运行步骤接口暂不可用", { code: "agent_steps_unavailable" });
    }
    steps = [...steps, ...page.data];
    if (page.nextCursor === null || !Number.isSafeInteger(page.nextCursor) || page.nextCursor <= after) break;
    after = page.nextCursor;
  }
  return steps;
}

export function cancelAgentRun(runId: string, reason = "用户从创作页停止本轮") {
  return agentRequest<AgentRuntimeRun & { replayed?: boolean }>(
    `agent/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST", body: { reason } },
  );
}

function normalizeSseEvent(eventName: string, dataLines: string[]) {
  if (!dataLines.length) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    ...payload,
    type: typeof payload.type === "string" ? payload.type : eventName || "message",
  } as AgentRuntimeEvent;
}

export async function streamAgentEvents(threadId: string, options: AgentEventStreamOptions): Promise<AgentEventStreamResult> {
  const settings = readApiSettings();
  const params = new URLSearchParams({ after: String(Math.max(0, options.after ?? 0)) });
  const response = await fetch(agentUrl(`agent/threads/${encodeURIComponent(threadId)}/events?${params.toString()}`), {
    method: "GET",
    signal: options.signal,
    headers: {
      Accept: "text/event-stream",
      ...(settings.token ? { Authorization: settings.token } : {}),
    },
  });
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new ApiError("浏览器无法读取 Agent 事件流", { status: response.status });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastSequence = Math.max(0, options.after ?? 0);
  let stopped = false;

  const consumeBlock = (block: string) => {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const rawLine of block.split(/\r?\n/)) {
      if (!rawLine || rawLine.startsWith(":")) continue;
      const separator = rawLine.indexOf(":");
      const field = separator < 0 ? rawLine : rawLine.slice(0, separator);
      const value = separator < 0 ? "" : rawLine.slice(separator + 1).replace(/^ /, "");
      if (field === "event") eventName = value;
      if (field === "data") dataLines.push(value);
      if (field === "id") {
        const sequence = Number(value);
        if (Number.isFinite(sequence)) lastSequence = Math.max(lastSequence, sequence);
      }
    }
    const event = normalizeSseEvent(eventName, dataLines);
    if (!event) return;
    if (event.type === "message.delta") {
      const delta = agentMessageDeltaFromEvent(event);
      if (delta) options.onMessageDelta?.(delta);
      return;
    }
    if (typeof event.seq === "number") lastSequence = Math.max(lastSequence, event.seq);
    if (event.type === "error") {
      throw new ApiError(event.message || "Agent 事件流中断", { code: event.code });
    }
    if (options.onEvent(event) === false) stopped = true;
  };

  try {
    while (!stopped) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const match = buffer.slice(boundary).match(/^\r?\n\r?\n/);
        const delimiterLength = match?.[0].length || 2;
        consumeBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + delimiterLength);
        if (stopped) break;
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (done) {
        if (buffer.trim()) consumeBlock(buffer);
        break;
      }
    }
  } finally {
    if (stopped) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  return { lastSequence, stopped };
}
