import {
  resolveQuickCreateVideoMode,
  resolveQuickCreateVideoReferences,
  type QuickCreateVideoModelOption,
} from "../../features/quick-create/modelCatalog";
import type { GenerationReference } from "../../features/quick-create/contracts";

/** Public canonical input; trusted policy evidence is produced only by the server. */
export function buildVideoDebugRequest(input: {
  projectId: number | null;
  model: string;
  prompt: string;
  ratio: string;
  capability: QuickCreateVideoModelOption | undefined;
  references?: GenerationReference[];
}): Record<string, unknown> {
  const capability = input.capability;
  if (!capability?.canSubmit || capability.id !== input.model) {
    throw new Error("所选视频模型缺少可提交的真实能力目录，已阻止发送");
  }
  if (!Number.isSafeInteger(input.projectId) || Number(input.projectId) <= 0) {
    throw new Error("请先明确选择当前工作区内的活动项目");
  }
  if (!input.prompt.trim()) throw new Error("请输入视频提示词");
  if (!capability.aspectRatios.includes(input.ratio as typeof capability.defaultAspectRatio)) {
    throw new Error("所选画幅不受当前视频模型支持");
  }
  const duration = capability.duration;
  const seconds = duration.default;
  const validDuration = seconds === -1 ? duration.auto === true : (
    Number.isFinite(seconds) && seconds > 0
    && seconds >= duration.min && seconds <= duration.max
    && (duration.allowed?.length
      ? duration.allowed.includes(seconds)
      : duration.step > 0 && Math.abs((seconds - duration.min) / duration.step - Math.round((seconds - duration.min) / duration.step)) < 1e-9)
  );
  if (!validDuration || !capability.resolutions.includes(capability.defaultResolution)
    || typeof capability.supportsGenerateAudio !== "boolean") {
    throw new Error("视频能力目录缺少有效的时长、分辨率或音频声明，已阻止发送");
  }
  const references = input.references ?? [];
  for (const reference of references) {
    if (!reference.assetVersionId?.trim() || /^(?:https?:|asset:|data:|\/)/iu.test(reference.assetVersionId)
      || !["image", "video", "audio"].includes(String(reference.mediaType))
      || !["subject", "style", "storyboard", "first_frame", "last_frame"].includes(reference.role)) {
      throw new Error("视频参考素材必须使用受控 assetVersionId 和明确的媒体类型");
    }
    if (reference.trim && (!Number.isSafeInteger(reference.trim.startMs)
      || !Number.isSafeInteger(reference.trim.endMs) || reference.trim.startMs < 0
      || reference.trim.endMs <= reference.trim.startMs)) {
      throw new Error("视频参考素材的裁剪范围无效");
    }
  }
  const attachments = references.map((reference) => ({
    kind: reference.mediaType === "audio" ? "file" as const : reference.mediaType as "image" | "video",
    assetVersionId: reference.assetVersionId,
    preferredRole: reference.role,
    trim: reference.trim,
  }));
  const mode = resolveQuickCreateVideoMode(capability, attachments.map((item) => item.kind));
  if (!mode.ok) throw new Error(mode.message);
  // Choose a declared mode that preserves explicit canonical roles. A style
  // reference must not silently become a first frame merely because it is an image.
  const candidates = references.length ? capability.modes : [mode.mode];
  let resolved: ReturnType<typeof resolveQuickCreateVideoReferences> | undefined;
  for (const candidate of candidates) {
    if (capability.operationByMode[candidate] !== "generate") continue;
    const result = resolveQuickCreateVideoReferences(capability, candidate, attachments);
    if (result.ok && result.references.every((reference, index) => reference.role === references[index]?.role)) {
      resolved = result;
      break;
    }
    if (!result.ok) resolved = result;
  }
  if (!resolved?.ok) throw new Error(resolved?.message || "当前模型未开放所请求的 generate 或参考素材角色");
  return {
    projectId: input.projectId,
    model: input.model,
    canonicalRequest: {
      version: "provider-neutral-video-request/v1",
      operation: resolved.operation,
      modelRouteId: capability.id,
      prompt: input.prompt.trim(),
      aspectRatio: input.ratio,
      durationSeconds: seconds,
      outputResolution: capability.defaultResolution,
      ...(capability.outputFormatsDeclared ? { outputFormat: capability.defaultOutputFormat } : {}),
      generateAudio: false,
      preserveSourceAudio: false,
      inputs: resolved.references,
    },
  };
}
