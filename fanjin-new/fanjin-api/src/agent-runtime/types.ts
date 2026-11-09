import type { AgentRole } from "@/agent-runtime/contracts";
import type { RunStatus } from "@/agent-runtime/stateMachine";

export type AgentThreadStatus = "active" | "archived";
export type AgentMessageRole = "user" | "assistant" | "system" | "tool";
export type AgentMessageVisibility = "user" | "internal" | "audit";
export type AgentMessageStatus = "pending" | "streaming" | "completed" | "stopped" | "error";
export type AgentRunKind = "root" | "delegated";
export type AgentStepKind = "model" | "tool" | "delegation" | "approval" | "wait" | "artifact";
export type AgentStepStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "waiting_external"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "uncertain";

export interface AgentContentPart {
  type: string;
  [key: string]: unknown;
}

export interface AgentThread {
  id: string;
  workspaceId: string;
  projectId: number;
  sessionId: string | null;
  title: string;
  status: AgentThreadStatus;
  activeRootRunId: string | null;
  messageSeq: number;
  eventSeq: number;
  lastMessageAt: number | null;
  version: number;
  createdBy: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface AgentMessage {
  id: string;
  workspaceId: string;
  projectId: number;
  threadId: string;
  runId: string | null;
  replyToId: string | null;
  clientMessageId: string | null;
  seq: number;
  role: AgentMessageRole;
  agentRole: AgentRole | null;
  visibility: AgentMessageVisibility;
  status: AgentMessageStatus;
  content: AgentContentPart[];
  referenceRefs: string[];
  createdBy: number | null;
  error: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface AgentRun {
  id: string;
  workspaceId: string;
  projectId: number;
  threadId: string;
  rootRunId: string;
  parentRunId: string | null;
  delegationId: string | null;
  blockedByRunId: string | null;
  kind: AgentRunKind;
  agentRole: AgentRole;
  triggerMessageId: string;
  responseMessageId: string | null;
  status: RunStatus;
  waitType: string | null;
  waitRef: string | null;
  wakeAt: number | null;
  policySnapshot: Record<string, unknown>;
  contextVersion: number;
  spendLimitMicros: number;
  actualSpendMicros: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  heartbeatAt: number | null;
  attempt: number;
  maxAttempts: number;
  recoveryCount: number;
  checkpointStepSeq: number;
  sideEffectsCommitted: boolean;
  cancelRequestedAt: number | null;
  cancelRequestedBy: number | null;
  cancelReason: string | null;
  error: Record<string, unknown> | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface AgentStep {
  id: string;
  workspaceId: string;
  projectId: number;
  threadId: string;
  runId: string;
  parentStepId: string | null;
  seq: number;
  agentRole: AgentRole;
  kind: AgentStepKind;
  status: AgentStepStatus;
  toolName: string | null;
  argumentsDigest: string | null;
  inputRefs: Array<Record<string, unknown>>;
  outputRefs: Array<Record<string, unknown>>;
  idempotencyKey: string | null;
  resolvedModel: string | null;
  provider: string | null;
  usage: Record<string, unknown>;
  costMicros: number;
  errorCategory: string | null;
  safeError: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface AgentEvent {
  id: string;
  workspaceId: string;
  projectId: number;
  threadId: string;
  runId: string | null;
  messageId: string | null;
  stepId: string | null;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
  expiresAt: number | null;
}

export interface AgentThreadPage<T> {
  data: T[];
  nextCursor: string | null;
}
