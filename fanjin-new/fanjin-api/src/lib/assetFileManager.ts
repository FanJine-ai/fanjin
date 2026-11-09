import { requireLiveWorkspaceAuthority } from "./workspaceAccess";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { AssetLibraryError, assertAssetLibraryPermission, listAuthorizedAssetIds } from "./accountWorkspaceAssetLibrary";
import { checkProjectPermission } from "@/middleware/projectAccess";
import { FILE_FOLDER, FILE_METADATA, FILE_PLACEMENT, HISTORY_VISIBILITY } from "./migrations/assetFileManager";
import { groupFromTags, hasExplicitUsageTag, normalizeAssetTags, usageFromTags, visibleAssetTags, type AssetUsage } from "./assetMetadata";

export interface FileManagerContext {
  database: Knex;
  workspaceId: string;
  actorUserId: number;
  role?: string;
}
// 资料隐藏/删除先取得实时工作区授权，随后才允许元数据或异步状态写入。
async function requireFileAuthority(ctx: FileManagerContext, database: Knex.Transaction, permission: string) {
  try {
    await requireLiveWorkspaceAuthority({ database, actorUserId: ctx.actorUserId,
      authenticatedWorkspaceId: ctx.workspaceId, workspaceId: ctx.workspaceId, permission });
  } catch (error) {
    if (error instanceof Error && "status" in error && "code" in error) {
      throw new AssetLibraryError(String(error.code), error.message, Number(error.status));
    }
    throw error;
  }
}
const fail = (code: string, message: string, status = 409): never => { throw new AssetLibraryError(code, message, status); };

export function fileDisplayName(value: unknown): string {
  const name = String(value ?? "").normalize("NFC").trim();
  if (!name || name.length > 200 || /[\p{Cc}\p{Cf}\\/]/u.test(name) || [".", ".."].includes(name)) {
    fail("FILE_NAME_INVALID", "名称须为 1–200 个字符，不能包含斜杠或控制字符", 400);
  }
  return name;
}

export async function requireFileManagerSchema(database: Knex) {
  for (const table of [FILE_FOLDER, FILE_METADATA, FILE_PLACEMENT, HISTORY_VISIBILITY]) {
    if (!await database.schema.hasTable(table)) fail("FILE_MANAGER_UPGRADE_REQUIRED", "文件管理升级尚未完成，请稍后重试", 503);
  }
}

