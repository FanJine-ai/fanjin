import { canonicalVideoGenerationRequest, videoGenerationRequestDigest, type VideoGenerationRequest } from "./videoGenerationContract";
import { BYTEPLUS_SEEDANCE_25_MODEL_ID, DOMESTIC_SEEDANCE_25_MODEL_ID, isSeedance25ModelId } from "./seedance25ModelIds";

export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DRAFT_MODEL = DOMESTIC_SEEDANCE_25_MODEL_ID;
export function draftError(code: string, message: string, status = 422): never {
  throw Object.assign(new Error(message), { code, status, statusCode: status });
}
export function draftRecord(value: unknown): Record<string, any> {
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
export function storedDraftRequest(task: Record<string, any>): VideoGenerationRequest | null {
  const binding = draftRecord(draftRecord(draftRecord(task.resultPayload).internal).canonicalVideoGeneration);
  if (!binding.request) return null;
  try {
    const request = canonicalVideoGenerationRequest(binding.request);
    return videoGenerationRequestDigest(request) === binding.digest ? request : null;
  } catch { return null; }
}
export function draftTaskInfo(task: Record<string, any>, now = Date.now()) {
  const request = storedDraftRequest(task);
  if (!request?.renderMode) return null;
  if (request.renderMode === "finalize") return { renderMode: "finalize" as const, parentTaskId: request.draftSource?.taskId, canFinalize: false };
  // Provider created_at is authoritative; local createTime and URL expiry are not substitutes.
  const result = draftRecord(task.resultPayload);
  const response = draftRecord(draftRecord(task.providerPayload).response);
  const created = Number(result.created_at ?? response.created_at);
  const expiresAt = Number.isFinite(created) && created > 0 ? created * 1000 + DRAFT_TTL_MS : null;
  const reason = task.status !== "succeeded" ? "样片尚未完成"
    : !task.providerTaskId || !expiresAt ? "样片任务信息尚未完整，请刷新任务状态"
    : now >= expiresAt ? "样片已超过 7 天，请重新生成样片" : null;
  return { renderMode: "draft" as const, draftTaskId: String(task.id), expiresAt, canFinalize: !reason, unavailableReason: reason };
}
export function resolveDraftParent(task: Record<string, any> | null, scope: { workspaceId: string; projectId: number }, now = Date.now()) {
  if (!task || String(task.workspaceId) !== scope.workspaceId || Number(task.projectId) !== scope.projectId) {
    draftError("draft_not_found", "样片不存在或无权访问", 404);
  }
  const request = storedDraftRequest(task);
  if (!request || request.renderMode !== "draft" || draftRecord(task.requestPayload).draft !== true
    || !isSeedance25ModelId(task.model) || request.outputResolution !== "480p" || task.provider !== "volcano" || !task.channelId) {
    draftError("draft_required", "只能将 Seedance 2.5 样片任务转为正式片，普通 480p 视频不适用");
  }
  const info = draftTaskInfo(task, now)!;
  if (!info.canFinalize || !("expiresAt" in info) || !info.expiresAt) {
    draftError("draft_unavailable", "unavailableReason" in info ? info.unavailableReason || "样片不可用" : "样片不可用", 409);
  }
  const outputDuration = Number(draftRecord(task.resultPayload).duration ?? draftRecord(draftRecord(task.providerPayload).response).duration);
  const outputDurationSeconds = Number.isFinite(outputDuration) && outputDuration >= 4 && outputDuration <= 30 ? Math.ceil(outputDuration) : undefined;
  const finalRequest = canonicalVideoGenerationRequest({ ...request, outputResolution: "1080p", renderMode: "finalize",
    draftSource: { taskId: String(task.id), providerTaskId: String(task.providerTaskId), channelId: String(task.channelId),
      expiresAt: info.expiresAt, parentDigest: videoGenerationRequestDigest(request),
      ...(task.model === BYTEPLUS_SEEDANCE_25_MODEL_ID ? { model: BYTEPLUS_SEEDANCE_25_MODEL_ID } : {}),
      ...(outputDurationSeconds ? { outputDurationSeconds } : {}) } });
  return { request: finalRequest, digest: videoGenerationRequestDigest(finalRequest) };
}
export function draftFinalPayload(request: VideoGenerationRequest): Record<string, unknown> {
  if (request.renderMode !== "finalize" || !request.draftSource?.providerTaskId || request.outputResolution !== "1080p") {
    draftError("draft_final_contract_invalid", "正式片必须关联有效样片并使用 1080p");
  }
  // Deliberate whitelist: inherited fields must never be sent, even unchanged.
  return { model: request.draftSource.model || DRAFT_MODEL,
    content: [{ type: "draft_task", draft_task: { id: request.draftSource.providerTaskId } }],
    resolution: "1080p",
    ...(request.outputFormat ? { output_format: request.outputFormat } : {}) };
}
export function assertDraftFinalPayload(payload: Record<string, unknown>, request: VideoGenerationRequest) {
  const expected = draftFinalPayload(request);
  if (Object.keys(payload).sort().join() !== Object.keys(expected).sort().join()
    || Object.keys(expected).some((key) => JSON.stringify(payload[key]) !== JSON.stringify(expected[key]))) {
    draftError("draft_final_payload_mismatch", "正式片请求不能包含提示词、素材、画幅、时长或音频等继承字段", 409);
  }
}
export function draftPricingDuration(request: VideoGenerationRequest): number {
  return request.renderMode === "finalize" && request.durationSeconds === -1
    ? request.draftSource?.outputDurationSeconds ?? request.durationSeconds : request.durationSeconds;
}
/** Pricing projection only. Never dispatch this object to the provider. */
export function draftPricingPayload(payload: Record<string, any>, request?: VideoGenerationRequest): Record<string, any> {
  if (request?.renderMode !== "finalize") return payload;
  return { model: request.draftSource?.model || DRAFT_MODEL, resolution: "1080p", duration: draftPricingDuration(request), ratio: request.aspectRatio,
    generate_audio: request.generateAudio, content: request.inputs.map(input => ({ type: `${input.mediaType}_url` })) };
}
