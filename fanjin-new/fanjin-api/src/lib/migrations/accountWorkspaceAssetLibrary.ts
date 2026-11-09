import { createHash } from "node:crypto";
import type { Knex } from "knex";

export const ASSET_OWNERSHIP_TABLE = "o_asset_ownership";
export const ASSET_GRANT_TABLE = "o_asset_grant";
export const PROJECT_ASSET_REF_TABLE = "o_project_asset_ref";
export const ASSET_LIBRARY_AUDIT_TABLE = "o_asset_library_audit";
export const CANVAS_SHARE_TABLE = "o_canvas_share";
export const FJTV_PUBLICATION_TABLE = "o_fjtv_publication";

export const ASSET_LIBRARY_INDEXES = {
  ownershipUser: "idx_o_asset_ownership_user",
  ownershipWorkspace: "idx_o_asset_ownership_workspace",
  grantAudience: "idx_o_asset_grant_audience",
  grantActiveKey: "uq_o_asset_grant_active_key",
  projectRefScope: "idx_o_project_asset_ref_scope",
  projectRefActiveKey: "uq_o_project_asset_ref_active_key",
  auditAsset: "idx_o_asset_library_audit_asset",
  canvasShareScope: "idx_o_canvas_share_scope",
  canvasShareSlug: "uq_o_canvas_share_slug",
  canvasShareIdempotency: "uq_o_canvas_share_idempotency",
  fjtvPublicationStatus: "idx_o_fjtv_publication_status",
  fjtvPublicationSlug: "uq_o_fjtv_publication_slug",
  fjtvPublicationIdempotency: "uq_o_fjtv_publication_idempotency",
} as const;

export const ACCOUNT_WORKSPACE_ASSET_LIBRARY_REQUIRED_CONSTRAINTS = [
  `table:${ASSET_OWNERSHIP_TABLE}`,
  `table:${ASSET_GRANT_TABLE}`,
  `table:${PROJECT_ASSET_REF_TABLE}`,
  `table:${ASSET_LIBRARY_AUDIT_TABLE}`,
  `primary-key:${ASSET_OWNERSHIP_TABLE}.assetId`,
  `primary-key:${ASSET_GRANT_TABLE}.id`,
  `primary-key:${PROJECT_ASSET_REF_TABLE}.id`,
  `primary-key:${ASSET_LIBRARY_AUDIT_TABLE}.id`,
  `not-null:${ASSET_OWNERSHIP_TABLE}.ownerType`,
  `not-null:${ASSET_OWNERSHIP_TABLE}.sourceWorkspaceId`,
  `not-null:${ASSET_GRANT_TABLE}.workspaceId`,
  `not-null:${PROJECT_ASSET_REF_TABLE}.workspaceId`,
  `not-null:${PROJECT_ASSET_REF_TABLE}.projectId`,
  `not-null:${PROJECT_ASSET_REF_TABLE}.assetId`,
  `not-null:${PROJECT_ASSET_REF_TABLE}.assetVersionId`,
  `index:${ASSET_OWNERSHIP_TABLE}.${ASSET_LIBRARY_INDEXES.ownershipUser}`,
  `index:${ASSET_OWNERSHIP_TABLE}.${ASSET_LIBRARY_INDEXES.ownershipWorkspace}`,
  `index:${ASSET_GRANT_TABLE}.${ASSET_LIBRARY_INDEXES.grantAudience}`,
  `index:${ASSET_GRANT_TABLE}.${ASSET_LIBRARY_INDEXES.grantActiveKey}`,
  `index:${PROJECT_ASSET_REF_TABLE}.${ASSET_LIBRARY_INDEXES.projectRefScope}`,
  `index:${PROJECT_ASSET_REF_TABLE}.${ASSET_LIBRARY_INDEXES.projectRefActiveKey}`,
  `index:${ASSET_LIBRARY_AUDIT_TABLE}.${ASSET_LIBRARY_INDEXES.auditAsset}`,
  `table:${CANVAS_SHARE_TABLE}`,
  `table:${FJTV_PUBLICATION_TABLE}`,
  `primary-key:${CANVAS_SHARE_TABLE}.id`,
  `primary-key:${FJTV_PUBLICATION_TABLE}.id`,
  `not-null:${CANVAS_SHARE_TABLE}.snapshotJson`,
  `not-null:${CANVAS_SHARE_TABLE}.snapshotHash`,
  `not-null:${FJTV_PUBLICATION_TABLE}.snapshotJson`,
  `not-null:${FJTV_PUBLICATION_TABLE}.snapshotHash`,
  `index:${CANVAS_SHARE_TABLE}.${ASSET_LIBRARY_INDEXES.canvasShareScope}`,
  `index:${CANVAS_SHARE_TABLE}.${ASSET_LIBRARY_INDEXES.canvasShareSlug}`,
  `index:${CANVAS_SHARE_TABLE}.${ASSET_LIBRARY_INDEXES.canvasShareIdempotency}`,
  `index:${FJTV_PUBLICATION_TABLE}.${ASSET_LIBRARY_INDEXES.fjtvPublicationStatus}`,
  `index:${FJTV_PUBLICATION_TABLE}.${ASSET_LIBRARY_INDEXES.fjtvPublicationSlug}`,
  `index:${FJTV_PUBLICATION_TABLE}.${ASSET_LIBRARY_INDEXES.fjtvPublicationIdempotency}`,
] as const;

