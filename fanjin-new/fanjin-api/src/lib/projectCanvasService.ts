import type { Knex } from "knex";
import { ensureProjectDefaultAgentThread } from "@/agent-runtime/service";
import { ensureCreationSession } from "@/lib/creationSessionService";
import { db } from "@/utils/db";
import { excludeInspirationWorkspaceProjects } from "@/lib/inspirationWorkspaceProject";

export type CanonicalCanvasSnapshot = {
  canvasId: string;
  projectId: string;
  name: string;
  coverImageUrl: string;
  nodes: unknown[];
  edges: unknown[];
  connections: unknown[];
  groups: unknown[];
  viewport: Record<string, unknown>;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isoTime(value: unknown): string {
  const timestamp = Number(value || 0);
  return new Date(Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now()).toISOString();
}

function readInsertedId(result: unknown): number {
  const first = Array.isArray(result) ? result[0] : result;
  const value = first && typeof first === "object" && "id" in first
    ? (first as { id: unknown }).id
    : first;
  const id = Number(value || 0);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("数据库未返回有效 ID");
  return id;
}

function canonicalCanvasRevision(value: unknown): number {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 1;
}

function affectedRows(value: unknown): number {
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.length;
  return Number(value || 0);
}

function canvasRowToSnapshot(row: any): CanonicalCanvasSnapshot {
  const edges = parseArray(row.edges);
  return {
    canvasId: String(row.id),
    projectId: String(row.projectId),
    name: String(row.name || "未命名画布"),
    coverImageUrl: String(row.coverImageUrl || ""),
    nodes: parseArray(row.nodes),
    edges,
    connections: edges,
    groups: parseArray(row.groups),
    viewport: parseObject(row.viewport),
    revision: canonicalCanvasRevision(row.revision),
    createdAt: isoTime(row.createTime),
    updatedAt: isoTime(row.updateTime || row.createTime),
  };
}

async function insertCanvas(
  trx: Knex.Transaction,
  input: { projectId: number; name?: string; coverImageUrl?: string },
): Promise<number> {
  const now = Date.now();
  const result = await trx("o_workflow_graph")
    .insert({
      projectId: input.projectId,
      episodesId: 0,
      name: input.name || "画布 1",
      nodes: "[]",
      edges: "[]",
      groups: "[]",
      viewport: JSON.stringify({ x: 0, y: 0, zoom: 1 }),
      coverImageUrl: input.coverImageUrl || "",
      revision: 1,
      createTime: now,
      updateTime: now,
    })
    .returning("id");
  return readInsertedId(result);
}

export async function listCanonicalProjects(workspaceId: string) {
  const query = db("o_project").where({ workspaceId, deletionState: "active" });
  excludeInspirationWorkspaceProjects(query);
  const projects = await query.orderBy([
    { column: "updatedAt", order: "desc" },
    { column: "createTime", order: "desc" },
  ]);
  const projectIds = projects.map((project: any) => Number(project.id)).filter(Boolean);
  const canvasRows = projectIds.length
    ? await db("o_workflow_graph")
      .whereIn("projectId", projectIds)
      .orderBy("updateTime", "desc")
      .select("projectId", "coverImageUrl", "updateTime")
    : [];
  const latestCanvasByProject = new Map<number, any>();
  for (const canvas of canvasRows) {
    const projectId = Number(canvas.projectId);
    if (!latestCanvasByProject.has(projectId)) latestCanvasByProject.set(projectId, canvas);
  }
  return projects.map((project: any) => {
    const latestCanvas = latestCanvasByProject.get(Number(project.id));
    return {
      projectId: String(project.id),
      name: String(project.name || "未命名项目"),
      intro: String(project.intro || ""),
      type: String(project.type || project.projectType || ""),
      coverImageUrl: String(project.coverImageUrl || latestCanvas?.coverImageUrl || ""),
      createdAt: isoTime(project.createTime),
      updatedAt: isoTime(project.updatedAt || latestCanvas?.updateTime || project.createTime),
    };
  });
}

export async function createCanonicalProject(input: {
  workspaceId: string;
  userId: number;
  name?: string;
}, database: Knex | Knex.Transaction = db) {
  return database.transaction(async (trx) => {
    const now = Date.now();
    const inserted = await trx("o_project")
      .insert({
        workspaceId: input.workspaceId,
        userId: input.userId,
        name: input.name || "未命名项目",
        projectType: "canvas",
        intro: "",
        type: "画布项目",
        artStyle: "",
        directorManual: "",
        videoRatio: "16:9",
        imageModel: "",
        videoModel: "",
        imageQuality: "",
        mode: "canvas",
        coverImageUrl: "",
        revision: 1,
        createTime: now,
        updatedAt: now,
      })
      .returning("id");
    const projectId = readInsertedId(inserted);
    const canvasId = await insertCanvas(trx, { projectId, name: "画布 1" });
    const ensuredSession = await ensureCreationSession({
      workspaceId: input.workspaceId,
      projectId,
      draft: { mode: "canvas", canvasId: String(canvasId) },
      createdBy: input.userId,
      now,
      database: trx,
    });
    const ensuredThread = await ensureProjectDefaultAgentThread({
      database: trx,
      workspaceId: input.workspaceId,
      projectId,
      sessionId: ensuredSession.session.id,
      title: input.name || "新 Agent 对话",
      createdBy: input.userId,
      now,
    });
    return {
      projectId: String(projectId),
      defaultCanvasId: String(canvasId),
      defaultSessionId: ensuredSession.session.id,
      defaultThreadId: ensuredThread.thread.id,
    };
  });
}

export async function listProjectCanvases(projectId: number) {
  const rows = await db("o_workflow_graph as canvas")
    .innerJoin("o_project as project", "project.id", "canvas.projectId")
    .where({
      "canvas.projectId": projectId,
      "project.deletionState": "active",
    })
    .orderBy("canvas.updateTime", "desc")
    .select("canvas.*");
  return rows.map((row: any) => {
    const snapshot = canvasRowToSnapshot(row);
    return {
      canvasId: snapshot.canvasId,
      revision: snapshot.revision,
      name: snapshot.name,
      coverImageUrl: snapshot.coverImageUrl,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    };
  });
}

export async function listWorkspaceCanvases(workspaceId: string) {
  const rows = await db("o_workflow_graph as canvas")
    .innerJoin("o_project as project", "project.id", "canvas.projectId")
    .where({
      "project.workspaceId": workspaceId,
      "project.deletionState": "active",
    })
    .where((builder) => {
      builder
        .whereNull("project.mode")
        .orWhereNot("project.mode", "inspiration-workspace");
    })
    .orderBy("canvas.updateTime", "desc")
    .select("canvas.*");
  return rows.map((row: any) => {
    const snapshot = canvasRowToSnapshot(row);
    return {
      id: snapshot.canvasId,
      projectId: snapshot.projectId,
      name: snapshot.name,
      coverImageUrl: snapshot.coverImageUrl,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    };
  });
}

export async function createProjectCanvas(projectId: number, name?: string) {
  return db.transaction(async (trx) => {
    const canvasId = await insertCanvas(trx, { projectId, name });
    await trx("o_project").where({ id: projectId }).update({ updatedAt: Date.now() });
    return { canvasId: String(canvasId), revision: 1 };
  });
}

export async function getCanvasOwner(canvasId: number) {
  return db("o_workflow_graph as canvas")
    .innerJoin("o_project as project", "project.id", "canvas.projectId")
    .where({
      "canvas.id": canvasId,
      "project.deletionState": "active",
    })
    .select("canvas.projectId")
    .first();
}

export async function loadCanonicalCanvas(canvasId: number) {
  const row = await db("o_workflow_graph as canvas")
    .innerJoin("o_project as project", "project.id", "canvas.projectId")
    .where({
      "canvas.id": canvasId,
      "project.deletionState": "active",
    })
    .select("canvas.*")
    .first();
  return row ? canvasRowToSnapshot(row) : null;
}

export async function saveCanonicalCanvas(input: {
  canvasId: number;
  projectId?: number | null;
  expectedRevision?: number | null;
  name?: string;
  coverImageUrl?: string;
  nodes?: unknown[];
  edges?: unknown[];
  connections?: unknown[];
  groups?: unknown[];
  viewport?: Record<string, unknown>;
}, database: Knex | Knex.Transaction = db) {
  return database.transaction(async (trx) => {
    if (input.expectedRevision != null
      && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0)) {
      throw new TypeError("expectedRevision 必须是正安全整数");
    }
    const current = await trx("o_workflow_graph")
      .where({ id: input.canvasId })
      .forUpdate()
      .first();
    if (!current) return null;
    if (input.projectId != null && Number(current.projectId) !== input.projectId) return null;
    const currentRevision = canonicalCanvasRevision(current.revision);
    const expectedRevision = input.expectedRevision ?? null;
    if (expectedRevision !== null && expectedRevision !== currentRevision) {
      return {
        kind: "conflict" as const,
        expectedRevision,
        currentRevision,
      };
    }
    if (currentRevision >= Number.MAX_SAFE_INTEGER) {
      return {
        kind: "conflict" as const,
        expectedRevision: expectedRevision ?? currentRevision,
        currentRevision,
      };
    }
    const now = Date.now();
    const nextEdges = Array.isArray(input.edges)
      ? input.edges
      : Array.isArray(input.connections)
        ? input.connections
        : parseArray(current.edges);
    const patch: Record<string, unknown> = {
      name: input.name ?? current.name ?? "未命名画布",
      coverImageUrl: input.coverImageUrl ?? current.coverImageUrl ?? "",
      nodes: JSON.stringify(Array.isArray(input.nodes) ? input.nodes : parseArray(current.nodes)),
      edges: JSON.stringify(nextEdges),
      groups: JSON.stringify(Array.isArray(input.groups) ? input.groups : parseArray(current.groups)),
      viewport: JSON.stringify(input.viewport ?? parseObject(current.viewport)),
      revision: currentRevision + 1,
      updateTime: now,
    };
    const updated = await trx("o_workflow_graph")
      .where({
        id: input.canvasId,
        projectId: Number(current.projectId),
        revision: currentRevision,
      })
      .update(patch);
    if (affectedRows(updated) !== 1) {
      const latest = await trx("o_workflow_graph")
        .where({ id: input.canvasId, projectId: Number(current.projectId) })
        .select("revision")
        .first();
      return {
        kind: "conflict" as const,
        expectedRevision: expectedRevision ?? currentRevision,
        currentRevision: latest ? canonicalCanvasRevision(latest.revision) : currentRevision,
      };
    }
    const projectPatch: Record<string, unknown> = { updatedAt: now };
    if (input.coverImageUrl) projectPatch.coverImageUrl = input.coverImageUrl;
    await trx("o_project").where({ id: Number(current.projectId) }).update(projectPatch);
    return {
      kind: "saved" as const,
      canvasId: String(input.canvasId),
      revision: currentRevision + 1,
    };
  });
}