export async function listManagedFiles(ctx: FileManagerContext, input: {
  projectId?: number; folderId?: string | null; trash?: boolean; source?: "uploaded" | "generated";
  type?: string; usage?: AssetUsage | "uncategorized"; keyword?: string; page: number; limit: number;
}) {
  await requireFileManagerSchema(ctx.database);
  if (input.projectId) await requireFileProject(ctx, input.projectId);
  const ids = await listAuthorizedAssetIds({ database: ctx.database, workspaceId: ctx.workspaceId, actorUserId: ctx.actorUserId,
    view: input.projectId ? "project_refs" : "all", projectId: input.projectId, permission: "view" });
  if (!ids.length) return { items: [], total: 0, page: input.page, limit: input.limit };
  const query = ctx.database("o_assets as asset")
    .leftJoin(`${FILE_METADATA} as meta`, "meta.assetId", "asset.id")
    .whereIn("asset.id", ids).where("asset.deletionState", "active");
  if (input.projectId) {
    query.join("o_project_asset_ref as ref", "ref.assetId", "asset.id")
      .where({ "ref.projectId": input.projectId, "ref.workspaceId": ctx.workspaceId }).whereNull("ref.removedAt")
      .leftJoin(`${FILE_PLACEMENT} as place`, "place.refId", "ref.id")
      .leftJoin("o_image as image", function () {
        this.on("image.assetsId", "=", "asset.id")
          .andOn(ctx.database.raw("CAST(image.id AS TEXT) = REPLACE(ref.\"assetVersionId\", 'image:', '')"));
      });
    if (input.folderId !== undefined) query.where("place.folderId", input.folderId);
  } else query.leftJoin("o_image as image", "image.id", "asset.imageId");
  query.where(q => q.whereNull("image.deletionState").orWhere("image.deletionState", "active"));
  if (input.trash) query.whereNotNull("meta.trashedAt");
  else query.whereNull("meta.trashedAt");
  if (input.source === "uploaded") query.whereLike("image.filePath", "%/assets/references/%");
  if (input.source === "generated") query.where(q => q.whereNull("image.filePath").orWhere("image.filePath", "not like", "%/assets/references/%"));
  if (input.type) {
    const types = input.type === "image" ? ["image", "role", "scene", "tool"] : input.type === "video" ? ["video", "clip"] : [input.type];
    query.whereIn("asset.type", types);
  }
  if (input.usage) {
    const explicitUsagePattern = `%fanjin:usage:${input.usage}%`;
    const explicitPrefixPattern = "%fanjin:usage:%";
    const defaultTypes = ["role", "scene", "tool", "audio"];
    if (input.usage === "uncategorized") {
      query.where(q => q.whereLike("meta.tags", explicitUsagePattern).orWhere(q2 => q2
        .where(q3 => q3.whereNull("meta.tags").orWhere("meta.tags", "not like", explicitPrefixPattern))
        .whereNotIn("asset.type", defaultTypes)));
    } else {
      query.where(q => q.whereLike("meta.tags", explicitUsagePattern).orWhere(q2 => {
        if (!defaultTypes.includes(input.usage!)) return q2.whereRaw("1 = 0");
        return q2.where("asset.type", input.usage!)
          .where(q3 => q3.whereNull("meta.tags").orWhere("meta.tags", "not like", explicitPrefixPattern));
      }));
    }
  }
  if (input.keyword) query.where(q => q.whereLike("asset.name", `%${input.keyword}%`).orWhereLike("meta.tags", `%${input.keyword}%`));
  const totalRow = await query.clone().count({ total: "asset.id" }).first();
  const rows = await query.select("asset.id", "asset.name", "asset.type", "asset.startTime", "image.id as versionId", "image.filePath",
    "meta.revision as fileRevision", "meta.tags", "meta.trashedAt",
    ...(input.projectId ? ["ref.id as refId", "ref.revision as refRevision", "place.folderId"] : []))
    .orderBy("asset.startTime", "desc").orderBy("asset.id", "desc")
    .modify(q => { if (input.projectId) q.orderBy("ref.id", "desc"); })
    .limit(input.limit).offset((input.page - 1) * input.limit);
  const items = [];
  for (const row of rows) {
    let manage = false, use = false;
    for (const permission of ["manage", "use"] as const) {
      try {
        await assertAssetLibraryPermission({ database: ctx.database, workspaceId: ctx.workspaceId, actorUserId: ctx.actorUserId, assetId: Number(row.id), permission });
        if (permission === "manage") manage = true; else use = true;
      } catch (error) { if (!(error instanceof AssetLibraryError)) throw error; }
    }
    const rawTags = normalizeAssetTags(row.tags || "[]");
    const tags = visibleAssetTags(rawTags);
    const assetUsage = usageFromTags(rawTags, row.type);
    const assetGroup = groupFromTags(rawTags);
    items.push({ assetId: Number(row.id), versionId: Number(row.versionId) || null, name: row.name || "未命名文件",
      type: row.type, createdAt: Number(row.startTime || 0), fileRevision: Number(row.fileRevision || 1), tags,
      source: /\/assets\/references\//.test(row.filePath || "") ? "uploaded" : "generated",
      refId: row.refId || null, refRevision: Number(row.refRevision || 0), folderId: row.folderId || null,
      trashedAt: row.trashedAt == null ? null : Number(row.trashedAt), permissions: { view: true, use, manage },
      assetUsage: assetUsage as AssetUsage | null,
      assetUsageExplicit: hasExplicitUsageTag(rawTags),
      assetGroup,
    });
  }
  return { items, total: Number(totalRow?.total || 0), page: input.page, limit: input.limit };
}

