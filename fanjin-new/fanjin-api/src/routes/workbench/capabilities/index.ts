import express from "express";

import { buildWorkbenchCanvasCapabilityDirectory } from "@/lib/workbenchCanvasCapabilityCatalog";
import { buildWorkbenchModelCatalog } from "@/lib/workbenchModelCatalog";
import { listWorkbenchTextModels } from "@/lib/workbenchTextModelCatalog";
import { inspectVideoStoryAnalyzerConfiguration } from "@/lib/videoStoryAnalyzer";
import { success } from "@/lib/responseFormat";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();

/**
 * GET /api/workbench/capabilities
 *
 * Returns the server-owned canvas action directory.  Model-specific options,
 * resolutions and pricing stay in the model catalog referenced by the
 * response and are revalidated by each submit endpoint.
 */
export default router.get(
  "/",
  requireActiveWorkspacePermission("project:read"),
  async (req, res) => {
    const workspaceId = String((req as any).auth?.workspaceId || "").trim();
    const [modelCatalog, textModels] = await Promise.all([
      buildWorkbenchModelCatalog(workspaceId),
      listWorkbenchTextModels(workspaceId),
    ]);
    return res.status(200).send(success(buildWorkbenchCanvasCapabilityDirectory({
      modelCatalog,
      textModels,
      videoStoryAnalyzer: inspectVideoStoryAnalyzerConfiguration(),
    })));
  },
);
