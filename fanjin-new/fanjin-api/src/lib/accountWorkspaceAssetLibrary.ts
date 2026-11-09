import { FILE_METADATA } from "./migrations/assetFileManager";
import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { assertMembershipFeature } from "./membership";

import {
  ASSET_GRANT_TABLE,
  ASSET_LIBRARY_AUDIT_TABLE,
  ASSET_OWNERSHIP_TABLE,
  PROJECT_ASSET_REF_TABLE,
} from "@/lib/migrations/accountWorkspaceAssetLibrary";
import { normalizeObjectKey } from "@/lib/objectStorage";

export type AssetLibraryView = "mine" | "workspace" | "shared_with_me" | "project_refs" | "all";
export type AssetOwnerType = "user" | "workspace";
export type AssetGrantTargetType = "workspace" | "user";
export type AssetLibraryPermission = "view" | "use" | "manage";

export class AssetLibraryError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AssetLibraryError";
    this.code = code;
    this.status = status;
  }
}

function fail(code: string, message: string, status = 400): never {
  throw new AssetLibraryError(code, message, status);
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail("ASSET_LIBRARY_INPUT_INVALID", `${label} 必须是正整数`);
  }
  return parsed;
}

function text(value: unknown, label: string, maxLength = 256): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maxLength) {
    fail("ASSET_LIBRARY_INPUT_INVALID", `${label} 无效`);
  }
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function managerRole(role: unknown): boolean {
  return ["owner", "admin", "workspace_owner", "workspace_admin"].includes(String(role || ""));
}

function assertExpectedRevision(
  actual: unknown,
  expected: unknown,
  subject: "ownership" | "grant" | "project_ref",
): void {
  if (expected == null) return;
  const expectedRevision = positiveInteger(expected, "expectedRevision");
  if (Number(actual) !== expectedRevision) {
    fail(
      "ASSET_LIBRARY_REVISION_CONFLICT",
      `${subject} 已被其他操作更新，请刷新后重试`,
      409,
    );
  }
}

export async function assertAssetLibrarySchema(
  database: Knex | Knex.Transaction,
): Promise<void> {
  for (const table of [
    ASSET_OWNERSHIP_TABLE,
    ASSET_GRANT_TABLE,
    PROJECT_ASSET_REF_TABLE,
    ASSET_LIBRARY_AUDIT_TABLE,
  ]) {
    if (!(await database.schema.hasTable(table))) {
      fail(
        "ASSET_LIBRARY_SCHEMA_UNAVAILABLE",
        "账号与工作区资产库尚未完成数据库升级",
        503,
      );
    }
  }
}

export async function assetLibrarySchemaAvailable(
  database: Knex | Knex.Transaction,
): Promise<boolean> {
  for (const table of [
    ASSET_OWNERSHIP_TABLE,
    ASSET_GRANT_TABLE,
    PROJECT_ASSET_REF_TABLE,
    ASSET_LIBRARY_AUDIT_TABLE,
  ]) {
    if (!(await database.schema.hasTable(table))) return false;
  }
  return true;
}

/**
 * Exact object keys whose asset bodies outlive their source project.  Project
 * deletion may remove project-local links and derived rows, but must never
 * enqueue these generations in the storage deletion outbox.
 */
export async function protectedAccountAssetStorageKeysForProject(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
}): Promise<string[]> {
  if (!(await assetLibrarySchemaAvailable(input.database))) return [];
  const workspaceId = text(input.workspaceId, "workspaceId", 128);
  const projectId = positiveInteger(input.projectId, "projectId");
  const hasStorageKey = await input.database.schema.hasColumn("o_image", "storageKey");
  const hasFilePath = await input.database.schema.hasColumn("o_image", "filePath");
  if (!hasStorageKey && !hasFilePath) return [];

  const columns: string[] = [];
  // storageKey is the authoritative logical object key. filePath is only a
  // compatibility fallback for pre-migration rows.
  if (hasStorageKey) columns.push("image.storageKey");
  else if (hasFilePath) columns.push("image.filePath");
  const rows = await input.database("o_asset_ownership as ownership")
    .innerJoin("o_assets as asset", "asset.id", "ownership.assetId")
    .innerJoin("o_image as image", "image.assetsId", "asset.id")
    .where({
      "asset.projectId": projectId,
      "ownership.sourceWorkspaceId": workspaceId,
    })
    .select(columns);
  return [...new Set(rows.flatMap((row) => columns.map((column) => {
    const name = column.slice(column.indexOf(".") + 1);
    const raw = String(row[name] || "").trim();
    if (!raw) return "";
    try {
      return normalizeObjectKey(raw);
    } catch {
      return "";
    }
  })).filter(Boolean))].sort();
}

async function activeMembership(
  database: Knex | Knex.Transaction,
  workspaceId: string,
  actorUserId: number,
) {
  return database("o_workspace_member")
    .where({ workspaceId, userId: actorUserId, status: "active" })
    .first();
}

