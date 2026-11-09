import { NextFunction, Request, Response } from "express";
import type { Knex } from "knex";
import { db } from "@/utils/db";
import { getEffectiveWorkspacePermissions } from "@/middleware/permissions";
import { getConsistentWorkspaceRole } from "@/lib/workspaceOwnership";

function includesPermission(permissions: string[], permission: string): boolean {
  return permissions.includes(permission);
}

function readProjectId(req: Request): number {
  const raw = req.body?.projectId || req.query?.projectId || req.params?.projectId;
  return Number(raw || 0);
}

function toIdList(value: unknown): number[] {
  const rawList = Array.isArray(value) ? value : value == null ? [] : [value];
  return rawList.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0);
}

function uniqueNumbers(values: Array<number | null | undefined>): number[] {
  return Array.from(new Set(values.map((item) => Number(item || 0)).filter((item) => Number.isInteger(item) && item > 0)));
}

function readPath(req: Request): string {
  return String(req.originalUrl || req.path || "").split("?")[0];
}

function isProjectScopedPath(path: string): boolean {
  return [
    "/api/agents/",
    "/api/assets/",
    "/api/assetsGenerate/",
    "/api/cornerScape/",
    "/api/novel/",
    "/api/production/",
    "/api/script/",
    "/api/scriptAgent/",
  ].some((prefix) => path.startsWith(prefix));
}

function permissionForProjectPath(path: string): string {
  if (/\/assets\/(delAssets|delImage|batchDelete)(?:\/|$)/.test(path)) return "project:delete";
  if (/\/(generate|batchGenerate|polish|extract|agent|clearMemory|cancel)/i.test(path)) return "generation:create";
  if (/\/(get|list|poll|check|preview|export|query|downPreview)/i.test(path)) return "project:read";
  return "project:write";
}

async function projectIdsFromTable(table: string, ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const rows = await db(table).whereIn("id", ids).select("projectId");
  return uniqueNumbers(rows.map((row) => row.projectId));
}

async function projectIdsFromAssetIds(
  assetIds: number[],
  requestedProjectId: number | null,
): Promise<number[]> {
  if (!assetIds.length) return [];
  let unresolvedIds = uniqueNumbers(assetIds);
  if (
    requestedProjectId
    && await db.schema.hasTable("o_project_asset_ref")
  ) {
    const referencedRows = await db("o_project_asset_ref")
      .where({ projectId: requestedProjectId })
      .whereIn("assetId", unresolvedIds)
      .whereNull("removedAt")
      .select("assetId");
    const referencedIds = new Set(referencedRows.map((row) => Number(row.assetId)));
    unresolvedIds = unresolvedIds.filter((assetId) => !referencedIds.has(assetId));
  }
  return projectIdsFromTable("o_assets", unresolvedIds);
}

async function projectIdsFromAssetsByImageIds(
  imageIds: number[],
  requestedProjectId: number | null,
): Promise<number[]> {
  if (!imageIds.length) return [];
  const directRows = await db("o_assets").whereIn("imageId", imageIds).select("id");
  const imageRows = await db("o_image").whereIn("id", imageIds).whereNotNull("assetsId").select("assetsId");
  return projectIdsFromAssetIds(
    uniqueNumbers([
      ...directRows.map((row) => row.id),
      ...imageRows.map((row) => row.assetsId),
    ]),
    requestedProjectId,
  );
}

async function projectIdsFromImageFlowIds(flowIds: number[]): Promise<number[]> {
  if (!flowIds.length) return [];
  const assetRows = await db("o_assets").whereIn("flowId", flowIds).select("projectId");
  const storyboardRows = await db("o_storyboard").whereIn("flowId", flowIds).select("projectId");
  return uniqueNumbers([...assetRows, ...storyboardRows].map((row) => row.projectId));
}

async function projectIdsFromEventIds(eventIds: number[]): Promise<number[]> {
  if (!eventIds.length) return [];
  const rows = await db("o_eventChapter")
    .leftJoin("o_novel", "o_novel.id", "o_eventChapter.novelId")
    .whereIn("o_eventChapter.eventId", eventIds)
    .select("o_novel.projectId");
  return uniqueNumbers(rows.map((row) => row.projectId));
}

