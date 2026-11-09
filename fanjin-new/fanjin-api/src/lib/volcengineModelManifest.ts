import {
  buildSeedance25LaunchRouteConfig,
  SEEDANCE_25_MODEL_ID,
} from "@/lib/seedance25Adapter";

export const VOLCENGINE_MODEL_MANIFEST_VERSION = "volcengine-model-manifest/v4";
export const VOLCENGINE_MODEL_MANIFEST_SOURCE_UPDATED_AT = "2026-08-14";

export type VolcengineEndpointType =
  | "text"
  | "image_generation"
  | "video_generation"
  | "multimodal_embedding";

type CapabilityStatus = "catalogued" | "configured" | "verified";
type CapabilityEvidence =
  | "legacy-vendor-catalog-configuration"
  | "production-seed-configuration"
  | "official-model-list-id-only-2026-07-13"
  | "official-multimodal-embedding-docs-2026-07-13"
  | "official-seedance-2.5-contract-2026-09-09"
  | "account-model-directory-id-only-2026-08-14"
  | "account-model-directory-missing-2026-08-14"
  | "official-document-guide-2026-08-14";

export type AccountModelDirectoryStatus = "present" | "absent" | "not_checked";

interface VolcengineModelBase {
  model: string;
  label: string;
  endpointType: VolcengineEndpointType;
  capabilityStatus: CapabilityStatus;
  capabilityEvidence: CapabilityEvidence;
  accountModelDirectoryStatus?: AccountModelDirectoryStatus;
  accountModelDirectoryCheckedAt?: string | null;
  source:
    | "vendor-catalog-volcengine-v2.4"
    | "production-seed"
    | "volcengine-official-model-list-2026-07-13"
    | "volcengine-official-seedance-2.5-contract-2026-09-09"
    | "volcengine-account-model-directory-2026-08-14"
    | "volcengine-official-document-guide-2026-08-14";
}

export interface VolcengineTextModel extends VolcengineModelBase {
  endpointType: "text";
  supportsThinking: boolean;
  contextWindowTokens?: number;
  maxInputTokens?: number;
  maxOutputAndReasoningTokens?: number;
}

export interface VolcengineImageModel extends VolcengineModelBase {
  endpointType: "image_generation";
  qualities: Array<"1K" | "2K" | "4K">;
  defaultQuality: "1K" | "2K" | "4K";
  aspectRatios: string[];
  defaultAspectRatio: string;
  supportsReferenceImages: boolean;
  maxReferenceImages: number;
  outputFormats: Array<"png" | "jpeg">;
  supportsSequentialGeneration: boolean;
  maxSequentialImages: number;
  supportsStreaming: boolean;
  supportsWebSearch: boolean;
  optimizePromptModes: Array<"standard" | "fast">;
}

export interface VolcengineMultimodalEmbeddingModel extends VolcengineModelBase {
  endpointType: "multimodal_embedding";
  inputTypes: Array<"text" | "image_url" | "video_url">;
  contextWindowTokens: number;
  dimensions: Array<1024 | 2048>;
  supportsSparseEmbedding: boolean;
  supportsMultiEmbedding: boolean;
}

export interface VolcengineVideoInputSlot {
  id: string;
  label: string;
  roles: string[];
  accepts: Array<"image" | "video" | "file">;
  min: number;
  max: number;
  modes: string[];
}

export interface VolcengineVideoModel extends VolcengineModelBase {
  endpointType: "video_generation";
  resolutions: Array<"480p" | "720p" | "1080p" | "4K">;
  defaultResolution: "480p" | "720p" | "1080p" | "4K";
  aspectRatios: string[];
  defaultAspectRatio: string;
  durations: number[];
  supportsAutoDuration?: boolean;
  supportsGenerateAudio: boolean;
  frameRates: number[];
  outputFormats: Array<"mp4" | "mov">;
  modes: string[];
  inputSlots: VolcengineVideoInputSlot[];
}

export type VolcengineModel =
  | VolcengineTextModel
  | VolcengineImageModel
  | VolcengineVideoModel
  | VolcengineMultimodalEmbeddingModel;

