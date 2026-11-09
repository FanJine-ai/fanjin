import { db } from "@/utils/db";
import { resolveWorkbenchModelCapability } from "./workbenchModelCatalog";
import { resolveCanonicalGenerationReferences } from "./generationReferenceResolver";
import { prepareSeedance25Request } from "./seedance25Adapter";
import { draftError, draftFinalPayload, resolveDraftParent } from "./seedanceDraft";
import { canonicalVideoGenerationRequest, videoGenerationRequestDigest } from "./videoGenerationContract";

export async function prepareDraftFinalization(scope: { workspaceId: string; projectId: number; actorUserId: number }, draftTaskId: string,
  options: { outputFormat?: "mp4" | "mov" } = {}) {
  const parent = await db("o_relay_task").where({ id: draftTaskId, workspaceId: scope.workspaceId, projectId: scope.projectId }).first();
  const parentCanonical = resolveDraftParent(parent || null, scope);
  const model = String(parent?.model || "");
  if (options.outputFormat && model !== "dreamina-seedance-2-5-260628") draftError("draft_output_format_unsupported", "原模型不支持指定成片格式");
  const request = canonicalVideoGenerationRequest({ ...parentCanonical.request,
    ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}) });
  const canonical = { request, digest: videoGenerationRequestDigest(request) };
  const capability = await resolveWorkbenchModelCapability({ workspaceId: scope.workspaceId, endpointType: "video_generation", model });
  if (!capability?.canSubmit || !capability.videoGeneration?.draft?.enabled) draftError("draft_model_unavailable", "样片原模型当前不可提交");
  const channel = await db("o_provider_channel").where({ id: canonical.request.draftSource!.channelId, disabled: 0, provider: "volcano", endpointType: "video_generation" }).first();
  if (!channel) draftError("draft_channel_unavailable", "样片原通道不可用，请稍后重试；不会改用其他通道", 409);
  const refs = await resolveCanonicalGenerationReferences({ ...scope, projectId: String(scope.projectId), references: canonical.request.inputs });
  // Re-run current capability and rights admission on the immutable parent inputs.
  const formal = prepareSeedance25Request({ capability, request: { ...canonical.request, renderMode: undefined, draftSource: undefined },
    providerContent: refs.providerContent, policyEvidence: refs.trustedPolicyEvidence, workspaceId: scope.workspaceId, projectId: String(scope.projectId) });
  return { capability, refs, canonical, formal: { ...formal, requestPayload: draftFinalPayload(canonical.request) }, payload: draftFinalPayload(canonical.request) };
}
