import { randomUUID } from "node:crypto";
import type { Knex } from "knex";

export interface AppendAgentEventInput {
  workspaceId: string;
  projectId: number;
  threadId: string;
  runId?: string | null;
  messageId?: string | null;
  stepId?: string | null;
  seq: number;
  type: string;
  payload?: Record<string, unknown>;
  createdAt: number;
  expiresAt?: number | null;
}

export async function appendAgentEvent(trx: Knex.Transaction, input: AppendAgentEventInput): Promise<string> {
  const id = randomUUID();
  await (trx as any)("o_agent_event").insert({
    id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    threadId: input.threadId,
    runId: input.runId ?? null,
    messageId: input.messageId ?? null,
    stepId: input.stepId ?? null,
    seq: input.seq,
    type: input.type,
    payload: JSON.stringify(input.payload ?? {}),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt ?? null,
  });
  return id;
}