async function requireMembership(
  database: Knex | Knex.Transaction,
  workspaceId: string,
  actorUserId: number,
) {
  const member = await activeMembership(database, workspaceId, actorUserId);
  if (!member) fail("ASSET_LIBRARY_WORKSPACE_FORBIDDEN", "无权访问该工作区资产", 403);
  return member;
}

type AssetAuthority = {
  ownership: any;
  canView: boolean;
  canUse: boolean;
  canManage: boolean;
  authority: "owner" | "workspace_owner" | "grant" | "none";
};

async function assetAuthority(input: {
  database: Knex | Knex.Transaction;
  assetId: number;
  workspaceId: string;
  actorUserId: number;
}): Promise<AssetAuthority> {
  const ownership = await input.database(ASSET_OWNERSHIP_TABLE)
    .where({ assetId: input.assetId })
    .first();
  if (!ownership) fail("ASSET_LIBRARY_ASSET_NOT_FOUND", "资产不存在", 404);

  if (ownership.ownerType === "user" && Number(ownership.ownerUserId) === input.actorUserId) {
    return { ownership, canView: true, canUse: true, canManage: true, authority: "owner" };
  }
  if (ownership.ownerType === "workspace"
    && String(ownership.ownerWorkspaceId) === input.workspaceId) {
    const member = await activeMembership(input.database, input.workspaceId, input.actorUserId);
    if (member) {
      return {
        ownership,
        canView: true,
        canUse: true,
        canManage: managerRole(member.role),
        authority: "workspace_owner",
      };
    }
  }

  const grants = await input.database(ASSET_GRANT_TABLE)
    .where({ assetId: input.assetId, workspaceId: input.workspaceId })
    .whereNull("revokedAt")
    .where((query) => query
      .where({ granteeType: "workspace" })
      .orWhere({ granteeType: "user", granteeUserId: input.actorUserId }));
  if (grants.length) {
    return {
      ownership,
      canView: grants.some((grant) => bool(grant.canView) || bool(grant.canUse) || bool(grant.canManage)),
      canUse: grants.some((grant) => bool(grant.canUse) || bool(grant.canManage)),
      canManage: grants.some((grant) => bool(grant.canManage)),
      authority: "grant",
    };
  }
  return { ownership, canView: false, canUse: false, canManage: false, authority: "none" };
}

async function candidateAssetIds(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  actorUserId: number;
  view: AssetLibraryView;
  projectId?: number | null;
}): Promise<number[]> {
  const candidateIds: number[] = [];
  if (input.view === "mine" || input.view === "all") {
    const rows = await input.database(ASSET_OWNERSHIP_TABLE)
      .where({ ownerType: "user", ownerUserId: input.actorUserId })
      .select("assetId");
    candidateIds.push(...rows.map((row) => Number(row.assetId)));
  }
  if (input.view === "workspace" || input.view === "all") {
    const rows = await input.database(ASSET_OWNERSHIP_TABLE)
      .where({ ownerType: "workspace", ownerWorkspaceId: input.workspaceId })
      .select("assetId");
    candidateIds.push(...rows.map((row) => Number(row.assetId)));
  }
  if (input.view === "shared_with_me" || input.view === "all") {
    const rows = await input.database(ASSET_GRANT_TABLE)
      .where({ workspaceId: input.workspaceId })
      .whereNull("revokedAt")
      .where((query) => query
        .where({ granteeType: "workspace" })
        .orWhere({ granteeType: "user", granteeUserId: input.actorUserId }))
      .select("assetId");
    candidateIds.push(...rows.map((row) => Number(row.assetId)));
  }
  if (input.view === "project_refs") {
    if (input.projectId == null) {
      fail("ASSET_LIBRARY_INPUT_INVALID", "project_refs 视图需要 projectId");
    }
    const project = await input.database("o_project")
      .where({
        id: input.projectId,
        workspaceId: input.workspaceId,
        deletionState: "active",
      })
      .first();
    if (!project) fail("ASSET_LIBRARY_PROJECT_NOT_FOUND", "项目不存在", 404);
    const rows = await input.database(PROJECT_ASSET_REF_TABLE)
      .where({ workspaceId: input.workspaceId, projectId: input.projectId })
      .whereNull("removedAt")
      .select("assetId");
    candidateIds.push(...rows.map((row) => Number(row.assetId)));
  }
  return [...new Set(candidateIds.filter(
    (value) => Number.isSafeInteger(value) && value > 0,
  ))];
}

function hasPermission(authority: AssetAuthority, permission: AssetLibraryPermission): boolean {
  if (permission === "manage") return authority.canManage;
  if (permission === "use") return authority.canUse;
  return authority.canView;
}