async function inferProjectIds(req: Request, path: string): Promise<number[]> {
  const body = req.body || {};
  const query = req.query || {};
  const directProjectId = readProjectId(req);
  const assetLibraryPath = path.startsWith("/api/assets/library");
  const projectIds = directProjectId ? [directProjectId] : [];

  const assetIds = toIdList(body.assetId)
    .concat(toIdList(body.assetIds))
    .concat(toIdList(body.assetsId))
    .concat(toIdList(body.assetsIds))
    .concat(toIdList(query.id));
  const imageIds = toIdList(body.imageId).concat(toIdList(body.imageIds));
  const scriptIds = toIdList(body.scriptId).concat(toIdList(body.scriptIds));
  const storyboardIds = toIdList(body.storyboardId)
    .concat(toIdList(body.storyboardIds))
    .concat(toIdList(body.storyIds));
  const trackIds = toIdList(body.trackId).concat(toIdList(body.trackIds));
  const videoIds = toIdList(body.videoId).concat(toIdList(body.videoIds));
  const novelIds = toIdList(body.novelId).concat(toIdList(body.novelIds));
  const flowIds = toIdList(body.flowId).concat(toIdList(body.flowIds));
  const eventIds = toIdList(body.eventId).concat(toIdList(body.eventIds));

  if (path === "/api/assets/delImage" || path === "/api/assetsGenerate/cancelGenerate") {
    imageIds.push(...toIdList(body.id), ...toIdList(body.ids));
  } else if (path.startsWith("/api/assets/") || path.startsWith("/api/assetsGenerate/") || path.startsWith("/api/production/assets/")) {
    assetIds.push(...toIdList(body.id), ...toIdList(body.ids));
  }
  if (path.startsWith("/api/script/")) {
    scriptIds.push(...toIdList(body.id), ...toIdList(body.ids));
    assetIds.push(...toIdList(body.assets));
  }
  if (path.startsWith("/api/scriptAgent/")) {
    projectIds.push(...(await projectIdsFromTable("o_agentWorkData", toIdList(body.id))));
  }
  if (path.startsWith("/api/novel/")) {
    novelIds.push(...toIdList(body.id), ...toIdList(body.ids));
    if (path.startsWith("/api/novel/event/")) eventIds.push(...toIdList(body.id), ...toIdList(body.ids));
  }
  if (path.startsWith("/api/cornerScape/")) {
    assetIds.push(...toIdList(body.id), ...toIdList(body.ids), ...toIdList(body.assetsId), ...toIdList(body.assetsIds), ...toIdList(body.audioIds));
  }
  if (path.startsWith("/api/production/storyboard/")) {
    storyboardIds.push(...toIdList(body.id), ...toIdList(body.ids));
  }
  if (path.startsWith("/api/production/workbench/")) {
    const entityIds = toIdList(body.id).concat(toIdList(body.ids));
    if (path.endsWith("/deleteTrack") || path.endsWith("/updateVideoDuration") || path.endsWith("/updateVideoPrompt")) {
      trackIds.push(...entityIds);
    }
    if (path.endsWith("/delVideo")) {
      videoIds.push(...entityIds);
    }
    if (path.endsWith("/getAudioBindAssetsList")) {
      assetIds.push(...toIdList(body.assetsIds));
    }
    const fileItems = Array.isArray(body.items) ? body.items : [];
    storyboardIds.push(...fileItems.filter((item: any) => item?.sources === "storyboard").flatMap((item: any) => toIdList(item.id)));
    assetIds.push(...fileItems.filter((item: any) => item?.sources === "assets").flatMap((item: any) => toIdList(item.id)));
  }
  if (path.startsWith("/api/production/editImage/")) {
    flowIds.push(...toIdList(body.flowId));
    if (path.endsWith("/getImageFlow")) flowIds.push(...toIdList(body.id));
  }

  if (
    !assetLibraryPath
    && (path.startsWith("/api/assets/") || path.startsWith("/api/assetsGenerate/") || path.startsWith("/api/production/assets/"))
  ) {
    projectIds.push(...(await projectIdsFromAssetIds(assetIds, directProjectId || null)));
    projectIds.push(...(await projectIdsFromAssetsByImageIds(imageIds, directProjectId || null)));
  }
  if (path.startsWith("/api/script/") || path.startsWith("/api/scriptAgent/") || path.startsWith("/api/production/")) {
    projectIds.push(...(await projectIdsFromTable("o_script", scriptIds)));
  }
  if (path.startsWith("/api/production/storyboard/")) {
    projectIds.push(...(await projectIdsFromTable("o_storyboard", storyboardIds)));
  }
  if (path.startsWith("/api/production/workbench/")) {
    projectIds.push(...(await projectIdsFromTable("o_videoTrack", trackIds)));
    projectIds.push(...(await projectIdsFromTable("o_video", videoIds)));
  }
  if (path.startsWith("/api/novel/")) {
    projectIds.push(...(await projectIdsFromTable("o_novel", novelIds)));
    projectIds.push(...(await projectIdsFromEventIds(eventIds)));
  }
  if (path.startsWith("/api/cornerScape/")) {
    projectIds.push(...(await projectIdsFromTable("o_assets", assetIds)));
  }
  if (path.startsWith("/api/production/editImage/") || path.startsWith("/api/production/storyboard/") || path.startsWith("/api/production/assets/")) {
    projectIds.push(...(await projectIdsFromImageFlowIds(flowIds)));
  }

  return uniqueNumbers(projectIds);
}

