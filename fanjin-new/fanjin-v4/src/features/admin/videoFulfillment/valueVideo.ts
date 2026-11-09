export const VALUE_VIDEO_MODELS = [
  "fanjin-seedance-2-5-value-720p", "fanjin-seedance-2-0-value-720p",
  "fanjin-seedance-2-0-mini-value-720p", "fanjin-seedance-2-0-fast-value-720p",
] as const;
export function isValueVideoModel(model: string) { return (VALUE_VIDEO_MODELS as readonly string[]).includes(model); }
export function valueVideoPair(model: string, target: string) {
  if (!isValueVideoModel(model)) return null;
  return target === "720p" ? { source: "480p", target: "720p" } : target === "1080p" ? { source: "720p", target: "1080p" } : null;
}