export async function listAuthorizedAssetIds(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  actorUserId: number;
  view?: AssetLibraryView;
  projectId?: number | null;
  permission?: AssetLibraryPermission;
}): Promise<number[]> {
  await assertAssetLibrarySchema(input.database);
  const workspaceId = text(input.workspaceId, "workspaceId", 128);
  const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
  const projectId = input.projectId == null
    ? null
    : positiveInteger(input.projectId, "projectId");
  await requireMembership(input.database, workspaceId, actorUserId);
  const ids = await candidateAssetIds({
    database: input.database,
    workspaceId,
    actorUserId,
    view: input.view ?? "all",
    projectId,
  });
  const authorized: number[] = [];
  for (const assetId of ids) {
    const authority = await assetAuthority({
      database: input.database,
      assetId,
      workspaceId,
      actorUserId,
    });
    if (hasPermission(authority, input.permission ?? "view")) {
      if (input.permission === "use" && await input.database.schema.hasTable(FILE_METADATA)
        && await input.database(FILE_METADATA).where({ assetId }).whereNotNull("trashedAt").first()) continue;
      authorized.push(assetId);
    }
  }
  return authorized.sort((left, right) => left - right);
}

export async function assertAssetLibraryPermission(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  actorUserId: number;
  assetId: number;
  permission?: AssetLibraryPermission;
}): Promise<{
  ownerType: AssetOwnerType;
  ownerUserId: number | null;
  ownerWorkspaceId: string | null;
  authority: AssetAuthority["authority"];
}> {
  await assertAssetLibrarySchema(input.database);
  const workspaceId = text(input.workspaceId, "workspaceId", 128);
  const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
  const assetId = positiveInteger(input.assetId, "assetId");
  await requireMembership(input.database, workspaceId, actorUserId);
  const authority = await assetAuthority({
    database: input.database,
    assetId,
    workspaceId,
    actorUserId,
  });
  if ((input.permission ?? "view") === "use" && await input.database.schema.hasTable(FILE_METADATA)) {
    const trashed = await input.database(FILE_METADATA).where({ assetId }).whereNotNull("trashedAt").first();
    if (trashed) fail("FILE_IN_TRASH", "文件已在回收站，请先恢复", 409);
  }
  if (!hasPermission(authority, input.permission ?? "view")) {
    fail("ASSET_LIBRARY_ACCESS_FORBIDDEN", "无权访问该资产", 403);
  }
  return {
    ownerType: authority.ownership.ownerType as AssetOwnerType,
    ownerUserId: authority.ownership.ownerUserId == null
      ? null
      : Number(authority.ownership.ownerUserId),
    ownerWorkspaceId: authority.ownership.ownerWorkspaceId == null
      ? null
      : String(authority.ownership.ownerWorkspaceId),
    authority: authority.authority,
  };
}

/**
 * Request-scoped bulk equivalent of assertAssetLibraryPermission(..., view).
 * Null means the legacy database has no asset authority schema yet. An empty
 * set means access is denied; never conflate these or cache a grant decision.
 */
export async function listViewableAssetIds(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  actorUserId: number;
  assetIds: number[];
}): Promise<Set<number> | null> {
  const allowed = new Set<number>();
  const ids = [...new Set(input.assetIds.map(id => positiveInteger(id, "assetId")))];
  if (!ids.length) return allowed;
  if (!(await assetLibrarySchemaAvailable(input.database))) return null;
  const workspaceId = text(input.workspaceId, "workspaceId", 128);
  const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
  if (!(await activeMembership(input.database, workspaceId, actorUserId))) return allowed;
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    const [ownerships, grants] = await Promise.all([
      input.database(ASSET_OWNERSHIP_TABLE).whereIn("assetId", chunk)
        .select("assetId", "ownerType", "ownerUserId", "ownerWorkspaceId"),
      input.database(ASSET_GRANT_TABLE).whereIn("assetId", chunk).where({ workspaceId }).whereNull("revokedAt")
        .where(query => query.where({ granteeType: "workspace" }).orWhere({ granteeType: "user", granteeUserId: actorUserId }))
        .select("assetId", "canView", "canUse", "canManage"),
    ]);
    const granted = new Set(grants.filter(grant => bool(grant.canView) || bool(grant.canUse) || bool(grant.canManage))
      .map(grant => Number(grant.assetId)));
    for (const ownership of ownerships) {
      if ((ownership.ownerType === "user" && Number(ownership.ownerUserId) === actorUserId)
        || (ownership.ownerType === "workspace" && String(ownership.ownerWorkspaceId) === workspaceId)
        || granted.has(Number(ownership.assetId))) allowed.add(Number(ownership.assetId));
    }
  }
  return allowed;
}

export async function assertProjectAssetReferencePermission(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  assetId: number;
  assetVersionId?: number | string | null;
  permission?: AssetLibraryPermission;
}): Promise<void> {
  await assertAssetLibrarySchema(input.database);
  const workspaceId = text(input.workspaceId, "workspaceId", 128);
  const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
  const projectId = positiveInteger(input.projectId, "projectId");
  const assetId = positiveInteger(input.assetId, "assetId");
  const project = await input.database("o_project")
    .where({ id: projectId, workspaceId, deletionState: "active" })
    .first();
  if (!project) fail("ASSET_LIBRARY_PROJECT_NOT_FOUND", "项目不存在", 404);
  await assertAssetLibraryPermission({
    database: input.database,
    workspaceId,
    actorUserId,
    assetId,
    permission: input.permission ?? "use",
  });
  const refQuery = input.database(PROJECT_ASSET_REF_TABLE)
    .where({ workspaceId, projectId, assetId })
    .whereNull("removedAt");
  if (input.assetVersionId != null) {
    const raw = String(input.assetVersionId).trim();
    const assetVersionId = raw.startsWith("image:") || raw.startsWith("asset:")
      ? raw
      : `image:${text(raw, "assetVersionId", 128)}`;
    refQuery.andWhere({ assetVersionId });
  }
  if (!(await refQuery.first())) {
    fail(
      "ASSET_LIBRARY_PROJECT_REF_REQUIRED",
      "资产尚未加入当前项目",
      409,
    );
  }
}

