import type { Knex } from "knex";
import { randomUUID } from "node:crypto";
import { AssetLibraryError, addProjectAssetReference, assertAssetLibraryPermission, registerAccountOwnedAsset } from "./accountWorkspaceAssetLibrary";
import { requireFileManagerSchema, requireFileProject, type FileManagerContext } from "./assetFileManager";
import { insertAndReturnId } from "./dbDialect";

function fail(code: string, message: string, status = 409): never { throw new AssetLibraryError(code, message, status); }
const positive = (value: unknown): number | null => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
function object(value: unknown): Record<string, any> {
  try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}
function keyOf(value: unknown): string {
  const key = typeof value === "string" ? value.trim().replace(/^\/+/, "") : "";
  if (!key || /[\\\p{Cc}]/u.test(key) || key.includes("://") || key.split("/").some(p => !p || p === "." || p === "..")) return "";
  return key;
}

async function sourceRecord(database: Knex, workspaceId: string, id: string, lock = false) {
  // Keep the same project -> task -> media lock order used by final writeback.
  const initial = await database("o_media_asset").where({ id }).first();
  if (!initial) fail("HISTORY_NOT_FOUND", "生成记录不存在或无权访问", 404);
  const taskQuery = initial.taskId ? database("o_relay_task").where({ id: initial.taskId }) : null;
  const task = taskQuery ? await (lock ? taskQuery.forUpdate() : taskQuery).first() : null;
  const media = lock ? await database("o_media_asset").where({ id }).forUpdate().first() : initial;
  if (!media || media.taskId !== initial.taskId
    || (media.workspaceId != null && media.workspaceId !== workspaceId)
    || (task && task.workspaceId !== workspaceId)
    || (media.workspaceId == null && !task)
    || (media.deletionState && media.deletionState !== "active")) {
    fail("HISTORY_NOT_FOUND", "生成记录不存在或无权访问", 404);
  }
  const payload = object(task?.requestPayload);
  const projectId = positive(media.projectId) || positive(task?.projectId)
    || positive(String(task?.requestId || "").match(/^(?:workbench|quick-create):(\d+):/)?.[1]) || positive(payload.projectId);
  if (!projectId) fail("HISTORY_PROJECT_REQUIRED", "这条旧记录缺少项目归属，暂时无法导入，请联系管理员修复", 409);
  if (task?.projectId != null && positive(task.projectId) !== projectId) fail("HISTORY_SOURCE_CHANGED", "生成记录归属异常，请刷新后重试");
  if ((task && task.status !== "succeeded") || !["image", "video", "audio"].includes(media.assetType)) {
    fail("HISTORY_NOT_COMPLETE", "仅支持导入已完成的图片、视频和音频", 409);
  }
  return { media, task, projectId, metadata: object(media.metadata) };
}

/** Import is a reference transaction: never download, copy, regenerate, or charge.
 * A media-row lock makes retries/concurrent requests converge on one canonical version.
 * Legacy rows follow the established project-owner backfill rule; the importer cannot
 * claim somebody else's result or turn a read-only share into permission to use it.
 */
