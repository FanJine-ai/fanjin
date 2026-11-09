import { auditAnalyticsExport } from "@/analytics/audit";
import { createToolService, type ToolService } from "./service";
import { createStudioGateway } from "./studioRuntime";

let service: Promise<ToolService> | undefined;

export function getToolService(): Promise<ToolService> {
  service ??= Promise.all([import("@/utils/db"), import("@/lib/workbenchModelCatalog"), import("./creationRuntime")])
    .then(async ([{ db, dbReady }, { buildWorkbenchModelCatalog }, { creationGateway }]) => {
      await dbReady;
      return createToolService({ studioGateway: createStudioGateway(db), analyticsAudit: auditAnalyticsExport, database: db, creationGateway, catalog: (workspaceId) => buildWorkbenchModelCatalog(workspaceId, db) });
    }).catch((error) => { service = undefined; throw error; });
  return service;
}
