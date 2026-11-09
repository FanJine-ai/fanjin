export const MINIMAX_H3_CONFIGURATION_SOURCE = "minimax-h3-official-v2-2026-09-01";
export const MINIMAX_H3_API_BASE_URL = "https://api.minimax.io";
export const MINIMAX_H3_CREDENTIAL_REF = "MINIMAX_API_KEY";
export const MINIMAX_H3_CHANNEL_ID = "fanjin-minimax-h3-video";

export type MiniMaxH3ModelId = "MiniMax-H3" | "MiniMax-H3-Max";

export interface MiniMaxH3RouteSeed {
  id: string;
  pricingRuleId: string;
  name: string;
  displayName: string;
  description: string;
  model: MiniMaxH3ModelId;
  resolutions: string[];
  defaultResolution: string;
  minimumDuration: number;
  defaultDuration: number;
  modes: string[];
  inputSlots: Array<Record<string, unknown>>;
}

const FIRST_FRAME_SLOT = Object.freeze({
  id: "first_frame",
  label: "首帧",
  accepts: ["image"],
  roles: ["first_frame"],
  modes: ["image_to_video", "first_last_frame"],
  min: 0,
  max: 1,
  allowDuplicateAsset: false,
  supportsTrim: false,
});

const LAST_FRAME_SLOT = Object.freeze({
  id: "last_frame",
  label: "尾帧",
  accepts: ["image"],
  roles: ["last_frame"],
  modes: ["first_last_frame"],
  min: 0,
  max: 1,
  allowDuplicateAsset: false,
  supportsTrim: false,
});

const H3_REFERENCE_SLOTS = Object.freeze([
  {
    id: "reference_images",
    label: "参考图片",
    accepts: ["image"],
    roles: ["subject", "style", "storyboard"],
    modes: ["omni_reference"],
    min: 0,
    max: 9,
    allowDuplicateAsset: false,
    supportsTrim: false,
  },
  {
    id: "reference_videos",
    label: "参考视频",
    accepts: ["video"],
    roles: ["subject", "style"],
    modes: ["omni_reference"],
    min: 0,
    max: 3,
    allowDuplicateAsset: false,
    supportsTrim: true,
  },
  {
    id: "reference_audio",
    label: "参考音频",
    accepts: ["audio"],
    roles: ["subject", "style"],
    modes: ["omni_reference"],
    min: 0,
    max: 3,
    allowDuplicateAsset: false,
    supportsTrim: true,
  },
]);

export const MINIMAX_H3_ROUTE_SEEDS: readonly MiniMaxH3RouteSeed[] = Object.freeze([
  {
    id: "fanjin-minimax-h3-route",
    pricingRuleId: "fanjin-minimax-h3-pricing",
    name: "MiniMax H3 official V2",
    displayName: "MiniMax H3",
    description: "原生同步音频，支持首尾帧与最多 9 图、3 视频、3 音频多参考",
    model: "MiniMax-H3",
    resolutions: ["768p", "2k"],
    defaultResolution: "768p",
    minimumDuration: 4,
    defaultDuration: 5,
    modes: ["text_to_video", "image_to_video", "first_last_frame", "omni_reference"],
    inputSlots: [FIRST_FRAME_SLOT, LAST_FRAME_SLOT, ...H3_REFERENCE_SLOTS],
  },
  {
    id: "fanjin-minimax-h3-max-route",
    pricingRuleId: "fanjin-minimax-h3-max-pricing",
    name: "MiniMax H3 Max official V2",
    displayName: "MiniMax H3 Max",
    description: "快速生成版本，支持文生视频、首帧和首尾帧，不支持多参考",
    model: "MiniMax-H3-Max",
    resolutions: ["480p", "768p"],
    defaultResolution: "768p",
    minimumDuration: 5,
    defaultDuration: 5,
    modes: ["text_to_video", "image_to_video", "first_last_frame"],
    inputSlots: [FIRST_FRAME_SLOT, LAST_FRAME_SLOT],
  },
]);

export function isMiniMaxH3Model(value: unknown): value is MiniMaxH3ModelId {
  return MINIMAX_H3_ROUTE_SEEDS.some((seed) => seed.model === value);
}

export function miniMaxH3RouteConfig(seed: MiniMaxH3RouteSeed): Record<string, unknown> {
  return {
    source: MINIMAX_H3_CONFIGURATION_SOURCE,
    officialDocumentation: "https://platform.minimax.io/docs/api-reference/video-generation-v2-create",
    capabilityStatus: "verified",
    label: seed.displayName,
    description: seed.description,
    resolutions: seed.resolutions,
    nativeResolutions: seed.resolutions,
    defaultResolution: seed.defaultResolution,
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    defaultAspectRatio: "16:9",
    duration: {
      min: seed.minimumDuration,
      max: 15,
      step: 1,
      default: seed.defaultDuration,
    },
    // H3 produces synchronized audio natively. The V2 request has no audio
    // toggle, so the UI must not expose a switch that the provider ignores.
    supportsGenerateAudio: false,
    nativeSynchronizedAudio: true,
    modes: seed.modes,
    inputSlots: seed.inputSlots,
    limits: seed.model === "MiniMax-H3"
      ? {
          totalRequestBytes: 64 * 1024 * 1024,
          referenceImages: 9,
          referenceVideos: 3,
          referenceAudio: 3,
          totalReferenceVideoSeconds: 15,
          totalReferenceAudioSeconds: 15,
        }
      : {
          referenceImages: 0,
          referenceVideos: 0,
          referenceAudio: 0,
        },
  };
}
