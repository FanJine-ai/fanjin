import { db } from "@/utils/db";
import { GenerationReferenceError, resolveCanonicalGenerationReferences, type GenerationReference } from "./generationReferenceResolver";
import { buildCanonicalVideoGenerationEnvelope } from "./videoGenerationSurfaceContract";
import { resolveWorkbenchModelCapability } from "./workbenchModelCatalog";
import type { WorkbenchRelayInput } from "./workbenchVideoRelay";
import type { VideoGenerationRequest } from "./videoGenerationContract";

/** Convert production storyboard selections to the same owned asset versions used by Canvas. */
export async function bindProductionVideoReferences(
  input: WorkbenchRelayInput,
  frozenRequest?: VideoGenerationRequest,
): Promise<WorkbenchRelayInput> {
  const project = await db("o_project").where({ id: input.projectId }).first("workspaceId", "videoRatio");
  if (!project?.workspaceId) throw new GenerationReferenceError(404, "project_not_found", "项目不存在");
  const references: GenerationReference[] = frozenRequest
    ? frozenRequest.inputs.map((reference) => ({ ...reference }))
    : await Promise.all(input.uploadData.map(async (item): Promise<GenerationReference> => {
        if (!Number.isSafeInteger(item.id) || Number(item.id) <= 0) {
          throw new GenerationReferenceError(400, "reference_id_invalid", "参考素材 ID 无效");
        }
        const query = db("o_image as image")
          .innerJoin("o_assets as asset", "asset.id", "image.assetsId")
          .where("asset.projectId", input.projectId);
        if (item.sources === "assets") {
          query.where("asset.id", item.id!).whereRaw("?? = ??", ["asset.imageId", "image.id"]);
        } else if (item.sources === "storyboard") {
          const storyboard = await db("o_storyboard").where({ id: item.id, projectId: input.projectId }).first("filePath");
          if (!storyboard?.filePath) throw new GenerationReferenceError(404, "reference_not_found", "分镜参考图不存在，请先生成或上传参考图");
          query.where("image.filePath", storyboard.filePath);
        } else {
          throw new GenerationReferenceError(400, "reference_source_unsupported", "参考素材来源不受支持");
        }
        const image = await query.orderBy("image.id", "desc").first("image.id");
        if (!image) throw new GenerationReferenceError(404, "reference_version_not_found", "参考图未关联项目素材，请重新选择或上传参考图");
        return { assetVersionId: String(image.id), role: item.role || (item.sources === "storyboard" ? "storyboard" : "subject") };
      }));
  const resolved = await resolveCanonicalGenerationReferences({
    workspaceId: String(project.workspaceId), projectId: String(input.projectId), references,
  });
  const capability = await resolveWorkbenchModelCapability({ workspaceId: String(project.workspaceId), endpointType: "video_generation", model: input.model });
  if (!capability?.canSubmit) throw new GenerationReferenceError(422, "video_model_unavailable", capability?.unavailableReason || "视频模型不可用");
  const canonicalRequest = frozenRequest ?? buildCanonicalVideoGenerationEnvelope({
    operation: "generate", modelRouteId: capability.routeId || capability.id, prompt: input.prompt,
    aspectRatio: String(project.videoRatio), durationSeconds: input.duration,
    outputResolution: input.resolution, generateAudio: Boolean(input.audio), inputs: resolved.inputs,
    outputFormat: input.outputFormat,
    preparedReferenceContent: resolved.providerContent,
  }).request;
  return { ...input, canonicalRequest, referenceContent: resolved.providerContent, trustedVideoAssetPolicyEvidence: resolved.trustedPolicyEvidence };
}