export async function importGenerationHistory(ctx: FileManagerContext, input: { mediaId: string; projectId: number },
  fileExists: (key: string) => Promise<boolean>) {
  await requireFileManagerSchema(ctx.database);
  const initial = await sourceRecord(ctx.database, ctx.workspaceId, input.mediaId);
  return ctx.database.transaction(async trx => {
    const projects = new Map<number, any>();
    for (const id of [...new Set([initial.projectId, input.projectId])].sort((a, b) => a - b)) {
      // Lock even the source project so deletion/writeback cannot race the import.
      const row = await trx("o_project").where({ id }).forUpdate().first();
      await requireFileProject(ctx, id, id === input.projectId, trx);
      projects.set(id, row);
    }
    const { media, task, projectId, metadata } = await sourceRecord(trx, ctx.workspaceId, input.mediaId, true);
    if (projectId !== initial.projectId) fail("HISTORY_SOURCE_CHANGED", "生成记录已更新，请刷新后重试");
    if (!positive(media.projectId) || !media.workspaceId) fail("HISTORY_PROJECT_REQUIRED", "这条旧记录缺少项目归属，暂时无法导入，请联系管理员修复");
    let assetId = positive(metadata.assetId), versionId = positive(metadata.assetVersionId);
    const mediaKey = keyOf(media.storageKey);
    let created = false;
    if (metadata.assetId != null || metadata.assetVersionId != null) {
      // An invalid/deleted explicit link must never be replaced by a new owned copy.
      if (!assetId || !versionId) fail("HISTORY_LINK_INVALID", "原资产关联不完整，请联系管理员修复");
    } else {
      if (!mediaKey) fail("HISTORY_FILE_NOT_SAVED", "原文件尚未保存到云存储，暂时无法导入，请联系管理员修复");
      const versions = await trx("o_image").where(q => q.whereIn("storageKey", [mediaKey, `/${mediaKey}`])
        .orWhereIn("filePath", [mediaKey, `/${mediaKey}`])).limit(2);
      if (versions.length > 1) fail("HISTORY_LINK_AMBIGUOUS", "原文件关联了多个资产，请联系管理员确认");
      if (versions.length) { assetId = positive(versions[0].assetsId); versionId = positive(versions[0].id); }
      else {
        const ownerUserId = positive(projects.get(projectId)?.userId);
        if (ownerUserId !== ctx.actorUserId) fail("HISTORY_OWNER_REQUIRED", "这条旧记录尚未归档，请由原项目创建者首次导入", 403);
        await requireFileProject(ctx, projectId, true, trx);
        // Only accept a canonical object in the original project's namespace. URL,
        // localPath and caller-supplied filenames are not storage authority.
        if (!mediaKey.startsWith(`${projectId}/`)) fail("HISTORY_STORAGE_SCOPE_INVALID", "原文件存储归属需要修复，暂时无法导入");
        await ensureExists(mediaKey, fileExists);
        const prompt = typeof metadata.prompt === "string" ? metadata.prompt : "";
        const now = Date.now();
        assetId = await insertAndReturnId(trx, "o_assets", { projectId, type: media.assetType,
          name: prompt.replace(/[\p{Cc}\p{Cf}\\/]/gu, " ").trim().slice(0, 80) || "历史生成作品", prompt,
          startTime: Number(media.createTime) || now });
        versionId = await insertAndReturnId(trx, "o_image", { assetsId: assetId, type: media.assetType,
          filePath: mediaKey, storageKey: mediaKey, state: "已完成", model: String(task?.model || metadata.model || "") });
        await trx("o_assets").where({ id: assetId }).update({ imageId: versionId });
        await registerAccountOwnedAsset({ transaction: trx, workspaceId: ctx.workspaceId, actorUserId: ownerUserId,
          projectId, assetId, assetVersionId: `image:${versionId}`, idempotencyKey: `history-import:${media.id}:owner`, now });
        created = true;
      }
    }
    if (!assetId || !versionId) fail("HISTORY_LINK_INVALID", "原资产关联不完整，请联系管理员修复");
    await trx("o_asset_ownership").where({ assetId }).forUpdate().first();
    await assertAssetLibraryPermission({ database: trx, workspaceId: ctx.workspaceId, actorUserId: ctx.actorUserId, assetId, permission: "use" });
    const asset = await trx("o_assets").where({ id: assetId, deletionState: "active" }).first();
    const version = await trx("o_image").where({ id: versionId, assetsId: assetId, deletionState: "active" }).first();
    const key = keyOf(version?.storageKey || version?.filePath);
    if (!asset || !version || !key || Number(asset.projectId) !== projectId || (mediaKey && key !== mediaKey)) fail("HISTORY_FILE_NOT_FOUND", "原文件已失效或关联异常，暂时无法导入", 404);
    if (!created) await ensureExists(key, fileExists);
    const assetVersionId = `image:${versionId}`;
    const existing = await trx("o_project_asset_ref").where({ workspaceId: ctx.workspaceId, projectId: input.projectId, assetId, assetVersionId }).whereNull("removedAt").first();
    const ref = await addProjectAssetReference({ database: trx, workspaceId: ctx.workspaceId, actorUserId: ctx.actorUserId,
      projectId: input.projectId, assetId, assetVersionId, idempotencyKey: `history-import:${media.id}:${input.projectId}:${randomUUID()}` });
    if (positive(metadata.assetId) !== assetId || positive(metadata.assetVersionId) !== versionId) {
      await trx("o_media_asset").where({ id: media.id }).update({ metadata: JSON.stringify({ ...metadata, assetId, assetVersionId: versionId }) });
    }
    return { mediaId: String(media.id), projectId: input.projectId, assetId, versionId, refId: String(ref.id),
      outcome: existing && !created ? "existing" as const : "imported" as const };
  });
}

async function ensureExists(key: string, fileExists: (key: string) => Promise<boolean>) {
  let exists: boolean;
  try { exists = await fileExists(key); }
  catch { fail("HISTORY_STORAGE_UNAVAILABLE", "暂时无法读取原文件，请稍后重试", 503); }
  if (!exists) fail("HISTORY_FILE_NOT_FOUND", "原文件已不存在，无法导入资产", 404);
}
