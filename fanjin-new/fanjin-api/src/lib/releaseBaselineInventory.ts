import crypto from "node:crypto";

const CONFIRM_PREFIX = "ESTABLISH_FANJIN_RELEASE_BASELINE";

export interface ReleaseBaselineInventoryDescriptor {
  descriptorVersion: 3;
  channel: string;
  environment: string;
  scope: string;
  workerTopology: "none" | "co-located" | "dedicated";
  clb: {
    region: string;
    listenerId: string;
    serverGroupId: string;
    targets: Array<{ nodeId: string; serverId: string }>;
  };
  publicSmoke: {
    baseUrl: string;
    totalTimeoutMs: number;
    stepTimeoutMs: number;
    canaryUsername: string;
    canaryPasswordFile: string;
    canaryUserId: number;
    canaryWorkspaceId: string;
    agentSseEnabled: boolean;
    canaryThreadId?: string;
    canaryProjectId: number;
  };
  apiSsh: Array<{ nodeId: string; target: string; port: number }>;
  workerTargets: Array<{ nodeId: string; serverId: string }>;
  workerSsh: Array<{ nodeId: string; target: string; port: number }>;
}

function canonicalJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return current;
  };
  return JSON.stringify(normalize(value));
}

function sortedInventoryDescriptor(
  descriptor: ReleaseBaselineInventoryDescriptor,
): ReleaseBaselineInventoryDescriptor {
  const byNodeId = <T extends { nodeId: string }>(items: readonly T[]) => (
    [...items].sort((left, right) => left.nodeId.localeCompare(right.nodeId))
  );
  return {
    ...descriptor,
    clb: { ...descriptor.clb, targets: byNodeId(descriptor.clb.targets) },
    apiSsh: byNodeId(descriptor.apiSsh),
    workerTargets: byNodeId(descriptor.workerTargets),
    workerSsh: byNodeId(descriptor.workerSsh),
  };
}

export function releaseBaselineInventoryDigest(
  descriptor: ReleaseBaselineInventoryDescriptor,
): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(sortedInventoryDescriptor(descriptor)))
    .digest("hex");
}

export function releaseBaselineConfirmation(input: {
  releaseId: string;
  artifactId: string;
  inventoryDigest: string;
}): string {
  return `${CONFIRM_PREFIX}:${input.releaseId}:${input.artifactId}:${input.inventoryDigest}`;
}
