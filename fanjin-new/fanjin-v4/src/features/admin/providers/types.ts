export const providerOptions = ["volcano", "minimax", "autodl", "custom", "openai", "anthropic", "codex", "gemini", "azure"] as const;
export const endpointOptions = [
  "video_generation",
  "image_generation",
  "text",
  "embedding",
  "multimodal_embedding",
  "tts",
  "rerank",
  "transcription",
] as const;
export const scopeOptions = ["platform", "workspace"] as const;

export type ProviderChannelProvider = (typeof providerOptions)[number];
export type ProviderChannelEndpoint = (typeof endpointOptions)[number];
export type ProviderChannelScope = (typeof scopeOptions)[number];

export interface ProviderChannel {
  id: string;
  name?: string | null;
  channelName?: string | null;
  scope?: ProviderChannelScope | string | null;
  workspaceId?: string | null;
  provider?: ProviderChannelProvider | string | null;
  endpointType?: ProviderChannelEndpoint | string | null;
  baseUrl?: string | null;
  credentialRef?: string | null;
  credentialConfigured?: boolean | null;
  credentialSource?: "request" | "stored" | "environment" | "inline" | "none" | string | null;
  portraitAssetsEnabled?: boolean | null;
  portraitCredentialConfigured?: boolean | null;
  portraitCredentialGeneration?: number | null;
  providerAccountId?: string | null;
  assetsProjectName?: string | null;
  imagexPortraitReviewEnabled?: boolean | null;
  imagexReviewCredentialConfigured?: boolean | null;
  imagexReviewCredentialGeneration?: number | null;
  configJson?: Record<string, unknown> | null;
  modelNames?: string[] | string | null;
  priority?: number | null;
  weight?: number | null;
  timeoutMs?: number | null;
  concurrencyLimit?: number | null;
  disabled?: boolean | number | null;
  healthStatus?: string | null;
  recordedHealthStatus?: string | null;
  healthFreshness?: "fresh" | "stale" | "unchecked" | string | null;
  lastHealthCheckAt?: string | number | null;
  lastHealthLatencyMs?: number | null;
  lastHealthError?: string | null;
  activeTaskCount?: number | null;
  health?: {
    credentialReady?: boolean | null;
    status?: string | null;
    recordedStatus?: string | null;
    freshness?: "fresh" | "stale" | "unchecked" | string | null;
    checkedAt?: string | number | null;
    latencyMs?: number | null;
    errorMessage?: string | null;
  } | null;
}

export interface ProviderChannelForm {
  id: string;
  name: string;
  scope: ProviderChannelScope;
  workspaceId: string;
  provider: ProviderChannelProvider;
  endpointType: string;
  baseUrl: string;
  apiKey: string;
  credentialConfigured: boolean;
  portraitAssetsEnabled: boolean;
  portraitCredentialConfigured: boolean;
  portraitCredentialGeneration: number | null;
  providerAccountId: string;
  assetsProjectName: string;
  portraitAccessKeyId: string;
  portraitSecretAccessKey: string;
  portraitSessionToken: string;
  imagexPortraitReviewEnabled: boolean;
  imagexReviewCredentialConfigured: boolean;
  imagexReviewCredentialGeneration: number | null;
  imagexServiceId: string;
  imagexAccessKeyId: string;
  imagexSecretAccessKey: string;
  imagexSessionToken: string;
  credentialRef: string;
  modelNames: string[];
  priority: number;
  weight: number;
  timeoutMs: number;
  concurrencyLimit: number | null;
  disabled: boolean;
  configJsonText: string;
}

export type ProviderChannelFormField =
  | "name"
  | "provider"
  | "endpointType"
  | "scope"
  | "workspaceId"
  | "apiKey"
  | "providerAccountId"
  | "assetsProjectName"
  | "portraitAccessKeyId"
  | "portraitSecretAccessKey"
  | "portraitSessionToken"
  | "imagexServiceId"
  | "imagexAccessKeyId"
  | "imagexSecretAccessKey"
  | "imagexSessionToken"
  | "priority"
  | "weight"
  | "timeoutMs"
  | "concurrencyLimit"
  | "configJsonText";

export type ProviderChannelFormErrors = Partial<Record<ProviderChannelFormField, string>>;

