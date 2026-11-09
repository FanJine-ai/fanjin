import express from "express";
import { success } from "@/lib/responseFormat";
import { buildWorkbenchModelCatalog } from "@/lib/workbenchModelCatalog";
import { listWorkbenchTextModels } from "@/lib/workbenchTextModelCatalog";
import { publicWorkbenchModelCapability } from "@/lib/fanjinValueVideoOffers";

const router = express.Router();

const handleModelOptions: express.RequestHandler = async (req, res) => {
  const workspaceId = String((req as any).auth?.workspaceId || "default");
  const [catalog, llmModels] = await Promise.all([
    buildWorkbenchModelCatalog(workspaceId),
    listWorkbenchTextModels(workspaceId),
  ]);

  const publicModels = catalog.models
    .filter((model) => model.canSubmit === true)
    .map(publicWorkbenchModelCapability);
  const publicImageModels = catalog.imageModels
    .filter((model) => model.canSubmit === true)
    .map(publicWorkbenchModelCapability);
  const publicVideoModels = catalog.videoModels
    .filter((model) => model.canSubmit === true)
    .map(publicWorkbenchModelCapability);
  res.status(200).send(success({
    catalogVersion: catalog.catalogVersion,
    models: publicModels,
    llmModels: llmModels.map(publicWorkbenchModelCapability),
    imageModels: publicImageModels,
    videoModels: publicVideoModels,
  }));
};

router.get("/", handleModelOptions);
router.post("/", handleModelOptions);

export default router;
