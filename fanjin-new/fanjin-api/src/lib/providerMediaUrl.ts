export interface ProviderMediaUrlOptions {
  publicBaseUrl?: string;
}

function configuredPublicBaseUrl(): string {
  const raw = String(process.env.FANJIN_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || process.env.ossURL || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if ((url.protocol === "http:" || url.protocol === "https:") && !isLocalHostname(url.hostname)) {
      return raw;
    }
  } catch {
    return "";
  }
  return "";
}

function isLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "127.0.0.1" || lower === "::1" || lower === "0.0.0.0";
}

function pathFromInput(inputUrl: string): string {
  try {
    const url = new URL(inputUrl);
    if ((url.protocol === "http:" || url.protocol === "https:") && !isLocalHostname(url.hostname)) {
      return "";
    }
    return `${url.pathname}${url.search || ""}`;
  } catch {
    return inputUrl;
  }
}

function joinPublicBase(baseUrl: string, mediaPath: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = mediaPath.startsWith("/") ? mediaPath : `/${mediaPath}`;
  return `${normalizedBase}${normalizedPath}`;
}

export function toProviderMediaUrl(inputUrl: string, options: ProviderMediaUrlOptions = {}): string {
  const raw = String(inputUrl || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    if ((url.protocol === "http:" || url.protocol === "https:") && !isLocalHostname(url.hostname)) {
      return raw;
    }
  } catch {
    // Relative paths are handled below.
  }

  const publicBaseUrl = String(options.publicBaseUrl ?? configuredPublicBaseUrl()).trim();
  if (!publicBaseUrl) {
    throw new Error("参考素材需要配置可公网访问的 FANJIN_PUBLIC_BASE_URL、PUBLIC_BASE_URL 或 ossURL，或在本地转换为 data URL，否则火山 Seedance 无法读取引用。");
  }

  const path = pathFromInput(raw).replace(/^\/+/, "");
  const mediaPath = path.startsWith("oss/") || path.startsWith("smallImage/") ? `/${path}` : `/oss/${path}`;
  return joinPublicBase(publicBaseUrl, mediaPath);
}