async function appendAudit(
  transaction: Knex.Transaction,
  input: {
    assetId: number;
    workspaceId: string;
    actorUserId: number;
    action: string;
    idempotencyKey: string;
    details: Record<string, unknown>;
    now: number;
  },
): Promise<void> {
  const detailsJson = canonicalJson(input.details);
  await transaction(ASSET_LIBRARY_AUDIT_TABLE).insert({
    id: randomUUID(),
    assetId: input.assetId,
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    action: input.action,
    idempotencyKey: input.idempotencyKey,
    detailsJson,
    detailsHash: sha256(detailsJson),
    createdAt: input.now,
  }).onConflict("idempotencyKey").ignore();
}

export async function registerAccountOwnedAsset(input: {
  transaction: Knex.Transaction;
  assetId: number;
  projectId: number;
  workspaceId: string;
  actorUserId: number;
  assetVersionId?: string | null;
  idempotencyKey: string;
  now?: number;
}): Promise<void> {
  await assertAssetLibrarySchema(input.transaction);
  const assetId = positiveInteger(input.assetId, "assetId");
  const projectId = positiveInteger(input.projectId, "projectId");
  const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
  const workspaceId = text(input.workspaceId, "workspaceId", 128);
  const now = input.now ?? Date.now();
  const project = await input.transaction("o_project")
    .where({ id: projectId, workspaceId, deletionState: "active" })
    .first();
  if (!project) fail("ASSET_LIBRARY_PROJECT_NOT_FOUND", "项目不存在", 404);
  await requireMembership(input.transaction, workspaceId, actorUserId);
  const asset = await input.transaction("o_assets").where({ id: assetId }).first();
  if (!asset) fail("ASSET_LIBRARY_ASSET_NOT_FOUND", "资产不存在", 404);

  await input.transaction(ASSET_OWNERSHIP_TABLE).insert({
    assetId,
    ownerType: "user",
    ownerUserId: actorUserId,
    ownerWorkspaceId: null,
    sourceWorkspaceId: workspaceId,
    createdBy: actorUserId,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }).onConflict("assetId").ignore();

  const assetVersionId = String(input.assetVersionId || (asset.imageId ? `image:${asset.imageId}` : `asset:${assetId}`));
  const activeKey = `${workspaceId}:${projectId}:${assetId}:${assetVersionId}`;
  await input.transaction(PROJECT_ASSET_REF_TABLE).insert({
    id: `project-asset-ref-${sha256(activeKey)}`,
    workspaceId,
    projectId,
    assetId,
    assetVersionId,
    activeKey,
    createdBy: actorUserId,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    removedAt: null,
  }).onConflict("activeKey").ignore();
  await appendAudit(input.transaction, {
    assetId,
    workspaceId,
    actorUserId,
    action: "asset.owner_registered",
    idempotencyKey: input.idempotencyKey,
    details: { ownerType: "user", ownerUserId: actorUserId, projectId, assetVersionId },
    now,
  });
}

export async function registerAccountOwnedAssetIfAvailable(
  input: Parameters<typeof registerAccountOwnedAsset>[0],
): Promise<boolean> {
  if (!(await assetLibrarySchemaAvailable(input.transaction))) return false;
  await registerAccountOwnedAsset(input);
  return true;
}

