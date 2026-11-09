import { managedFileVersion, requireFileProject } from "@/lib/assetFileManager";
import { PROJECT_ASSET_REF_TABLE } from "@/lib/migrations/accountWorkspaceAssetLibrary";
import { FILE_METADATA } from "@/lib/migrations/assetFileManager";
import { attachCanvasOutput } from "./canvasDelivery";
import { prepareDraftFinalization } from "@/lib/seedanceDraftRuntime";
import { draftTaskInfo, draftPricingDuration } from "@/lib/seedanceDraft";
import { EXTERNAL_TOOL_TABLE } from "@/lib/migrations/externalTools";
import { ceilGuChargeMicros } from "@/lib/billingUnits";
import { internalModelId, modelAllowlistIncludes } from "@/lib/minimaxH3PublicIdentity";
import { createHash } from "node:crypto";
import { db } from "@/utils/db";
import oss from "@/utils/oss";
import { createCanonicalProject } from "@/lib/projectCanvasService";
import { buildWorkbenchModelCatalog } from "@/lib/workbenchModelCatalog";
import { resolveCanonicalGenerationReferences } from "@/lib/generationReferenceResolver";
import { validateWorkbenchVideoInputs } from "@/lib/workbenchVideoCapability";
import { validateImageReferenceInputs } from "@/lib/workbenchImageCapability";
import { resolveVolcengineImageSize } from "@/lib/volcengineImageSize";
import { buildCanonicalVideoGenerationEnvelope, buildLegacyVideoProviderRequestPayload } from "@/lib/videoGenerationSurfaceContract";
import { prepareSeedance25Request } from "@/lib/seedance25Adapter";
import { createRelayTask, selectChannel, getRelayTask, formatPublicRelayTask, cancelRelayPortraitPreparation } from "@/lib/relay";
import { isRelayPortraitPreparing, readRelayPortraitPreparation, relayPortraitPreparationView } from "@/lib/relayPortraitPreparation";
import { readVideoGenerationRelayBillingAudit } from "@/lib/videoGenerationRelayBillingAudit";
import { executeRelayImage } from "@/lib/relayImage";
import { calculatePricingCost, resolveProviderSpecificPricingRule } from "@/lib/billing";
import { resolveWorkbenchGenerationBudgetExposure } from "@/agent-runtime/generationQuoteService";
import { persistGeneratedProjectImages } from "@/lib/generatedImagePersistence";
import { importGenerationHistory } from "@/lib/generationHistoryImport";
import { isJwsAsyncImage, prepareJwsAsyncImage } from "@/lib/jwsAsyncImage";
import { jwsImagePricePolicy, jwsImageRetailAmountMicros } from "@/lib/jwsImagePricing";
import { jwsOfficialImagePolicy, jwsOfficialImageCost } from "@/lib/jwsOfficialImagePricing";
import { ToolError } from "./contracts";
import { runToolVideoGeneration } from "./videoDispatchEvidence";
import { stableJson, type CreationGateway, type ToolIdentity } from "./creationService";
import type { GenerationRequest } from "./creationContracts";
import { assetGateway, fileContext, toolAsset } from "./assetRuntime";
function fail(code: string, message: string, status = 422): never { throw new ToolError(code, message, status); }
const digest = (v: unknown) => createHash("sha256").update(stableJson(v)).digest("hex");
function preparationView(task: Parameters<typeof relayPortraitPreparationView>[0]) {
  const view = relayPortraitPreparationView(task);
  return { executionPhase: view.preparationStage ? "preparing_materials" : null,
    statusMessage: view.statusMessage, canCancel: isRelayPortraitPreparing(task) };
}
export async function prepareToolGeneration(i: ToolIdentity, request: GenerationRequest) {
  if (request.renderMode === "finalize") {
    const toolParent = i.keyId ? await db(EXTERNAL_TOOL_TABLE).where({ id: request.draftTaskId, workspaceId: i.workspaceId, keyId: i.keyId, projectId: request.projectId, kind: "fanjin_generation_submit" }).first() : null;
    const prepared = await prepareDraftFinalization({ workspaceId: i.workspaceId, projectId: request.projectId, actorUserId: i.userId }, toolParent?.relayTaskId || request.draftTaskId, { outputFormat: request.outputFormat });
    if (i.modelAllowlist.length && !modelAllowlistIncludes(i.modelAllowlist, prepared.capability.model)) fail("MODEL_NOT_FOUND", "模型不存在或未获授权", 404);
    return prepared;
  }
  const catalog = await buildWorkbenchModelCatalog(i.workspaceId, db);
  const capability = catalog.models.find(m => m.id === internalModelId(request.modelId) && m.endpointType === `${request.type}_generation`);
  if (!capability || i.modelAllowlist.length && !modelAllowlistIncludes(i.modelAllowlist, capability.model)) fail("MODEL_NOT_FOUND", "模型不存在或未获授权", 404);
  if (!capability.canSubmit || !["configured", "verified", "legacy"].includes(capability.capabilityStatus)) fail("MODEL_UNAVAILABLE", "模型当前不可提交");
  if (!request.prompt && (request.type !== "video" || capability.videoGeneration?.contractFamily !== "seedance-2.5" || !request.references.length || request.operation === "edit")) fail("PROMPT_REQUIRED", "当前请求需要提示词或编辑指令");
  if (request.renderMode === "draft" && (request.type !== "video" || request.resolution !== "480p" || !capability.videoGeneration?.draft?.enabled)) fail("DRAFT_UNSUPPORTED", "样片仅支持已开放的 Seedance 2.5 模型和 480p 输出");
  const operation = request.operation ?? "generate";
  const nativeOperation = capability.videoGeneration?.operations.find(item => item.operation === operation && item.enabled);
  if (operation !== "generate" && (request.type !== "video" || capability.videoGeneration?.contractFamily !== "seedance-2.5" || !nativeOperation)) {
    fail("OPERATION_UNSUPPORTED", "当前模型未开放此原生视频操作，不能退回普通生成");
  }
  if (request.mode === "video_edit" && operation !== "edit" || request.mode === "video_extension" && operation !== "extend") {
    fail("OPERATION_MODE_MISMATCH", "请明确指定与视频模式相同的 operation");
  }
  if (operation === "generate" && request.sourceAssetVersionId) fail("SOURCE_UNSUPPORTED", "普通生成不能携带原片编辑字段");
  if (operation !== "generate" && !request.sourceAssetVersionId) fail("SOURCE_REQUIRED", "请指定原片 sourceAssetVersionId，并将其放入 references");
  if (!(operation !== "generate" ? ["adaptive"] : capability.aspectRatios).includes(request.aspectRatio)) fail("PARAMETER_UNSUPPORTED", "模型不支持所选比例");
  if (request.renderMode !== "draft" && !(request.type === "image" ? capability.qualities : capability.resolutions)?.includes(request.resolution)) fail("PARAMETER_UNSUPPORTED", "模型不支持所选分辨率");
  const refs = await resolveCanonicalGenerationReferences({ workspaceId: i.workspaceId, projectId: String(request.projectId), actorUserId: i.userId, references: request.references.map(reference => {
    if (reference.role !== "source_video") return reference;
    if (operation === "generate" || reference.assetVersionId !== request.sourceAssetVersionId) fail("SOURCE_MISMATCH", "source_video 必须指向当前编辑或延长的原片");
    return { ...reference, role: "subject" as const, mediaType: "video" as const };
  }) });
  if (request.type === "video") {
    const d = nativeOperation?.duration ?? capability.duration, seconds = request.duration;
    if (request.count !== 1 || !d || seconds === undefined || (seconds === -1 ? !d.auto : d.allowed?.length ? !d.allowed.includes(seconds) : seconds < d.min || seconds > d.max || (seconds - d.min) % d.step !== 0)) fail("PARAMETER_UNSUPPORTED", "请使用模型目录声明的视频时长，单次生成一个视频");
    if (request.outputFormat && !capability.videoGeneration?.outputFormats?.includes(request.outputFormat)) fail("PARAMETER_UNSUPPORTED", "模型不支持所选视频格式");
    if (request.audio && !capability.supportsGenerateAudio) fail("PARAMETER_UNSUPPORTED", "模型不支持生成音频");
    if (!capability.videoGeneration?.contractFamily) {
      const validation = validateWorkbenchVideoInputs(capability, [{ references: request.references, referenceContent: refs.providerContent, mode: request.mode }]);
      if (!validation.ok) fail("PARAMETER_UNSUPPORTED", validation.message);
    }
    const canonical = buildCanonicalVideoGenerationEnvelope({ operation, renderMode: request.renderMode === "draft" ? "draft" : undefined, selectedLegacyMode: operation === "generate" ? request.mode : undefined, modelRouteId: capability.routeId || capability.id,
      prompt: request.prompt, aspectRatio: request.aspectRatio, durationSeconds: seconds, outputResolution: request.resolution, outputFormat: request.outputFormat, generateAudio: request.audio,
      inputs: refs.inputs, preparedReferenceContent: refs.providerContent,
      ...(operation !== "generate" ? { source: { assetVersionId: request.sourceAssetVersionId } } : {}),
      ...(operation === "edit" ? { edit: { instruction: request.prompt, preserve: [] } } : {}) });
    const formal = capability.videoGeneration?.contractFamily ? prepareSeedance25Request({ capability, request: canonical.request, providerContent: refs.providerContent,
      policyEvidence: refs.trustedPolicyEvidence, workspaceId: i.workspaceId, projectId: String(request.projectId) }) : undefined;
    return { capability, refs, canonical, formal, payload: formal?.requestPayload ?? buildLegacyVideoProviderRequestPayload({ model: capability.id, canonicalRequest: canonical.request, providerContent: refs.providerContent }) };
  }
  if (request.duration !== undefined || request.audio || request.mode !== undefined || request.outputFormat !== undefined) fail("PARAMETER_UNSUPPORTED", "图片请求不能包含视频参数");
  const validation = validateImageReferenceInputs(capability.inputSlots, request.references, refs.providerContent);
  if (!validation.ok) fail("PARAMETER_UNSUPPORTED", validation.message);
  const size = resolveVolcengineImageSize(request.resolution, request.aspectRatio);
  if (!size) fail("PARAMETER_UNSUPPORTED", "图片尺寸组合尚未支持");
  return { capability, refs, canonical: undefined, formal: undefined, payload: { model: capability.id, prompt: request.prompt, n: request.count, size,
    response_format: "url" as const, ...(validation.imageUrls.length ? { image: validation.imageUrls } : {}) } };
}
export const creationGateway: CreationGateway = {
  ...assetGateway,
  projectCreate: (i, name, tx) => createCanonicalProject({ workspaceId: i.workspaceId, userId: i.userId, name }, tx),
  async quote(i, request) {
    const prepared = await prepareToolGeneration(i, request);
    let maximumCostMicros: number, pricingDigest: string;
    if (request.type === "video") {
      const exposure = await resolveWorkbenchGenerationBudgetExposure({ database: db, workspaceId: i.workspaceId,
        videoReferenceContext: prepared.canonical ? { projectId: request.projectId, request: prepared.canonical.request } : undefined,
        request: { generationType: "video", model: prepared.capability.id, units: 1, durationSeconds: draftPricingDuration(prepared.canonical!.request),
          resolution: prepared.canonical!.request.outputResolution, videoInputPricingTier: prepared.refs.inputs.some(r => r.mediaType === "video") ? "with_video_input" : "without_video_input" } });
      maximumCostMicros = exposure.maximumCostMicros; pricingDigest = exposure.pricingDigest;
    } else {
      const channel = await selectChannel({ workspaceId: i.workspaceId, apiKeyId: i.keyId, principalId: String(i.userId), endpointType: "image_generation", model: prepared.capability.id, requestPayload: prepared.payload });
      if (!channel) fail("PRICING_UNAVAILABLE", "模型没有可用通道");
      const rule = await resolveProviderSpecificPricingRule({ workspaceId: i.workspaceId, endpointType: "image_generation", model: prepared.capability.id, provider: channel.provider });
      if (!rule || rule.unit !== "image" || rule.currency !== "GU") fail("PRICING_UNAVAILABLE", "模型缺少图片计费规则");
      const dynamic = jwsImagePricePolicy(rule.ruleConfig), official = jwsOfficialImagePolicy(rule.ruleConfig);
      if (dynamic || official) {
        if (!isJwsAsyncImage(channel)) fail("PRICING_UNAVAILABLE", "图片报价通道不匹配");
        const upstream = await prepareJwsAsyncImage(prepared.payload as any, channel, String((channel.config?.modelMapping as Record<string, string> | undefined)?.[prepared.capability.id] || prepared.capability.model), request.count);
        maximumCostMicros = dynamic ? jwsImageRetailAmountMicros(upstream.quote.amount, upstream.quote.currency, dynamic)
          : jwsOfficialImageCost(official!, { size: (prepared.payload as any).size, count: request.count, referenceCount: request.references.length }).costMicros;
        maximumCostMicros = ceilGuChargeMicros(maximumCostMicros);
        pricingDigest = digest({ rule, upstream: { model: upstream.quote.model, amount: upstream.quote.amount, currency: upstream.quote.currency } });
      } else { maximumCostMicros = calculatePricingCost(rule, request.count, undefined, undefined, Date.now(), request.references.length); pricingDigest = digest(rule); }
    }
    return { maximumCostMicros, pricingDigest: digest({ pricingDigest, maximumCostMicros, capability: prepared.capability, request }) };
  },
  async generate(i, request, maximumCostMicros, taskId) {
    // This ceiling comes only from the stored, user-approved quote, never the tool request body.
    const authorization = { maximumCostMicros, expiresAt: Date.now() + 60_000 };
    if (request.type === "video") {
      return runToolVideoGeneration(db, taskId, async () => {
        const p = await prepareToolGeneration(i, request);
        const r = await createRelayTask({ workspaceId: i.workspaceId, projectId: request.projectId, apiKeyId: i.keyId, actorUserId: i.userId, principalId: String(i.userId), endpointType: "video_generation", model: p.capability.id,
          requestPayload: p.payload, requestId: `tools:${taskId}` }, { trustedCanonicalVideoGeneration: p.canonical!, trustedVideoAssetPolicyEvidence: p.refs.trustedPolicyEvidence,
          trustedVideoProviderAdapter: p.formal?.relayAdapterBinding, trustedGenerationKeyPermission: "generation:create", requireQuickCreatePricingConfirmation: true, trustedQuickCreatePricingAuthorization: authorization });
        return { relayTaskId: r.task.id, billingStatus: isRelayPortraitPreparing(r.task) ? "not_started" : "reserved",
          ...preparationView(r.task), request, draft: draftTaskInfo(r.task) };
      });
    }
    const p = await prepareToolGeneration(i, request);
    const r = await executeRelayImage(p.payload as any, { workspaceId: i.workspaceId, apiKeyId: i.keyId, principalId: String(i.userId), requestId: `tools:${taskId}`, idempotencyKey: `tools:${taskId}`,
      portraitReferenceScope: {
        projectId: String(request.projectId),
        orderedAssetVersionIds: request.references.map(r => r.assetVersionId),
        requiresPortraitAdmission: false,
      },
      requireQuickCreatePricingConfirmation: true, quickCreatePricingAuthorization: authorization });
    return { images: r.data, billingStatus: "settled", request, toolTaskId: taskId };
  },
  async prepareCanvasOutput(i, input) {
    const asset = await toolAsset(i, { projectId: input.projectId, assetId: input.asset.assetId, assetVersionId: input.asset.assetVersionId });
    if (!asset.storageKey) fail("ASSET_NOT_STORED", "作品尚未保存");
    const type = asset.mimeType?.startsWith("video/") ? "video" : asset.mimeType?.startsWith("image/") ? "image" : asset.type;
    return { ...asset, type, url: await oss.getFileUrl(asset.storageKey!) };
  },
  async validateCanvasAsset(i, projectId, asset, tx) {
    const context = { ...fileContext(i), database: tx };
    await requireFileProject(context, projectId, true, tx);
    const current = await managedFileVersion(context, asset.assetId, asset.assetVersionId);
    const ref = await tx(PROJECT_ASSET_REF_TABLE).where({ workspaceId: i.workspaceId, projectId,
      assetId: asset.assetId, assetVersionId: `image:${asset.assetVersionId}` }).whereNull("removedAt").first();
    const metadata = await tx(FILE_METADATA).where({ assetId: asset.assetId }).first();
    if (!ref || metadata?.trashedAt != null || current.key.replace(/^\/+/, "") !== asset.storageKey) fail("ASSET_NOT_FOUND", "素材不存在或已被移除", 404);
  },
  async attachToCanvas(i, input, tx) {
    const asset = input.asset;
    await creationGateway.validateCanvasAsset!(i, input.projectId, asset, tx);
    return attachCanvasOutput(tx, { projectId: input.projectId, canvasId: input.canvasId, nodeId: input.nodeId,
      expectedRevision: input.expectedRevision, taskId: input.taskId,
      asset: { assetId: asset.assetId, assetVersionId: asset.assetVersionId, type: asset.type, url: asset.url } });
  },
  async cancelPreparation(i, relayTaskId) {
    const task = await getRelayTask(relayTaskId);
    if (!task || task.workspaceId !== i.workspaceId || task.apiKeyId !== i.keyId) fail("TASK_NOT_FOUND", "任务不存在", 404);
    const result = await cancelRelayPortraitPreparation(relayTaskId, { actorUserId: i.userId, apiKey: { id: i.keyId } });
    if (!result.cancelled) fail("CANCELLATION_UNAVAILABLE", "任务已开始生成，暂时无法取消；请继续查询", 409);
    return creationGateway.inspect(i, relayTaskId);
  },
  async recoverGeneration(i, request, taskId) {
    if (request.type !== "video" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(taskId)) return null;
    const requestId = `tools:${taskId}`;
    const matches = await db("o_relay_task").where({ workspaceId: i.workspaceId, apiKeyId: i.keyId,
      projectId: request.projectId, endpointType: "video_generation" })
      .andWhere(query => query.where("requestId", requestId).orWhere("requestId", "like", `${requestId}:scope:%`))
      .select("id").limit(2);
    if (matches.length !== 1) return null;
    return creationGateway.inspect(i, String(matches[0].id));
  },
  async inspect(i, relayTaskId) {
    const task = await getRelayTask(relayTaskId);
    if (!task || task.workspaceId !== i.workspaceId || task.apiKeyId !== i.keyId) fail("TASK_NOT_FOUND", "任务不存在", 404);
    if (task.status === "mocked") fail("MOCK_RESULT_REJECTED", "模拟生成不能作为真实作品交付");
    const preparation = readRelayPortraitPreparation(task);
    let billingStatus: string;
    if (preparation) {
      try {
        const audit = await readVideoGenerationRelayBillingAudit({ taskId: task.id, workspaceId: i.workspaceId, projectId: Number(task.projectId) });
        billingStatus = audit.status === "pending_reconcile" ? "pending_reconciliation" : audit.status;
      } catch {
        // A missing billing snapshot must never hide a completed video or
        // change its execution state. Detailed amounts have their own query.
        billingStatus = "updating";
      }
    } else {
      try {
        const usage = await db("o_usage_record").where({ taskId: task.id, workspaceId: i.workspaceId }).orderBy("createTime", "desc").first();
        billingStatus = ["charged", "free"].includes(usage?.status) ? "settled" : usage?.status === "released" ? "released"
          : usage?.status === "reserved" ? "reserved" : "updating";
      } catch { billingStatus = "updating"; }
    }
    // Use the common delivery projection: a local billing/dispatch recovery
    // marker can outlive generation and must not become an MCP approval step.
    const publicTask = await formatPublicRelayTask(task);
    const executionStatus = String(publicTask.status || task.status);
    let error: { code: string; message: string } | undefined;
    if (executionStatus === "failed") {
      const failure = publicTask.error as { code?: string; message?: string } | null;
      const portraitRefusal = /may contain real person|可能.*真人|疑似.*真人|PORTRAIT_UPSTREAM_REAL_PERSON_REJECTED/i.test(String(task.errorMessage || failure?.message || ""));
      error = portraitRefusal ? {
        code: "PORTRAIT_UPSTREAM_REAL_PERSON_REJECTED",
        message: "生成平台认为参考素材可能包含真人，已拒绝本次生成。请在素材详情查看拒绝原因；真实人物需补录真人资产授权，虚拟素材可申请复核。任务不会自动重投。",
      } : { code: failure?.code || "GENERATION_FAILED", message: failure?.message || "生成未完成，请查看任务详情。任务不会自动重投。" };
    }
    return { status: ["succeeded", "failed", "cancelled"].includes(executionStatus) ? executionStatus : "running", relayTaskId, billingStatus,
      ...preparationView(task), draft: draftTaskInfo(task), ...(error ? { error } : {}) };
  },
  async archive(i, projectId, result) {
    if (result.images) {
      const r = result.request;
      const saved = await persistGeneratedProjectImages({ workspaceId: i.workspaceId, projectId, actorUserId: i.userId, source: "external-tools", prompt: r.prompt, finalPrompt: r.prompt,
        model: r.modelId, ratio: r.aspectRatio, quality: r.resolution, resolution: r.resolution, taskIdPrefix: "external-tools", taskId: result.toolTaskId, items: result.images }, { database: db });
      return { assets: await Promise.all(saved.map(a => toolAsset(i, { projectId, ...a }))), billingStatus: result.billingStatus };
    }
    const rows = await db("o_media_asset").where({ taskId: result.relayTaskId, workspaceId: i.workspaceId, source: "relay_final", assetType: "video", deletionState: "active" });
    if (!rows.length) fail("ASSET_NOT_STORED", "成片正在保存");
    const assets = [];
    for (const row of rows) { const a = await importGenerationHistory(fileContext(i), { projectId, mediaId: row.id }, key => oss.fileExists(key)); assets.push(await toolAsset(i, { projectId, assetId: a.assetId, assetVersionId: a.versionId })); }
    return { assets, billingStatus: result.billingStatus, draft: result.draft || null };
  },
};
