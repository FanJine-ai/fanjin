import {
  openProviderChannelCredential,
  readProviderChannelCredentialCiphertext,
  TOKENHEX_PORTRAIT_CREDENTIAL_VERSION,
  TOKENHEX_PORTRAIT_ORIGIN,
  withProviderChannelPortraitCredential,
} from "./providerChannelCredentials";

/** This protocol is explicitly configured; arbitrary gateways never receive a copied key. */
export function isTokenhexPortraitOrigin(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string") return false;
  try {
    const url = new URL(baseUrl);
    return url.origin === TOKENHEX_PORTRAIT_ORIGIN && url.pathname === "/"
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function configureTokenhexPortraitCredential(input: {
  id: string;
  provider: string;
  endpointType: string;
  baseUrl: unknown;
  config: Record<string, unknown>;
}): Record<string, unknown> {
  if (input.provider !== "volcano" || input.endpointType !== "video_generation"
    || !isTokenhexPortraitOrigin(input.baseUrl)) {
    throw new Error("Tokenhex 人像资产仅支持 https://api.tokenhex.com 的 Volcano 视频通道");
  }
  const bearerToken = openProviderChannelCredential(
    input.id, readProviderChannelCredentialCiphertext(input.config),
  );
  if (!bearerToken) throw new Error("请先在该通道加密保存有效的 Tokenhex API Key");
  return withProviderChannelPortraitCredential(input.id, input.config, {
    version: TOKENHEX_PORTRAIT_CREDENTIAL_VERSION,
    bearerToken,
  });
}