export async function listAssetLibrary(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  actorUserId: number;
  view: AssetLibraryView;
  /** Optional exact identities used to restore a durable generation result. */
  assetIds?: number[];
  /** Exact asset/image-version pairs used to restore the originally generated bytes. */
  assetVersions?: Array<{ assetId: number; assetVersionId: number }>;
  projectId?: number | null;
  type?: string | null;
  name?: string | null;
  limit?: number;
  offset?: number;
}) {
  await assertAssetLibrarySchema(input.database);
  const workspaceId = text(input.workspaceId, "workspaceId", 128);
  const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
  await requireMembership(input.database, workspaceId, actorUserId);
  const limit = Math.min(200, Math.max(1, Number(input.limit || 50)));
  const offset = Math.max(0, Number(input.offset || 0));
  const projectId = input.projectId == null ? null : positiveInteger(input.projectId, "projectId");

  if (input.assetIds !== undefined && input.assetVersions !== undefined) {
    fail("ASSET_LIBRARY_INPUT_INVALID", "指定资产与指定资产版本不能同时使用");
  }
  const requestedAssetVersions = input.assetVersions === undefined
    ? null
    : [...new Map(input.assetVersions.map((identity) => {
      const assetId = positiveInteger(identity.assetId, "assetId");
      const assetVersionId = positiveInteger(identity.assetVersionId, "assetVersionId");
      return [`${assetId}:${assetVersionId}`, { assetId, assetVersionId }] as const;
    })).values()];
  if (requestedAssetVersions && requestedAssetVersions.length > 8) {
    fail("ASSET_LIBRARY_INPUT_INVALID", "单次最多读取 8 个指定资产版本");
  }
  const requestedAssetIds = input.assetIds === undefined
    ? requestedAssetVersions === null
      ? null
      : [...new Set(requestedAssetVersions.map((identity) => identity.assetId))]
    : [...new Set(input.assetIds.map((assetId) => positiveInteger(assetId, "assetId")))];
  if (requestedAssetIds && requestedAssetIds.length > 8) {
    fail("ASSET_LIBRARY_INPUT_INVALID", "单次最多读取 8 个指定资产");
  }
  const candidateIds = await candidateAssetIds({
    database: input.database,
    workspaceId,
    actorUserId,
    view: input.view,
    projectId,
  }).then((ids) => requestedAssetIds === null
    ? ids
    : ids.filter((assetId) => requestedAssetIds.includes(assetId)));
  const authorized: Array<{ assetId: number; authority: AssetAuthority }> = [];
  for (const assetId of candidateIds) {
    const authority = await assetAuthority({ database: input.database, assetId, workspaceId, actorUserId });
    // A project reference is not an authorization grant.  In particular, a
    // revoked personal share may remain as historical project provenance, but
    // it must disappear from every live asset picker immediately.
    if (authority.canView) {
      authorized.push({ assetId, authority });
    }
  }
  if (!authorized.length) return { items: [], total: 0, view: input.view };

  let rowsQuery = requestedAssetVersions === null
    ? input.database("o_assets as asset")
      .leftJoin("o_image as image", "image.id", "asset.imageId")
    : input.database("o_assets as asset")
      .innerJoin("o_image as image", "image.assetsId", "asset.id")
      .where((query) => {
        const [first, ...rest] = requestedAssetVersions;
        query.where((pair) => pair
          .where("asset.id", first.assetId)
          .andWhere("image.id", first.assetVersionId));
        for (const identity of rest) {
          query.orWhere((pair) => pair
            .where("asset.id", identity.assetId)
            .andWhere("image.id", identity.assetVersionId));
        }
      });
  rowsQuery = rowsQuery
    .whereIn("asset.id", authorized.map((entry) => entry.assetId))
    .where((query) => query.whereNull("asset.deletionState").orWhere("asset.deletionState", "active"));
  const hasFileMetadata = await input.database.schema.hasTable(FILE_METADATA);
  if (hasFileMetadata) {
    rowsQuery.leftJoin(`${FILE_METADATA} as metadata`, "metadata.assetId", "asset.id");
    rowsQuery.whereNotExists(input.database(FILE_METADATA).select("assetId").whereRaw('"o_asset_file_metadata"."assetId" = "asset"."id"').whereNotNull("trashedAt"));
  }
  if (input.type) rowsQuery = rowsQuery.where("asset.type", String(input.type));
  if (input.name) rowsQuery = rowsQuery.whereLike("asset.name", `%${String(input.name)}%`);
  const rows = await rowsQuery
    .select(
      "asset.*",
      "image.id as resolvedImageId",
      "image.filePath",
      "image.state as imageState",
      "image.errorReason as imageErrorReason",
      ...(hasFileMetadata ? ["metadata.tags as assetTags"] : []),
    )
    .orderBy([{ column: "asset.startTime", order: "desc" }, { column: "asset.id", order: "desc" }]);
  const authorityByAsset = new Map(authorized.map((entry) => [entry.assetId, entry.authority]));
  const projectReferences = projectId == null
    ? []
    : await input.database(PROJECT_ASSET_REF_TABLE)
      .where({ workspaceId, projectId })
      .whereNull("removedAt")
      .whereIn("assetId", authorized.map((entry) => entry.assetId))
      .select("id", "projectId", "assetId", "assetVersionId", "revision", "createdAt", "updatedAt");
  const projectReferenceByAsset = new Map(
    projectReferences.map((reference) => [Number(reference.assetId), reference]),
  );
  const total = rows.length;
  const items = rows.slice(offset, offset + limit).map((row) => {
    const authority = authorityByAsset.get(Number(row.id))!;
    const { assetTags: _assetTags, ...rowFields } = row as any;
    return {
      ...rowFields,
      imageId: Number(row.resolvedImageId || row.imageId || 0) || null,
      resolvedImageId: undefined,
      ownership: {
        ownerType: authority.ownership.ownerType,
        ownerUserId: authority.ownership.ownerUserId == null ? null : Number(authority.ownership.ownerUserId),
        ownerWorkspaceId: authority.ownership.ownerWorkspaceId == null ? null : String(authority.ownership.ownerWorkspaceId),
        revision: Number(authority.ownership.revision),
      },
      permissions: {
        view: authority.canView,
        use: authority.canUse,
        manage: authority.canManage,
      },
      authority: authority.authority,
      projectReference: projectReferenceByAsset.get(Number(row.id)) ?? null,
      tags: (() => {
        if (Array.isArray(_assetTags)) return _assetTags;
        try { return JSON.parse(String(_assetTags || "[]")); } catch { return []; }
      })(),
    };
  });
  return { items, total, view: input.view };
}