export async function managedFileVersion(ctx: FileManagerContext, assetId: number, versionId: number) {
  await assertAssetLibraryPermission({ database: ctx.database, workspaceId: ctx.workspaceId, actorUserId: ctx.actorUserId, assetId, permission: "view" });
  const row = await ctx.database("o_assets as a").join("o_image as i", "i.assetsId", "a.id")
    .where({ "a.id": assetId, "i.id": versionId, "a.deletionState": "active", "i.deletionState": "active" })
    .select("a.name", "i.filePath", "i.storageKey").first();
  if (!row || !(row.storageKey || row.filePath)) fail("FILE_NOT_FOUND", "文件不存在或尚未保存完成", 404);
  return { name: row.name, key: String(row.storageKey || row.filePath) };
}

export async function requireFileProject(ctx: FileManagerContext, projectId: number, write = false, database = ctx.database) {
  const result = await checkProjectPermission({ database, projectId, userId: ctx.actorUserId,
    role: ctx.role, authWorkspaceId: ctx.workspaceId, permission: write ? "project:write" : "project:read", lock: write });
  if (!result.allowed) fail("FILE_PROJECT_FORBIDDEN", result.message, result.status);
  // Platform roles must not accidentally mutate a project in a different selected workspace.
  if (String(result.project?.workspaceId) !== ctx.workspaceId) fail("FILE_PROJECT_FORBIDDEN", "项目不在当前工作区", 404);
  return result.project;
}

async function lockFile(ctx: FileManagerContext, trx: Knex.Transaction, assetId: number, expectedRevision: number) {
  await trx("o_asset_ownership").where({ assetId }).forUpdate().first();
  await assertAssetLibraryPermission({ database: trx, workspaceId: ctx.workspaceId,
    actorUserId: ctx.actorUserId, assetId, permission: "manage" });
  const asset = await trx("o_assets").where({ id: assetId, deletionState: "active" }).forUpdate().first();
  if (!asset) fail("FILE_NOT_FOUND", "文件不存在或正在删除", 404);
  await trx(FILE_METADATA).insert({ assetId, revision: 1, tags: "[]", updatedAt: Date.now() }).onConflict("assetId").ignore();
  const metadata = await trx(FILE_METADATA).where({ assetId }).forUpdate().first();
  if (Number(metadata.revision) !== expectedRevision) fail("FILE_REVISION_CONFLICT", "文件已被修改，请刷新后重试");
  return { asset, metadata };
}

export async function updateFile(ctx: FileManagerContext, input: {
  assetId: number; expectedRevision: number; name?: string; tags?: string[]; action?: "trash" | "restore";
}) {
  await requireFileManagerSchema(ctx.database);
  return ctx.database.transaction(async trx => {
    await requireFileAuthority(ctx, trx, input.action === "trash" ? "project:delete" : "project:write");
    const { asset, metadata } = await lockFile(ctx, trx, input.assetId, input.expectedRevision);
    const patch: Record<string, unknown> = { revision: Number(metadata.revision) + 1, updatedAt: Date.now() };
    if (input.action === "trash") {
      // References pin real bytes. Require users to remove those references explicitly;
      // a file-management action must never invalidate another project's content.
      const ref = await trx("o_project_asset_ref").where({ assetId: input.assetId }).whereNull("removedAt").first();
      if (ref) fail("FILE_STILL_REFERENCED", "文件仍被项目使用，请先从项目中移除；其他项目的文件不会被删除");
      patch.trashedAt = Date.now(); patch.trashedBy = ctx.actorUserId;
    } else if (input.action === "restore") {
      patch.trashedAt = null; patch.trashedBy = null;
    } else {
      if (metadata.trashedAt != null) fail("FILE_IN_TRASH", "请先恢复文件再修改");
      if (input.name !== undefined) await trx("o_assets").where({ id: asset.id }).update({ name: fileDisplayName(input.name) });
      if (input.tags !== undefined) {
        const reservedTags = normalizeAssetTags(metadata.tags).filter((tag) => tag.startsWith("fanjin:"));
        const visibleTags = input.tags.filter((tag) => !tag.startsWith("fanjin:")).map(fileDisplayName);
        patch.tags = JSON.stringify([...new Set([...reservedTags, ...visibleTags])]);
      }
    }
    await trx(FILE_METADATA).where({ assetId: input.assetId }).update(patch);
    return { assetId: input.assetId, ...metadata, ...patch };
  });
}

