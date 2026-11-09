const OBJECT_STORAGE_PROVIDER_ENV_NAMES = [
  "FANJIN_OBJECT_STORAGE_PROVIDER",
  "FANJIN_OBJECT_STORAGE_DRIVER",
] as const;

const REMOTE_OBJECT_STORAGE_ENV_NAMES = [
  "FANJIN_OBJECT_STORAGE_BUCKET",
  "FANJIN_OBJECT_STORAGE_REGION",
  "FANJIN_OBJECT_STORAGE_ENDPOINT",
  "FANJIN_OBJECT_STORAGE_CDN_URL",
  "FANJIN_OBJECT_STORAGE_ACCESS_KEY",
  "FANJIN_OBJECT_STORAGE_SECRET_KEY",
  "FANJIN_OBJECT_STORAGE_CORS_ORIGINS",
] as const;

const REQUIRED_REMOTE_ENV_NAMES = [
  "FANJIN_OBJECT_STORAGE_BUCKET",
  "FANJIN_OBJECT_STORAGE_REGION",
  "FANJIN_OBJECT_STORAGE_ENDPOINT",
  "FANJIN_OBJECT_STORAGE_ACCESS_KEY",
  "FANJIN_OBJECT_STORAGE_SECRET_KEY",
  "FANJIN_OBJECT_STORAGE_CORS_ORIGINS",
] as const;

type ObjectStorageEnvironment = Record<string, string | undefined>;
export type ObjectStorageProvider = "local" | "s3" | "tos";
export type ObjectStorageUrlMode = "signed" | "cdn";

export interface ObjectStorageConfiguration {
  provider: ObjectStorageProvider;
  bucket?: string;
  region?: string;
  endpoint?: string;
  accessKey?: string;
  secretKey?: string;
  keyPrefix: string;
  urlMode: ObjectStorageUrlMode;
  cdnUrl?: string;
  signedUrlTtlSeconds: number;
  forcePathStyle: boolean;
  corsOrigins: string[];
}

export interface ObjectStorageConfigurationInspection {
  supported: boolean;
  effectiveProvider: string;
  configuredProviderVariables: string[];
  unsupportedVariables: string[];
  missingVariables: string[];
  invalidVariables: string[];
  urlMode: string;
  corsConfigured: boolean;
  cdnConfigured: boolean;
  cdnBaseUrl: string | null;
}

function configuredValue(environment: ObjectStorageEnvironment, name: string): string {
  return String(environment[name] || "").trim();
}

function normalizeProvider(raw: string): string {
  const provider = raw.toLowerCase();
  if (["s3-compatible", "s3_compatible", "s3compatible"].includes(provider)) return "s3";
  if (["volcengine-tos", "volcengine_tos", "volcano-tos"].includes(provider)) return "tos";
  return provider || "local";
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isCorsOrigin(value: string, environment: ObjectStorageEnvironment): boolean {
  if (isHttpsUrl(value)) return true;
  if (!["development", "dev", "test"].includes(environment.NODE_ENV || "")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  } catch {
    return false;
  }
}

export function normalizeStableObjectBaseUrl(
  value: unknown,
): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      return null;
    }
    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/gu, "")
      .replace(/\.+$/u, "");
    const mappedIpv4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu
      .exec(hostname);
    const mappedIpv4High = mappedIpv4
      ? Number.parseInt(mappedIpv4[1], 16)
      : null;
    const mappedIpv4Low = mappedIpv4
      ? Number.parseInt(mappedIpv4[2], 16)
      : null;
    if (
      hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname === "0.0.0.0"
      || hostname.startsWith("127.")
      || hostname === "::"
      || hostname === "::1"
      || (
        mappedIpv4High !== null
        && mappedIpv4Low !== null
        && (
          mappedIpv4High >>> 8 === 127
          || mappedIpv4High === 0 && mappedIpv4Low === 0
        )
      )
    ) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return null;
  }
}

function parsePositiveInteger(raw: string, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : Number.NaN;
}

