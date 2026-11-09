export type AgentRuntimeApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "consumed"
  | "revoked"
  | "expired";

export type AgentRuntimeApprovalRiskClass = "R2" | "R3";

export type AgentRuntimeApprovalQuote = {
  currency: "GU";
  estimatedCostMicros: number;
  maximumCostMicros: number;
  quoteId?: string;
  expiresAt?: number;
};

export type AgentRuntimeApprovalImpactSummary = {
  summary: string;
  affectedResourceRefs: string[];
  destructive: boolean;
};

/**
 * Display-only scalar projection of the proposed tool arguments, echoed back
 * to the confirmation card so the user can review/edit before approving
 * (REVAMP-PLAN 1.5). Never carries hashes, policies or actor identities.
 */
export type AgentRuntimeApprovalArgumentsSummary = Record<string, string | number | boolean | null>;

/**
 * Deliberately mirrors only the browser-safe approval DTO. Tool arguments,
 * hashes, policies and actor identities must never cross this UI boundary.
 */
export type AgentRuntimeApproval = {
  id: string;
  runId: string;
  stepId: string | null;
  toolId: string;
  toolVersion: string;
  riskClass: AgentRuntimeApprovalRiskClass;
  status: AgentRuntimeApprovalStatus;
  quote: AgentRuntimeApprovalQuote | null;
  impactSummary: AgentRuntimeApprovalImpactSummary | null;
  argumentsSummary: AgentRuntimeApprovalArgumentsSummary | null;
  /**
   * 预算自主审批:true 表示该审批在项目 GU 预算内被服务端自动批准(无需用户
   * 操作);确认卡据此展示"预算内自动批准"。预留释放(执行/过期等终态)后回 false。
   */
  autoApproved: boolean;
  expiresAt: number;
  revision: number;
  decidedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type AgentRuntimeApprovalPage = {
  data: AgentRuntimeApproval[];
  nextCursor: string | number | null;
};

export type AgentRuntimeApprovalDecision = "approved" | "denied";