export async function listAssetGrants(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  actorUserId: number;
  assetId: number;
  includeRevoked?: boolean;
}) {
  await assertAssetLibrarySchema(input.database);
  const workspaceId = text(input.workspaceId, "workspaceId", 128);
  const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
  const assetId = positiveInteger(input.assetId, "assetId");
  await requireMembership(input.database, workspaceId, actorUserId);
  const authority = await assetAuthority({
    database: input.database,
    assetId,
    workspaceId,
    actorUserId,
  });
  if (!authority.canManage) {
    fail("ASSET_LIBRARY_MANAGE_FORBIDDEN", "无权查看该资产的分享授权", 403);
  }
  const query = input.database(ASSET_GRANT_TABLE)
    .where({ assetId, workspaceId });
  if (!input.includeRevoked) query.whereNull("revokedAt");
  return query.orderBy([
    { column: "createdAt", order: "desc" },
    { column: "id", order: "asc" },
  ]);
}

export async function grantAssetAccess(input: {
  database: Knex;
  workspaceId: string;
  actorUserId: number;
  assetId: number;
  granteeType: AssetGrantTargetType;
  granteeUserId?: number | null;
  canView?: boolean;
  canUse?: boolean;
  canManage?: boolean;
  expectedOwnershipRevision?: number | null;
  idempotencyKey: string;
  now?: number;
}) {
  await assertAssetLibrarySchema(input.database);
  const workspaceId = text(input.workspaceId, "workspaceId", 128);
  const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
  const assetId = positiveInteger(input.assetId, "assetId");
  const granteeUserId = input.granteeType === "user"
    ? positiveInteger(input.granteeUserId, "granteeUserId")
    : null;
  const permissions = {
    canView: input.canView !== false,
    canUse: input.canUse !== false,
    canManage: input.canManage === true,
  };
  if (!permissions.canView && !permissions.canUse && !permissions.canManage) {
    fail("ASSET_LIBRARY_INPUT_INVALID", "分享权限不能为空");
  }
  const now = input.now ?? Date.now();
  return input.database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, actorUserId);
    const lockedOwnership = await transaction(ASSET_OWNERSHIP_TABLE)
      .where({ assetId })
      .forUpdate()
      .first();
    if (!lockedOwnership) fail("ASSET_LIBRARY_ASSET_NOT_FOUND", "资产不存在", 404);
    assertExpectedRevision(
      lockedOwnership.revision,
      input.expectedOwnershipRevision,
      "ownership",
    );
    const authority = await assetAuthority({ database: transaction, assetId, workspaceId, actorUserId });
    if (!authority.canManage) fail("ASSET_LIBRARY_MANAGE_FORBIDDEN", "无权分享该资产", 403);
    if (granteeUserId !== null) await requireMembership(transaction, workspaceId, granteeUserId);
    const targetKey = input.granteeType === "workspace" ? "workspace:*" : `user:${granteeUserId}`;
    const activeKey = `${assetId}:${workspaceId}:${targetKey}`;
    const existing = await transaction(ASSET_GRANT_TABLE).where({ activeKey }).first();
    if (existing) return existing;
    await assertMembershipFeature(workspaceId, "shared", transaction);
    const id = randomUUID();
    await transaction(ASSET_GRANT_TABLE).insert({
      id,
      assetId,
      workspaceId,
      granteeType: input.granteeType,
      granteeUserId,
      ...permissions,
      activeKey,
      createdBy: actorUserId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
    });
    await appendAudit(transaction, {
      assetId,
      workspaceId,
      actorUserId,
      action: "asset.grant_created",
      idempotencyKey: input.idempotencyKey,
      details: { grantId: id, granteeType: input.granteeType, granteeUserId, ...permissions },
      now,
    });
    return transaction(ASSET_GRANT_TABLE).where({ id }).first();
  });
}

