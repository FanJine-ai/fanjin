import { ApiError } from "../../api/http";

type AgentRuntimeFailure = {
  message: string;
  code: string;
  requestId?: string;
  recovery: string;
};

function diagnosticToken(value: unknown): string | undefined {
  const token = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,200}$/.test(token) ? token : undefined;
}

function fallbackCode(error: unknown): string {
  if (error instanceof ApiError) {
    const explicit = diagnosticToken(error.code);
    if (explicit) return explicit;
    if (error.status === 404) return "agent_runtime_unavailable";
    if (Number(error.status || 0) >= 500) return "internal_error";
    if (error.status) return `http_${error.status}`;
  }
  return error instanceof Error ? "network_error" : "agent_runtime_error";
}

export function describeAgentRuntimeFailure(error: unknown, fallback: string): AgentRuntimeFailure {
  const status = error instanceof ApiError ? Number(error.status || 0) : 0;
  const code = fallbackCode(error);
  const requestId = error instanceof ApiError ? diagnosticToken(error.requestId) : undefined;
  const rawMessage = error instanceof Error ? error.message.trim() : "";

  if (code === "agent_runtime_unavailable") {
    return {
      message: "Agent 服务暂未开放",
      code: "agent_runtime_unavailable",
      requestId,
      recovery: "请联系管理员启用 Agent Runtime、Worker 与模型后重试。",
    };
  }
  if (code === "active_run_exists" || code === "agent_run_active") {
    return {
      message: rawMessage || "当前对话已有一轮正在运行",
      code,
      requestId,
      recovery: "请等待本轮完成，或先停止本轮再发送。",
    };
  }
  if (code === "agent_chat_budget_exceeded" || status === 402) {
    return {
      message: "余额不足，暂时无法发送这轮消息",
      code,
      requestId,
      recovery: "请充值后重试。",
    };
  }
  if (status === 429) {
    return {
      message: rawMessage || "请求过于频繁",
      code,
      requestId,
      recovery: "请稍后再试。",
    };
  }
  if (status >= 500 || code === "internal_error") {
    return {
      message: "服务器内部错误",
      code: "internal_error",
      requestId,
      recovery: requestId
        ? "请稍后重试；若持续失败，请将请求 ID 提交给管理员排查。"
        : "请稍后重试；若持续失败，请联系管理员排查。",
    };
  }
  if (code === "network_error") {
    return {
      message: rawMessage || fallback,
      code,
      requestId,
      recovery: "请检查网络连接后重试；消息草稿仍会保留。",
    };
  }
  return {
    message: rawMessage || fallback,
    code,
    requestId,
    recovery: status === 400
      ? "请检查输入内容后重试。"
      : status === 403
        ? "请确认当前项目权限，或联系管理员处理。"
        : "请重试；若持续失败，请联系管理员。",
  };
}

export function formatAgentRuntimeFailure(error: unknown, fallback: string): string {
  const failure = describeAgentRuntimeFailure(error, fallback);
  const diagnostics = [
    `错误码：${failure.code}`,
    failure.requestId ? `请求 ID：${failure.requestId}` : "",
  ].filter(Boolean).join("；");
  return `${failure.message}（${diagnostics}）。${failure.recovery}`;
}