const TEXT_MODELS: Array<[
  label: string,
  model: string,
  supportsThinking: boolean,
  source?: VolcengineTextModel["source"],
]> = [
  ["Doubao-Seed-2.1-Pro", "doubao-seed-2-1-pro-260628", true, "volcengine-official-document-guide-2026-08-14"],
  ["Doubao-Seed-2.1-Turbo", "doubao-seed-2-1-turbo-260628", true, "volcengine-official-document-guide-2026-08-14"],
  ["Doubao-Seed-Evolving", "doubao-seed-evolving", true, "volcengine-official-document-guide-2026-08-14"],
  ["GLM-5.2", "glm-5-2-260617", true, "volcengine-account-model-directory-2026-08-14"],
  ["DeepSeek-V4-Pro", "deepseek-v4-pro-260425", true, "volcengine-account-model-directory-2026-08-14"],
  ["DeepSeek-V4-Flash", "deepseek-v4-flash-260425", true, "volcengine-account-model-directory-2026-08-14"],
  ["DeepSeek-V4-Flash 正式版", "deepseek-v4-flash-ga-260731", true, "volcengine-account-model-directory-2026-08-14"],
  ["Doubao-Seed-2.0-Lite", "doubao-seed-2-0-lite-260428", false, "volcengine-official-model-list-2026-07-13"],
  ["Doubao-Seed-2.0-Mini", "doubao-seed-2-0-mini-260428", false, "volcengine-official-model-list-2026-07-13"],
  ["Doubao-Seed-Character", "doubao-seed-character-260628", false, "volcengine-official-model-list-2026-07-13"],
  ["Doubao-Seed-2.0-Pro", "doubao-seed-2-0-pro-260215", true],
  ["Doubao-Seed-2.0-Lite", "doubao-seed-2-0-lite-260215", true],
  ["Doubao-Seed-2.0-Mini", "doubao-seed-2-0-mini-260215", true],
  ["Doubao-Seed-2.0-Code-Preview", "doubao-seed-2-0-code-preview-260215", true],
  ["Doubao-Seed-Character", "doubao-seed-character-251128", false],
  ["Doubao-Seed-1.8", "doubao-seed-1-8-251228", true],
  ["Doubao-Seed-Code-Preview", "doubao-seed-code-preview-251028", true],
  ["Doubao-Seed-1.6-Lite", "doubao-seed-1-6-lite-251015", true],
  ["Doubao-Seed-1.6-Flash(0828)", "doubao-seed-1-6-flash-250828", true],
  ["Doubao-Seed-1.6-Vision", "doubao-seed-1-6-vision-250815", true],
  ["Doubao-Seed-1.6(1015)", "doubao-seed-1-6-251015", true],
  ["Doubao-Seed-1.6(0615)", "doubao-seed-1-6-250615", true],
  ["Doubao-Seed-1.6-Flash(0615)", "doubao-seed-1-6-flash-250615", true],
  ["Doubao-Seed-Translation", "doubao-seed-translation-250915", false],
  ["Doubao-1.5-Pro-32K", "doubao-1-5-pro-32k-250115", false],
  ["Doubao-1.5-Pro-32K-Character(0715)", "doubao-1-5-pro-32k-character-250715", false],
  ["Doubao-1.5-Pro-32K-Character(0228)", "doubao-1-5-pro-32k-character-250228", false],
  ["Doubao-1.5-Lite-32K", "doubao-1-5-lite-32k-250115", false],
  ["Doubao-1.5-Vision-Pro-32K", "doubao-1-5-vision-pro-32k-250115", false],
  ["GLM-4-7", "glm-4-7-251222", true],
  ["DeepSeek-V3-2", "deepseek-v3-2-251201", true],
  ["DeepSeek-V3-1-Terminus", "deepseek-v3-1-terminus", true],
  ["DeepSeek-V3(0324)", "deepseek-v3-250324", false],
  ["DeepSeek-R1(0528)", "deepseek-r1-250528", true],
  ["Qwen3-32B", "qwen3-32b-20250429", false],
  ["Qwen3-14B", "qwen3-14b-20250429", false],
  ["Qwen3-8B", "qwen3-8b-20250429", false],
  ["Qwen3-0.6B", "qwen3-0-6b-20250429", false],
  ["Qwen2.5-72B", "qwen2-5-72b-20240919", false],
  ["GLM-4.5-Air", "glm-4-5-air", false],
];

const IMAGE_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"];
const VIDEO_ASPECT_RATIOS = ["16:9", "9:16"];
const GENERIC_REFERENCE_ROLES = ["subject", "style", "storyboard"];
const NON_IMAGE_REFERENCE_ROLES = ["subject", "style"];

