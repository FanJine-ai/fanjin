import crypto from "node:crypto";
import path from "node:path";
import type { Knex } from "knex";

export const INSPIRATION_WORKSPACE_PROJECT_MODE = "inspiration-workspace";

export type InspirationWorkspaceProject = {
  id: number;
  workspaceId: string;
  userId: number;
  mode: typeof INSPIRATION_WORKSPACE_PROJECT_MODE;
  [key: string]: unknown;
};

type EnsureInspirationWorkspaceProjectInput = {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  userId: number;
  imageModel?: string;
  videoModel?: string;
  imageQuality?: string;
  videoRatio?: string;
  now?: number;
};

type FindInspirationWorkspaceProjectInput = Pick<
  EnsureInspirationWorkspaceProjectInput,
  "database" | "workspaceId" | "userId"
>;

export type InspirationWorkspaceReference = {
  assetId: number;
  assetVersionId: number;
  filePath: string;
  previewUrl: string;
  type: "image" | "video" | "audio" | "document";
  mimeType: string;
  size: number;
  name: string;
};

const REFERENCE_MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
};

function normalizeReferenceType(value: unknown): InspirationWorkspaceReference["type"] | null {
  const normalized = String(value || "").trim().toLowerCase();
  return ["image", "video", "audio", "document"].includes(normalized)
    ? normalized as InspirationWorkspaceReference["type"]
    : null;
}

function asProject(row: Record<string, unknown>): InspirationWorkspaceProject {
  return {
    ...row,
    id: Number(row.id),
    workspaceId: String(row.workspaceId),
    userId: Number(row.userId),
    mode: INSPIRATION_WORKSPACE_PROJECT_MODE,
  };
}

/** Read the existing hidden carrier without creating rows on a GET request. */
export async function findInspirationWorkspaceProject(
  input: FindInspirationWorkspaceProjectInput,
): Promise<InspirationWorkspaceProject | null> {
  const existing = await input.database("o_project")
    .where({
      workspaceId: input.workspaceId,
      userId: input.userId,
      mode: INSPIRATION_WORKSPACE_PROJECT_MODE,
      deletionState: "active",
    })
    .orderBy("createTime", "asc")
    .first();
  return existing ? asProject(existing) : null;
}

/**
 * Recover direct-upload references from the hidden inspiration carrier. This
 * is a crash/new-session fallback; once CreationSession has an explicit
 * `uploadedAttachments` array, that array remains authoritative.
 */
export async function listInspirationWorkspaceReferences(
  input: FindInspirationWorkspaceProjectInput & { projectId: number },
): Promise<InspirationWorkspaceReference[]> {
  const prefix = `/${input.projectId}/assets/references/`;
  const rows = await input.database("o_assets as asset")
    .innerJoin("o_project as project", "asset.projectId", "project.id")
    .innerJoin("o_image as image", function () {
      this.on("asset.imageId", "=", "image.id")
        .andOn("image.assetsId", "=", "asset.id");
    })
    .where({
      "project.id": input.projectId,
      "project.workspaceId": input.workspaceId,
      "project.userId": input.userId,
      "project.mode": INSPIRATION_WORKSPACE_PROJECT_MODE,
      "project.deletionState": "active",
      "asset.deletionState": "active",
      "image.deletionState": "active",
    })
    .andWhere("image.filePath", "like", `${prefix}%`)
    .select(
      "asset.id as assetId",
      "asset.name as name",
      "asset.type as assetType",
      "image.id as assetVersionId",
      "image.type as imageType",
      "image.filePath as filePath",
    )
    .orderBy("image.id", "asc");

  return rows.flatMap((row: Record<string, unknown>) => {
    const assetId = Number(row.assetId);
    const assetVersionId = Number(row.assetVersionId);
    const filePath = String(row.filePath || "").replace(/\\/g, "/");
    const relativePath = filePath.slice(prefix.length);
    const type = normalizeReferenceType(row.assetType) || normalizeReferenceType(row.imageType);
    if (
      !Number.isSafeInteger(assetId)
      || assetId <= 0
      || !Number.isSafeInteger(assetVersionId)
      || assetVersionId <= 0
      || !type
      || !filePath.startsWith(prefix)
      || !relativePath
      || relativePath.includes("/")
    ) return [];
    const extension = path.extname(filePath).toLowerCase();
    return [{
      assetId,
      assetVersionId,
      filePath,
      previewUrl: `/api/assets/getReferenceFile?id=${assetId}&disposition=inline`,
      type,
      mimeType: REFERENCE_MIME_BY_EXTENSION[extension] || "application/octet-stream",
      size: 0,
      name: String(row.name || "").trim() || `参考素材 ${assetVersionId}${extension}`,
    }];
  });
}