export async function revokeAssetGrant(input: {
  database: Knex;
  workspaceId: string;
  actorUserId: number;
  assetId: number;
  grantId: string;
  expectedRevision?: number | null;
  idempotencyKey: string;
  now?: number;
}) {
  await assertAssetLibrarySchema(input.database);
  const workspaceId = text(input.workspaceId, "workspaceId", 128);
  const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
  const assetId = positiveInteger(input.assetId, "assetId");
  const grantId = text(input.grantId, "grantId", 128);
  const now = input.now ?? Date.now();
  return input.database.transaction(async (transaction) => {
    const lockedOwnership = await transaction(ASSET_OWNERSHIP_TABLE)
      .where({ assetId })
      .forUpdate()
      .first();
    if (!lockedOwnership) fail("ASSET_LIBRARY_ASSET_NOT_FOUND", "资产不存在", 404);
    const authority = await assetAuthority({ database: transaction, assetId, workspaceId, actorUserId });
    if (!authority.canManage) fail("ASSET_LIBRARY_MANAGE_FORBIDDEN", "无权撤销该分享", 403);
    const grant = await transaction(ASSET_GRANT_TABLE)
      .where({ id: grantId, assetId, workspaceId })
      .forUpdate()
      .first();
    if (!grant) fail("ASSET_LIBRARY_GRANT_NOT_FOUND", "分享授权不存在", 404);
    assertExpectedRevision(grant.revision, input.expectedRevision, "grant");
    if (grant.revokedAt != null) return grant;
    await transaction(ASSET_GRANT_TABLE).where({ id: grantId }).update({
      activeKey: null,
      revokedAt: now,
      updatedAt: now,
      revision: Number(grant.revision) + 1,
    });
    await appendAudit(transaction, {
      assetId,
      workspaceId,
      actorUserId,
      action: "asset.grant_revoked",
      idempotencyKey: input.idempotencyKey,
      details: { grantId },
      now,
    });
    return transaction(ASSET_GRANT_TABLE).where({ id: grantId }).first();
  });
}

export async function transferAssetToWorkspace(input: {
  database: Knex;
  workspaceId: string;
  actorUserId: number;
  assetId: number;
  expectedRevision: number;
  idempotencyKey: string;
  now?: number;
}) {
  await assertAssetLibrarySchema(input.database);
  const workspaceId = text(input.workspaceId, "workspaceId", 128);
  const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
  const assetId = positiveInteger(input.assetId, "assetId");
  const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
  const now = input.now ?? Date.now();
  return input.database.transaction(async (transaction) => {
    const member = await requireMembership(transaction, workspaceId, actorUserId);
    if (!managerRole(member.role)) {
      fail(
        "ASSET_LIBRARY_WORKSPACE_MANAGE_FORBIDDEN",
        "只有工作区所有者或管理员可以接收工作区资产",
        403,
      );
    }
    const priorAudit = await transaction(ASSET_LIBRARY_AUDIT_TABLE)
      .where({ idempotencyKey: input.idempotencyKey, action: "asset.ownership_transferred_to_workspace" })
      .first();
    const ownership = await transaction(ASSET_OWNERSHIP_TABLE)
      .where({ assetId })
      .forUpdate()
      .first();
    if (!ownership) fail("ASSET_LIBRARY_ASSET_NOT_FOUND", "资产不存在", 404);
    if (priorAudit
      && ownership.ownerType === "workspace"
      && String(ownership.ownerWorkspaceId) === workspaceId) {
      return ownership;
    }
    assertExpectedRevision(ownership.revision, expectedRevision, "ownership");
    if (ownership.ownerType !== "user" || Number(ownership.ownerUserId) !== actorUserId) {
      fail(
        "ASSET_LIBRARY_OWNERSHIP_TRANSFER_FORBIDDEN",
        "只有账号资产所有者可以转为工作区资产",
        403,
      );
    }
    await assertMembershipFeature(workspaceId, "shared", transaction);
    await transaction(ASSET_OWNERSHIP_TABLE).where({ assetId }).update({
      ownerType: "workspace",
      ownerUserId: null,
      ownerWorkspaceId: workspaceId,
      revision: Number(ownership.revision) + 1,
      updatedAt: now,
    });
    const activeGrants = await transaction(ASSET_GRANT_TABLE)
      .where({ assetId, workspaceId })
      .whereNull("revokedAt")
      .forUpdate();
    for (const grant of activeGrants) {
      await transaction(ASSET_GRANT_TABLE).where({ id: grant.id }).update({
        activeKey: null,
        revokedAt: now,
        revision: Number(grant.revision) + 1,
        updatedAt: now,
      });
    }
    await appendAudit(transaction, {
      assetId,
      workspaceId,
      actorUserId,
      action: "asset.ownership_transferred_to_workspace",
      idempotencyKey: input.idempotencyKey,
      details: {
        fromOwnerType: "user",
        fromOwnerUserId: actorUserId,
        toOwnerType: "workspace",
        toOwnerWorkspaceId: workspaceId,
        priorRevision: Number(ownership.revision),
        revokedGrantIds: activeGrants.map((grant) => String(grant.id)).sort(),
      },
      now,
    });
    return transaction(ASSET_OWNERSHIP_TABLE).where({ assetId }).first();
  });
}

