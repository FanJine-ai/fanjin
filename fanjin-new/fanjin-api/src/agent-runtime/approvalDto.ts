import type {
  AgentApproval,
  AgentApprovalArgumentsSummary,
  AgentApprovalImpactSummary,
  AgentApprovalQuote,
  AgentApprovalRiskClass,
  AgentApprovalStatus,
} from "@/agent-runtime/approvalService";

/** Browser-safe approval projection. Security hashes and actor identities never cross this boundary. */
export interface SafeAgentApprovalDto {
  id: string;
  runId: string;
  stepId: string | null;
  toolId: string;
  toolVersion: string;
  riskClass: AgentApprovalRiskClass;
  status: AgentApprovalStatus;
  quote: AgentApprovalQuote | null;
  impactSummary: AgentApprovalImpactSummary | null;
  /**
   * Scalar projection of the proposed (or revised) tool arguments for the
   * editable confirmation card (REVAMP-PLAN 1.2-6). Display-only: the
   * argumentsHash/scopeHash binding and actor identities are never exposed.
   */
  argumentsSummary: AgentApprovalArgumentsSummary | null;
  /**
   * 预算自主审批:true 表示该审批在项目预算内被系统自动批准(当前仍持有预算
   * 预留);确认卡据此展示"预算内自动批准"而非等待用户操作。预留释放
   * (consumed/expired 等终态)后投影回 false,持久审计见 approval.approved 事件。
   */
  autoApproved: boolean;
  expiresAt: number;
  revision: number;
  decidedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function copyQuote(quote: AgentApprovalQuote | null): AgentApprovalQuote | null {
  return quote ? { ...quote } : null;
}

function copyImpactSummary(summary: AgentApprovalImpactSummary | null): AgentApprovalImpactSummary | null {
  return summary
    ? { ...summary, affectedResourceRefs: [...summary.affectedResourceRefs] }
    : null;
}

function copyArgumentsSummary(
  summary: AgentApprovalArgumentsSummary | null,
): AgentApprovalArgumentsSummary | null {
  return summary ? { ...summary } : null;
}

export function toSafeAgentApprovalDto(approval: AgentApproval): SafeAgentApprovalDto {
  return {
    id: approval.id,
    runId: approval.runId,
    stepId: approval.stepId,
    toolId: approval.toolId,
    toolVersion: approval.toolVersion,
    riskClass: approval.riskClass,
    status: approval.status,
    quote: copyQuote(approval.quote),
    impactSummary: copyImpactSummary(approval.impactSummary),
    argumentsSummary: copyArgumentsSummary(approval.argumentsSummary),
    autoApproved: approval.budgetReservedMicros != null && approval.budgetReservedMicros > 0,
    expiresAt: approval.expiresAt,
    revision: approval.revision,
    decidedAt: approval.decidedAt,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
  };
}
