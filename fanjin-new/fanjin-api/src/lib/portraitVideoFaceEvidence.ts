/** Sampled frames cannot establish that the entire video contains no people. */
export function isUnconfirmedVideoNoFace(row: Record<string, any>): boolean {
  return ["video", "clip"].includes(String(row.mediaType)) && row.faceScanState === "no_face"
    && row.faceScanCoverage !== "full_video_manual";
}