function imageModel(input: {
  label: string;
  model: string;
  source?: VolcengineImageModel["source"];
  capabilityStatus?: CapabilityStatus;
  capabilityEvidence?: CapabilityEvidence;
  qualities: VolcengineImageModel["qualities"];
  supportsReferenceImages: boolean;
  maxReferenceImages?: number;
  supportsSequentialGeneration?: boolean;
  maxSequentialImages?: number;
  supportsStreaming?: boolean;
  supportsWebSearch?: boolean;
  optimizePromptModes?: VolcengineImageModel["optimizePromptModes"];
}): VolcengineImageModel {
  const officialGuide = input.source === "volcengine-official-document-guide-2026-08-14";
  return {
    ...input,
    endpointType: "image_generation",
    capabilityStatus: input.capabilityStatus ?? (
      officialGuide
        ? "verified"
        : input.source === "volcengine-official-model-list-2026-07-13"
          || input.source === "volcengine-account-model-directory-2026-08-14"
        ? "catalogued"
        : "configured"
    ),
    capabilityEvidence: input.capabilityEvidence ?? (
      officialGuide
        ? "official-document-guide-2026-08-14"
        : input.source === "volcengine-official-model-list-2026-07-13"
          ? "official-model-list-id-only-2026-07-13"
          : input.source === "volcengine-account-model-directory-2026-08-14"
            ? "account-model-directory-id-only-2026-08-14"
            : "legacy-vendor-catalog-configuration"
    ),
    source: input.source ?? "vendor-catalog-volcengine-v2.4",
    defaultQuality: input.qualities.includes("2K") ? "2K" : input.qualities[0],
    aspectRatios: [...IMAGE_ASPECT_RATIOS],
    defaultAspectRatio: "16:9",
    maxReferenceImages: input.supportsReferenceImages ? input.maxReferenceImages ?? 10 : 0,
    outputFormats: ["png", "jpeg"],
    supportsSequentialGeneration: input.supportsSequentialGeneration ?? false,
    maxSequentialImages: input.supportsSequentialGeneration ? input.maxSequentialImages ?? 15 : 1,
    supportsStreaming: input.supportsStreaming ?? false,
    supportsWebSearch: input.supportsWebSearch ?? false,
    optimizePromptModes: input.optimizePromptModes ?? [],
  };
}

function optionalFrameSlots(): VolcengineVideoInputSlot[] {
  return [
    {
      id: "first_frame",
      label: "首帧",
      roles: ["first_frame"],
      accepts: ["image"],
      min: 1,
      max: 1,
      modes: ["image_to_video", "first_last_frame"],
    },
    {
      id: "last_frame",
      label: "尾帧",
      roles: ["last_frame"],
      accepts: ["image"],
      min: 1,
      max: 1,
      modes: ["first_last_frame"],
    },
  ];
}

function omniReferenceSlots(): VolcengineVideoInputSlot[] {
  return [
    {
      id: "reference_images",
      label: "参考图片",
      roles: [...GENERIC_REFERENCE_ROLES],
      accepts: ["image"],
      min: 0,
      max: 9,
      modes: ["omni_reference"],
    },
    {
      id: "reference_videos",
      label: "参考视频",
      roles: [...NON_IMAGE_REFERENCE_ROLES],
      accepts: ["video"],
      min: 0,
      max: 3,
      modes: ["omni_reference"],
    },
    {
      id: "reference_audio",
      label: "参考音频",
      roles: [...NON_IMAGE_REFERENCE_ROLES],
      accepts: ["file"],
      min: 0,
      max: 3,
      modes: ["omni_reference"],
    },
  ];
}

