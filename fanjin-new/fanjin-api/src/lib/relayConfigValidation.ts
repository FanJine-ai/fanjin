import type { Knex } from "knex";
import { isPostgresClient } from "@/lib/dbDialect";
import { relayEndpointTypes, relayProviders } from "@/lib/sharedTypes";

export type RelayConfigScope = "platform" | "workspace";

export interface RelayConfigValidationIssue {
  path: string[];
  message: string;
}

export class RelayConfigValidationError extends Error {
  readonly statusCode: 400 | 409;
  readonly issues: RelayConfigValidationIssue[];
  readonly conflictId: string | null;

  constructor(input: {
    message: string;
    statusCode?: 400 | 409;
    issues?: RelayConfigValidationIssue[];
    conflictId?: string | null;
  }) {
    super(input.message);
    this.name = "RelayConfigValidationError";
    this.statusCode = input.statusCode ?? 400;
    this.issues = input.issues ?? [];
    this.conflictId = input.conflictId ?? null;
  }
}

export function relayConfigValidationErrorBody(error: RelayConfigValidationError): Record<string, unknown> {
  return {
    message: error.message,
    ...(error.issues.length ? { errors: error.issues } : {}),
    ...(error.conflictId ? { data: { conflictId: error.conflictId } } : {}),
  };
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function optionalString(value: unknown): string | null {
  return trimmedString(value) || null;
}

function normalizedDisabled(value: unknown): 0 | 1 {
  return Number(value) === 0 ? 0 : 1;
}

/** 用户可见映射名列:trim 后为空一律落 NULL,让前端回退 name/model。 */
export function normalizeModelRouteDisplayName(value: unknown): string | null {
  return optionalString(value);
}

/**
 * 超分组合映射名只存 routeConfig JSON(enhanceDisplayName 键),不单独建列;
 * 写入时 trim,空值直接移除该键,避免留下 "" 阻止前端回退。
 */
export function normalizeRouteConfigEnhanceDisplayName(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!("enhanceDisplayName" in config)) return config;
  const next = { ...config };
  const value = trimmedString(next.enhanceDisplayName);
  if (value) next.enhanceDisplayName = value;
  else delete next.enhanceDisplayName;
  return next;
}

export function normalizeRelayConfigScope(input: {
  scope?: unknown;
  workspaceId?: unknown;
}): { scope: RelayConfigScope; workspaceId: string | null } {
  const scope = input.scope === "workspace" ? "workspace" : "platform";
  return {
    scope,
    workspaceId: scope === "workspace" ? optionalString(input.workspaceId) : null,
  };
}

async function assertActiveWorkspace(
  client: Knex | Knex.Transaction,
  input: { scope: RelayConfigScope; workspaceId: string | null },
): Promise<void> {
  if (input.scope === "platform") return;
  if (!input.workspaceId) {
    throw new RelayConfigValidationError({
      message: "工作区范围的 Relay 配置必须提供 workspaceId",
      issues: [{ path: ["workspaceId"], message: "请选择有效的活动工作区" }],
    });
  }

  if (!(await activeWorkspaceExists(client, input.workspaceId))) {
    throw new RelayConfigValidationError({
      message: "workspaceId 无效：工作区不存在或已停用",
      issues: [{ path: ["workspaceId"], message: "请选择有效的活动工作区" }],
    });
  }
}

async function activeWorkspaceExists(
  client: Knex | Knex.Transaction,
  workspaceId: string,
): Promise<boolean> {
  const query = client("o_workspace")
    .where({ id: workspaceId, status: "active" })
    .select("id")
    .first();
  if (isPostgresClient(client)) query.forShare();
  return Boolean(await query);
}

export interface ProviderChannelIntegrityInput {
  scope: unknown;
  workspaceId?: unknown;
  provider: unknown;
  endpointType: unknown;
  credentialRef?: unknown;
  disabled: unknown;
}

export interface NormalizedProviderChannelIntegrity {
  scope: RelayConfigScope;
  workspaceId: string | null;
  provider: string;
  endpointType: string;
  disabled: 0 | 1;
}

