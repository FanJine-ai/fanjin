import {
  listWorkbenchRouteModels,
  type WorkbenchModelCredentialReadMode,
  type WorkbenchModelCatalogDatabase,
} from "@/lib/workbenchModelCatalog";

export type WorkbenchTextModel = {
  id: string;
  label: string;
  description: string;
  capabilityStatus: "verified";
  canSubmit: true;
};

/**
 * Return only text models that can reach an enabled provider channel and have
 * an enabled pricing rule for the current workspace. Quick Create must not
 * advertise legacy Agent deployments as usable text models when the actual
 * relay route cannot submit them.
 */
export async function listWorkbenchTextModels(
  workspaceId: string,
  database?: WorkbenchModelCatalogDatabase,
  options: Readonly<{
    credentialReadMode?: WorkbenchModelCredentialReadMode;
  }> = {},
): Promise<WorkbenchTextModel[]> {
  const summaries = await listWorkbenchRouteModels({
    workspaceId,
    endpointTypes: ["text"],
    database,
    credentialReadMode: options.credentialReadMode,
  });
  return summaries
    .filter((summary) => summary.canSubmit)
    .map((summary) => ({
      id: summary.model,
      label: summary.displayName || summary.name || summary.model,
      description: "按实际用量计费",
      capabilityStatus: "verified" as const,
      canSubmit: true as const,
    }));
}