function videoModel(input: {
  label: string;
  model: string;
  source?: VolcengineVideoModel["source"];
  capabilityStatus?: CapabilityStatus;
  capabilityEvidence?: CapabilityEvidence;
  resolutions: VolcengineVideoModel["resolutions"];
  aspectRatios?: string[];
  durations: number[];
  supportsAutoDuration?: boolean;
  supportsGenerateAudio: boolean;
  outputFormats?: VolcengineVideoModel["outputFormats"];
  modes: string[];
  inputSlots?: VolcengineVideoInputSlot[];
}): VolcengineVideoModel {
  const officialGuide = input.source === "volcengine-official-document-guide-2026-08-14";
  return {
    ...input,
    endpointType: "video_generation",
    capabilityStatus: input.capabilityStatus ?? (officialGuide ? "verified" : "configured"),
    capabilityEvidence: input.capabilityEvidence ?? (officialGuide
      ? "official-document-guide-2026-08-14"
      : input.source === "production-seed"
        ? "production-seed-configuration"
        : "legacy-vendor-catalog-configuration"),
    source: input.source ?? "vendor-catalog-volcengine-v2.4",
    defaultResolution: input.resolutions.includes("720p") ? "720p" : input.resolutions[0],
    aspectRatios: [...(input.aspectRatios ?? VIDEO_ASPECT_RATIOS)],
    defaultAspectRatio: (input.aspectRatios ?? VIDEO_ASPECT_RATIOS).includes("16:9")
      ? "16:9"
      : (input.aspectRatios ?? VIDEO_ASPECT_RATIOS)[0],
    frameRates: [24],
    outputFormats: input.outputFormats ?? ["mp4"],
    inputSlots: input.inputSlots ?? [],
  };
}

const IMAGE_MODELS: VolcengineImageModel[] = [
  imageModel({
    label: "Seedream-5.0-Pro",
    model: "doubao-seedream-5-0-pro-260628",
    source: "volcengine-official-document-guide-2026-08-14",
    qualities: ["1K", "2K"],
    supportsReferenceImages: true,
    maxReferenceImages: 14,
    optimizePromptModes: ["standard", "fast"],
  }),
  imageModel({
    label: "Seedream-5.0",
    model: "doubao-seedream-5-0-260128",
    source: "volcengine-official-document-guide-2026-08-14",
    qualities: ["2K", "4K"],
    supportsReferenceImages: true,
    maxReferenceImages: 14,
    supportsSequentialGeneration: true,
    maxSequentialImages: 15,
    supportsStreaming: true,
    supportsWebSearch: true,
    optimizePromptModes: ["standard"],
  }),
  imageModel({
    label: "Seedream-5.0-Lite",
    model: "doubao-seedream-5-0-lite-260128",
    source: "volcengine-official-document-guide-2026-08-14",
    capabilityStatus: "catalogued",
    capabilityEvidence: "account-model-directory-missing-2026-08-14",
    qualities: ["2K", "4K"],
    supportsReferenceImages: true,
    maxReferenceImages: 14,
    supportsSequentialGeneration: true,
    maxSequentialImages: 15,
    supportsStreaming: true,
    supportsWebSearch: true,
    optimizePromptModes: ["standard"],
  }),
  imageModel({
    label: "Seedream-4.5",
    model: "doubao-seedream-4-5-251128",
    qualities: ["2K", "4K"],
    supportsReferenceImages: true,
    maxReferenceImages: 14,
  }),
  imageModel({
    label: "Seedream-4.0",
    model: "doubao-seedream-4-0-250828",
    qualities: ["1K", "2K", "4K"],
    supportsReferenceImages: true,
    maxReferenceImages: 14,
  }),
  imageModel({
    label: "Seedream-3.0-T2I",
    model: "doubao-seedream-3-0-t2i-250415",
    qualities: ["1K", "2K"],
    supportsReferenceImages: false,
  }),
];

const DURATIONS_2_TO_12 = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const DURATIONS_4_TO_12 = [4, 5, 6, 7, 8, 9, 10, 11, 12];
const DURATIONS_4_TO_15 = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const DURATIONS_4_TO_30 = Array.from({ length: 27 }, (_, index) => index + 4);

const SEEDANCE_2_MODES = ["text_to_video", "image_to_video", "first_last_frame", "omni_reference"];
const OPTIONAL_FRAME_MODES = ["text_to_video", "image_to_video", "first_last_frame"];