function isPlatformRole(role?: string | null): boolean {
  return ["root", "admin", "super_admin"].includes(String(role || ""));
}

export interface ProjectPermissionInput {
  projectId: number;
  userId?: number | null;
  role?: string | null;
  permission: string;
  scriptId?: number | null;
  authWorkspaceId?: string | null;
  allowDeleting?: boolean;
  database?: Knex | Knex.Transaction;
  lock?: boolean;
}

export interface ProjectPermissionResult {
  allowed: boolean;
  status: number;
  message: string;
  project?: any;
  workspaceMember?: any;
}

function workspaceProjectPermission(
  input: Pick<ProjectPermissionInput, "userId" | "role" | "permission">,
  project: any,
  workspace: any,
  member: any,
): ProjectPermissionResult {
  if (!workspace) return { allowed: false, status: 404, message: "项目不存在" };
  if (workspace.status !== "active") {
    if (isPlatformRole(input.role) && input.permission === "project:read") {
      return { allowed: true, status: 200, message: "ok", project };
    }
    return { allowed: false, status: 403, message: "项目所属工作区不可用" };
  }
  if (isPlatformRole(input.role)) return { allowed: true, status: 200, message: "ok", project };
  if (!Number(input.userId || 0)) return { allowed: false, status: 401, message: "未登录" };
  if (!member) return { allowed: false, status: 403, message: "无权访问该项目" };
  const memberRole = getConsistentWorkspaceRole({
    userId: member.userId, memberRole: member.role, ownerUserId: workspace.ownerUserId,
  });
  if (!memberRole || !includesPermission(
    getEffectiveWorkspacePermissions({ ...member, role: memberRole }), input.permission,
  )) return { allowed: false, status: 403, message: "项目权限不足" };
  return { allowed: true, status: 200, message: "ok", project, workspaceMember: { ...member, role: memberRole } };
}

/** Read-only bulk authorization; never reuse this snapshot across requests. */
export async function listReadableProjectIds(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectIds: number[];
  userId: number;
  role?: string | null;
}): Promise<Set<number>> {
  const ids = uniqueNumbers(input.projectIds);
  const readable = new Set<number>();
  if (!ids.length) return readable;
  const [workspace, member] = await Promise.all([
    input.database("o_workspace").where({ id: input.workspaceId }).select("id", "status", "ownerUserId").first(),
    input.database("o_workspace_member").where({ workspaceId: input.workspaceId, userId: input.userId, status: "active" }).first(),
  ]);
  // All projects in this scope share workspace permissions; use the same
  // decision function as the single-project guard, including platform roles.
  if (!workspaceProjectPermission({ ...input, permission: "project:read" }, undefined, workspace, member).allowed) return readable;
  for (let offset = 0; offset < ids.length; offset += 500) {
    const projects = await input.database("o_project")
      .where({ workspaceId: input.workspaceId }).whereIn("id", ids.slice(offset, offset + 500))
      .select("id", "deletionState");
    for (const project of projects) {
      if (String(project.deletionState || "active") === "active") readable.add(Number(project.id));
    }
  }
  return readable;
}