export async function listFileFolders(ctx: FileManagerContext, projectId: number) {
  await requireFileManagerSchema(ctx.database);
  await requireFileProject(ctx, projectId);
  return ctx.database(FILE_FOLDER).where({ workspaceId: ctx.workspaceId, projectId }).orderBy("name").orderBy("id");
}

export async function writeFileFolder(ctx: FileManagerContext, input: {
  projectId: number; id?: string; name?: string; parentId?: string | null; expectedRevision?: number; remove?: boolean;
}) {
  await requireFileManagerSchema(ctx.database);
  return ctx.database.transaction(async trx => {
    await requireFileAuthority(ctx, trx, input.remove ? "project:delete" : "project:write");
    // Serialise the tree and placements on the project lock, including moves/deletes.
    await requireFileProject(ctx, input.projectId, true, trx);
    const scope = { workspaceId: ctx.workspaceId, projectId: input.projectId };
    const existing = input.id ? await trx(FILE_FOLDER).where({ ...scope, id: input.id }).forUpdate().first() : null;
    if (input.id && !existing) fail("FILE_FOLDER_NOT_FOUND", "文件夹不存在", 404);
    if (existing && Number(existing.revision) !== input.expectedRevision) fail("FILE_FOLDER_CONFLICT", "文件夹已被修改，请刷新后重试");
    if (input.remove) {
      if (!existing) fail("FILE_FOLDER_NOT_FOUND", "文件夹不存在", 404);
      const children = await trx(FILE_FOLDER).where({ parentId: existing.id }).first();
      const files = await trx(FILE_PLACEMENT).join("o_project_asset_ref as ref", "ref.id", `${FILE_PLACEMENT}.refId`)
        .where({ folderId: existing.id }).whereNull("ref.removedAt").first();
      if (children || files) fail("FILE_FOLDER_NOT_EMPTY", "请先移出文件和子文件夹，再删除文件夹");
      await trx(FILE_PLACEMENT).where({ folderId: existing.id }).delete();
      await trx(FILE_FOLDER).where({ id: existing.id }).delete();
      return { id: existing.id, removed: true };
    }
    const parentId = input.parentId === undefined ? existing?.parentId ?? null : input.parentId;
    let ancestor = parentId;
    const visited = new Set<string>();
    while (ancestor) {
      if (ancestor === input.id || visited.has(ancestor)) fail("FILE_FOLDER_CYCLE", "不能把文件夹移入自身或其子文件夹", 400);
      visited.add(ancestor);
      const parent = await trx(FILE_FOLDER).where({ ...scope, id: ancestor }).first();
      if (!parent) fail("FILE_FOLDER_NOT_FOUND", "目标文件夹不在当前项目", 404);
      ancestor = parent.parentId;
    }
    const name = fileDisplayName(input.name ?? existing?.name);
    const duplicate = await trx(FILE_FOLDER).where({ ...scope, parentId, name }).modify(q => { if (existing) q.whereNot("id", existing.id); }).first();
    if (duplicate) fail("FILE_FOLDER_DUPLICATE", "该位置已有同名文件夹");
    const now = Date.now(), id = input.id || randomUUID();
    if (existing) await trx(FILE_FOLDER).where({ id }).update({ name, parentId, revision: Number(existing.revision) + 1, updatedAt: now });
    else await trx(FILE_FOLDER).insert({ ...scope, id, parentId, name, revision: 1, createdBy: ctx.actorUserId, createdAt: now, updatedAt: now });
    return trx(FILE_FOLDER).where({ id }).first();
  });
}