const VIDEO_MODELS: VolcengineVideoModel[] = [
  videoModel({
    label: "Seedance 2.5",
    model: SEEDANCE_25_MODEL_ID,
    source: "volcengine-official-seedance-2.5-contract-2026-09-09",
    capabilityStatus: "verified",
    capabilityEvidence: "official-seedance-2.5-contract-2026-09-09",
    resolutions: ["480p", "720p", "1080p"],
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    supportsAutoDuration: true,
    durations: [...DURATIONS_4_TO_30],
    supportsGenerateAudio: true,
    outputFormats: ["mp4", "mov"],
    modes: ["text_to_video", "omni_reference"],
    inputSlots: [
      {
        id: "reference_images",
        label: "参考图片",
        roles: [...GENERIC_REFERENCE_ROLES],
        accepts: ["image"],
        min: 0,
        max: 30,
        modes: ["omni_reference"],
      },
      {
        id: "reference_videos",
        label: "参考视频",
        roles: [...GENERIC_REFERENCE_ROLES],
        accepts: ["video"],
        min: 0,
        max: 10,
        modes: ["omni_reference"],
      },
      {
        id: "reference_audio",
        label: "参考音频",
        roles: [...GENERIC_REFERENCE_ROLES],
        accepts: ["file"],
        min: 0,
        max: 10,
        modes: ["omni_reference"],
      },
    ],
  }),
  videoModel({
    label: "Seedance-2.0(音画同生)",
    model: "doubao-seedance-2-0-260128",
    source: "volcengine-official-document-guide-2026-08-14",
    resolutions: ["480p", "720p", "1080p", "4K"],
    supportsAutoDuration: true,
    durations: [...DURATIONS_4_TO_15],
    supportsGenerateAudio: true,
    modes: [...SEEDANCE_2_MODES],
    inputSlots: [...optionalFrameSlots(), ...omniReferenceSlots()],
  }),
  videoModel({
    label: "Seedance-2.0-Fast",
    model: "doubao-seedance-2-0-fast-260128",
    source: "volcengine-official-document-guide-2026-08-14",
    resolutions: ["480p", "720p"],
    supportsAutoDuration: true,
    durations: [...DURATIONS_4_TO_15],
    supportsGenerateAudio: true,
    modes: [...SEEDANCE_2_MODES],
    inputSlots: [...optionalFrameSlots(), ...omniReferenceSlots()],
  }),
  videoModel({
    label: "Seedance-2.0-Mini",
    model: "doubao-seedance-2-0-mini-260615",
    source: "production-seed",
    resolutions: ["480p", "720p"],
    supportsAutoDuration: true,
    durations: [...DURATIONS_4_TO_15],
    supportsGenerateAudio: true,
    modes: [...SEEDANCE_2_MODES],
    inputSlots: [...optionalFrameSlots(), ...omniReferenceSlots()],
  }),
  videoModel({
    label: "Seedance-1.5-Pro(音画同生)",
    model: "doubao-seedance-1-5-pro-251215",
    resolutions: ["480p", "720p", "1080p"],
    supportsAutoDuration: true,
    durations: [...DURATIONS_4_TO_12],
    supportsGenerateAudio: true,
    modes: [...OPTIONAL_FRAME_MODES],
    inputSlots: optionalFrameSlots(),
  }),
  videoModel({
    label: "Seedance-1.0-Pro",
    model: "doubao-seedance-1-0-pro-250528",
    resolutions: ["480p", "720p", "1080p"],
    durations: [...DURATIONS_2_TO_12],
    supportsGenerateAudio: false,
    modes: [...OPTIONAL_FRAME_MODES],
    inputSlots: optionalFrameSlots(),
  }),
  videoModel({
    label: "Seedance-1.0-Pro-Fast",
    model: "doubao-seedance-1-0-pro-fast-251015",
    resolutions: ["480p", "720p", "1080p"],
    durations: [...DURATIONS_2_TO_12],
    supportsGenerateAudio: false,
    modes: ["text_to_video", "image_to_video"],
    inputSlots: [
      {
        id: "first_frame",
        label: "首帧",
        roles: ["first_frame"],
        accepts: ["image"],
        min: 1,
        max: 1,
        modes: ["image_to_video"],
      },
    ],
  }),
  videoModel({
    label: "Seedance-1.0-Lite-T2V",
    model: "doubao-seedance-1-0-lite-t2v-250428",
    resolutions: ["480p", "720p", "1080p"],
    durations: [...DURATIONS_2_TO_12],
    supportsGenerateAudio: false,
    modes: ["text_to_video"],
  }),
  videoModel({
    label: "Seedance-1.0-Lite-I2V",
    model: "doubao-seedance-1-0-lite-i2v-250428",
    resolutions: ["480p", "720p", "1080p"],
    durations: [...DURATIONS_2_TO_12],
    supportsGenerateAudio: false,
    modes: ["image_to_video", "first_last_frame", "image_reference"],
    inputSlots: [
      ...optionalFrameSlots(),
      {
        id: "reference_images",
        label: "参考图片",
        roles: [...GENERIC_REFERENCE_ROLES],
        accepts: ["image"],
        min: 1,
        max: 4,
        modes: ["image_reference"],
      },
    ],
  }),
];

