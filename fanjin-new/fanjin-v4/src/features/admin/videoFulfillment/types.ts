export const PUBLIC_VIDEO_RESOLUTIONS = ["720p", "1080p", "2k", "4k"] as const;
export type PublicVideoResolution = (typeof PUBLIC_VIDEO_RESOLUTIONS)[number];

/** 配方内部起分档(含 480,仅内部) */
export const INTERNAL_VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "2k", "4k"] as const;

export interface VideoChannelOption {
  id: string;
  name: string;
  provider: string;
  endpointType: string;
  modelNames: string[];
  disabled: boolean;
  healthStatus: string | null;
}

export interface VideoOfferModelRoute {
  id: string;
  name: string;
  provider: string | null;
  channelId: string | null;
  displayName: string | null;
  disabled: boolean;
}

export interface VideoOffer {
  publicModel: string;
  displayName: string;
  visibleResolutions: string[];
  enabled: boolean;
  offerConfigured: boolean;
  modelRoutes: VideoOfferModelRoute[];
  recipeCounts: Record<string, { enabled: number; total: number }>;
}

export interface RecipeChannelInfo {
  id: string;
  name: string;
  endpointType: string;
  disabled: boolean;
}

export interface VideoRecipe {
  id: string;
  publicModel: string;
  targetResolution: string;
  name: string;
  generateChannelId: string;
  generateResolution: string;
  upstreamModel: string | null;
  enhanceEnabled: boolean;
  enhanceChannelId: string | null;
  weight: number;
  priority: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  generateChannel: RecipeChannelInfo | null;
  enhanceChannel: RecipeChannelInfo | null;
  warnings: string[];
}

export interface EnhancePricingRule {
  id: string;
  name: string;
  sourceResolution: string | null;
  targetResolution: string | null;
  unit: string;
  unitPriceMicros: number;
  currency: string;
  disabled: boolean;
  updateTime: number;
}

export interface EnhanceMatrixCell {
  sourceResolution: string;
  targetResolution: string;
  allowed: boolean;
  rule: EnhancePricingRule | null;
}

export interface EnhanceOverview {
  matrix: EnhanceMatrixCell[];
  pricingRules: EnhancePricingRule[];
  upscaleChannels: VideoChannelOption[];
}

export interface RecipeForm {
  id: string;
  name: string;
  generateChannelId: string;
  generateResolution: string;
  upstreamModel: string;
  enhanceEnabled: boolean;
  enhanceChannelId: string;
  weight: number;
  priority: number;
  enabled: boolean;
}

export type RecipeFormErrors = Partial<Record<
  "generateChannelId" | "generateResolution" | "enhanceChannelId" | "weight" | "priority",
  string
>>;

export interface SaveResult {
  warnings?: string[];
}