export const VOLCANO_ARK_MODEL_CREDENTIAL_REF = "VOLCANO_ARK_API_KEY" as const;
export const VOLCANO_UPSCALE_CREDENTIAL_REFS = Object.freeze([
  "VOLCANO_VIDEO_ENHANCE_API_KEY",
  "VOLCANO_MEDIAKIT_API_KEY",
] as const);

export function isProviderChannelCredentialReferenceAllowed(input: {
  provider: unknown;
  endpointType: unknown;
  credentialRef?: unknown;
}): boolean {
  const provider = trimmedString(input.provider);
  const endpointType = trimmedString(input.endpointType);
  const credentialRef = optionalString(input.credentialRef);
  if (provider === "autodl" && credentialRef) {
    return credentialRef === "AUTODL_COMFYUI_API_KEY"
      || (process.env.NODE_ENV === "test" && /^FANJIN_TEST_[A-Z0-9_]+$/u.test(credentialRef));
  }
  if (provider !== "volcano" || !credentialRef) return true;
  // Test fixtures use one-use mock provider credentials. This exception is
  // unreachable in deployed runtimes and therefore does not widen the
  // production product-credential allowlist.
  if (
    process.env.NODE_ENV === "test"
    && /^FANJIN_TEST_[A-Z0-9_]+$/u.test(credentialRef)
  ) {
    return true;
  }
  const allowed = endpointType === "video_upscale"
    ? VOLCANO_UPSCALE_CREDENTIAL_REFS as readonly string[]
    : [VOLCANO_ARK_MODEL_CREDENTIAL_REF];
  return allowed.includes(credentialRef);
}

/**
 * Volcano has multiple credential products with intentionally incompatible
 * authorities. A credential reference is optional because a channel can use
 * its purpose-bound sealed DB slot, but an environment reference must name the
 * exact product credential. In particular, ECS/RunCommand deployment AK/SK
 * variables can never be selected by a model or MediaKit channel.
 */
export function assertProviderChannelCredentialReferenceBoundary(input: {
  provider: unknown;
  endpointType: unknown;
  credentialRef?: unknown;
}): void {
  const provider = trimmedString(input.provider);
  const endpointType = trimmedString(input.endpointType);
  const credentialRef = optionalString(input.credentialRef);
  if (isProviderChannelCredentialReferenceAllowed(input)) return;
  if (provider === "autodl") {
    throw new RelayConfigValidationError({ message: "AutoDL 通道只能引用独立的 ComfyUI API Key", issues: [{ path: ["credentialRef"], message: "仅允许 AUTODL_COMFYUI_API_KEY，不能复用 MiniMax 或火山凭据" }] });
  }
  const allowed = endpointType === "video_upscale"
    ? VOLCANO_UPSCALE_CREDENTIAL_REFS as readonly string[]
    : [VOLCANO_ARK_MODEL_CREDENTIAL_REF];
  throw new RelayConfigValidationError({
    message: endpointType === "video_upscale"
      ? "火山超分通道只能引用独立的 MediaKit/画质增强 API Key"
      : "火山模型通道只能引用方舟模型 API Key",
    issues: [{
      path: ["credentialRef"],
      message: `仅允许：${allowed.join(" / ")}；禁止复用部署 AK/SK 或其他产品凭据`,
    }],
  });
}

export async function normalizeAndValidateProviderChannel(
  client: Knex | Knex.Transaction,
  input: ProviderChannelIntegrityInput,
): Promise<NormalizedProviderChannelIntegrity> {
  const scoped = normalizeRelayConfigScope(input);
  await assertActiveWorkspace(client, scoped);
  const provider = trimmedString(input.provider);
  const endpointType = trimmedString(input.endpointType);
  if (!relayProviders.includes(provider as (typeof relayProviders)[number])) {
    throw new RelayConfigValidationError({
      message: "Provider channel 的 provider 配置无效",
      issues: [{ path: ["provider"], message: "请选择有效供应商" }],
    });
  }
  if (!relayEndpointTypes.includes(endpointType as (typeof relayEndpointTypes)[number])) {
    throw new RelayConfigValidationError({
      message: "Provider channel 的 endpointType 配置无效",
      issues: [{ path: ["endpointType"], message: "请选择有效能力类型" }],
    });
  }
  assertProviderChannelCredentialReferenceBoundary({
    provider,
    endpointType,
    credentialRef: input.credentialRef,
  });
  return {
    ...scoped,
    provider,
    endpointType,
    disabled: normalizedDisabled(input.disabled),
  };
}