const MULTIMODAL_EMBEDDING_MODELS: VolcengineMultimodalEmbeddingModel[] = [
  "doubao-embedding-vision-251215",
  "doubao-embedding-vision-250615",
].map((model) => ({
  label: model === "doubao-embedding-vision-251215"
    ? "Doubao-Embedding-Vision(251215)"
    : "Doubao-Embedding-Vision(250615)",
  model,
  endpointType: "multimodal_embedding",
  capabilityStatus: "verified",
  capabilityEvidence: "official-multimodal-embedding-docs-2026-07-13",
  source: "volcengine-official-model-list-2026-07-13",
  inputTypes: ["text", "image_url", "video_url"],
  contextWindowTokens: 131_072,
  dimensions: [1024, 2048],
  supportsSparseEmbedding: true,
  supportsMultiEmbedding: true,
}));

const ACCOUNT_MODEL_DIRECTORY_PRESENT = new Set([
  "doubao-seed-evolving",
  "doubao-seed-2-1-pro-260628",
  "doubao-seed-2-1-turbo-260628",
  "doubao-seed-character-260628",
  "glm-5-2-260617",
  "deepseek-v4-pro-260425",
  "deepseek-v4-flash-260425",
  "deepseek-v4-flash-ga-260731",
  "doubao-seedance-2-5-260628",
  "doubao-seedance-2-0-260128",
  "doubao-seedance-2-0-fast-260128",
  "doubao-seedance-2-0-mini-260615",
  "doubao-seedream-5-0-pro-260628",
  "doubao-seedream-5-0-260128",
  "doubao-seedream-4-5-251128",
  "doubao-embedding-vision-251215",
  "doubao-embedding-vision-250615",
]);

const ACCOUNT_MODEL_DIRECTORY_ABSENT = new Set([
  "doubao-seedream-5-0-lite-260128",
]);

function accountModelDirectoryStatus(model: string): AccountModelDirectoryStatus {
  if (ACCOUNT_MODEL_DIRECTORY_PRESENT.has(model)) return "present";
  if (ACCOUNT_MODEL_DIRECTORY_ABSENT.has(model)) return "absent";
  return "not_checked";
}

function withAccountModelDirectoryStatus<T extends VolcengineModel>(entry: T): T {
  const status = accountModelDirectoryStatus(entry.model);
  return {
    ...entry,
    accountModelDirectoryStatus: status,
    accountModelDirectoryCheckedAt: status === "not_checked" ? null : "2026-08-14",
  };
}

export const VOLCENGINE_MODEL_MANIFEST: VolcengineModel[] = [
  ...TEXT_MODELS.map(([label, model, supportsThinking, source]): VolcengineTextModel => ({
    label,
    model,
    endpointType: "text",
    supportsThinking,
    capabilityStatus: source === "volcengine-official-document-guide-2026-08-14"
      ? "verified"
      : source === "volcengine-official-model-list-2026-07-13"
        || source === "volcengine-account-model-directory-2026-08-14"
        ? "catalogued"
        : "configured",
    capabilityEvidence: source === "volcengine-official-document-guide-2026-08-14"
      ? "official-document-guide-2026-08-14"
      : source === "volcengine-official-model-list-2026-07-13"
        ? "official-model-list-id-only-2026-07-13"
        : source === "volcengine-account-model-directory-2026-08-14"
          ? "account-model-directory-id-only-2026-08-14"
          : "legacy-vendor-catalog-configuration",
    source: source ?? "vendor-catalog-volcengine-v2.4",
    ...(model === "doubao-seed-2-0-pro-260215"
      ? {
          contextWindowTokens: 256_000,
          maxInputTokens: 224_000,
          maxOutputAndReasoningTokens: 128_000,
        }
      : {}),
  })),
  ...IMAGE_MODELS,
  ...VIDEO_MODELS,
  ...MULTIMODAL_EMBEDDING_MODELS,
].map((entry) => withAccountModelDirectoryStatus(entry));

