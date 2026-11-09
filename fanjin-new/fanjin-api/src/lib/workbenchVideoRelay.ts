import { db } from "@/utils/db";
import { relayPortraitPreparationView } from "@/lib/relayPortraitPreparation";
import { hasVideoPersistenceFailure, VIDEO_PERSISTENCE_RETRY_MESSAGE } from "@/lib/videoPersistenceRetry";
import u from "@/utils";
import {
  createRelayTask,
  recoverCanonicalRelayTask,
  formatPublicRelayTask,
  getRelayTask,
  refreshRelayTask,
  shouldDeferRelayProviderWorkToDedicatedWorker,
  type RelayTask,
} from "@/lib/relay";
import { syncVideoTaskState } from "@/lib/videoTaskState";
import { toProviderMediaUrl } from "@/lib/providerMediaUrl";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import {
  GENERATION_REFERENCE_ROLES,
  GenerationReferenceError,
  type GenerationReference,
} from "@/lib/generationReferenceResolver";
import { resolveWorkbenchModelCapability } from "@/lib/workbenchModelCatalog";
import { validateWorkbenchVideoInputs } from "@/lib/workbenchVideoCapability";
import { normalizeVideoResolution } from "@/lib/videoResolutions";
import { isRecoveryOnlyMode } from "@/lib/recoveryOnlyMode";
import {
  canonicalVideoGenerationRequest,
  videoGenerationRequestDigest,
  type VideoGenerationRequest,
} from "@/lib/videoGenerationContract";
import { buildLegacyVideoProviderRequestPayload } from "@/lib/videoGenerationSurfaceContract";
import { readVideoGenerationRelayBillingAudit } from "@/lib/videoGenerationRelayBillingAudit";
import type { StructuredTimelineRelayContext } from "@/lib/structuredThirtySecondTimeline";
import type { TrustedVideoAssetPolicyEvidence } from "@/lib/videoAssetPolicy";
import {
  prepareSeedance25Request,
  type PreparedSeedance25Request,
} from "@/lib/seedance25Adapter";
import type {
  ReleaseFullMaintenancePrivateValidationBudgetSlotBinding,
} from "@/lib/releaseFullMaintenancePrivateValidationBudget";
import type { QuickCreatePricingAuthorization } from "@/lib/quickCreatePricingConfirmation";

interface UploadItem {
  id?: number;
  sources?: string;
  role?: GenerationReferenceRole;
}

export interface WorkbenchRelayInput {
  /** 已验证登录上下文中的实际提交者。 */
  actorUserId?: number | null;
  projectId: number;
  scriptId: number;
  videoId: number;
  trackId: number;
  uploadData: UploadItem[];
  referenceContent?: Record<string, unknown>[];
  prompt: string;
  model: string;
  mode?: string;
  canonicalRequest?: VideoGenerationRequest;
  /** Trusted server-only binding; never serialize this into provider content. */
  structuredTimelineContext?: StructuredTimelineRelayContext;
  /** Trusted server-only binding from the canonical reference resolver. */
  trustedVideoAssetPolicyEvidence?: TrustedVideoAssetPolicyEvidence;
  /** Trusted server-only proof emitted by the formal provider adapter. */
  trustedVideoProviderAdapter?: PreparedSeedance25Request["relayAdapterBinding"];
  /** Trusted server-only release validation budget; never sourced from JSON. */
  trustedPrivateValidationBudget?: ReleaseFullMaintenancePrivateValidationBudgetSlotBinding;
  /** Trusted ceiling resolved from the encrypted Quick Create confirmation. */
  trustedQuickCreatePricingAuthorization?: QuickCreatePricingAuthorization | null;
  requireQuickCreatePricingConfirmation?: boolean;
  duration: number;
  resolution: string;
  outputFormat?: "mp4" | "mov";
  audio?: boolean;
  requestIdPrefix?: "workbench" | "quick-create";
}