export interface ModelRouteIntegrityInput {
  scope: unknown;
  workspaceId?: unknown;
  provider?: unknown;
  endpointType: unknown;
  channelId?: unknown;
  disabled: unknown;
}

export interface NormalizedModelRouteIntegrity {
  scope: RelayConfigScope;
  workspaceId: string | null;
  provider: string;
  endpointType: string;
  channelId: string | null;
  disabled: 0 | 1;
}

export async function normalizeAndValidateModelRoute(
  client: Knex | Knex.Transaction,
  input: ModelRouteIntegrityInput,
): Promise<NormalizedModelRouteIntegrity> {
  const scoped = normalizeRelayConfigScope(input);
  await assertActiveWorkspace(client, scoped);

  const channelId = optionalString(input.channelId);
  const requestedProvider = optionalString(input.provider);
  const endpointType = trimmedString(input.endpointType);
  if (endpointType === "video_upscale") {
    throw new RelayConfigValidationError({
      message: "超分属于媒体服务，不能注册为上游模型通道或模型路由",
      issues: [{ path: ["endpointType"], message: "请在媒体服务页配置密钥，在视频路由中绑定服务" }],
    });
  }
  if (!relayEndpointTypes.includes(endpointType as (typeof relayEndpointTypes)[number])) {
    throw new RelayConfigValidationError({
      message: "Model route 的 endpointType 配置无效",
      issues: [{ path: ["endpointType"], message: "请选择有效能力类型" }],
    });
  }
  if (!channelId) {
    if (!requestedProvider || !relayProviders.includes(requestedProvider as (typeof relayProviders)[number])) {
      throw new RelayConfigValidationError({
        message: "未绑定 channelId 的 Model route 必须指定有效 provider",
        issues: [{ path: ["provider"], message: "请选择供应商，或绑定一个可用通道" }],
      });
    }
    return {
      ...scoped,
      provider: requestedProvider,
      endpointType,
      channelId: null,
      disabled: normalizedDisabled(input.disabled),
    };
  }

  const channel = await client("o_provider_channel").where({ id: channelId }).first();
  if (!channel) {
    throw new RelayConfigValidationError({
      message: "channelId 无效：Provider channel 不存在",
      issues: [{ path: ["channelId"], message: "请选择存在的供应商通道" }],
    });
  }
  if (normalizedDisabled(channel.disabled) !== 0) {
    throw new RelayConfigValidationError({
      message: "channelId 无效：Provider channel 已停用",
      issues: [{ path: ["channelId"], message: "请先启用通道，或绑定其他可用通道" }],
    });
  }

  const channelEndpointType = trimmedString(channel.endpointType);
  if (endpointType !== channelEndpointType) {
    throw new RelayConfigValidationError({
      message: "Model route 与 Provider channel 的 endpointType 不一致",
      issues: [{ path: ["endpointType"], message: `绑定通道仅支持 ${channelEndpointType}` }],
    });
  }

  const channelProvider = trimmedString(channel.provider);
  if (!relayProviders.includes(channelProvider as (typeof relayProviders)[number])) {
    throw new RelayConfigValidationError({
      message: "channelId 无效：Provider channel 的 provider 配置无效",
      issues: [{ path: ["channelId"], message: "请先修复通道的供应商配置" }],
    });
  }
  if (requestedProvider && requestedProvider !== channelProvider) {
    throw new RelayConfigValidationError({
      message: "Model route 与 Provider channel 的 provider 不一致",
      issues: [{ path: ["provider"], message: `绑定通道的供应商为 ${channelProvider}` }],
    });
  }

  const rawChannelScope = trimmedString(channel.scope);
  if (rawChannelScope !== "platform" && rawChannelScope !== "workspace") {
    throw new RelayConfigValidationError({
      message: "channelId 无效：Provider channel 的 scope 配置无效",
      issues: [{ path: ["channelId"], message: "请先修复通道的范围配置" }],
    });
  }
  const channelScope: RelayConfigScope = rawChannelScope;
  let channelWorkspaceId: string | null = null;
  if (channelScope === "platform") {
    if (channel.workspaceId !== null) {
      throw new RelayConfigValidationError({
        message: "channelId 无效：平台 Provider channel 的 workspaceId 必须为 NULL",
        issues: [{ path: ["channelId"], message: "请先清理通道遗留的 workspaceId" }],
      });
    }
  } else {
    const rawChannelWorkspaceId = typeof channel.workspaceId === "string" ? channel.workspaceId : "";
    channelWorkspaceId = optionalString(rawChannelWorkspaceId);
    if (!channelWorkspaceId || rawChannelWorkspaceId !== channelWorkspaceId) {
      throw new RelayConfigValidationError({
        message: "channelId 无效：工作区 Provider channel 必须配置规范的 workspaceId",
        issues: [{ path: ["channelId"], message: "请先修复通道的工作区配置" }],
      });
    }
    if (!(await activeWorkspaceExists(client, channelWorkspaceId))) {
      throw new RelayConfigValidationError({
        message: "channelId 无效：Provider channel 引用的工作区不存在或已停用",
        issues: [{ path: ["channelId"], message: "请绑定活动工作区中的可用通道" }],
      });
    }
  }
  const scopeCompatible = scoped.scope === "platform"
    ? channelScope === "platform"
    : channelScope === "platform" || channelWorkspaceId === scoped.workspaceId;
  if (!scopeCompatible) {
    throw new RelayConfigValidationError({
      message: "Model route 与 Provider channel 的 scope/workspace 不相容",
      issues: [{
        path: ["channelId"],
        message: scoped.scope === "platform"
          ? "平台路由只能绑定平台通道"
          : "工作区路由只能绑定平台通道或同一工作区通道",
      }],
    });
  }

  return {
    ...scoped,
    provider: requestedProvider ?? channelProvider,
    endpointType,
    channelId,
    disabled: normalizedDisabled(input.disabled),
  };
}

