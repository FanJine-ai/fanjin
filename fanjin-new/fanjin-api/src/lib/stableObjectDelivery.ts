import {
  normalizeObjectKey,
} from "@/lib/objectStorage";
import {
  normalizeStableObjectBaseUrl,
  type ObjectStorageConfiguration,
} from "@/lib/objectStorageConfig";

export type StableObjectDeliveryMode = "local" | "cdn";

export interface StableObjectDeliveryEvidence {
  mode: StableObjectDeliveryMode;
  publicUrl: string;
  cdnBaseUrl: string | null;
}

function encodeObjectPath(value: string): string {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function exactUrl(value: unknown): URL | null {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Resolve the only stable URL forms that may be committed as a persistent
 * generated-video delivery:
 *
 * - local storage is canonicalized to the application-owned `/oss/<key>`;
 * - remote storage must be in explicit CDN mode and match the configured CDN,
 *   configured provider prefix, and logical object key byte-for-byte.
 *
 * Provider signed URLs deliberately fail because their query-bound lifetime is
 * shorter than the billing and deletion evidence they would otherwise back.
 */
export function resolveStableObjectDelivery(input: {
  configuration: ObjectStorageConfiguration;
  objectKey: string;
  candidateUrl: unknown;
}): StableObjectDeliveryEvidence | null {
  let objectKey: string;
  try {
    objectKey = normalizeObjectKey(input.objectKey);
  } catch {
    return null;
  }
  const encodedObjectKey = encodeObjectPath(objectKey);
  if (input.configuration.provider === "local") {
    const canonicalPath = `/oss/${encodedObjectKey}`;
    const candidate = String(input.candidateUrl || "").trim();
    if (candidate === canonicalPath) {
      return {
        mode: "local",
        publicUrl: canonicalPath,
        cdnBaseUrl: null,
      };
    }
    const parsed = exactUrl(candidate);
    if (!parsed || parsed.pathname !== canonicalPath) return null;
    return {
      mode: "local",
      publicUrl: canonicalPath,
      cdnBaseUrl: null,
    };
  }

  if (input.configuration.urlMode !== "cdn") return null;
  const cdnBaseUrl = normalizeStableObjectBaseUrl(
    input.configuration.cdnUrl,
  );
  if (!cdnBaseUrl) return null;
  let storedKey: string;
  try {
    storedKey = input.configuration.keyPrefix
      ? `${normalizeObjectKey(input.configuration.keyPrefix)}/${objectKey}`
      : objectKey;
  } catch {
    return null;
  }
  const expected = `${cdnBaseUrl}/${encodeObjectPath(storedKey)}`;
  const candidate = exactUrl(input.candidateUrl);
  if (!candidate || candidate.toString() !== new URL(expected).toString()) {
    return null;
  }
  return {
    mode: "cdn",
    publicUrl: expected,
    cdnBaseUrl,
  };
}

/**
 * Validate immutable v2 evidence without consulting mutable runtime config.
 * The commit path already proved the CDN base against its exact provider
 * configuration; this re-derives the bound path from the hashed base/key.
 */
export function validateStableObjectDeliveryEvidence(input: {
  provider: ObjectStorageConfiguration["provider"];
  keyPrefix: string;
  objectKey: string;
  mode: unknown;
  publicUrl: unknown;
  cdnBaseUrl: unknown;
}): StableObjectDeliveryEvidence | null {
  const configuration: ObjectStorageConfiguration = input.provider === "local"
    ? {
        provider: "local",
        keyPrefix: "oss",
        urlMode: "signed",
        signedUrlTtlSeconds: 1,
        forcePathStyle: true,
        corsOrigins: [],
      }
    : {
        provider: input.provider,
        bucket: "evidence-only",
        region: "evidence-only",
        endpoint: "https://evidence.invalid",
        accessKey: "evidence-only",
        secretKey: "evidence-only",
        keyPrefix: input.keyPrefix,
        urlMode: "cdn",
        cdnUrl: typeof input.cdnBaseUrl === "string"
          ? input.cdnBaseUrl
          : undefined,
        signedUrlTtlSeconds: 1,
        forcePathStyle: true,
        corsOrigins: [],
      };
  const evidence = resolveStableObjectDelivery({
    configuration,
    objectKey: input.objectKey,
    candidateUrl: input.publicUrl,
  });
  if (
    !evidence
    || evidence.mode !== input.mode
    || evidence.cdnBaseUrl !== input.cdnBaseUrl
  ) {
    return null;
  }
  return evidence;
}
