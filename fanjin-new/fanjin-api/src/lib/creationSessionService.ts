import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import { isIsolatedSessionEvidenceMode } from "@/lib/isolatedSessionEvidenceRuntime";
import {
  StructuredTimelineError,
  validateStructuredTimelineParameters,
} from "@/lib/structuredThirtySecondTimeline";
import { db } from "@/utils/db";

export type CreationSessionMode = "agent" | "quick_create" | "canvas";

export interface CreationSession {
  id: string;
  workspaceId: string;
  projectId: number;
  goal: string;
  mode: CreationSessionMode;
  inputs: unknown[];
  parameters: Record<string, unknown>;
  selectedAssetVersionIds: string[];
  canvasId: string | null;
  status: "active" | "archived";
  version: number;
  createdBy: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface CreationSessionDraft {
  goal?: string;
  mode?: CreationSessionMode;
  inputs?: unknown[];
  parameters?: Record<string, unknown>;
  selectedAssetVersionIds?: string[];
  canvasId?: string | null;
}

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
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validatedCreationSessionParameters(input: {
  parameters: Record<string, unknown>;
  selectedAssetVersionIds: string[];
}): Record<string, unknown> {
  try {
    return validateStructuredTimelineParameters(input);
  } catch (error) {
    if (!(error instanceof StructuredTimelineError)) throw error;
    throw new AgentRuntimeError(400, error.code, error.message, {
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
}

export function mapCreationSession(row: any): CreationSession {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    projectId: Number(row.projectId),
    goal: String(row.goal || ""),
    mode: String(row.mode || "agent") as CreationSessionMode,
    inputs: parseJson<unknown[]>(row.inputs, []),
    parameters: parseJson<Record<string, unknown>>(row.parameters, {}),
    selectedAssetVersionIds: parseJson<string[]>(row.selectedAssetVersionIds, []),
    canvasId: row.canvasId == null ? null : String(row.canvasId),
    status: String(row.status || "active") as CreationSession["status"],
    version: Number(row.version || 0),
    createdBy: Number(row.createdBy || 0),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
    archivedAt: optionalNumber(row.archivedAt),
  };
}

export async function getCreationSession(input: {
  id: string;
  workspaceId: string;
  projectId: number;
  database?: Knex | Knex.Transaction;
}): Promise<CreationSession | null> {
  const database = input.database ?? (db as unknown as Knex);
  const row = await (database as any)("o_creation_session")
    .where({ id: input.id, workspaceId: input.workspaceId, projectId: input.projectId })
    .first();
  return row ? mapCreationSession(row) : null;
}

export async function getCurrentCreationSession(input: {
  workspaceId: string;
  projectId: number;
  database?: Knex | Knex.Transaction;
}): Promise<CreationSession | null> {
  const database = input.database ?? (db as unknown as Knex);
  const row = await (database as any)("o_creation_session")
    .where({ workspaceId: input.workspaceId, projectId: input.projectId, status: "active" })
    .whereNull("archivedAt")
    .orderBy("updatedAt", "desc")
    .orderBy("id", "desc")
    .first();
  return row ? mapCreationSession(row) : null;
}

export async function ensureCreationSession(input: {
  workspaceId: string;
  projectId: number;
  sessionId?: string | null;
  draft?: CreationSessionDraft;
  createdBy: number;
  now: number;
  database: Knex.Transaction;
}): Promise<{ session: CreationSession; created: boolean }> {
  if (input.sessionId) {
    const existing = await getCreationSession({
      id: input.sessionId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      database: input.database,
    });
    if (!existing || existing.status !== "active") {
      throw new AgentRuntimeError(404, "creation_session_not_found", "创作会话不存在");
    }
    return { session: existing, created: false };
  }

  const id = randomUUID();
  const draft = input.draft ?? {};
  const selectedAssetVersionIds = draft.selectedAssetVersionIds ?? [];
  const parameters = validatedCreationSessionParameters({
    parameters: draft.parameters ?? {},
    selectedAssetVersionIds,
  });
  await (input.database as any)("o_creation_session").insert({
    id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    goal: String(draft.goal || "").trim(),
    mode: draft.mode ?? "agent",
    inputs: JSON.stringify(draft.inputs ?? []),
    parameters: JSON.stringify(parameters),
    selectedAssetVersionIds: JSON.stringify(selectedAssetVersionIds),
    canvasId: draft.canvasId ?? null,
    status: "active",
    version: 1,
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
  });
  const row = await (input.database as any)("o_creation_session").where({ id }).first();
  return { session: mapCreationSession(row), created: true };
}

const currentSessionEnsureTails = new Map<string, Promise<void>>();

async function serializeCurrentSessionEnsure<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = currentSessionEnsureTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  currentSessionEnsureTails.set(key, current);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (currentSessionEnsureTails.get(key) === current) {
      currentSessionEnsureTails.delete(key);
    }
  }
}

/**
 * Return the current active Session for a project, creating one when absent.
 *
 * The in-process queue protects SQLite/local deployments from duplicate
 * concurrent ensures. The project row lock provides the same serialization
 * boundary for database engines that support `FOR UPDATE`.
 */
export async function ensureCurrentCreationSession(input: {
  workspaceId: string;
  projectId: number;
  draft?: CreationSessionDraft;
  createdBy: number;
  now?: number;
}): Promise<{ session: CreationSession; created: boolean }> {
  const key = `${input.workspaceId}:${input.projectId}`;
  return serializeCurrentSessionEnsure(key, async () => {
    return (db as unknown as Knex).transaction(async (trx) => {
      const project = await (trx as any)("o_project")
        .where({ id: input.projectId, workspaceId: input.workspaceId })
        .forUpdate()
        .first();
      if (!project) {
        throw new AgentRuntimeError(404, "project_not_found", "项目不存在");
      }

      const current = await getCurrentCreationSession({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        database: trx,
      });
      if (current) return { session: current, created: false };

      // Isolated-session evidence may exercise the real ensure endpoint, but
      // its contract is strictly "return the already-snapshotted session".
      // Never let a scope/auth mismatch materialize a new row in the clone and
      // accidentally masquerade as evidence for the bound session.
      if (isIsolatedSessionEvidenceMode()) {
        throw new AgentRuntimeError(
          409,
          "isolated_session_existing_session_required",
          "隔离会话验证仅允许复用已有创作会话",
        );
      }

      return ensureCreationSession({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        draft: input.draft,
        createdBy: input.createdBy,
        now: input.now ?? Date.now(),
        database: trx,
      });
    });
  });
}

export async function updateCreationSession(input: {
  id: string;
  workspaceId: string;
  projectId: number;
  expectedVersion: number;
  draft: CreationSessionDraft;
  now?: number;
  database?: Knex | Knex.Transaction;
}): Promise<CreationSession> {
  const database = input.database ?? (db as unknown as Knex);
  const current = await getCreationSession({
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    database,
  });
  if (!current || current.status !== "active") {
    throw new AgentRuntimeError(404, "creation_session_not_found", "创作会话不存在");
  }
  if (current.version !== input.expectedVersion) {
    throw new AgentRuntimeError(409, "creation_session_version_conflict", "创作会话已被其他请求更新", {
      currentVersion: current.version,
    });
  }

  const updatedAt = input.now ?? Date.now();
  const selectedAssetVersionIds = input.draft.selectedAssetVersionIds
    ?? current.selectedAssetVersionIds;
  const parameters = validatedCreationSessionParameters({
    parameters: input.draft.parameters ?? current.parameters,
    selectedAssetVersionIds,
  });
  const updated = await (database as any)("o_creation_session")
    .where({
      id: input.id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      status: "active",
      version: input.expectedVersion,
    })
    .whereNull("archivedAt")
    .update({
      goal: input.draft.goal === undefined ? current.goal : String(input.draft.goal).trim(),
      mode: input.draft.mode ?? current.mode,
      inputs: JSON.stringify(input.draft.inputs ?? current.inputs),
      parameters: JSON.stringify(parameters),
      selectedAssetVersionIds: JSON.stringify(selectedAssetVersionIds),
      canvasId: input.draft.canvasId === undefined ? current.canvasId : input.draft.canvasId,
      version: current.version + 1,
      updatedAt,
    });
  if (Number(updated) !== 1) {
    const latest = await getCreationSession({
      id: input.id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      database,
    });
    throw new AgentRuntimeError(409, "creation_session_version_conflict", "创作会话已被其他请求更新", {
      currentVersion: latest?.version ?? current.version,
    });
  }
  const next = await getCreationSession({
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    database,
  });
  if (!next) throw new AgentRuntimeError(500, "creation_session_update_failed", "创作会话更新后无法读取");
  return next;
}

export function toCreationSessionDto(session: CreationSession) {
  return {
    id: session.id,
    projectId: session.projectId,
    goal: session.goal,
    mode: session.mode,
    inputs: session.inputs,
    parameters: session.parameters,
    selectedAssetVersionIds: session.selectedAssetVersionIds,
    canvasId: session.canvasId,
    status: session.status,
    version: session.version,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