export interface ProviderChannelPayload {
  name: string;
  scope: ProviderChannelScope;
  workspaceId: string | null;
  provider: ProviderChannelProvider;
  endpointType: ProviderChannelEndpoint;
  baseUrl: string | null;
  apiKey?: string;
  portraitAssetsEnabled: boolean;
  providerAccountId?: string;
  assetsProjectName?: string;
  portraitAccessKeyId?: string;
  portraitSecretAccessKey?: string;
  portraitSessionToken?: string;
  imagexPortraitReviewEnabled?: boolean;
  imagexServiceId?: string;
  imagexAccessKeyId?: string;
  imagexSecretAccessKey?: string;
  imagexSessionToken?: string;
  credentialRef: string | null;
  configJson: Record<string, unknown>;
  modelNames: string[];
  priority: number;
  weight: number;
  timeoutMs: number;
  concurrencyLimit: number | null;
  disabled: number;
}

export type ProviderChannelHealthDraft = Pick<
  ProviderChannelPayload,
  "provider" | "endpointType" | "baseUrl" | "apiKey" | "credentialRef" | "configJson" | "timeoutMs" | "disabled"
> & {
  id?: string;
  name?: string;
};

export const providerLabels: Record<ProviderChannelProvider, string> = {
  volcano: "Volcano",
  minimax: "MiniMax",
  autodl: "AutoDL",
  custom: "自定义",
  openai: "OpenAI",
  anthropic: "Anthropic",
  codex: "Codex",
  gemini: "Gemini",
  azure: "Azure",
};

export const endpointLabels: Record<ProviderChannelEndpoint, string> = {
  video_generation: "视频生成",
  image_generation: "图片生成",
  text: "文本",
  embedding: "文本向量",
  multimodal_embedding: "多模态向量",
  tts: "语音合成",
  rerank: "文本重排",
  transcription: "音频转写",
};

export function isProviderChannelEndpoint(value: unknown): value is ProviderChannelEndpoint {
  return endpointOptions.includes(value as ProviderChannelEndpoint);
}

export const scopeLabels: Record<ProviderChannelScope, string> = {
  platform: "平台",
  workspace: "工作区",
};

export function createEmptyProviderForm(): ProviderChannelForm {
  return {
    id: "",
    name: "",
    scope: "platform",
    workspaceId: "",
    provider: "volcano",
    endpointType: "video_generation",
    baseUrl: "https://ark.cn-beijing.volces.com",
    apiKey: "",
    credentialConfigured: false,
    portraitAssetsEnabled: false,
    portraitCredentialConfigured: false,
    portraitCredentialGeneration: null,
    providerAccountId: "",
    assetsProjectName: "",
    portraitAccessKeyId: "",
    portraitSecretAccessKey: "",
    portraitSessionToken: "",
    imagexPortraitReviewEnabled: false,
    imagexReviewCredentialConfigured: false,
    imagexReviewCredentialGeneration: null,
    imagexServiceId: "",
    imagexAccessKeyId: "",
    imagexSecretAccessKey: "",
    imagexSessionToken: "",
    credentialRef: "",
    modelNames: [],
    priority: 100,
    weight: 1,
    timeoutMs: 600000,
    concurrencyLimit: null,
    disabled: false,
    configJsonText: "{}",
  };
}

/** Explicit new-channel preset; never used to rewrite an existing channel. */
export function createFanjinProviderForm(endpoint: "text" | "image_generation" | "video_generation" = "video_generation"): ProviderChannelForm {
  return {
    ...createEmptyProviderForm(),
    name: `繁境${endpoint === "text" ? "文本" : endpoint === "image_generation" ? "图片" : "视频"}中转`,
    provider: endpoint === "video_generation" ? "volcano" : "openai",
    endpointType: endpoint,
    baseUrl: "https://fanjin.top",
    disabled: true,
    configJsonText: JSON.stringify({
      modelDiscoveryUrl: "https://fanjin.top/v1/models",
      healthProbeUrl: "https://fanjin.top/v1/models",
    }, null, 2),
  };
}