export async function placeProjectFile(ctx: FileManagerContext, input: {
  projectId: number; refId: string; folderId: string | null; expectedRevision: number;
}) {
  await requireFileManagerSchema(ctx.database);
  return ctx.database.transaction(async trx => {
    await requireFileProject(ctx, input.projectId, true, trx);
    const ref = await trx("o_project_asset_ref").where({ id: input.refId, workspaceId: ctx.workspaceId, projectId: input.projectId })
      .whereNull("removedAt").forUpdate().first();
    if (!ref) fail("FILE_REFERENCE_NOT_FOUND", "文件已从项目移除", 404);
    await assertAssetLibraryPermission({ database: trx, workspaceId: ctx.workspaceId, actorUserId: ctx.actorUserId, assetId: Number(ref.assetId), permission: "use" });
    if (Number(ref.revision) !== input.expectedRevision) fail("FILE_REFERENCE_CONFLICT", "文件位置已更新，请刷新后重试");
    if (input.folderId) {
      const folder = await trx(FILE_FOLDER).where({ id: input.folderId, workspaceId: ctx.workspaceId, projectId: input.projectId }).first();
      if (!folder) fail("FILE_FOLDER_NOT_FOUND", "目标文件夹不在当前项目", 404);
      await trx(FILE_PLACEMENT).insert({ refId: ref.id, folderId: input.folderId, revision: 1, updatedAt: Date.now() })
        .onConflict("refId").merge({ folderId: input.folderId, updatedAt: Date.now() });
    } else await trx(FILE_PLACEMENT).where({ refId: ref.id }).delete();
    await trx("o_project_asset_ref").where({ id: ref.id }).update({ revision: Number(ref.revision) + 1, updatedAt: Date.now() });
    return { refId: ref.id, folderId: input.folderId, revision: Number(ref.revision) + 1 };
  });
}

export async function setGenerationHistoryHidden(ctx: FileManagerContext, mediaIds: string[], hidden: boolean) {
  await requireFileManagerSchema(ctx.database);
  return ctx.database.transaction(async trx => {
    await requireFileAuthority(ctx, trx, hidden ? "project:delete" : "project:write");
    for (const mediaId of mediaIds) {
      const media = await trx("o_media_asset").where({ id: mediaId }).first();
      if (!media || (media.workspaceId != null && media.workspaceId !== ctx.workspaceId)) fail("HISTORY_NOT_FOUND", "生成记录不存在或无权访问", 404);
      let projectId = Number(media.projectId) || null;
      if (!projectId || media.workspaceId == null) {
        const task = media.taskId ? await trx("o_relay_task").where({ id: media.taskId, workspaceId: ctx.workspaceId }).first() : null;
        if (!task) fail("HISTORY_PROJECT_REQUIRED", "生成记录缺少可验证的项目归属", 409);
        let payload: any = {}; try { payload = JSON.parse(task.requestPayload || "{}"); } catch { /* absent legacy binding */ }
        projectId ||= Number(task.projectId || String(task.requestId || "").match(/^(?:workbench|quick-create):(\d+):/)?.[1] || payload.projectId) || null;
      }
      if (!projectId) fail("HISTORY_PROJECT_REQUIRED", "生成记录缺少可验证的项目归属", 409);
      await requireFileProject(ctx, Number(projectId), false, trx);
      let metadata: any = {};
      try { metadata = typeof media.metadata === "string" ? JSON.parse(media.metadata) : media.metadata ?? {}; } catch { /* no asset link */ }
      if (Number.isSafeInteger(Number(metadata.assetId)) && Number(metadata.assetId) > 0) {
        await assertAssetLibraryPermission({ database: trx, workspaceId: ctx.workspaceId, actorUserId: ctx.actorUserId, assetId: Number(metadata.assetId), permission: "view" });
      }
      const key = { workspaceId: ctx.workspaceId, userId: ctx.actorUserId, mediaId };
      if (hidden) await trx(HISTORY_VISIBILITY).insert({ ...key, hiddenAt: Date.now() }).onConflict(["workspaceId", "userId", "mediaId"]).ignore();
      else await trx(HISTORY_VISIBILITY).where(key).delete();
    }
    return { hidden, count: mediaIds.length };
  });
}
