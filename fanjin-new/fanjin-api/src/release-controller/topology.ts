export type SupportedReleaseWorkerTopology = "none" | "co-located" | "dedicated";

export class ReleaseControllerTopologyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReleaseControllerTopologyError";
    this.code = code;
  }
}

function normalizedNodeIds(values: readonly string[], label: string): string[] {
  if (values.length < 2) {
    throw new ReleaseControllerTopologyError(
      "RELEASE_TOPOLOGY_INSUFFICIENT_API_NODES",
      `${label} must contain at least two API nodes`,
    );
  }
  const normalized = values.map((value) => String(value).trim());
  if (normalized.some((value) => !value) || new Set(normalized).size !== normalized.length) {
    throw new ReleaseControllerTopologyError(
      "RELEASE_TOPOLOGY_DUPLICATE_NODE",
      `${label} contains an empty or duplicate node id`,
    );
  }
  return normalized.sort();
}

export function assertReleaseControllerTopology(input: {
  clbNodeIds: readonly string[];
  sshNodeIds: readonly string[];
  workerTopology: string | undefined;
  workerSshNodeIds?: readonly string[];
  workerControlNodeIds?: readonly string[];
  workerDatabaseControlConfigured?: boolean;
}): SupportedReleaseWorkerTopology {
  const clbNodeIds = normalizedNodeIds(input.clbNodeIds, "CLB inventory");
  const sshNodeIds = normalizedNodeIds(input.sshNodeIds, "SSH inventory");
  if (
    clbNodeIds.length !== sshNodeIds.length
    || clbNodeIds.some((nodeId, index) => nodeId !== sshNodeIds[index])
  ) {
    throw new ReleaseControllerTopologyError(
      "RELEASE_TOPOLOGY_NODE_SET_MISMATCH",
      "CLB and SSH inventories must contain exactly the same API node ids",
    );
  }

  const workerTopology = String(input.workerTopology || "").trim().toLowerCase();
  if (workerTopology === "dedicated") {
    const workerSshNodeIds = normalizedNodeIds(input.workerSshNodeIds || [], "Worker SSH inventory");
    const workerControlNodeIds = normalizedNodeIds(
      input.workerControlNodeIds || [],
      "Worker DB control inventory",
    );
    if (!input.workerDatabaseControlConfigured) {
      throw new ReleaseControllerTopologyError(
        "RELEASE_WORKER_DB_CONTROL_MISSING",
        "dedicated Worker topology requires the database drain control plane",
      );
    }
    if (workerSshNodeIds.some((nodeId) => clbNodeIds.includes(nodeId))) {
      throw new ReleaseControllerTopologyError(
        "RELEASE_TOPOLOGY_NODE_ROLE_CONFLICT",
        "API and dedicated Worker node ids must be disjoint",
      );
    }
    if (workerSshNodeIds.length !== workerControlNodeIds.length
      || workerSshNodeIds.some((nodeId, index) => nodeId !== workerControlNodeIds[index])) {
      throw new ReleaseControllerTopologyError(
        "RELEASE_WORKER_TOPOLOGY_NODE_SET_MISMATCH",
        "Worker SSH and DB control inventories must contain exactly the same nodes",
      );
    }
    return "dedicated";
  }
  if (workerTopology !== "none" && workerTopology !== "co-located") {
    throw new ReleaseControllerTopologyError(
      "RELEASE_WORKER_TOPOLOGY_UNCONFIRMED",
      "FANJIN_RELEASE_WORKER_TOPOLOGY must explicitly be none or co-located",
    );
  }
  return workerTopology;
}
