import type { Knex } from "knex";
import { AssetLibraryError, assertProjectAssetReferencePermission } from "@/lib/accountWorkspaceAssetLibrary";
import { PROJECT_ASSET_REF_TABLE } from "@/lib/migrations/accountWorkspaceAssetLibrary";

export type ProjectAssetVersion = {
  id: number;
  assetId: number;
  sourceProjectId: number;
  filePath: string | null;
  storageKey: string | null;
  type: string;
};

/** Resolve usage in a project without moving/copying the immutable source
 * version. Workers revalidate the recorded reference author's live authority;
 * interactive callers additionally supply the current actor. */
export async function resolveProjectAssetVersion(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  projectId: number;
  assetVersionId: number;
  actorUserId?: number;
}): Promise<ProjectAssetVersion | null> {
  const { database, workspaceId, projectId, assetVersionId } = input;
  const row = await database("o_image as version")
    .innerJoin("o_assets as asset", "asset.id", "version.assetsId")
    .innerJoin("o_project as source", "source.id", "asset.projectId")
    .where({ "version.id": assetVersionId, "source.workspaceId": workspaceId,
      "asset.deletionState": "active", "version.deletionState": "active" })
    .select({ id: "version.id", assetId: "asset.id", sourceProjectId: "asset.projectId", sourceDeletionState: "source.deletionState",
      filePath: "version.filePath", storageKey: "version.storageKey", type: "version.type" })
    .first();
  if (!row) return null;
  // A retained library asset may outlive its source project, but a deleted
  // project itself must never become a valid generation target again.
  if (Number(row.sourceProjectId) === projectId && row.sourceDeletionState !== "active") return null;
  if (Number(row.sourceProjectId) !== projectId) {
    if (!(await database.schema.hasTable(PROJECT_ASSET_REF_TABLE))) return null;
    const ref = await database(PROJECT_ASSET_REF_TABLE)
      .where({ workspaceId, projectId, assetId: row.assetId, assetVersionId: `image:${assetVersionId}` })
      .whereNull("removedAt").select("createdBy").first();
    if (!ref) return null;
    try {
      await assertProjectAssetReferencePermission({ database, workspaceId, projectId,
        actorUserId: input.actorUserId ?? Number(ref.createdBy),
        assetId: Number(row.assetId), assetVersionId, permission: "use" });
    } catch (error) {
      if (error instanceof AssetLibraryError && error.status < 500) return null;
      throw error;
    }
  }
  return { ...row, id: Number(row.id), assetId: Number(row.assetId), sourceProjectId: Number(row.sourceProjectId) };
}
