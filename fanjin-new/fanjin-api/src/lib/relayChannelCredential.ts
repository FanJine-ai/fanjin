import type { RelayChannel } from "@/lib/sharedTypes";
import { REDACTED_PROVIDER_SECRET } from "@/lib/providerChannelSecrets";
import {
  inspectProviderChannelPortraitCredential,
  openProviderChannelCredential,
  parseProviderChannelPortraitCredential,
  readProviderChannelCredentialCiphertext,
} from "@/lib/providerChannelCredentials";
import {
  isFormalCandidateCredentialRuntimeDeclared,
  withFormalCandidateCredentialForDispatch,
} from "@/lib/formalCandidateCredentialRuntime";
import { isProviderChannelCredentialReferenceAllowed } from "@/lib/relayConfigValidation";

export const PREVIEW_PROVIDER_DISPATCH_DISABLED_ENV =
  "FANJIN_PREVIEW_PROVIDER_DISPATCH_DISABLED";

export class PreviewProviderDispatchDisabledError extends Error {
  readonly code = "PREVIEW_PROVIDER_DISPATCH_DISABLED";
  readonly statusCode = 503;

  constructor() {
    super("PREVIEW_PROVIDER_DISPATCH_DISABLED");
    this.name = "PreviewProviderDispatchDisabledError";
  }
}

export function isPreviewProviderDispatchDisabled(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return String(environment[PREVIEW_PROVIDER_DISPATCH_DISABLED_ENV] || "").trim() === "1";
}