export function parseProviderModelNames(value: ProviderChannel["modelNames"]) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean);
      } catch {
        // Fall back to the legacy comma/newline representation below.
      }
    }
    return trimmed.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function stringifyConfig(value: ProviderChannel["configJson"]) {
  try {
    return JSON.stringify(value && typeof value === "object" && !Array.isArray(value) ? value : {}, null, 2);
  } catch {
    return "{}";
  }
}

export function providerFormFromChannel(channel: ProviderChannel): ProviderChannelForm {
  const config = channel.configJson && typeof channel.configJson === "object" && !Array.isArray(channel.configJson)
    ? channel.configJson
    : {};
  return {
    ...createEmptyProviderForm(),
    id: String(channel.id || ""),
    name: String(channel.name || channel.channelName || ""),
    scope: scopeOptions.includes(channel.scope as ProviderChannelScope) ? channel.scope as ProviderChannelScope : "platform",
    workspaceId: String(channel.workspaceId || ""),
    provider: providerOptions.includes(channel.provider as ProviderChannelProvider) ? channel.provider as ProviderChannelProvider : "custom",
    endpointType: String(channel.endpointType || ""),
    baseUrl: String(channel.baseUrl || ""),
    apiKey: "",
    credentialConfigured: Boolean(channel.credentialConfigured || channel.health?.credentialReady),
    portraitAssetsEnabled: Boolean(channel.portraitAssetsEnabled),
    portraitCredentialConfigured: Boolean(channel.portraitCredentialConfigured),
    portraitCredentialGeneration: channel.portraitCredentialGeneration == null
      ? null
      : Number(channel.portraitCredentialGeneration),
    providerAccountId: String(
      channel.providerAccountId
      || config.providerAccountId
      || config.volcengineAccountId
      || config.accountId
      || "",
    ),
    assetsProjectName: String(
      channel.assetsProjectName
      || config.assetsProjectName
      || config.projectName
      || "",
    ),
    portraitAccessKeyId: "",
    portraitSecretAccessKey: "",
    portraitSessionToken: "",
    imagexPortraitReviewEnabled: Boolean(channel.imagexPortraitReviewEnabled),
    imagexReviewCredentialConfigured: Boolean(channel.imagexReviewCredentialConfigured),
    imagexReviewCredentialGeneration: channel.imagexReviewCredentialGeneration == null
      ? null
      : Number(channel.imagexReviewCredentialGeneration),
    imagexServiceId: "",
    imagexAccessKeyId: "",
    imagexSecretAccessKey: "",
    imagexSessionToken: "",
    credentialRef: String(channel.credentialRef || ""),
    modelNames: parseProviderModelNames(channel.modelNames),
    priority: Number.isInteger(Number(channel.priority)) ? Number(channel.priority) : 100,
    weight: Number.isInteger(Number(channel.weight)) ? Number(channel.weight) : 1,
    timeoutMs: Number.isInteger(Number(channel.timeoutMs)) ? Number(channel.timeoutMs) : 600000,
    concurrencyLimit: channel.concurrencyLimit == null ? null : Number(channel.concurrencyLimit),
    disabled: Boolean(channel.disabled),
    configJsonText: stringifyConfig(config),
  };
}

