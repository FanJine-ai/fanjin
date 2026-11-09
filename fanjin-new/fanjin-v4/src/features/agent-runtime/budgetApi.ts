import { ApiError, apiGet, apiPut } from "../../api/http";

/**
 * 项目级 Agent GU 预算(预算自主审批)读写客户端。
 * agentBudgetMicros = null 表示未设置预算:R2 审批全部走人工确认卡;
 * 设置后,服务端在 预留+报价最高额 ≤ 预算 时自动批准 R2 审批(灰度开关控制)。
 */
export type AgentProjectBudget = {
  projectId: number;
  agentBudgetMicros: number | null;
  /** 当前被自动批准占用的预留额度(微 GU);执行/过期/拒绝后自动回滚。 */
  agentBudgetReservedMicros: number;
  /** 服务端灰度开关 FANJIN_AGENT_AUTO_APPROVE_ENABLED 当前状态。 */
  autoApproveEnabled: boolean;
};

function invalidBudgetResponse(): never {
  throw new ApiError("Agent 预算响应格式无效", { code: "agent_budget_response_invalid" });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidBudgetResponse();
  return value as Record<string, unknown>;
}

function asSafeInteger(value: unknown, min = 0) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) invalidBudgetResponse();
  return value;
}

function projectBudget(value: unknown): AgentProjectBudget {
  const record = asRecord(value);
  return {
    projectId: asSafeInteger(record.projectId, 1),
    agentBudgetMicros: record.agentBudgetMicros === null ? null : asSafeInteger(record.agentBudgetMicros, 1),
    agentBudgetReservedMicros: asSafeInteger(record.agentBudgetReservedMicros),
    autoApproveEnabled: record.autoApproveEnabled === true,
  };
}

export async function getAgentProjectBudget(projectId: number | string, signal?: AbortSignal) {
  const response = await apiGet<unknown>(
    `/agent/projects/${encodeURIComponent(String(projectId))}/budget`,
    undefined,
    { signal },
  );
  return projectBudget(response);
}

export async function updateAgentProjectBudget(
  projectId: number | string,
  agentBudgetMicros: number | null,
  signal?: AbortSignal,
) {
  if (agentBudgetMicros !== null && (!Number.isSafeInteger(agentBudgetMicros) || agentBudgetMicros < 1)) {
    throw new ApiError("预算必须是正整数(微 GU)或 null(清除)", { code: "agent_budget_invalid" });
  }
  const response = await apiPut<unknown>(
    `/agent/projects/${encodeURIComponent(String(projectId))}/budget`,
    { agentBudgetMicros },
    undefined,
    { signal },
  );
  return projectBudget(response);
}