export async function renameCanonicalCanvas(
  projectId: number,
  canvasId: number,
  name: string,
  expectedRevision?: number | null,
) {
  return db.transaction(async (trx) => {
    if (expectedRevision != null
      && (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0)) {
      throw new TypeError("expectedRevision 必须是正安全整数");
    }
    const current = await trx("o_workflow_graph")
      .where({ id: canvasId, projectId })
      .forUpdate()
      .first();
    if (!current) return null;
    const currentRevision = canonicalCanvasRevision(current.revision);
    if (expectedRevision != null && expectedRevision !== currentRevision) {
      return {
        kind: "conflict" as const,
        expectedRevision,
        currentRevision,
      };
    }
    if (currentRevision >= Number.MAX_SAFE_INTEGER) {
      return {
        kind: "conflict" as const,
        expectedRevision: expectedRevision ?? currentRevision,
        currentRevision,
      };
    }
    const now = Date.now();
    const nextRevision = currentRevision + 1;
    const updated = await trx("o_workflow_graph")
      .where({ id: canvasId, projectId, revision: currentRevision })
      .update({ name, updateTime: now, revision: nextRevision });
    if (affectedRows(updated) !== 1) {
      const latest = await trx("o_workflow_graph")
        .where({ id: canvasId, projectId })
        .select("revision")
        .first();
      return {
        kind: "conflict" as const,
        expectedRevision: expectedRevision ?? currentRevision,
        currentRevision: latest ? canonicalCanvasRevision(latest.revision) : currentRevision,
      };
    }
    await trx("o_project").where({ id: projectId }).update({ updatedAt: now });
    return {
      kind: "renamed" as const,
      canvasId: String(canvasId),
      revision: nextRevision,
    };
  });
}

export async function updateCanonicalProject(
  projectId: number,
  patch: { name?: string; coverImageUrl?: string },
) {
  const update: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.coverImageUrl !== undefined) update.coverImageUrl = patch.coverImageUrl;
  const updated = await db("o_project").where({ id: projectId }).update(update);
  return Boolean(updated);
}