export function buildProviderPayload(form: ProviderChannelForm): ProviderChannelPayload {
  if (!form.name.trim()) throw new Error("请填写通道名称");
  if (!form.apiKey.trim() && !form.credentialConfigured && !form.credentialRef.trim()) {
    throw new Error("请填写 API Key，或填写环境变量引用");
  }
  if (form.scope === "workspace" && !form.workspaceId.trim()) throw new Error("工作区通道需要填写 Workspace ID");
  if (!isProviderChannelEndpoint(form.endpointType)) {
    throw new Error(`不支持的能力类型「${form.endpointType || "空值"}」，请选择有效能力后再保存`);
  }
  if (!Number.isInteger(form.priority)) throw new Error("优先级必须是整数");
  if (!Number.isInteger(form.weight) || form.weight < 0) throw new Error("权重必须是非负整数");
  if (!Number.isInteger(form.timeoutMs) || form.timeoutMs < 1000) throw new Error("超时至少为 1000ms");
  if (form.concurrencyLimit !== null && (!Number.isInteger(form.concurrencyLimit) || form.concurrencyLimit < 0)) {
    throw new Error("并发上限必须是非负整数或留空");
  }
  const portraitEligible = form.provider === "volcano" && form.endpointType === "video_generation";
  const portraitCredentialSubmitted = Boolean(
    form.portraitAccessKeyId.trim()
    || form.portraitSecretAccessKey
    || form.portraitSessionToken,
  );
  if ((form.portraitAssetsEnabled || portraitCredentialSubmitted) && !portraitEligible) {
    throw new Error("人像资产仅支持 Volcano 视频生成通道");
  }
  if (portraitCredentialSubmitted && (!form.portraitAccessKeyId.trim() || !form.portraitSecretAccessKey)) {
    throw new Error("更新人像资产凭据时必须同时填写 Access Key ID 与 Secret Access Key");
  }
  if (form.portraitAssetsEnabled && !portraitCredentialSubmitted && !form.portraitCredentialConfigured) {
    throw new Error("启用人像资产前请填写独立 AK/SK");
  }
  const providerAccountId = form.providerAccountId.trim();
  const assetsProjectName = form.assetsProjectName.trim();
  if (
    (form.portraitAssetsEnabled || portraitCredentialSubmitted || providerAccountId || assetsProjectName)
    && !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(providerAccountId)
  ) {
    throw new Error("请填写有效的火山账号标识（providerAccountId）");
  }
  if (
    (form.portraitAssetsEnabled || portraitCredentialSubmitted || providerAccountId || assetsProjectName)
    && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(assetsProjectName)
  ) {
    throw new Error("请填写有效的人像资产 ProjectName");
  }
  let configJson: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(form.configJsonText.trim() || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    configJson = parsed as Record<string, unknown>;
  } catch {
    throw new Error("高级配置必须是合法的 JSON 对象");
  }
  if (providerAccountId || assetsProjectName) {
    configJson = {
      ...configJson,
      assetsProjectName,
      providerAccountId,
    };
  }

  return {
    name: form.name.trim(),
    scope: form.scope,
    workspaceId: form.scope === "workspace" ? form.workspaceId.trim() : null,
    provider: form.provider,
    endpointType: form.endpointType,
    baseUrl: form.baseUrl.trim() || null,
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    portraitAssetsEnabled: portraitEligible ? form.portraitAssetsEnabled : false,
    ...(portraitEligible && (providerAccountId || assetsProjectName) ? {
      providerAccountId,
      assetsProjectName,
    } : {}),
    ...(portraitCredentialSubmitted ? {
      portraitAccessKeyId: form.portraitAccessKeyId.trim(),
      portraitSecretAccessKey: form.portraitSecretAccessKey,
      ...(form.portraitSessionToken ? { portraitSessionToken: form.portraitSessionToken } : {}),
    } : {}),
    credentialRef: form.credentialRef.trim() || null,
    configJson,
    modelNames: [...new Set(form.modelNames.map((item) => item.trim()).filter(Boolean))],
    priority: form.priority,
    weight: form.weight,
    timeoutMs: form.timeoutMs,
    concurrencyLimit: form.concurrencyLimit,
    disabled: form.disabled ? 1 : 0,
  };
}

export function buildProviderHealthDraft(form: ProviderChannelForm): ProviderChannelHealthDraft {
  if (!form.baseUrl.trim()) throw new Error("请填写 Base URL");
  if (!form.apiKey.trim() && !form.credentialConfigured && !form.credentialRef.trim()) {
    throw new Error("请填写 API Key");
  }
  if (!isProviderChannelEndpoint(form.endpointType)) {
    throw new Error(`不支持的能力类型「${form.endpointType || "空值"}」`);
  }
  if (!Number.isInteger(form.timeoutMs) || form.timeoutMs < 1000) throw new Error("超时至少为 1000ms");

  let configJson: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(form.configJsonText.trim() || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    configJson = parsed as Record<string, unknown>;
  } catch {
    throw new Error("高级配置必须是合法的 JSON 对象");
  }

  return {
    ...(form.id ? { id: form.id } : {}),
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
    provider: form.provider,
    endpointType: form.endpointType,
    baseUrl: form.baseUrl.trim(),
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    credentialRef: form.credentialRef.trim() || null,
    configJson,
    timeoutMs: form.timeoutMs,
    disabled: form.disabled ? 1 : 0,
  };
}