export async function checkProjectPermission(input: ProjectPermissionInput): Promise<ProjectPermissionResult> {
  const database = input.database ?? db;
  const projectId = Number(input.projectId || 0);
  if (!projectId) return { allowed: false, status: 400, message: "缺少 projectId" };

  let projectQuery = database("o_project").where({ id: projectId });
  if (input.lock) projectQuery = projectQuery.forUpdate();
  const project = await projectQuery.first();
  if (!project) return { allowed: false, status: 404, message: "项目不存在" };

  const authWorkspaceId = input.authWorkspaceId;
  if (authWorkspaceId && String(project.workspaceId) !== String(authWorkspaceId)) {
    return { allowed: false, status: 404, message: "项目不存在" };
  }

  if (input.scriptId) {
    const script = await database("o_script")
      .where({ id: Number(input.scriptId), projectId })
      .first();
    if (!script) return { allowed: false, status: 404, message: "项目不存在" };
  }

  const deletionState = String(project.deletionState || "active");
  if (input.allowDeleting !== true && deletionState !== "active") {
    return deletionState === "deleted" || input.permission === "project:read"
      ? { allowed: false, status: 404, message: "项目不存在" }
      : { allowed: false, status: 409, message: "项目正在删除" };
  }

  const workspaceId = project.workspaceId || "default";
  const workspace = await database("o_workspace")
    .where({ id: workspaceId })
    .select("id", "status", "ownerUserId")
    .first();
  const userId = Number(input.userId || 0);
  if (!workspace || workspace.status !== "active" || isPlatformRole(input.role) || !userId) {
    return workspaceProjectPermission(input, project, workspace, undefined);
  }
  let memberQuery = database("o_workspace_member")
    .where({ workspaceId, userId, status: "active" });
  if (input.lock) memberQuery = memberQuery.forShare();
  const member = await memberQuery.first();
  return workspaceProjectPermission(input, project, workspace, member);
}

export function requireProjectPermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const projectId = readProjectId(req);
    const user = (req as any).auth?.user || (req as any).user || {};
    const result = await checkProjectPermission({
      projectId,
      userId: Number(user.id || 0),
      role: user.role,
      permission,
      scriptId: req.body?.scriptId || req.query?.scriptId || req.params?.scriptId,
      authWorkspaceId: (req as any).auth?.workspaceId,
    });
    if (!result.allowed) return res.status(result.status).send({ message: result.message });

    (req as any).project = result.project;
    if (result.workspaceMember) (req as any).workspaceMember = result.workspaceMember;
    return next();
  };
}

export function requireInferredProjectPermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const path = readPath(req);
    const projectIds = await inferProjectIds(req, path);
    if (!projectIds.length) return res.status(404).send({ message: "资源不存在或未归属项目" });
    if (projectIds.length > 1) return res.status(403).send({ message: "请求包含多个项目的数据，已拒绝" });

    const user = (req as any).auth?.user || (req as any).user || {};
    const result = await checkProjectPermission({
      projectId: projectIds[0],
      userId: Number(user.id || 0),
      role: user.role,
      permission,
      scriptId: req.body?.scriptId || req.query?.scriptId || req.params?.scriptId,
      authWorkspaceId: (req as any).auth?.workspaceId,
    });
    if (!result.allowed) return res.status(result.status).send({ message: result.message });

    (req as any).project = result.project;
    if (result.workspaceMember) (req as any).workspaceMember = result.workspaceMember;
    return next();
  };
}

export async function guardProjectScopedRoutes(req: Request, res: Response, next: NextFunction) {
  if (req.method === "OPTIONS") return next();
  const path = readPath(req);
  if (!isProjectScopedPath(path)) return next();

  const projectIds = await inferProjectIds(req, path);
  if (!projectIds.length) return next();
  if (projectIds.length > 1) return res.status(403).send({ message: "请求包含多个项目的数据，已拒绝" });

  const user = (req as any).auth?.user || (req as any).user || {};
  const result = await checkProjectPermission({
    projectId: projectIds[0],
    userId: Number(user.id || 0),
    role: user.role,
    permission: permissionForProjectPath(path),
    scriptId: req.body?.scriptId || req.query?.scriptId || req.params?.scriptId,
    authWorkspaceId: (req as any).auth?.workspaceId,
  });
  if (!result.allowed) return res.status(result.status).send({ message: result.message });

  (req as any).project = result.project;
  if (result.workspaceMember) (req as any).workspaceMember = result.workspaceMember;
  return next();
}
