import express from "express";
import { z } from "zod";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { generationRequestSchema } from "@/tools/creationContracts";
import { creationGateway, prepareToolGeneration } from "@/tools/creationRuntime";
import { assertRelayTaskProjectAuthority, createRelayTask, formatPublicRelayTask } from "@/lib/relay";
import { issueQuickCreatePricingConfirmation, verifyQuickCreatePricingConfirmation } from "@/lib/quickCreatePricingConfirmation";
import { guMicrosPerGu } from "@/lib/billingUnits";
import { resolveRelaySubmissionOutcome } from "@/lib/relaySubmissionOutcome";
import { relayPortraitPreparationView } from "@/lib/relayPortraitPreparation";

const schema = z.strictObject({
  action: z.enum(["quote", "submit"]), request: generationRequestSchema,
  generationAttemptId: z.string().min(16).max(128).regex(/^[A-Za-z0-9._-]+$/),
  confirmationToken: z.string().max(16384).optional(),
});
export default express.Router().post("/", requireActiveWorkspacePermission("generation:create"), async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).send({ message: "样片参数错误", errors: parsed.error.issues });
  const { request, action, generationAttemptId, confirmationToken } = parsed.data;
  if (request.type !== "video" || !["draft", "finalize"].includes(request.renderMode || "")) return res.status(422).send({ message: "此入口仅用于样片和样片转正式片" });
  const workspaceId = String((req as any).auth?.workspaceId || ""), userId = Number((req as any).auth?.user?.id);
  if (!workspaceId || !userId) return res.status(403).send({ message: "缺少可信工作区上下文" });
  try {
    await assertRelayTaskProjectAuthority({ endpointType: "video_generation", workspaceId, projectId: request.projectId });
    const identity = { workspaceId, userId, keyId: "", modelAllowlist: [], permissions: [], memberPermissions: [] };
    const prepared = await prepareToolGeneration(identity, request);
    const binding = { kind: "video_batch" as const, workspaceId, actorUserId: userId, projectId: request.projectId,
      idempotencyKey: generationAttemptId, requestHash: prepared.canonical!.digest };
    if (action === "quote") {
      const pricing = await creationGateway.quote(identity, request);
      const confirmation = issueQuickCreatePricingConfirmation({ binding, itemMaximumCostMicros: { video: pricing.maximumCostMicros } });
      return res.send({ ...confirmation, maximumGu: pricing.maximumCostMicros / guMicrosPerGu,
        renderMode: request.renderMode, resolution: prepared.canonical!.request.outputResolution,
        draftExpiresAt: prepared.canonical!.request.draftSource?.expiresAt ?? null });
    }
    const approved = verifyQuickCreatePricingConfirmation({ token: confirmationToken || "", binding, expectedItemKeys: ["video"] });
    const { task } = await createRelayTask({ endpointType: "video_generation", workspaceId, projectId: request.projectId,
      actorUserId: userId,
      apiKeyId: null, principalId: String(userId), model: prepared.capability.id,
      requestId: `canvas-draft:${userId}:${generationAttemptId}`, requestPayload: prepared.payload }, {
      trustedCanonicalVideoGeneration: prepared.canonical, trustedVideoAssetPolicyEvidence: prepared.refs.trustedPolicyEvidence,
      trustedVideoProviderAdapter: prepared.formal?.relayAdapterBinding,
      requireQuickCreatePricingConfirmation: true,
      trustedQuickCreatePricingAuthorization: { maximumCostMicros: approved.itemMaximumCostMicros.video, expiresAt: approved.expiresAt },
    });
    const outcome = resolveRelaySubmissionOutcome({ status: task.status, providerPayload: task.providerPayload });
    return res.send({ taskId: task.id, status: outcome.accepted ? "processing" : outcome.status, ...relayPortraitPreparationView(task), draft: (await formatPublicRelayTask(task)).draft,
      ...(outcome.message ? { message: outcome.message } : {}) });
  } catch (error: any) {
    const status = Number(error.statusCode ?? error.status);
    return res.status(status >= 400 && status < 600 ? status : 500).send({ code: error.code || "draft_request_failed", message: error.message || "样片请求未完成" });
  }
});
