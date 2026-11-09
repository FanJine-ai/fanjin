export type ReferenceMediaInput = {
  kind: "image" | "video" | "file";
  name?: string;
  mimeType?: string;
  size?: number;
  durationSeconds?: number;
  trim?: { startMs: number; endMs: number };
};

// Official Ark input requirements, read 2026-09-09:
// https://docs.volcengine.com/docs/82379/1520757?lang=zh
// These rules narrow enabled catalog slots; they never enable a model or mode.
export function seedanceReferenceRequirements(modelId: string) {
  if (/(?:^|[-_])seedance[-_]2[.\-_]5(?:$|[-_])/i.test(modelId)) {
    return { durationMax: 30, videoMax: 10, audioMax: 10, audioOnly: true };
  }
  if (/(?:^|[-_])seedance[-_]2[.\-_]0(?:$|[-_])/i.test(modelId)) {
    return { durationMax: 15, videoMax: 3, audioMax: 3, audioOnly: false };
  }
  return null;
}

function seconds(value: number): string {
  return Number(value.toFixed(2)).toString();
}

export function referenceRequirementError(
  modelId: string,
  mode: string,
  inputs: readonly ReferenceMediaInput[],
  options: { checkCombination?: boolean } = {},
): string | null {
  const rule = seedanceReferenceRequirements(modelId);
  if (!rule) return null;
  for (const kind of ["video", "file"] as const) {
    const selected = inputs.filter((input) => input.kind === kind);
    const label = kind === "video" ? "视频" : "音频";
    const max = kind === "video" ? rule.videoMax : rule.audioMax;
    if (selected.length > max) return `参考${label}数量超限：当前 ${selected.length} 段，当前模型最多支持 ${max} 段。请移除部分素材。`;
    let total = 0;
    for (const input of selected) {
      const prefix = input.name ? `${input.name}：` : "";
      const mime = input.mimeType?.toLowerCase().split(";")[0];
      const allowed = kind === "video" ? ["video/mp4", "video/quicktime"] : ["audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg", "audio/mp3"];
      if (mime && !allowed.includes(mime)) return `${prefix}当前模型的参考${label}仅支持 ${kind === "video" ? "MP4 / MOV" : "WAV / MP3"}，请转换格式后添加。`;
      const sizeLimitMb = kind === "video" ? 200 : 15;
      if (input.size != null && input.size > sizeLimitMb * 1024 * 1024 && !input.trim) return `${prefix}${label}文件过大：当前 ${(input.size / 1024 / 1024).toFixed(1)} MB，单个最多 ${sizeLimitMb} MB。请压缩或裁剪后添加。`;
      const duration = input.trim ? (input.trim.endMs - input.trim.startMs) / 1000 : input.durationSeconds;
      // Missing browser metadata is not a successful validation. The server
      // remains authoritative for media it can read but the browser cannot.
      if (duration == null || !Number.isFinite(duration)) continue;
      const min = kind === "video" && mode === "video_edit" && rule.audioOnly ? 4 : 2;
      if (duration < min) return `${prefix}${label}片段过短：当前为 ${seconds(duration)} 秒，请选择至少 ${min} 秒的片段。`;
      if (duration > rule.durationMax) return `${prefix}${label}时长超限：已选 ${seconds(duration)} 秒，当前模型最多支持 ${rule.durationMax} 秒。请裁剪后继续。`;
      total += duration;
    }
    if (total > rule.durationMax) return `参考${label}总时长超限：当前合计 ${seconds(total)} 秒，最多支持 ${rule.durationMax} 秒。请缩短或移除部分片段。`;
  }
  if (options.checkCombination !== false && !rule.audioOnly && inputs.length > 0 && inputs.every((input) => input.kind === "file")) {
    return "当前模型不支持音频单独参考：请添加一张图片或一段视频，或切换至支持音频单独参考的模型。";
  }
  return null;
}
