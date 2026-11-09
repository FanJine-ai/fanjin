import type { ReleaseSchemaCompatibilityBridgeV1 } from "@/lib/releaseSchemaCompatibility";
import type { ExpectedCurrentRelease } from "./sshNodeAgent";
import type { ReleaseArtifact, ReleaseCheckpoint } from "./types";

/**
 * Resolve the exact identity an SSH Node Agent may treat as current while the
 * one-shot baseline rollout is resuming.
 *
 * API activation has an intentionally ambiguous response-loss window between
 * persisting activationAttempted and persisting activated. Returning null in
 * only that window lets preflight record the exact old-or-target observation;
 * the subsequent activate call still performs the remote CAS. Worker activate
 * has a separate previous-pointer proof, so it must always retain the old
 * identity as its CAS and rollback anchor.
 */
export function expectedBaselineRolloutCurrent(input: {
  checkpoint: ReleaseCheckpoint | null;
  nodeId: string;
  role: "api" | "worker";
  previousArtifact: ReleaseArtifact;
  targetReleaseId: string;
  targetArtifact: ReleaseArtifact;
  schemaCompatibility: ReleaseSchemaCompatibilityBridgeV1 | null;
}): ExpectedCurrentRelease | null {
  const previous: ExpectedCurrentRelease = {
    releaseId: input.previousArtifact.version,
    artifactSha256: input.previousArtifact.sha256,
    schemaCompatibility: input.schemaCompatibility,
  };
  if (input.role === "worker") return previous;

  const node = input.checkpoint?.nodes[input.nodeId];
  if (
    node
    && node.activationAttempted
    && !node.activated
    && !node.completed
    && !node.rolledBack
  ) {
    return null;
  }
  if (
    node
    && !node.rolledBack
    && (node.activated || node.completed)
  ) {
    return {
      releaseId: input.targetReleaseId,
      artifactSha256: input.targetArtifact.sha256,
      schemaCompatibility: null,
    };
  }
  return previous;
}
