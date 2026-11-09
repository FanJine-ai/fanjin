import type { Knex } from "knex";
import type { ModelRouteGroup } from "@/lib/modelRouteGroups";
import { isManagedModelRoute } from "@/lib/modelRouteGroups";
import { explainManagedLogicalModelPublication } from "@/lib/workbenchModelCatalog";

type Database = Knex | Knex.Transaction;

export async function enrichModelRouteGroupPublication(
  database: Database,
  groups: ModelRouteGroup[],
): Promise<ModelRouteGroup[]> {
  return await Promise.all(groups.map(async (group) => {
    const managed = group.targets.some((target) => isManagedModelRoute({ routeConfig: target.routeConfig }));
    if (!managed || group.disabled || group.publication.status === "needs_attention") return group;
    const readiness = await explainManagedLogicalModelPublication({
      database,
      workspaceId: group.scope === "workspace"
        ? String(group.workspaceId || "")
        : "__platform_logical_model_catalog__",
      endpointType: group.endpointType,
      model: group.publicModel,
    });
    if (!readiness.managed) return group;
    const blockingReasons = Array.from(new Set([
      ...group.publication.blockingReasons,
      ...readiness.reasons,
    ]));
    if (!readiness.ready) {
      return {
        ...group,
        publication: {
          ...group.publication,
          status: "draft" as const,
          blockingReasons,
        },
      };
    }
    return {
      ...group,
      publication: {
        ...group.publication,
        status: readiness.degraded ? "degraded" as const : "published" as const,
        blockingReasons: [],
      },
    };
  }));
}
