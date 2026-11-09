import type { ToolId, ToolSelector } from "@/agent-runtime/toolIds";

export const AGENT_ROLES = ["main", "writer", "visual", "storyboard", "executor", "reviewer"] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export const MAIN_AGENT_ROLE = "main" as const satisfies AgentRole;
export const SPECIALIST_AGENT_ROLES = ["writer", "visual", "storyboard", "executor"] as const satisfies readonly AgentRole[];
export type SpecialistAgentRole = (typeof SPECIALIST_AGENT_ROLES)[number];
export const REVIEWER_AGENT_ROLE = "reviewer" as const satisfies AgentRole;
export type DelegatedAgentRole = SpecialistAgentRole | typeof REVIEWER_AGENT_ROLE;

export const RISK_CLASSES = ["R0", "R1", "R2", "R3", "R4"] as const;

export type RiskClass = (typeof RISK_CLASSES)[number];

export type AgentRuntimePhase = "A0" | "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "never";

export type ToolAvailability =
  | {
      state: "available";
      sincePhase: Exclude<AgentRuntimePhase, "never">;
    }
  | {
      state: "preview";
      reason: string;
      targetPhase: Exclude<AgentRuntimePhase, "A0" | "never">;
    }
  | {
      state: "disabled";
      reason: string;
      targetPhase: Exclude<AgentRuntimePhase, "A0">;
    };

export interface ToolManifest<TName extends ToolId = ToolId> {
  name: TName;
  version: string;
  displayName: string;
  description: string;
  riskClass: RiskClass;
  availability: ToolAvailability;
  requiredPermissions: readonly string[];
  resourceTypes: readonly string[];
  mutatesState: boolean;
  metered: boolean;
}

export type AgentRoleKind = "main" | "specialist" | "reviewer";

export interface RolePolicy {
  role: AgentRole;
  kind: AgentRoleKind;
  displayName: string;
  description: string;
  allowedTools: readonly ToolSelector[];
  deniedTools: readonly ToolSelector[];
  maxRiskClass: RiskClass;
  canDelegate: boolean;
  delegateTo: readonly AgentRole[];
  requiresDelegationGrant: boolean;
}

export type DelegationGrantStatus = "active" | "consumed" | "revoked" | "expired";

export interface DelegationResourceScope {
  scriptIds?: readonly string[];
  assetIds?: readonly string[];
  assetVersionIds?: readonly string[];
  storyboardIds?: readonly string[];
  canvasIds?: readonly string[];
  taskIds?: readonly string[];
}

export interface DelegationLimits {
  maxToolCalls: number;
  maxItems?: number;
  maxOutputCount?: number;
  allowedModels?: readonly string[];
  maxDurationSeconds?: number;
}

export interface DelegationSpendLimit {
  currency: "GU";
  maxEstimatedMicros: number;
  maxActualMicros: number;
  reservationId?: string;
}

export interface DelegationApprovalReference {
  approvalId: string;
  scopeHash: string;
  policyVersion: string;
}

export interface DelegationGrant {
  id: string;
  version: 1;
  status: DelegationGrantStatus;
  actorUserId: number;
  workspaceId: string;
  projectId: string;
  sessionId?: string;
  parentRunId: string;
  parentStepId: string;
  issuerRole: typeof MAIN_AGENT_ROLE;
  granteeRole: DelegatedAgentRole;
  purpose: string;
  objectiveHash: string;
  inputRefs: readonly string[];
  outputContract: string;
  allowedTools: readonly ToolSelector[];
  resourceScope: DelegationResourceScope;
  limits: DelegationLimits;
  spend: DelegationSpendLimit;
  approval?: DelegationApprovalReference;
  idempotencyPrefix: string;
  canDelegate: false;
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
  signature: string;
}

export type ApprovalStatus = "approved" | "consumed" | "revoked" | "expired";

export interface ApprovalEvidence {
  id: string;
  status: ApprovalStatus;
  workspaceId: string;
  projectId: string;
  toolName: ToolId;
  toolVersion: string;
  scopeHash: string;
  policyVersion: string;
  expiresAt: number;
}
