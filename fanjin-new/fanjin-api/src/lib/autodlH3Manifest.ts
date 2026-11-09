// Verified in the authenticated AutoDL workflow documentation on 2026-10-23.
// This is an AutoDL ComfyUI workflow, not MiniMax's official V2 protocol.
export const AUTODL_H3_MODEL = "autodl-h3" as const;
export const AUTODL_H3_CINEMA_MODEL = "autodl-h3-cinema" as const;
export const AUTODL_H3_CINEMA_WORKFLOW = "minimax_h3_zm_u30" as const;
export const AUTODL_H3_CINEMA_RESOLUTIONS = ["480p", "768p", "960p"] as const;
export const AUTODL_H3_LEGACY_WORKFLOW = "minimax_h3_image_audio_to_video_v2_15s" as const;
export const AUTODL_H3_WORKFLOW = "minimax_h3_zm_u08" as const;
export const AUTODL_H3_LIGHT_WORKFLOW = "minimax_h3_lightx2v_v5_15s" as const;
export const AUTODL_H3_BASE_URL = "https://autodl.art";
export const AUTODL_H3_CHANNEL_ID = "fanjin-autodl-h3-video";
export const AUTODL_H3_CREDENTIAL_REF = "AUTODL_COMFYUI_API_KEY";
export const AUTODL_H3_DOCUMENTATION = `https://autodl.art/large-model/comfyui/${AUTODL_H3_WORKFLOW}`;

// 本地测试开关不在生产环境生效，避免旧模型入口在部署后改变语义。
export function isAutoDLH3LocalLightWorkflow(): boolean {
  return (process.env.NODE_ENV === "dev" || process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test")
    && process.env.FANJIN_AUTODL_H3_LIGHT_LOCAL === "1";
}

export function activeAutoDLH3Workflow(model: unknown = AUTODL_H3_MODEL): string {
  if (model === AUTODL_H3_CINEMA_MODEL) return AUTODL_H3_CINEMA_WORKFLOW;
  if (model !== AUTODL_H3_MODEL) throw new Error("AutoDL H3 模型标识无效");
  return isAutoDLH3LocalLightWorkflow() ? AUTODL_H3_LIGHT_WORKFLOW : AUTODL_H3_WORKFLOW;
}

export function isAutoDLH3Model(value: unknown): value is typeof AUTODL_H3_MODEL | typeof AUTODL_H3_CINEMA_MODEL {
  return value === AUTODL_H3_MODEL || value === AUTODL_H3_CINEMA_MODEL;
}

export function autoDLH3RouteConfig(): Record<string, unknown> {
  return {
    source: "autodl-h3-fast-2026-10-23",
    officialDocumentation: AUTODL_H3_DOCUMENTATION,
    label: "MiniMax H3",
    description: "高速版需要 1–9 张参考图片，可添加最多 3 段参考音频，最长 15 秒",
    capabilityStatus: "verified",
    resolutions: ["768p"],
    nativeResolutions: ["768p"],
    defaultResolution: "768p",
    aspectRatios: ["16:9", "9:16"],
    defaultAspectRatio: "16:9",
    duration: { min: 1, max: 15, step: 1, default: 5 },
    supportsGenerateAudio: false,
    modes: ["omni_reference"],
    inputSlots: [
      { id: "reference_images", label: "参考图片", accepts: ["image"], roles: ["subject", "style", "storyboard"], modes: ["omni_reference"], min: 1, max: 9, allowDuplicateAsset: false, supportsTrim: false },
      { id: "reference_audio", label: "参考音频", accepts: ["audio"], roles: ["subject", "style"], modes: ["omni_reference"], min: 0, max: 3, allowDuplicateAsset: false, supportsTrim: false },
    ],
    limits: { referenceImages: 9, referenceVideos: 0, referenceAudio: 3 },
  };
}

export function autoDLH3SupportsResolution(model: unknown, resolution: unknown): boolean {
  return model === AUTODL_H3_CINEMA_MODEL
    ? (AUTODL_H3_CINEMA_RESOLUTIONS as readonly unknown[]).includes(resolution)
    : model === AUTODL_H3_MODEL && resolution === "768p";
}

/** User-selected u30 workflow (upstream calls it 超清画质), not zm_nono. */
export function autoDLH3CinemaRouteConfig(): Record<string, unknown> {
  return {
    ...autoDLH3RouteConfig(),
    source: "autodl-h3-cinema-2026-10-28",
    officialDocumentation: `${AUTODL_H3_BASE_URL}/large-model/comfyui/${AUTODL_H3_CINEMA_WORKFLOW}`,
    label: "H3 影视版",
    description: "1–9 张参考图片、最多 3 段参考音频，1–15 秒，480p / 768p / 960p 横竖屏",
    resolutions: [...AUTODL_H3_CINEMA_RESOLUTIONS],
    nativeResolutions: [...AUTODL_H3_CINEMA_RESOLUTIONS],
  };
}