export function volcengineModelsByEndpoint(endpointType: VolcengineEndpointType): VolcengineModel[] {
  return VOLCENGINE_MODEL_MANIFEST.filter((entry) => entry.endpointType === endpointType);
}

export function findVolcengineModel(model: string, endpointType?: VolcengineEndpointType): VolcengineModel | undefined {
  const normalized = String(model || "").trim();
  return VOLCENGINE_MODEL_MANIFEST.find((entry) => (
    entry.model === normalized && (!endpointType || entry.endpointType === endpointType)
  ));
}

export function buildVolcengineRouteConfig(entry: VolcengineModel): Record<string, unknown> {
  const common = {
    seeded: true,
    managedBy: "production-bootstrap",
    manifestVersion: VOLCENGINE_MODEL_MANIFEST_VERSION,
    catalogSource: entry.source,
    capabilityStatus: entry.capabilityStatus,
    capabilityEvidence: entry.capabilityEvidence,
    accountModelDirectoryStatus: entry.accountModelDirectoryStatus,
    accountModelDirectoryCheckedAt: entry.accountModelDirectoryCheckedAt,
    accountLaunchEligible: entry.accountModelDirectoryStatus !== "absent",
    label: entry.label,
  };

  if (entry.endpointType === "text") {
    return {
      ...common,
      supportsThinking: entry.supportsThinking,
      ...(entry.contextWindowTokens ? { contextWindowTokens: entry.contextWindowTokens } : {}),
      ...(entry.maxInputTokens ? { maxInputTokens: entry.maxInputTokens } : {}),
      ...(entry.maxOutputAndReasoningTokens
        ? { maxOutputAndReasoningTokens: entry.maxOutputAndReasoningTokens }
        : {}),
    };
  }

  if (entry.endpointType === "image_generation") {
    return {
      ...common,
      qualities: entry.qualities,
      defaultQuality: entry.defaultQuality,
      aspectRatios: entry.aspectRatios,
      defaultAspectRatio: entry.defaultAspectRatio,
      inputSlots: entry.supportsReferenceImages
        ? [{
            id: "reference_images",
            label: "参考图片",
            roles: ["subject", "style", "storyboard", "first_frame", "last_frame"],
            accepts: ["image"],
            min: 0,
            max: entry.maxReferenceImages,
          }]
        : [],
      outputFormats: entry.outputFormats,
      supportsSequentialGeneration: entry.supportsSequentialGeneration,
      maxSequentialImages: entry.maxSequentialImages,
      supportsStreaming: entry.supportsStreaming,
      supportsWebSearch: entry.supportsWebSearch,
      optimizePromptModes: entry.optimizePromptModes,
    };
  }

  if (entry.endpointType === "multimodal_embedding") {
    return {
      ...common,
      inputTypes: entry.inputTypes,
      contextWindowTokens: entry.contextWindowTokens,
      dimensions: entry.dimensions,
      supportsSparseEmbedding: entry.supportsSparseEmbedding,
      supportsMultiEmbedding: entry.supportsMultiEmbedding,
      apiPath: "/api/v3/embeddings/multimodal",
    };
  }

  if (entry.model === SEEDANCE_25_MODEL_ID) {
    return {
      ...common,
      ...buildSeedance25LaunchRouteConfig({ featureFlagEnabled: false }),
      seeded: true,
      managedBy: "production-bootstrap",
      rolloutState: "catalog-staged",
      productionEntitlementVerified: false,
      realPaidSmokePassed: false,
      frameRates: entry.frameRates,
      outputFormats: entry.outputFormats,
    };
  }

  return {
    ...common,
    resolutions: entry.resolutions,
    nativeResolutions: entry.resolutions,
    defaultResolution: entry.defaultResolution,
    aspectRatios: entry.aspectRatios,
    defaultAspectRatio: entry.defaultAspectRatio,
    duration: {
      min: entry.durations[0],
      max: entry.durations[entry.durations.length - 1],
      step: 1,
      default: entry.durations.includes(5) ? 5 : entry.durations[0],
      allowed: entry.durations,
    },
    supportsGenerateAudio: entry.supportsGenerateAudio,
    frameRates: entry.frameRates,
    outputFormats: entry.outputFormats,
    modes: entry.modes,
    inputSlots: entry.inputSlots,
  };
}