export type PreparedWorkbenchRelayVideoTask = {
  workspaceId: string;
  model: string;
  content: Record<string, unknown>[];
  requestPayload: Record<string, unknown>;
  relayAdapterBinding?: PreparedSeedance25Request["relayAdapterBinding"];
};

type ProviderMediaKind = "image" | "video" | "audio";
type GenerationReferenceRole = GenerationReference["role"];

const GENERATION_REFERENCE_ROLE_SET = new Set<string>(GENERATION_REFERENCE_ROLES);

const LEGACY_MEDIA_TYPE_ALLOWLIST: Record<string, "image" | "video" | "audio"> = {
  role: "image",
  scene: "image",
  tool: "image",
  image: "image",
  storyboard: "image",
  clip: "video",
  video: "video",
  audio: "audio",
};

function mediaContentByType(
  url: string,
  type: string | null | undefined,
  referenceRole: GenerationReferenceRole,
): Record<string, unknown> | null {
  if (!url) return null;
  const normalizedType = String(type || "").trim().toLowerCase();
  const kind = LEGACY_MEDIA_TYPE_ALLOWLIST[normalizedType];
  if (!kind) {
    throw new GenerationReferenceError(400, "reference_media_type_unsupported", "参考素材类型不受支持");
  }
  if (kind === "audio") {
    return { type: "audio_url", audio_url: { url }, role: "reference_audio", reference_role: referenceRole };
  }
  if (kind === "video") {
    return { type: "video_url", video_url: { url }, role: "reference_video", reference_role: referenceRole };
  }
  return {
    type: "image_url",
    image_url: { url },
    role: referenceRole === "first_frame" || referenceRole === "last_frame"
      ? referenceRole
      : "reference_image",
    reference_role: referenceRole,
  };
}

async function resolveStoredProviderUrl(filePath: string, kind: ProviderMediaKind): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(filePath)) {
    throw new GenerationReferenceError(400, "reference_media_unmanaged", "参考素材必须来自项目受控存储");
  }
  const localUrl = await u.oss.getFileUrl(filePath);
  try {
    return toProviderMediaUrl(localUrl);
  } catch {
    if (kind === "image") return await u.oss.getImageBase64(filePath);
    throw new GenerationReferenceError(
      400,
      "reference_media_not_public",
      "本地视频/音频引用需要配置可公网访问的 FANJIN_PUBLIC_BASE_URL、PUBLIC_BASE_URL 或 ossURL。",
    );
  }
}

async function resolveReferenceContent(projectId: number, uploadData: UploadItem[]): Promise<Record<string, unknown>[]> {
  const refs = await Promise.all(
    uploadData.map(async (item) => {
      if (!item?.id || !Number.isInteger(item.id) || item.id <= 0) {
        throw new GenerationReferenceError(400, "reference_id_invalid", "参考素材 ID 无效");
      }
      if (item.sources === "storyboard") {
        const row = await db("o_storyboard")
          .where({ id: item.id, projectId })
          .select("filePath")
          .first();
        if (!row?.filePath) {
          throw new GenerationReferenceError(404, "reference_not_found", "参考素材不存在");
        }
        const url = await resolveStoredProviderUrl(row.filePath, "image");
        const role = item.role || "storyboard";
        if (!GENERATION_REFERENCE_ROLE_SET.has(role)) {
          throw new GenerationReferenceError(400, "reference_role_invalid", "参考素材角色无效");
        }
        return mediaContentByType(url, "image", role);
      }
      if (item.sources === "assets") {
        const row = await db("o_assets")
          .innerJoin("o_image", function () {
            this.on("o_assets.imageId", "=", "o_image.id")
              .andOn("o_image.assetsId", "=", "o_assets.id");
          })
          .where({ "o_assets.id": item.id, "o_assets.projectId": projectId })
          .select("o_image.filePath", "o_image.type", "o_assets.type as assetType")
          .first();
        if (!row?.filePath) {
          throw new GenerationReferenceError(404, "reference_not_found", "参考素材不存在");
        }
        const kind = mediaKindFromLegacyType(row.type || row.assetType);
        const url = await resolveStoredProviderUrl(row.filePath, kind);
        const role = item.role || "subject";
        if (!GENERATION_REFERENCE_ROLE_SET.has(role)) {
          throw new GenerationReferenceError(400, "reference_role_invalid", "参考素材角色无效");
        }
        return mediaContentByType(url, row.type || row.assetType, role);
      }
      throw new GenerationReferenceError(400, "reference_source_unsupported", "参考素材来源不受支持");
    }),
  );
  return refs.filter(Boolean) as Record<string, unknown>[];
}

