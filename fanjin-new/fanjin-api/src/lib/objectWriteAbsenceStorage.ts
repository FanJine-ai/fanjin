import { createHash } from "node:crypto";
import { HeadObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import type { ObjectStorageConfiguration } from "@/lib/objectStorageConfig";

export interface ObjectWriteAbsenceObservation {
  intentId: string;
  bucket: string;
  key: string;
  startedAt: number;
  completedAt: number;
  pages: Array<{
    requestId: string;
    keyMarker: string | null;
    versionIdMarker: string | null;
    nextKeyMarker: string | null;
    nextVersionIdMarker: string | null;
    isTruncated: boolean;
    exactVersions: number;
    exactDeleteMarkers: number;
    responseSha256: string;
  }>;
  head: { httpStatus: 404; requestId: string };
}

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw Object.assign(new Error(code), { code });
}
function requestId(value: unknown): string {
  check(typeof value === "string" && /^[\x21-\x7e]{1,512}$/u.test(value), "OBJECT_WRITE_ABSENCE_REQUEST_ID_MISSING");
  return value;
}

/** Only LIST and HEAD exist in this adapter. A 403, incomplete page, current
 * object, historical version or delete marker can never become an absence. */
export function createObjectWriteAbsenceStorage(configuration: ObjectStorageConfiguration) {
  check(configuration.provider === "tos" || configuration.provider === "s3", "OBJECT_WRITE_ABSENCE_REMOTE_REQUIRED");
  check(configuration.bucket && configuration.region && configuration.endpoint?.startsWith("https://"), "OBJECT_WRITE_ABSENCE_STORAGE_IDENTITY_INVALID");
  const client = new S3Client({
    region: configuration.region,
    endpoint: configuration.endpoint,
    forcePathStyle: configuration.forcePathStyle,
    maxAttempts: 1,
    credentials: { accessKeyId: configuration.accessKey || "", secretAccessKey: configuration.secretKey || "" },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return {
    async observe(intent: { id: string; objectKey: string }): Promise<ObjectWriteAbsenceObservation> {
      const key = [configuration.keyPrefix, intent.objectKey].filter(Boolean).join("/");
      const bucket = configuration.bucket!;
      const startedAt = Date.now();
      const signal = AbortSignal.timeout(15_000);
      const pages: ObjectWriteAbsenceObservation["pages"] = [];
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      const markers = new Set<string>();
      for (;;) {
        check(pages.length < 10, "OBJECT_WRITE_ABSENCE_PAGE_LIMIT");
        const result = await client.send(new ListObjectVersionsCommand({
          Bucket: bucket, Prefix: key, MaxKeys: 1000,
          ...(keyMarker ? { KeyMarker: keyMarker, VersionIdMarker: versionIdMarker } : {}),
        }), { abortSignal: signal });
        check(result.$metadata.httpStatusCode === 200 && result.Name === bucket && result.Prefix === key, "OBJECT_WRITE_ABSENCE_LIST_IDENTITY_MISMATCH");
        check(typeof result.IsTruncated === "boolean", "OBJECT_WRITE_ABSENCE_LIST_INCOMPLETE");
        const versions = result.Versions || [];
        const deleted = result.DeleteMarkers || [];
        for (const item of [...versions, ...deleted]) {
          check(typeof item.Key === "string" && item.Key.startsWith(key), "OBJECT_WRITE_ABSENCE_PREFIX_ESCAPED");
        }
        const exactVersions = versions.filter((entry) => entry.Key === key).length;
        const exactDeleteMarkers = deleted.filter((entry) => entry.Key === key).length;
        check(exactVersions === 0 && exactDeleteMarkers === 0, "OBJECT_WRITE_ABSENCE_GENERATION_PRESENT");
        pages.push({
          requestId: requestId(result.$metadata.requestId),
          keyMarker: keyMarker ?? null, versionIdMarker: versionIdMarker ?? null,
          nextKeyMarker: result.NextKeyMarker ?? null,
          nextVersionIdMarker: result.NextVersionIdMarker ?? null,
          isTruncated: result.IsTruncated,
          exactVersions, exactDeleteMarkers,
          responseSha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
        });
        if (!result.IsTruncated) break;
        check(typeof result.NextKeyMarker === "string" && result.NextKeyMarker.startsWith(key)
          && typeof result.NextVersionIdMarker === "string" && result.NextVersionIdMarker.length > 0,
        "OBJECT_WRITE_ABSENCE_PAGINATION_INVALID");
        const marker = `${result.NextKeyMarker}\0${result.NextVersionIdMarker}`;
        check(!markers.has(marker), "OBJECT_WRITE_ABSENCE_PAGINATION_LOOP");
        markers.add(marker);
        keyMarker = result.NextKeyMarker;
        versionIdMarker = result.NextVersionIdMarker;
      }
      let head: ObjectWriteAbsenceObservation["head"] | undefined;
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
      } catch (error) {
        const response = error as { name?: string; $metadata?: { httpStatusCode?: number; requestId?: string } };
        check(response.$metadata?.httpStatusCode === 404
          && ["NotFound", "NoSuchKey"].includes(response.name || ""), "OBJECT_WRITE_ABSENCE_HEAD_NOT_PROVEN");
        head = { httpStatus: 404, requestId: requestId(response.$metadata.requestId) };
      }
      check(head, "OBJECT_WRITE_ABSENCE_CURRENT_OBJECT_PRESENT");
      return { intentId: intent.id, bucket, key, startedAt, completedAt: Date.now(), pages, head };
    },
    destroy: () => client.destroy(),
  };
}
