import type { AgentRole } from "@/agent-runtime/contracts";
import type { AgentStep, AgentStepKind, AgentStepStatus } from "@/agent-runtime/types";

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function optionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Pure persistence mapper. This module must never import the global DB. */
export function mapAgentStep(row: any): AgentStep {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    projectId: Number(row.projectId),
    threadId: String(row.threadId),
    runId: String(row.runId),
    parentStepId: row.parentStepId == null ? null : String(row.parentStepId),
    seq: Number(row.seq || 0),
    agentRole: String(row.agentRole) as AgentRole,
    kind: String(row.kind) as AgentStepKind,
    status: String(row.status) as AgentStepStatus,
    toolName: row.toolName == null ? null : String(row.toolName),
    argumentsDigest: row.argumentsDigest == null ? null : String(row.argumentsDigest),
    inputRefs: parseJson<Array<Record<string, unknown>>>(row.inputRefs, []),
    outputRefs: parseJson<Array<Record<string, unknown>>>(row.outputRefs, []),
    idempotencyKey: row.idempotencyKey == null ? null : String(row.idempotencyKey),
    resolvedModel: row.resolvedModel == null ? null : String(row.resolvedModel),
    provider: row.provider == null ? null : String(row.provider),
    usage: parseJson<Record<string, unknown>>(row.usage, {}),
    costMicros: Number(row.costMicros || 0),
    errorCategory: row.errorCategory == null ? null : String(row.errorCategory),
    safeError: row.safeError == null ? null : parseJson<Record<string, unknown>>(row.safeError, {}),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
    startedAt: optionalNumber(row.startedAt),
    completedAt: optionalNumber(row.completedAt),
  };
}
