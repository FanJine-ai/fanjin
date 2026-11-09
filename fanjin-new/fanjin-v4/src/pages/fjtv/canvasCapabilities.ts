export const CANVAS_REAL_CAPABILITIES = {
  controlledImageGeneration: true,
  controlledVideoGeneration: true,
  controlledReferenceDesigns: true,
  localImageCrop: true,
  localVideoFrameExtract: true,
  localImageTransform: true,
  styleEffectMarketplace: false,
  canvasShare: false,
  fjtvPublish: false,
  videoEnhance: false,
  videoClipRewrite: false,
  imageEnhance: false,
  imageOutpaint: false,
  imageBackgroundRemove: false,
  imageErase: false,
  productScript: false,
  videoStoryAnalysis: false,
  videoSubtitleErase: false,
  audioSeparate: false,
} as const;

export type CanvasCapability = keyof typeof CANVAS_REAL_CAPABILITIES;
export type CanvasRealCapabilities = Record<CanvasCapability, boolean>;

export type CanvasActionDirectoryEntry = {
  id: string;
  version: string;
  status: "available" | "unavailable";
  endpoint: string | null;
};

export type CanvasActionDirectory = {
  version: string;
  modelCatalogVersion: string;
  modelCatalogPath: string;
  actions: CanvasActionDirectoryEntry[];
};

const ACTION_TO_CAPABILITY = {
  "canvas.image.generate": "controlledImageGeneration",
  "canvas.video.generate": "controlledVideoGeneration",
  "canvas.video.enhance": "videoEnhance",
  "canvas.video.clip-rewrite": "videoClipRewrite",
  "canvas.image.enhance": "imageEnhance",
  "canvas.image.outpaint": "imageOutpaint",
  "canvas.image.remove-background": "imageBackgroundRemove",
  "canvas.image.erase": "imageErase",
  "canvas.video.story-analysis": "videoStoryAnalysis",
  "canvas.video.erase-subtitle": "videoSubtitleErase",
  "canvas.video.separate-audio": "audioSeparate",
  "canvas.share.create": "canvasShare",
  "canvas.fjtv.publish": "fjtvPublish",
} as const satisfies Record<string, CanvasCapability>;

/**
 * Local constants remain a fail-safe floor.  A server directory may close an
 * existing remote action or open a newly implemented one, but it cannot turn
 * on marketplace/product-script actions that have no mapped executor.
 */
export function resolveCanvasRealCapabilities(
  directory: CanvasActionDirectory | null | undefined,
): CanvasRealCapabilities {
  const resolved: CanvasRealCapabilities = { ...CANVAS_REAL_CAPABILITIES };
  if (!directory || !Array.isArray(directory.actions)) return resolved;
  const byId = new Map(directory.actions.map((action) => [action.id, action]));
  for (const [actionId, capability] of Object.entries(ACTION_TO_CAPABILITY)) {
    const action = byId.get(actionId);
    if (!action) {
      // A missing server action must close remote behavior. Local-only
      // operations are not represented by this mapping.
      resolved[capability] = false;
      continue;
    }
    resolved[capability] = action.status === "available" && action.endpoint !== null;
  }
  return resolved;
}

export function isCanvasCapabilityOpen(capability: CanvasCapability): boolean {
  return CANVAS_REAL_CAPABILITIES[capability];
}
