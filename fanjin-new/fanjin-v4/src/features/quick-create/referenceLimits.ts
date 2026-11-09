export const MAX_QUICK_CREATE_ATTACHMENTS = 15;
export const MAX_QUICK_CREATE_IMAGE_REFERENCES = 16;
export const MAX_QUICK_CREATE_VIDEO_REFERENCES_PER_SHOT = 15;
export const MAX_QUICK_CREATE_VIDEO_REFERENCES_TOTAL = 45;
export const MAX_QUICK_CREATE_FORMAL_VIDEO_REFERENCES_PER_SHOT = 50;

export function resolveQuickCreateAttachmentLimit(
  entry: string,
  declaredVideoLimit?: number,
): number {
  if (entry === "Agent 模式") return 6;
  if (entry === "图片生成") return MAX_QUICK_CREATE_IMAGE_REFERENCES;
  if (entry !== "视频生成") return MAX_QUICK_CREATE_ATTACHMENTS;
  if (!Number.isSafeInteger(declaredVideoLimit) || Number(declaredVideoLimit) <= 0) {
    return MAX_QUICK_CREATE_VIDEO_REFERENCES_PER_SHOT;
  }
  return Math.min(
    MAX_QUICK_CREATE_FORMAL_VIDEO_REFERENCES_PER_SHOT,
    Number(declaredVideoLimit),
  );
}

export function resolveQuickCreateVideoReferencesPerShot(shotCountInput: number): number {
  const shotCount = Number.isSafeInteger(shotCountInput) && shotCountInput > 0 ? shotCountInput : 1;
  return Math.min(
    MAX_QUICK_CREATE_VIDEO_REFERENCES_PER_SHOT,
    Math.floor(MAX_QUICK_CREATE_VIDEO_REFERENCES_TOTAL / shotCount),
  );
}