/**
 * The inspiration page intentionally has no user-visible project selection.
 * Existing generation tables still require a project, so each account keeps
 * one hidden carrier per workspace. It is never selected as the current
 * project and is filtered from every user-facing project catalogue.
 */
export async function ensureInspirationWorkspaceProject(
  input: EnsureInspirationWorkspaceProjectInput,
): Promise<InspirationWorkspaceProject> {
  const transaction = input.database as Knex.Transaction;
  if (!transaction.isTransaction) {
    return (input.database as Knex).transaction((trx) =>
      ensureInspirationWorkspaceProject({ ...input, database: trx }));
  }
  const now = input.now ?? Date.now();
  const clientName = String((transaction.client.config as { client?: unknown }).client || "");
  if (["pg", "postgres", "postgresql"].includes(clientName)) {
    const lock = crypto
      .createHash("sha256")
      .update(`${input.workspaceId}\u0000${input.userId}\u0000${INSPIRATION_WORKSPACE_PROJECT_MODE}`)
      .digest();
    await transaction.raw("select pg_advisory_xact_lock(?, ?)", [
      lock.readInt32BE(0),
      lock.readInt32BE(4),
    ]);
  }
  const existing = await findInspirationWorkspaceProject({
    database: transaction,
    workspaceId: input.workspaceId,
    userId: input.userId,
  });

  if (existing) {
    const updates = {
      ...(input.imageModel ? { imageModel: input.imageModel } : {}),
      ...(input.videoModel ? { videoModel: input.videoModel } : {}),
      ...(input.imageQuality ? { imageQuality: input.imageQuality } : {}),
      ...(input.videoRatio ? { videoRatio: input.videoRatio } : {}),
      updatedAt: now,
    };
    await transaction("o_project").where({ id: existing.id }).update(updates);
    return asProject({ ...existing, ...updates });
  }

  const row = {
    workspaceId: input.workspaceId,
    projectType: "system",
    name: "灵感暂存空间",
    intro: "",
    type: "灵感暂存空间",
    artStyle: "",
    videoRatio: input.videoRatio || "16:9",
    directorManual: "",
    userId: input.userId,
    imageModel: input.imageModel || "",
    videoModel: input.videoModel || "",
    createTime: now,
    updatedAt: now,
    revision: 1,
    imageQuality: input.imageQuality || "",
    mode: INSPIRATION_WORKSPACE_PROJECT_MODE,
  };
  const inserted = await transaction("o_project")
    .insert(row)
    .returning("id");
  const first = Array.isArray(inserted) ? inserted[0] : inserted;
  const id = Number(first && typeof first === "object" && "id" in first
    ? (first as { id: unknown }).id
    : first);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("灵感暂存空间创建失败");
  }
  return asProject({ id, ...row, deletionState: "active" });
}

export function excludeInspirationWorkspaceProjects(query: Knex.QueryBuilder): Knex.QueryBuilder {
  return query.where((builder) => {
    builder.whereNull("mode").orWhereNot("mode", INSPIRATION_WORKSPACE_PROJECT_MODE);
  });
}
