import type { CanvasCatalogGenerationReference } from "./canvasCatalogContract";

/** Native extension follows the source frame; canvas geometry remains concrete. */
export function buildCanvasVideoExtensionFields(references: CanvasCatalogGenerationReference[]) {
  const videos = references.filter((reference) => reference.mediaType === "video");
  if (videos.length !== 1 || !videos[0].assetVersionId) {
    throw new Error("延长视频需要连接 1 段已上传完成的原片");
  }
  return {
    operation: "extend" as const,
    ratio: "adaptive" as const,
    source: { assetVersionId: videos[0].assetVersionId },
  };
}

/** Native edits retain the complete source; prompt includes all preservation requirements. */
export function buildCanvasVideoEditFields(references: CanvasCatalogGenerationReference[], prompt: string) {
  const videos = references.filter((reference) => reference.mediaType === "video");
  if (videos.length !== 1 || !videos[0].assetVersionId || !prompt.trim()) {
    throw new Error("修改视频需要连接 1 段已上传完成的原片，并填写修改要求");
  }
  return { operation: "edit" as const, ratio: "adaptive" as const, duration: -1,
    source: { assetVersionId: videos[0].assetVersionId }, edit: { instruction: prompt.trim(), preserve: [] } };
}

export function isCanvasSourceVideoMode(mode: string | undefined) {
  return mode === "video_extension" || mode === "video_edit";
}