export async function addProjectAssetReference(input: {
  database: Knex;
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  assetId: number;
  assetVersionId?: string | null;
  expectedOwnershipRevision?: number | null;
  idempotencyKey: string;
  now?: number;
}) {
  await assertAssetLibrarySchema(input.database);
  const workspaceId = text(input.workspaceId, "workspaceId", 128);
  const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
  const projectId = positiveInteger(input.projectId, "projectId");
  const assetId = positiveInteger(input.assetId, "assetId");
  const now = input.now ?? Date.now();
  return input.database.transaction(async (transaction) => {
    const project = await transaction("o_project")
      .where({ id: projectId, workspaceId, deletionState: "active" })
      .first();
    if (!project) fail("ASSET_LIBRARY_PROJECT_NOT_FOUND", "项目不存在", 404);
    await requireMembership(transaction, workspaceId, actorUserId);
    const lockedOwnership = await transaction(ASSET_OWNERSHIP_TABLE)
      .where({ assetId })
      .forUpdate()
      .first();
    if (!lockedOwnership) fail("ASSET_LIBRARY_ASSET_NOT_FOUND", "资产不存在", 404);
    assertExpectedRevision(
      lockedOwnership.revision,
      input.expectedOwnershipRevision,
      "ownership",
    );
    const authority = await assetAuthority({ database: transaction, assetId, workspaceId, actorUserId });
    if (!authority.canUse) fail("ASSET_LIBRARY_USE_FORBIDDEN", "无权在项目中使用该资产", 403);
    const asset = await transaction("o_assets").where({ id: assetId }).first();
    if (!asset) fail("ASSET_LIBRARY_ASSET_NOT_FOUND", "资产不存在", 404);
    if (asset.deletionState && asset.deletionState !== "active") fail("ASSET_LIBRARY_ASSET_NOT_FOUND", "资产正在删除", 409);
    if (await transaction.schema.hasTable(FILE_METADATA) && await transaction(FILE_METADATA).where({ assetId }).whereNotNull("trashedAt").first()) {
      fail("FILE_IN_TRASH", "请先恢复文件再加入项目", 409);
    }
    const assetVersionId = String(input.assetVersionId || (asset.imageId ? `image:${asset.imageId}` : `asset:${assetId}`));
    if (assetVersionId.startsWith("image:")) {
      const version = await transaction("o_image").where({ id: Number(assetVersionId.slice(6)), assetsId: assetId }).first();
      if (!version || (version.deletionState && version.deletionState !== "active")) fail("ASSET_VERSION_NOT_FOUND", "素材版本不存在", 404);
    } else if (assetVersionId !== `asset:${assetId}`) fail("ASSET_VERSION_NOT_FOUND", "素材版本不存在", 404);
    const activeKey = `${workspaceId}:${projectId}:${assetId}:${assetVersionId}`;
    const existing = await transaction(PROJECT_ASSET_REF_TABLE).where({ activeKey }).first();
    if (existing) return existing;
    const id = randomUUID();
    await transaction(PROJECT_ASSET_REF_TABLE).insert({
      id,
      workspaceId,
      projectId,
      assetId,
      assetVersionId,
      activeKey,
      createdBy: actorUserId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      removedAt: null,
    });
    await appendAudit(transaction, {
      assetId,
      workspaceId,
      actorUserId,
      action: "asset.project_ref_added",
      idempotencyKey: input.idempotencyKey,
      details: { refId: id, projectId, assetVersionId },
      now,
    });
    return transaction(PROJECT_ASSET_REF_TABLE).where({ id }).first();
  });
}

export async function removeProjectAssetReference(input: {
  database: Knex;
  workspaceId: string;
  actorUserId: number;
  projectId: number;
  refId: string;
  expectedRevision?: number | null;
  idempotencyKey: string;
  now?: number;
}) {
  await assertAssetLibrarySchema(input.database);
  const workspaceId = text(input.workspaceId, "workspaceId", 128);
  const actorUserId = positiveInteger(input.actorUserId, "actorUserId");
  const projectId = positiveInteger(input.projectId, "projectId");
  const refId = text(input.refId, "refId", 128);
  const now = input.now ?? Date.now();
  return input.database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, actorUserId);
    const project = await transaction("o_project")
      .where({ id: projectId, workspaceId, deletionState: "active" })
      .first();
    if (!project) fail("ASSET_LIBRARY_PROJECT_NOT_FOUND", "项目不存在", 404);
    const ref = await transaction(PROJECT_ASSET_REF_TABLE)
      .where({ id: refId, workspaceId, projectId })
      .forUpdate()
      .first();
    if (!ref) fail("ASSET_LIBRARY_PROJECT_REF_NOT_FOUND", "项目资产引用不存在", 404);
    assertExpectedRevision(ref.revision, input.expectedRevision, "project_ref");
    if (ref.removedAt != null) return ref;
    await transaction(PROJECT_ASSET_REF_TABLE).where({ id: refId }).update({
      activeKey: null,
      removedAt: now,
      updatedAt: now,
      revision: Number(ref.revision) + 1,
    });
    await appendAudit(transaction, {
      assetId: Number(ref.assetId),
      workspaceId,
      actorUserId,
      action: "asset.project_ref_removed",
      idempotencyKey: input.idempotencyKey,
      details: { refId, projectId },
      now,
    });
    return transaction(PROJECT_ASSET_REF_TABLE).where({ id: refId }).first();
  });
}