export function assertProviderDispatchAllowed(
  environment: Record<string, string | undefined> = process.env,
): void {
  if (isPreviewProviderDispatchDisabled(environment)) {
    throw new PreviewProviderDispatchDisabledError();
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function usableInlineSecret(value: unknown): string {
  const text = cleanString(value);
  if (!text || text === REDACTED_PROVIDER_SECRET || text.includes("[REDACTED]") || text.endsWith("_****")) return "";
  return text;
}

export interface RelayChannelCredentialInput {
  id?: string | null;
  provider?: string | null;
  endpointType?: string | null;
  credentialCiphertext?: string | null;
  credentialPlaintext?: string | null;
  credentialRef?: string | null;
  config?: Record<string, unknown> | null;
}

export type RelayChannelCredentialSource = "request" | "stored" | "environment" | "inline" | "none";

/**
 * Purpose-separated environment fallbacks for Volcano channels.
 *
 * Ark's bearer API key is valid only for Ark model endpoints. MediaKit video
 * enhancement has its own bearer credential and must never silently borrow the
 * Ark key (or either AK/SK pair used by deployment and Ark Assets).
 */
export function providerCredentialFallbackEnvNames(
  provider: unknown,
  endpointType: unknown,
): string[] {
  const normalizedProvider = cleanString(provider);
  if (normalizedProvider === "autodl") return ["AUTODL_COMFYUI_API_KEY"];
  if (normalizedProvider === "minimax") return ["MINIMAX_API_KEY"];
  if (normalizedProvider !== "volcano") return [];
  if (cleanString(endpointType) === "video_upscale") {
    return ["VOLCANO_VIDEO_ENHANCE_API_KEY", "VOLCANO_MEDIAKIT_API_KEY"];
  }
  return ["VOLCANO_ARK_API_KEY"];
}

export type RelayChannelCredentialDispatchScope = Readonly<{
  channelId: string;
  provider: string;
  endpointType: string;
  model: string;
}>;

export function resolveChannelCredential(
  channel: RelayChannelCredentialInput,
  fallbackEnvNames: string[] = [],
): { value: string; source: RelayChannelCredentialSource } {
  // Preview is a no-spend validation runtime. It may render stored provider
  // configuration, but it must never decrypt or return a usable credential.
  if (isPreviewProviderDispatchDisabled()) {
    return { value: "", source: "none" };
  }
  // A formal runtime may only obtain provider credentials from the root-owned
  // FD6 capability. Availability probes deliberately see `none`; they must
  // never decrypt DB state or fall back to process environment/inline config.
  if (isFormalCandidateCredentialRuntimeDeclared()) {
    return { value: "", source: "none" };
  }
  const config = channel.config || {};
  const transient = usableInlineSecret(channel.credentialPlaintext);
  if (transient) return { value: transient, source: "request" };

  const stored = openProviderChannelCredential(
    cleanString(channel.id),
    cleanString(channel.credentialCiphertext) || readProviderChannelCredentialCiphertext(config),
  );
  if (stored) return { value: stored, source: "stored" };

  const credentialRef = cleanString(channel.credentialRef) || cleanString((config as any).credentialRef);
  if (credentialRef) {
    if (!isProviderChannelCredentialReferenceAllowed({
      provider: channel.provider,
      endpointType: channel.endpointType,
      credentialRef,
    })) {
      return { value: "", source: "none" };
    }
    if (process.env[credentialRef]) {
      return { value: String(process.env[credentialRef]), source: "environment" };
    }
  }

  const production = ["prod", "production"].includes(
    String(process.env.NODE_ENV || "").trim().toLowerCase(),
  );
  const inline = production
    ? ""
    : usableInlineSecret((config as any).apiKey) || usableInlineSecret((config as any).key);
  if (inline) return { value: inline, source: "inline" };

  for (const envName of fallbackEnvNames) {
    if (envName && process.env[envName]) {
      return { value: String(process.env[envName]), source: "environment" };
    }
  }
  return { value: "", source: "none" };
}

export function resolveChannelApiKey(channel: RelayChannelCredentialInput, fallbackEnvNames: string[] = []): string {
  // Every synchronous Relay/provider implementation obtains its dispatch
  // credential through this function. Throwing here prevents an accidental
  // unauthenticated outbound request in implementations that do not explicitly
  // check for an empty credential before fetch/axios.
  assertProviderDispatchAllowed();
  return resolveChannelCredential(channel, fallbackEnvNames).value;
}

/**
 * Portrait credentials intentionally have no environment/inline fallback.
 * They are a typed AK/SK envelope in a purpose-separated sealed slot; the
 * ordinary channel credential remains an opaque Bearer value.
 */
export function resolvePortraitChannelCredential(
  channel: RelayChannelCredentialInput,
): { value: string; source: RelayChannelCredentialSource } {
  if (isFormalCandidateCredentialRuntimeDeclared()) return { value: "", source: "none" };
  const transient = usableInlineSecret(channel.credentialPlaintext);
  if (transient && parseProviderChannelPortraitCredential(transient)) {
    return { value: transient, source: "request" };
  }
  const inspected = inspectProviderChannelPortraitCredential(
    cleanString(channel.id),
    channel.config || {},
  );
  return inspected.enabled && inspected.configured
    ? { value: inspected.serializedCredential, source: "stored" }
    : { value: "", source: "none" };
}

/**
 * Credential-bearing work stays inside the synchronous callback. In formal
 * mode callers normally construct and start the upstream request in `use`,
 * returning a non-thenable holder around the resulting Promise rather than a
 * reusable secret string.
 */
export function withChannelApiKeyForDispatch<T>(
  channel: RelayChannelCredentialInput,
  scope: RelayChannelCredentialDispatchScope,
  use: (apiKey: string) => T,
  fallbackEnvNames: string[] = [],
): T {
  assertProviderDispatchAllowed();
  if (isFormalCandidateCredentialRuntimeDeclared()) {
    const channelId = cleanString(channel.id);
    const provider = cleanString(channel.provider);
    const endpointType = cleanString(channel.endpointType);
    if (
      channelId !== scope.channelId
      || provider !== scope.provider
      || endpointType !== scope.endpointType
      || !cleanString(scope.model)
    ) {
      throw new Error("FORMAL_CANDIDATE_CREDENTIAL_DISPATCH_SCOPE_INVALID");
    }
    return withFormalCandidateCredentialForDispatch({
      channelId,
      provider,
      endpointType,
      model: scope.model,
    }, use);
  }
  return use(resolveChannelApiKey(channel, fallbackEnvNames));
}

export function withPortraitChannelCredentialForDispatch<T>(
  channel: RelayChannelCredentialInput,
  scope: RelayChannelCredentialDispatchScope,
  use: (credentialEnvelope: string) => T,
): T {
  assertProviderDispatchAllowed();
  if (isFormalCandidateCredentialRuntimeDeclared()) {
    const channelId = cleanString(channel.id);
    const provider = cleanString(channel.provider);
    const endpointType = cleanString(channel.endpointType);
    if (
      channelId !== scope.channelId
      || provider !== scope.provider
      || endpointType !== scope.endpointType
      || !cleanString(scope.model)
    ) {
      throw new Error("FORMAL_CANDIDATE_PORTRAIT_CREDENTIAL_DISPATCH_SCOPE_INVALID");
    }
    return withFormalCandidateCredentialForDispatch({
      channelId,
      provider,
      endpointType,
      model: scope.model,
    }, (credential) => {
      if (!parseProviderChannelPortraitCredential(credential)) {
        throw new Error("FORMAL_CANDIDATE_PORTRAIT_CREDENTIAL_INVALID");
      }
      return use(credential);
    });
  }
  return use(resolvePortraitChannelCredential(channel).value);
}

export function resolveChannelBaseUrl(channel: Pick<RelayChannel, "baseUrl" | "config">): string {
  return (cleanString(channel.baseUrl) || cleanString((channel.config as any)?.baseUrl)).replace(/\/$/, "");
}