function mediaKindFromLegacyType(type: string | null | undefined): ProviderMediaKind {
  const normalizedType = String(type || "").trim().toLowerCase();
  const kind = LEGACY_MEDIA_TYPE_ALLOWLIST[normalizedType];
  if (!kind) return "image";
  return kind;
}

function generationReferencesFromContent(content: Record<string, unknown>[]): GenerationReference[] {
  return content.map((item, index) => {
    const role = typeof item.reference_role === "string" ? item.reference_role.trim() : "";
    if (!GENERATION_REFERENCE_ROLE_SET.has(role)) {
      throw new GenerationReferenceError(422, "reference_role_missing", "参考素材缺少可验证的引用角色");
    }
    return {
      assetVersionId: `resolved:${index + 1}`,
      role: role as GenerationReferenceRole,
    };
  });
}

function supportsDuration(
  capability: { min: number; max: number; step: number; auto?: boolean; allowed?: number[] } | undefined,
  requested: number,
): boolean {
  if (!capability || !Number.isFinite(requested)) return false;
  if (requested === -1) return capability.auto === true;
  if (Array.isArray(capability.allowed) && capability.allowed.length > 0) {
    return capability.allowed.includes(requested);
  }
  if (
    ![capability.min, capability.max, capability.step].every(Number.isFinite)
    || capability.step <= 0
    || requested < capability.min
    || requested > capability.max
  ) return false;
  const steps = (requested - capability.min) / capability.step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

export async function prepareWorkbenchRelayVideoTask(
  input: WorkbenchRelayInput,
): Promise<PreparedWorkbenchRelayVideoTask> {
  const project = await db("o_project")
    .where("id", input.projectId)
    .select("workspaceId", "videoRatio", "deletionState")
    .first();
  if (!project) {
    throw new GenerationReferenceError(404, "project_not_found", "项目不存在");
  }
  if (String(project.deletionState || "") !== "active") {
    throw new GenerationReferenceError(
      409,
      "project_not_active",
      "项目正在删除，不能创建视频任务",
    );
  }
  const graph = await db("o_videoTrack as track")
    .innerJoin("o_script as script", function () {
      this.on("script.id", "=", "track.scriptId")
        .andOn("script.projectId", "=", "track.projectId");
    })
    .where({
      "track.id": input.trackId,
      "track.projectId": input.projectId,
      "track.scriptId": input.scriptId,
      "script.id": input.scriptId,
      "script.projectId": input.projectId,
    })
    .select("track.id")
    .first();
  if (!graph) {
    throw new GenerationReferenceError(
      404,
      "video_track_not_found",
      "剧本或镜头不存在",
    );
  }
  const workspaceId = String(project.workspaceId || "").trim();
  if (!workspaceId) {
    throw new GenerationReferenceError(422, "project_workspace_missing", "项目未绑定有效工作区");
  }
  const ratio = String(project.videoRatio || "").trim();
  if (!ratio) {
    throw new GenerationReferenceError(422, "project_video_ratio_missing", "项目未配置视频画幅比例");
  }
  const requestedModel = String(input.model || "").trim();
  if (!requestedModel) {
    throw new GenerationReferenceError(422, "video_model_missing", "未选择视频模型");
  }
  if (!String(input.prompt || "").trim()) {
    throw new GenerationReferenceError(422, "video_prompt_missing", "视频提示词不能为空");
  }
  const capability = await resolveWorkbenchModelCapability({
    workspaceId,
    endpointType: "video_generation",
    model: requestedModel,
  });
  if (!capability?.canSubmit) {
    throw new GenerationReferenceError(
      422,
      "video_model_unavailable",
      capability?.unavailableReason || "所选视频模型当前不可提交",
    );
  }
  const resolution = normalizeVideoResolution(input.resolution);
  if (!resolution || !capability.resolutions?.includes(resolution)) {
    throw new GenerationReferenceError(422, "video_resolution_unsupported", "所选视频分辨率不受当前模型支持");
  }
  if (!capability.aspectRatios.includes(ratio)) {
    throw new GenerationReferenceError(422, "video_ratio_unsupported", "项目画幅比例不受当前视频模型支持");
  }
  if (!supportsDuration(capability.duration, input.duration)) {
    throw new GenerationReferenceError(422, "video_duration_unsupported", "视频时长不受当前模型支持");
  }
  if (typeof capability.supportsGenerateAudio !== "boolean") {
    throw new GenerationReferenceError(422, "video_audio_capability_missing", "视频模型缺少音频生成能力声明");
  }
  if (input.audio === undefined && capability.supportsGenerateAudio) {
    throw new GenerationReferenceError(422, "video_audio_choice_missing", "请明确选择是否生成音频");
  }
  if (input.audio === true && !capability.supportsGenerateAudio) {
    throw new GenerationReferenceError(422, "video_audio_unsupported", "当前视频模型不支持生成音频");
  }
  const references = input.referenceContent ?? (await resolveReferenceContent(input.projectId, input.uploadData));
  const canonicalRequest = input.canonicalRequest
    ? canonicalVideoGenerationRequest(input.canonicalRequest)
    : null;
  if (canonicalRequest && (
    canonicalRequest.operation !== "generate"
    || canonicalRequest.modelRouteId !== (capability.routeId || capability.id)
    || canonicalRequest.prompt !== String(input.prompt || "").trim()
    || canonicalRequest.aspectRatio !== ratio
    || canonicalRequest.durationSeconds !== input.duration
    || canonicalRequest.outputResolution !== resolution
    || canonicalRequest.generateAudio !== Boolean(input.audio)
    || canonicalRequest.inputs.length !== references.length
  )) {
    throw new GenerationReferenceError(
      422,
      "video_canonical_request_mismatch",
      "统一视频请求与供应商 Adapter 输入不一致",
    );
  }
  const content: Record<string, unknown>[] = [{
    type: "text",
    text: canonicalRequest?.prompt ?? input.prompt,
  }, ...references];
  if (capability.videoGeneration?.contractFamily) {
    if (!canonicalRequest || !input.trustedVideoAssetPolicyEvidence) {
      throw new GenerationReferenceError(
        409,
        "video_formal_preflight_evidence_missing",
        "正式视频合同缺少统一请求或可信素材策略证据",
      );
    }
    const prepared = prepareSeedance25Request({
      capability,
      request: canonicalRequest,
      providerContent: references,
      policyEvidence: input.trustedVideoAssetPolicyEvidence,
      workspaceId,
      projectId: String(input.projectId),
    });
    return {
      workspaceId,
      model: capability.id,
      content,
      requestPayload: prepared.requestPayload,
      relayAdapterBinding: prepared.relayAdapterBinding,
    };
  }
  const referenceDeclarations = canonicalRequest?.inputs
    ?? generationReferencesFromContent(references);
  const inputValidation = validateWorkbenchVideoInputs(capability, [{
    mode: input.mode,
    references: referenceDeclarations,
    referenceContent: references,
  }]);
  if (!inputValidation.ok) {
    throw new GenerationReferenceError(422, "video_mode_unsupported", inputValidation.message);
  }
  return {
    workspaceId,
    model: capability.id,
    content,
    requestPayload: canonicalRequest
      ? buildLegacyVideoProviderRequestPayload({
          model: capability.id,
          canonicalRequest,
          providerContent: references,
        })
      : {
          model: capability.id,
          content,
          generate_audio: Boolean(input.audio),
          ratio,
          duration: input.duration,
          resolution,
          watermark: false,
        },
  };
}

export async function createWorkbenchRelayVideoTask(
  input: WorkbenchRelayInput,
  preparedInput?: Pick<
    PreparedWorkbenchRelayVideoTask,
    "workspaceId" | "model" | "requestPayload" | "relayAdapterBinding"
  >,
): Promise<RelayTask> {
  const prepared = preparedInput || await prepareWorkbenchRelayVideoTask(input);
  const canonicalRequest = input.canonicalRequest
    ? canonicalVideoGenerationRequest(input.canonicalRequest)
    : null;
  const relayInput = {
    endpointType: "video_generation",
    workspaceId: prepared.workspaceId,
    projectId: input.projectId,
    actorUserId: input.actorUserId ?? null,
    principalId: `workspace-service:${prepared.workspaceId}`,
    model: prepared.model,
    requestId: `${input.requestIdPrefix || "workbench"}:${input.projectId}:${input.scriptId}:${input.trackId}:${input.videoId}`,
    requestPayload: prepared.requestPayload,
  } as const;
  const relayOptions = (canonicalRequest
    || input.structuredTimelineContext
    || input.trustedVideoAssetPolicyEvidence
    || prepared.relayAdapterBinding
    || input.trustedVideoProviderAdapter
    || input.trustedPrivateValidationBudget
    || input.requireQuickCreatePricingConfirmation)
    ? {
        ...(canonicalRequest
          ? {
              trustedCanonicalVideoGeneration: {
                request: canonicalRequest,
                digest: videoGenerationRequestDigest(canonicalRequest),
              },
            }
          : {}),
        ...(input.structuredTimelineContext
          ? { trustedStructuredTimeline: input.structuredTimelineContext }
          : {}),
        ...(input.trustedVideoAssetPolicyEvidence
          ? { trustedVideoAssetPolicyEvidence: input.trustedVideoAssetPolicyEvidence }
          : {}),
        ...((prepared.relayAdapterBinding || input.trustedVideoProviderAdapter)
          ? {
              trustedVideoProviderAdapter: prepared.relayAdapterBinding
                || input.trustedVideoProviderAdapter,
            }
          : {}),
        ...(input.trustedPrivateValidationBudget
          ? { trustedPrivateValidationBudget: input.trustedPrivateValidationBudget }
          : {}),
        ...(input.requireQuickCreatePricingConfirmation
          ? {
              requireQuickCreatePricingConfirmation: true,
              trustedQuickCreatePricingAuthorization:
                input.trustedQuickCreatePricingAuthorization ?? null,
            }
          : {}),
      }
    : {};
  try {
    return (await createRelayTask(relayInput, relayOptions)).task;
  } catch (error) {
    if (canonicalRequest && (error as { code?: string })?.code === "idempotency_conflict") {
      const recovered = await recoverCanonicalRelayTask(relayInput, relayOptions);
      if (recovered) return recovered.task;
    }
    throw error;
  }
}

function readPublicVideoUrl(publicTask: Record<string, any>): string {
  return String(publicTask?.content?.video_url || publicTask?.output?.find((item: any) => item?.type === "video")?.url || "");
}

interface PersistedWorkbenchVideoProjection {
  mediaAssetId: string;
  assetId: number;
  assetVersionId: number;
}

function readPersistedWorkbenchVideoProjection(
  publicTask: Record<string, any>,
  videoUrl: string,
): PersistedWorkbenchVideoProjection | null {
  if (!videoUrl || !Array.isArray(publicTask.output)) return null;
  for (const item of publicTask.output) {
    const assetId = Number(item?.asset_id || 0);
    const assetVersionId = Number(item?.asset_version_id || 0);
    const mediaAssetId = String(item?.media_asset_id || "").trim();
    if (
      item?.type === "video"
      && String(item?.url || "") === videoUrl
      && Boolean(mediaAssetId)
      && Number.isSafeInteger(assetId)
      && assetId > 0
      && Number.isSafeInteger(assetVersionId)
      && assetVersionId > 0
    ) {
      return { mediaAssetId, assetId, assetVersionId };
    }
  }
  return null;
}

function normalizeStoredVideoPath(url: string): string {
  if (!url) return "";
  if (url.startsWith("/oss/")) return u.replaceUrl(url);
  const ossUrl = process.env.ossURL || process.env.FANJIN_PUBLIC_BASE_URL || "";
  if (ossUrl && url.startsWith(ossUrl)) return u.replaceUrl(url);
  return url;
}

export async function videoFileUrl(filePath?: string | null): Promise<string> {
  if (!filePath) return "";
  if (/^https?:\/\//i.test(filePath)) return filePath;
  return await u.oss.getFileUrl(filePath);
}

const WORKBENCH_RELAY_BILLING_PENDING_MARKER = "账务待核";

export function isRecoverableWorkbenchRelayVideo(video: any): boolean {
  if (!video?.relayTaskId) return false;
  if (video.state === "生成中") return true;
  if (["pending_reconcile", "reconciliation_required"].includes(String(video.relayBillingState))) return true;
  if (String(video.errorReason || "").includes(WORKBENCH_RELAY_BILLING_PENDING_MARKER)) return true;
  return video.state === "生成失败" && video.errorReason === "软件退出导致失败";
}

interface WorkbenchRelayVideoAuthority {
  videoId: number;
  relayTaskId: string;
  projectId: number;
  workspaceId: string;
  projectDeletionState: string;
}

function workbenchRelayOwnershipError(message: string): GenerationReferenceError {
  return new GenerationReferenceError(
    409,
    "relay_video_ownership_invalid",
    message,
  );
}

function assertWorkbenchRelayTaskAuthority(
  task: Pick<RelayTask, "id" | "projectId" | "workspaceId">,
  authority: WorkbenchRelayVideoAuthority,
): void {
  if (
    task.id !== authority.relayTaskId
    || task.projectId !== authority.projectId
    || task.workspaceId !== authority.workspaceId
  ) {
    throw workbenchRelayOwnershipError(
      "视频任务与项目归属不一致，拒绝同步结果",
    );
  }
}

async function loadWorkbenchRelayVideoAuthority(
  videoId: number,
  relayTaskId: string,
): Promise<WorkbenchRelayVideoAuthority> {
  const row = await db("o_video as video")
    .innerJoin("o_project as project", "project.id", "video.projectId")
    .where({
      "video.id": videoId,
      "video.relayTaskId": relayTaskId,
    })
    .select(
      "video.id as videoId",
      "video.relayTaskId as relayTaskId",
      "video.projectId as projectId",
      "project.workspaceId as workspaceId",
      "project.deletionState as projectDeletionState",
    )
    .first();
  const authority = row
    ? {
        videoId: Number(row.videoId),
        relayTaskId: String(row.relayTaskId || ""),
        projectId: Number(row.projectId),
        workspaceId: String(row.workspaceId || ""),
        projectDeletionState: String(row.projectDeletionState || ""),
      }
    : null;
  if (
    !authority
    || authority.videoId !== videoId
    || authority.relayTaskId !== relayTaskId
    || !Number.isSafeInteger(authority.projectId)
    || authority.projectId <= 0
    || !authority.workspaceId
  ) {
    throw workbenchRelayOwnershipError(
      "无法证明视频任务的项目归属，拒绝同步结果",
    );
  }
  if (authority.projectDeletionState !== "active") {
    throw new GenerationReferenceError(
      409,
      "project_not_active",
      "项目正在删除，不能同步视频任务",
    );
  }
  return authority;
}

/**
 * A split API process may enqueue and project Relay work, but it must never
 * cross the provider boundary. The dedicated Worker owns claim/dispatch/poll
 * so a release validation can bind a paid task to an independently attested
 * Worker rather than to the HTTP process that accepted the request.
 */
export function shouldDeferWorkbenchRelayToDedicatedWorker(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return shouldDeferRelayProviderWorkToDedicatedWorker(environment);
}

export async function syncWorkbenchVideoRelay(video: any): Promise<any> {
  if (!isRecoverableWorkbenchRelayVideo(video)) return video;
  const videoId = Number(video.id);
  const relayTaskId = String(video.relayTaskId || "").trim();
  if (!Number.isSafeInteger(videoId) || videoId <= 0 || !relayTaskId) {
    throw workbenchRelayOwnershipError(
      "视频或 relay 任务标识无效，拒绝同步结果",
    );
  }
  const authority = await loadWorkbenchRelayVideoAuthority(
    videoId,
    relayTaskId,
  );
  const task = await getRelayTask(relayTaskId);
  if (!task) return video;
  assertWorkbenchRelayTaskAuthority(task, authority);
  const dedicatedWorkerProjection = shouldDeferWorkbenchRelayToDedicatedWorker();
  if (
    dedicatedWorkerProjection
    && !["succeeded", "failed", "cancelled"].includes(task.status)
  ) {
    return {
      ...video,
      relayStatus: task.status,
      relayBillingState: null,
      ...relayPortraitPreparationView(task),
    };
  }
  // A split API process must not poll the provider. Once the dedicated Worker
  // has persisted a terminal Relay task, however, the API may project that
  // database checkpoint through the same ownership, billing and delivery
  // fences used by an in-process Worker.
  const refreshed = dedicatedWorkerProjection
    ? task
    : await refreshRelayTask(task, {
        providerReadOnly: isRecoveryOnlyMode(),
      });
  assertWorkbenchRelayTaskAuthority(refreshed, authority);
  const publicTask = await formatPublicRelayTask(refreshed);
  const publicStatus = String(publicTask.status || refreshed.status);
  const deliveryStatus = String((publicTask.delivery as any)?.deliveryStatus || "");
  let billingState = String((publicTask as any).billing_state || (publicTask as any).billingState || "");
  const canonicalBinding = refreshed.resultPayload?.internal
    && typeof refreshed.resultPayload.internal === "object"
    && !Array.isArray(refreshed.resultPayload.internal)
    ? (refreshed.resultPayload.internal as Record<string, unknown>).canonicalVideoGeneration
    : null;
  if (canonicalBinding && typeof canonicalBinding === "object" && !Array.isArray(canonicalBinding)) {
    // Billing readback has a separate endpoint and recovery worker. Its
    // consistency window must not quarantine a verified generation result.
    try {
      const billingAudit = await readVideoGenerationRelayBillingAudit({ taskId: refreshed.id,
        workspaceId: authority.workspaceId, projectId: authority.projectId });
      billingState = billingAudit.status;
    } catch {
      billingState = "updating";
    }
  }

  const projectedVideoUrl = readPublicVideoUrl(publicTask);
  const persistedProjection = dedicatedWorkerProjection
    ? readPersistedWorkbenchVideoProjection(publicTask, projectedVideoUrl)
    : null;
  const publicVideoUrl = normalizeStoredVideoPath(
    dedicatedWorkerProjection
      && !persistedProjection
      ? ""
      : projectedVideoUrl,
  );

  const patch: Record<string, unknown> = {};
  if (deliveryStatus === "degraded" && publicVideoUrl) {
    patch.state = "生成成功";
    patch.filePath = publicVideoUrl;
    patch.errorReason = "目标清晰度处理失败，已保留可用的原始清晰度视频";
  } else if (publicStatus === "pending_reconcile") {
    patch.state = "生成中";
    patch.errorReason = "暂未取得上游结果，请稍后查看；费用记录可在账单中查询";
  } else if (publicStatus === "succeeded") {
    if (publicVideoUrl) {
      patch.state = "生成成功";
      patch.filePath = publicVideoUrl;
      patch.errorReason = null;
    } else {
      patch.state = "生成失败";
      patch.errorReason = "生成任务成功但未返回视频地址";
    }
  } else if (["failed", "cancelled"].includes(publicStatus)) {
    patch.state = "生成失败";
    patch.errorReason = redactSensitiveText((publicTask.error as any)?.message || refreshed.errorMessage || "视频生成失败");
  } else {
    const recoveryMessage = hasVideoPersistenceFailure(refreshed.providerPayload?.poll)
      ? VIDEO_PERSISTENCE_RETRY_MESSAGE
      : null;
    if (video.state !== "生成中") patch.state = "生成中";
    if ((video.errorReason || null) !== recoveryMessage) patch.errorReason = recoveryMessage;
  }

  if (Object.keys(patch).length) {
    await db.transaction(async (transaction) => {
      const project = await transaction("o_project")
        .where({
          id: authority.projectId,
          workspaceId: authority.workspaceId,
        })
        .forUpdate()
        .select("id", "workspaceId", "deletionState")
        .first();
      if (
        !project
        || String(project.deletionState || "") !== "active"
      ) {
        throw new GenerationReferenceError(
          409,
          "project_not_active",
          "项目正在删除，不能同步视频任务",
        );
      }
      const persistedTask = await transaction("o_relay_task")
        .where({ id: relayTaskId })
        .forUpdate()
        .select("id", "projectId", "workspaceId")
        .first();
      if (!persistedTask) {
        throw workbenchRelayOwnershipError(
          "relay 任务不存在，拒绝同步结果",
        );
      }
      assertWorkbenchRelayTaskAuthority({
        id: String(persistedTask.id || ""),
        projectId: persistedTask.projectId == null
          ? null
          : Number(persistedTask.projectId),
        workspaceId: persistedTask.workspaceId == null
          ? null
          : String(persistedTask.workspaceId),
      }, authority);
      const persistedVideo = await transaction("o_video")
        .where({
          id: videoId,
          projectId: authority.projectId,
          relayTaskId,
        })
        .forUpdate()
        .select("id")
        .first();
      if (!persistedVideo) {
        throw workbenchRelayOwnershipError(
          "视频与 relay 任务关系已变化，拒绝同步结果",
        );
      }
      const updated = await transaction("o_video")
        .where({
          id: videoId,
          projectId: authority.projectId,
          relayTaskId,
        })
        .update(patch);
      if (Number(updated) !== 1) {
        throw workbenchRelayOwnershipError(
          "视频任务同步发生竞争，请重试",
        );
      }
    });
    if (patch.state === "生成成功") {
      await syncVideoTaskState(videoId, "已完成");
    } else if (patch.state === "生成失败") {
      await syncVideoTaskState(videoId, "生成失败", String(patch.errorReason || ""));
    }
    return {
      ...video,
      ...patch,
      relayStatus: publicStatus,
      relayBillingState: billingState || null,
      ...relayPortraitPreparationView(refreshed),
      ...(persistedProjection || {}),
    };
  }
  return {
    ...video,
    relayStatus: publicStatus,
    relayBillingState: billingState || null,
    ...relayPortraitPreparationView(refreshed),
    ...(persistedProjection || {}),
  };
}
