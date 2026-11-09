export type VideoOutputFormat = "mp4" | "mov";

export const BYTEPLUS_SEEDANCE_25_MODEL_ID = "dreamina-seedance-2-5-260628";

export function normalizeVideoOutputFormats(value: unknown): VideoOutputFormat[] {
  if (!Array.isArray(value)) return ["mp4"];
  const formats = Array.from(new Set(value.map((item) => String(item).trim().toLowerCase())))
    .filter((item): item is VideoOutputFormat => item === "mp4" || item === "mov");
  return formats.length ? formats : ["mp4"];
}

export function hasDeclaredVideoOutputFormats(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
    && value.every((item) => item === "mp4" || item === "mov");
}

export function videoOutputFormatRequestField(declared: boolean, value?: VideoOutputFormat): { outputFormat?: VideoOutputFormat } {
  return declared && value ? { outputFormat: value } : {};
}

export function normalizeDefaultVideoOutputFormat(value: unknown, formats: readonly VideoOutputFormat[]): VideoOutputFormat {
  const requested = String(value || "").trim().toLowerCase();
  return formats.includes(requested as VideoOutputFormat) ? requested as VideoOutputFormat : formats[0] || "mp4";
}

/** BytePlus source-frame, edit and extension operations derive their canvas size from input media. */
export function requiredVideoRatio(modelId: string, mode: string): "adaptive" | null {
  return modelId === BYTEPLUS_SEEDANCE_25_MODEL_ID
    && ["image_to_video", "first_last_frame", "video_extension", "video_edit"].includes(mode)
    ? "adaptive"
    : null;
}

export function requiredVideoDuration(modelId: string, mode: string): -1 | null {
  return modelId === BYTEPLUS_SEEDANCE_25_MODEL_ID && mode === "video_edit" ? -1 : null;
}