function deterministicId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * Additive account/workspace asset authority. `o_assets.projectId` remains a
 * legacy provenance field; ownership and current project usage live here.
 * Existing assets are backfilled to the account that owned their source
 * project.  Previous broad workspace queries were an implementation leak, not
 * durable ownership authority, and must not silently publish private media.
 */
export async function upAccountWorkspaceAssetLibrary(
  trx: Knex.Transaction,
): Promise<void> {
  if (!(await trx.schema.hasTable("o_assets"))
    || !(await trx.schema.hasTable("o_project"))) return;

  if (!(await trx.schema.hasTable(ASSET_OWNERSHIP_TABLE))) {
    await trx.schema.createTable(ASSET_OWNERSHIP_TABLE, (table) => {
      table.bigInteger("assetId").notNullable().primary()
        .references("id").inTable("o_assets").onDelete("CASCADE");
      table.text("ownerType").notNullable();
      table.bigInteger("ownerUserId");
      table.text("ownerWorkspaceId");
      table.text("sourceWorkspaceId").notNullable();
      table.bigInteger("createdBy").notNullable();
      table.bigInteger("revision").notNullable().defaultTo(1);
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
      table.index(["ownerUserId", "updatedAt", "assetId"], ASSET_LIBRARY_INDEXES.ownershipUser);
      table.index(["ownerWorkspaceId", "updatedAt", "assetId"], ASSET_LIBRARY_INDEXES.ownershipWorkspace);
      table.check(
        "(\"ownerType\" = 'user' AND \"ownerUserId\" IS NOT NULL AND \"ownerWorkspaceId\" IS NULL)"
          + " OR (\"ownerType\" = 'workspace' AND \"ownerUserId\" IS NULL AND \"ownerWorkspaceId\" IS NOT NULL)",
        {},
        "chk_o_asset_ownership_exact_owner",
      );
      table.check("\"revision\" >= 1", {}, "chk_o_asset_ownership_revision");
    });
  }

  if (!(await trx.schema.hasTable(ASSET_GRANT_TABLE))) {
    await trx.schema.createTable(ASSET_GRANT_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.bigInteger("assetId").notNullable()
        .references("assetId").inTable(ASSET_OWNERSHIP_TABLE).onDelete("CASCADE");
      table.text("workspaceId").notNullable();
      table.text("granteeType").notNullable();
      table.bigInteger("granteeUserId");
      table.boolean("canView").notNullable().defaultTo(true);
      table.boolean("canUse").notNullable().defaultTo(true);
      table.boolean("canManage").notNullable().defaultTo(false);
      table.text("activeKey").unique(ASSET_LIBRARY_INDEXES.grantActiveKey);
      table.bigInteger("createdBy").notNullable();
      table.bigInteger("revision").notNullable().defaultTo(1);
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
      table.bigInteger("revokedAt");
      table.index(
        ["workspaceId", "granteeType", "granteeUserId", "revokedAt", "assetId"],
        ASSET_LIBRARY_INDEXES.grantAudience,
      );
      table.check(
        "(\"granteeType\" = 'workspace' AND \"granteeUserId\" IS NULL)"
          + " OR (\"granteeType\" = 'user' AND \"granteeUserId\" IS NOT NULL)",
        {},
        "chk_o_asset_grant_exact_grantee",
      );
      table.check(
        "\"canView\" OR \"canUse\" OR \"canManage\"",
        {},
        "chk_o_asset_grant_nonempty_permissions",
      );
    });
  }

  if (!(await trx.schema.hasTable(PROJECT_ASSET_REF_TABLE))) {
    await trx.schema.createTable(PROJECT_ASSET_REF_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.text("workspaceId").notNullable();
      table.bigInteger("projectId").notNullable()
        .references("id").inTable("o_project").onDelete("CASCADE");
      table.bigInteger("assetId").notNullable()
        .references("assetId").inTable(ASSET_OWNERSHIP_TABLE).onDelete("CASCADE");
      table.text("assetVersionId").notNullable();
      table.text("activeKey").unique(ASSET_LIBRARY_INDEXES.projectRefActiveKey);
      table.bigInteger("createdBy").notNullable();
      table.bigInteger("revision").notNullable().defaultTo(1);
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
      table.bigInteger("removedAt");
      table.index(
        ["workspaceId", "projectId", "removedAt", "updatedAt", "id"],
        ASSET_LIBRARY_INDEXES.projectRefScope,
      );
    });
  }

  if (!(await trx.schema.hasTable(ASSET_LIBRARY_AUDIT_TABLE))) {
    await trx.schema.createTable(ASSET_LIBRARY_AUDIT_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.bigInteger("assetId").notNullable();
      table.text("workspaceId").notNullable();
      table.bigInteger("actorUserId").notNullable();
      table.text("action").notNullable();
      table.text("idempotencyKey").notNullable().unique();
      table.text("detailsJson").notNullable().defaultTo("{}");
      table.text("detailsHash").notNullable();
      table.bigInteger("createdAt").notNullable();
      table.index(["assetId", "createdAt", "id"], ASSET_LIBRARY_INDEXES.auditAsset);
    });
  }

  if (!(await trx.schema.hasTable(CANVAS_SHARE_TABLE))) {
    await trx.schema.createTable(CANVAS_SHARE_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.text("slug").notNullable().unique(ASSET_LIBRARY_INDEXES.canvasShareSlug);
      table.text("workspaceId").notNullable();
      table.bigInteger("projectId").notNullable()
        .references("id").inTable("o_project").onDelete("CASCADE");
      table.bigInteger("canvasId").notNullable()
        .references("id").inTable("o_workflow_graph").onDelete("CASCADE");
      table.bigInteger("snapshotRevision").notNullable();
      table.text("snapshotHash").notNullable();
      table.text("snapshotJson").notNullable();
      table.text("title").notNullable();
      table.bigInteger("createdBy").notNullable();
      table.text("status").notNullable().defaultTo("active");
      table.text("idempotencyKey").notNullable();
      table.bigInteger("revision").notNullable().defaultTo(1);
      table.bigInteger("expiresAt");
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
      table.bigInteger("revokedAt");
      table.index(
        ["workspaceId", "projectId", "canvasId", "status", "createdAt"],
        ASSET_LIBRARY_INDEXES.canvasShareScope,
      );
      table.unique(
        ["workspaceId", "canvasId", "idempotencyKey"],
        ASSET_LIBRARY_INDEXES.canvasShareIdempotency,
      );
      table.check("\"snapshotRevision\" >= 1", {}, "chk_o_canvas_share_snapshot_revision");
      table.check("\"revision\" >= 1", {}, "chk_o_canvas_share_revision");
      table.check("\"status\" IN ('active', 'revoked')", {}, "chk_o_canvas_share_status");
    });
  }

  if (!(await trx.schema.hasTable(FJTV_PUBLICATION_TABLE))) {
    await trx.schema.createTable(FJTV_PUBLICATION_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.text("slug").notNullable().unique(ASSET_LIBRARY_INDEXES.fjtvPublicationSlug);
      table.text("workspaceId").notNullable();
      table.bigInteger("projectId").notNullable()
        .references("id").inTable("o_project").onDelete("CASCADE");
      table.bigInteger("canvasId").notNullable()
        .references("id").inTable("o_workflow_graph").onDelete("CASCADE");
      table.bigInteger("snapshotRevision").notNullable();
      table.text("snapshotHash").notNullable();
      table.text("snapshotJson").notNullable();
      table.text("title").notNullable();
      table.text("description").notNullable().defaultTo("");
      table.text("coverUrl");
      table.bigInteger("submittedBy").notNullable();
      table.text("status").notNullable().defaultTo("pending_review");
      table.text("idempotencyKey").notNullable();
      table.bigInteger("revision").notNullable().defaultTo(1);
      table.bigInteger("moderatedBy");
      table.text("moderationReason");
      table.bigInteger("moderatedAt");
      table.bigInteger("publishedAt");
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
      table.unique(
        ["workspaceId", "canvasId", "idempotencyKey"],
        ASSET_LIBRARY_INDEXES.fjtvPublicationIdempotency,
      );
      table.index(
        ["status", "publishedAt", "createdAt", "id"],
        ASSET_LIBRARY_INDEXES.fjtvPublicationStatus,
      );
      table.check("\"snapshotRevision\" >= 1", {}, "chk_o_fjtv_publication_snapshot_revision");
      table.check("\"revision\" >= 1", {}, "chk_o_fjtv_publication_revision");
      table.check(
        "\"status\" IN ('pending_review', 'published', 'rejected', 'unpublished')",
        {},
        "chk_o_fjtv_publication_status",
      );
    });
  }

  const legacyRows = await trx("o_assets as asset")
    .innerJoin("o_project as project", "project.id", "asset.projectId")
    .leftJoin("o_asset_ownership as ownership", "ownership.assetId", "asset.id")
    .whereNull("ownership.assetId")
    .where((query) => query.whereNull("asset.deletionState").orWhere("asset.deletionState", "active"))
    .select(
      "asset.id as assetId",
      "asset.imageId as imageId",
      "project.id as projectId",
      "project.workspaceId as workspaceId",
      "project.userId as projectUserId",
      "project.createTime as projectCreatedAt",
    );
  const now = Date.now();
  for (const row of legacyRows) {
    const assetId = Number(row.assetId);
    const projectId = Number(row.projectId);
    const workspaceId = String(row.workspaceId || "default");
    const actorUserId = Number(row.projectUserId || 0);
    if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
      throw new Error(
        `Migration account_workspace_asset_library cannot prove an owner for asset ${assetId}`,
      );
    }
    const createdAt = Number(row.projectCreatedAt || now);
    await trx(ASSET_OWNERSHIP_TABLE).insert({
      assetId,
      ownerType: "user",
      ownerUserId: actorUserId,
      ownerWorkspaceId: null,
      sourceWorkspaceId: workspaceId,
      createdBy: actorUserId,
      revision: 1,
      createdAt,
      updatedAt: now,
    }).onConflict("assetId").ignore();
    const assetVersionId = row.imageId == null
      ? `asset:${assetId}`
      : `image:${Number(row.imageId)}`;
    const activeKey = `${workspaceId}:${projectId}:${assetId}:${assetVersionId}`;
    await trx(PROJECT_ASSET_REF_TABLE).insert({
      id: deterministicId("project-asset-ref", activeKey),
      workspaceId,
      projectId,
      assetId,
      assetVersionId,
      activeKey,
      createdBy: actorUserId,
      revision: 1,
      createdAt,
      updatedAt: now,
      removedAt: null,
    }).onConflict("activeKey").ignore();
  }

  const unowned = await trx("o_assets as asset")
    .leftJoin(ASSET_OWNERSHIP_TABLE, `${ASSET_OWNERSHIP_TABLE}.assetId`, "asset.id")
    .whereNull(`${ASSET_OWNERSHIP_TABLE}.assetId`)
    .where((query) => query.whereNull("asset.deletionState").orWhere("asset.deletionState", "active"))
    .select("asset.id")
    .limit(1)
    .first();
  if (unowned) {
    throw new Error(
      `Migration account_workspace_asset_library cannot prove ownership for asset ${String(unowned.id)}`,
    );
  }
}

export async function downAccountWorkspaceAssetLibrary(): Promise<void> {
  throw new Error(
    "Migration account_workspace_asset_library cannot be rolled back safely because ownership, grants and project references are durable user authority.",
  );
}
