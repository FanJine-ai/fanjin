import type { AttachmentQueueItem } from "../../features/quick-create/attachments/uploadQueue.types";
import {
  normalizeVideoDuration,
  resolveQuickCreateVideoMode,
  resolveQuickCreateVideoReferences,
  type QuickCreateVideoModelOption,
} from "../../features/quick-create/modelCatalog";
import type { StructuredThirtySecondTimeline } from "../../features/quick-create/structuredTimeline";
import type {
  QuickCreateMaterializedProject,
  QuickCreateVideoPayload,
} from "../../features/quick-create/types";

export function quickCreateAttachmentKind(
  attachment: Pick<AttachmentQueueItem, "mimeType">,
): "image" | "video" | "file" {
  if (attachment.mimeType.startsWith("image/")) return "image";
  if (attachment.mimeType.startsWith("video/")) return "video";
  return "file";
}

export function buildQuickCreateVideoTrackData(input: {
  timeline: StructuredThirtySecondTimeline;
  projectShots: QuickCreateMaterializedProject["shots"];
  attachments: AttachmentQueueItem[];
  model: QuickCreateVideoModelOption;
  /** Standalone references use whole files; editable timeline cues retain their selected slices. */
  audioReferenceMode?: "full" | "timeline";
  durationOverride?: number;
  preferredMode?: string;
  referenceAssignments?: Record<string, {
    preferredRole?: "subject" | "style" | "storyboard" | "first_frame" | "last_frame";
    slotId?: string;
    order: number;
  }>;
}): QuickCreateVideoPayload["trackData"] {
  if (input.durationOverride === -1 && input.model.duration.auto !== true) {
    throw new Error("当前模型不支持自动时长，请选择固定时长");
  }
  const attachmentsByVersionId = new Map(input.attachments.map((attachment) => [
    String(attachment.asset?.assetVersionId || ""),
    attachment,
  ]));

  return input.projectShots.map((shot, index) => {
    const timelineShot = input.timeline.shots[index];
    if (!timelineShot || !shot.trackId) {
      throw new Error(`镜头 ${index + 1} 缺少可提交的时间线或 Track ID`);
    }
    const requestedDuration = input.durationOverride === undefined
      ? Number((timelineShot.endSeconds - timelineShot.startSeconds).toFixed(3))
      : normalizeVideoDuration(input.durationOverride, input.model.duration);
    const timelineDuration = requestedDuration === -1 ? Number((timelineShot.endSeconds - timelineShot.startSeconds).toFixed(3)) : requestedDuration;
    const effectiveEndSeconds = input.durationOverride === undefined
      ? timelineShot.endSeconds
      : timelineShot.startSeconds + timelineDuration;
    const supportedDuration = normalizeVideoDuration(requestedDuration, input.model.duration);
    if (Math.abs(supportedDuration - requestedDuration) > 1e-6) {
      throw new Error(
        `镜头 ${index + 1} 的 ${timelineDuration} 秒时长不受当前模型支持，请调整镜头结构或更换模型`,
      );
    }
    const overlappingAudioCues = input.timeline.audioCues.filter((cue) => (
      cue.endSeconds > timelineShot.startSeconds
      && cue.startSeconds < effectiveEndSeconds
    ));
    const versionIds = Array.from(new Set([
      ...timelineShot.assetVersionIds,
      ...(input.audioReferenceMode === "full"
        ? input.attachments.filter((attachment) => attachment.mimeType.startsWith("audio/"))
          .map((attachment) => String(attachment.asset?.assetVersionId || ""))
        : overlappingAudioCues.map((cue) => cue.assetVersionId)),
    ]));
    const trackAttachments = versionIds.map((assetVersionId) => {
      const attachment = attachmentsByVersionId.get(assetVersionId);
      if (!attachment) {
        throw new Error(`镜头 ${index + 1} 引用的素材版本 ${assetVersionId} 已移除，请重新绑定时间线`);
      }
      return attachment;
    }).sort((left, right) => (
      (input.referenceAssignments?.[left.clientId]?.order ?? Number.MAX_SAFE_INTEGER)
      - (input.referenceAssignments?.[right.clientId]?.order ?? Number.MAX_SAFE_INTEGER)
    ));
    const resolvedMode = resolveQuickCreateVideoMode(
      input.model,
      trackAttachments.map(quickCreateAttachmentKind),
      input.preferredMode,
    );
    if (!resolvedMode.ok) throw new Error(`镜头 ${index + 1}：${resolvedMode.message}`);
    const resolvedReferences = resolveQuickCreateVideoReferences(
      input.model,
      resolvedMode.mode,
      trackAttachments.map((attachment) => {
        const assetVersionId = String(attachment.asset?.assetVersionId || "");
        const kind = quickCreateAttachmentKind(attachment);
        const cue = input.audioReferenceMode !== "full" && kind === "file"
          ? overlappingAudioCues.find((item) => item.assetVersionId === assetVersionId)
          : undefined;
        const overlapStart = cue ? Math.max(cue.startSeconds, timelineShot.startSeconds) : 0;
        const overlapEnd = cue ? Math.min(cue.endSeconds, effectiveEndSeconds) : 0;
        const sourceStartSeconds = cue ? cue.sourceStartSeconds + overlapStart - cue.startSeconds : 0;
        return {
          kind,
          assetVersionId,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          durationSeconds: attachment.durationSeconds,
          ...(input.referenceAssignments?.[attachment.clientId]?.preferredRole
            ? { preferredRole: input.referenceAssignments[attachment.clientId].preferredRole }
            : {}),
          ...(input.referenceAssignments?.[attachment.clientId]?.slotId
            ? { slotId: input.referenceAssignments[attachment.clientId].slotId }
            : {}),
          // Validate the final slice against both media limits and slot capabilities.
          ...(cue ? { trim: {
            startMs: Math.round(sourceStartSeconds * 1_000),
            endMs: Math.round((sourceStartSeconds + overlapEnd - overlapStart) * 1_000),
          } } : {}),
        };
      }),
    );
    if (!resolvedReferences.ok) {
      throw new Error(`镜头 ${index + 1}：${resolvedReferences.message}`);
    }
    if (resolvedReferences.references.length > input.model.totalInputLimit) {
      throw new Error(
        `镜头 ${index + 1} 的参考附件超过动态上限：当前 ${resolvedReferences.references.length} 个，最多 ${input.model.totalInputLimit} 个`,
      );
    }
    return {
      trackId: Number(shot.trackId),
      prompt: timelineShot.prompt,
      duration: requestedDuration,
      mode: resolvedMode.mode,
      operation: resolvedReferences.operation,
      references: resolvedReferences.references,
    };
  });
}
