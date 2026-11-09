import type {
  ReleaseArtifactManifestV1,
  ReleaseArtifactRecord,
  ReleaseArtifactStatus,
} from "@/lib/releaseDeployments";

/**
 * Browser-safe release artifact projection. Object-storage coordinates,
 * upload reservations, request hashes and actor provenance remain strictly
 * server-side because the release controller—not the browser—consumes them.
 */
export interface AdminReleaseArtifactDTO {
  id: string;
  releaseId: string;
  fileName: string | null;
  byteSize: number | null;
  sha256: string;
  sourceCommit: string | null;
  manifest: ReleaseArtifactManifestV1;
  status: ReleaseArtifactStatus;
  rejectionReason: string | null;
  verifiedAt: number | null;
  revision: number;
  idempotentReplay?: boolean;
}

export const ADMIN_RELEASE_ARTIFACT_DTO_KEYS = [
  "id",
  "releaseId",
  "fileName",
  "byteSize",
  "sha256",
  "sourceCommit",
  "manifest",
  "status",
  "rejectionReason",
  "verifiedAt",
  "revision",
] as const satisfies readonly (keyof AdminReleaseArtifactDTO)[];

export function serializeAdminReleaseArtifact(
  artifact: ReleaseArtifactRecord,
  options: { idempotentReplay?: boolean } = {},
): AdminReleaseArtifactDTO {
  const dto: AdminReleaseArtifactDTO = {
    id: artifact.id,
    releaseId: artifact.releaseId,
    fileName: artifact.fileName,
    byteSize: artifact.byteSize,
    sha256: artifact.sha256,
    sourceCommit: artifact.sourceCommit,
    manifest: artifact.manifest,
    status: artifact.status,
    rejectionReason: artifact.rejectionReason,
    verifiedAt: artifact.verifiedAt,
    revision: artifact.revision,
  };
  if (options.idempotentReplay !== undefined) {
    dto.idempotentReplay = options.idempotentReplay;
  }
  return dto;
}