export function inspectObjectStorageConfiguration(
  environment: ObjectStorageEnvironment = process.env,
): ObjectStorageConfigurationInspection {
  const providers = OBJECT_STORAGE_PROVIDER_ENV_NAMES.flatMap((name) => {
    const value = configuredValue(environment, name);
    return value ? [{ name, value: normalizeProvider(value) }] : [];
  });
  const effectiveProvider = providers[0]?.value || "local";
  const configuredProviderVariables = providers.map(({ name }) => name);
  const unsupportedVariables: string[] = [];
  const missingVariables: string[] = [];
  const invalidVariables: string[] = [];
  const remoteVariables = REMOTE_OBJECT_STORAGE_ENV_NAMES.filter((name) =>
    Boolean(configuredValue(environment, name)),
  );
  const urlMode = configuredValue(environment, "FANJIN_OBJECT_STORAGE_URL_MODE").toLowerCase() || "signed";

  if (providers.length > 1 && providers.some(({ value }) => value !== effectiveProvider)) {
    invalidVariables.push(...OBJECT_STORAGE_PROVIDER_ENV_NAMES);
  }
  if (!["local", "s3", "tos"].includes(effectiveProvider)) {
    invalidVariables.push(providers[0]?.name || "FANJIN_OBJECT_STORAGE_PROVIDER");
  } else if (effectiveProvider === "local") {
    unsupportedVariables.push(...remoteVariables);
  } else {
    for (const name of REQUIRED_REMOTE_ENV_NAMES) {
      if (!configuredValue(environment, name)) missingVariables.push(name);
    }
    const endpoint = configuredValue(environment, "FANJIN_OBJECT_STORAGE_ENDPOINT");
    if (endpoint && !isHttpsUrl(endpoint)) invalidVariables.push("FANJIN_OBJECT_STORAGE_ENDPOINT");
    const bucket = configuredValue(environment, "FANJIN_OBJECT_STORAGE_BUCKET");
    if (bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i.test(bucket)) {
      invalidVariables.push("FANJIN_OBJECT_STORAGE_BUCKET");
    }
    const region = configuredValue(environment, "FANJIN_OBJECT_STORAGE_REGION");
    if (region && !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(region)) {
      invalidVariables.push("FANJIN_OBJECT_STORAGE_REGION");
    }
    const corsOrigins = configuredValue(environment, "FANJIN_OBJECT_STORAGE_CORS_ORIGINS")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (corsOrigins.length && corsOrigins.some((origin) => !isCorsOrigin(origin, environment))) {
      invalidVariables.push("FANJIN_OBJECT_STORAGE_CORS_ORIGINS");
    }
    const keyPrefix = configuredValue(environment, "FANJIN_OBJECT_STORAGE_KEY_PREFIX");
    if (keyPrefix && (keyPrefix.includes("\\") || keyPrefix.split("/").some((part) => !part || part === "." || part === ".."))) {
      invalidVariables.push("FANJIN_OBJECT_STORAGE_KEY_PREFIX");
    }
    const forcePathStyle = configuredValue(environment, "FANJIN_OBJECT_STORAGE_FORCE_PATH_STYLE");
    if (forcePathStyle && !["0", "1"].includes(forcePathStyle)) {
      invalidVariables.push("FANJIN_OBJECT_STORAGE_FORCE_PATH_STYLE");
    }
    if (!["signed", "cdn"].includes(urlMode)) invalidVariables.push("FANJIN_OBJECT_STORAGE_URL_MODE");
    const ttl = parsePositiveInteger(
      configuredValue(environment, "FANJIN_OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS"),
      900,
    );
    if (!Number.isFinite(ttl) || ttl > 604_800) {
      invalidVariables.push("FANJIN_OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS");
    }
    if (urlMode === "cdn") {
      const cdnUrl = configuredValue(environment, "FANJIN_OBJECT_STORAGE_CDN_URL");
      if (!cdnUrl) missingVariables.push("FANJIN_OBJECT_STORAGE_CDN_URL");
      else if (!normalizeStableObjectBaseUrl(cdnUrl)) {
        invalidVariables.push("FANJIN_OBJECT_STORAGE_CDN_URL");
      }
    }
  }

  const cdnBaseUrl = normalizeStableObjectBaseUrl(
    configuredValue(environment, "FANJIN_OBJECT_STORAGE_CDN_URL"),
  );
  return {
    supported: unsupportedVariables.length === 0 && missingVariables.length === 0 && invalidVariables.length === 0,
    effectiveProvider,
    configuredProviderVariables,
    unsupportedVariables: [...new Set(unsupportedVariables)],
    missingVariables: [...new Set(missingVariables)],
    invalidVariables: [...new Set(invalidVariables)],
    urlMode,
    corsConfigured: Boolean(configuredValue(environment, "FANJIN_OBJECT_STORAGE_CORS_ORIGINS")),
    cdnConfigured: Boolean(cdnBaseUrl),
    cdnBaseUrl,
  };
}

export function resolveObjectStorageConfiguration(
  environment: ObjectStorageEnvironment = process.env,
): ObjectStorageConfiguration {
  assertSupportedObjectStorageConfiguration(environment);
  const inspection = inspectObjectStorageConfiguration(environment);
  const ttl = parsePositiveInteger(
    configuredValue(environment, "FANJIN_OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS"),
    900,
  );
  return {
    provider: inspection.effectiveProvider as ObjectStorageProvider,
    bucket: configuredValue(environment, "FANJIN_OBJECT_STORAGE_BUCKET") || undefined,
    region: configuredValue(environment, "FANJIN_OBJECT_STORAGE_REGION") || undefined,
    endpoint: configuredValue(environment, "FANJIN_OBJECT_STORAGE_ENDPOINT").replace(/\/+$/, "") || undefined,
    accessKey: configuredValue(environment, "FANJIN_OBJECT_STORAGE_ACCESS_KEY") || undefined,
    secretKey: configuredValue(environment, "FANJIN_OBJECT_STORAGE_SECRET_KEY") || undefined,
    keyPrefix: configuredValue(environment, "FANJIN_OBJECT_STORAGE_KEY_PREFIX").replace(/^\/+|\/+$/g, "") || "oss",
    urlMode: inspection.urlMode as ObjectStorageUrlMode,
    cdnUrl: inspection.cdnBaseUrl || undefined,
    signedUrlTtlSeconds: ttl,
    forcePathStyle: configuredValue(environment, "FANJIN_OBJECT_STORAGE_FORCE_PATH_STYLE") !== "0",
    corsOrigins: configuredValue(environment, "FANJIN_OBJECT_STORAGE_CORS_ORIGINS")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

export function assertSupportedObjectStorageConfiguration(
  environment: ObjectStorageEnvironment = process.env,
): void {
  const inspection = inspectObjectStorageConfiguration(environment);
  if (inspection.supported) return;
  const variableNames = [
    ...inspection.unsupportedVariables,
    ...inspection.missingVariables,
    ...inspection.invalidVariables,
  ];
  throw new Error(
    `OBJECT_STORAGE_CONFIGURATION_INVALID: 对象存储配置不完整或不受支持（${[...new Set(variableNames)].join(", ")}）`,
  );
}