function sameIntegrityValue(left: unknown, right: unknown): boolean {
  return optionalString(left) === optionalString(right);
}

export async function assertProviderChannelMutationAllowed(
  client: Knex | Knex.Transaction,
  existing: Record<string, unknown>,
  next: NormalizedProviderChannelIntegrity,
  options: { forceDisableCheck?: boolean } = {},
): Promise<void> {
  const existingScope = normalizeRelayConfigScope(existing);
  const changedFields: string[] = [];
  if (existingScope.scope !== next.scope) changedFields.push("scope");
  if (!sameIntegrityValue(existingScope.workspaceId, next.workspaceId)) changedFields.push("workspaceId");
  if (!sameIntegrityValue(existing.provider, next.provider)) changedFields.push("provider");
  if (!sameIntegrityValue(existing.endpointType, next.endpointType)) changedFields.push("endpointType");

  const disabling = options.forceDisableCheck || (
    normalizedDisabled(existing.disabled) === 0 && next.disabled === 1
  );
  if (disabling) changedFields.push("disabled");
  if (!changedFields.length) return;

  const dependency = await client("o_model_route")
    .where({ channelId: trimmedString(existing.id), disabled: 0 })
    .select("id")
    .first();
  if (!dependency) return;

  throw new RelayConfigValidationError({
    message: `Provider channel 仍被启用的 Model route 引用；请先停用路由，再修改 ${changedFields.join("/")}`,
    statusCode: 409,
    conflictId: trimmedString(dependency.id),
  });
}

// SQLite deployments are serialized inside one API process. PostgreSQL also
// takes table locks so multiple API instances cannot create a route between a
// dependency check and the provider-channel write.
let relayConfigMutationTail: Promise<void> = Promise.resolve();

export async function serializeRelayConfigMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = relayConfigMutationTail;
  let release = () => {};
  relayConfigMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function lockRelayConfigTablesForMutation(client: Knex.Transaction): Promise<void> {
  if (!isPostgresClient(client)) return;
  await client.raw(
    'LOCK TABLE "o_provider_channel", "o_model_route" IN SHARE ROW EXCLUSIVE MODE',
  );
}
