export interface TrustedReleaseTarget {
  key: string;
  label: string;
  role: "api" | "worker";
  serverId: string;
  zone?: string;
  wave: number;
}

export class ReleaseTargetInventoryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ReleaseTargetInventoryError";
    this.status = status;
    this.code = code;
  }
}

const SAFE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TARGETS = 500;

function inventoryError(message: string, code: string, status = 503): never {
  throw new ReleaseTargetInventoryError(message, status, code);
}

function nonEmptyText(value: unknown, label: string, maximum: number): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    inventoryError(`${label} 格式无效`, "RELEASE_DEPLOYMENT_INPUT_INVALID", 400);
  }
  return normalized;
}

function safeKey(value: unknown, label: string): string {
  const normalized = nonEmptyText(value, label, 128);
  if (!SAFE_KEY_PATTERN.test(normalized)) {
    inventoryError(`${label} 格式无效`, "RELEASE_DEPLOYMENT_INPUT_INVALID", 400);
  }
  return normalized;
}

export function resolveTrustedApiTargetInventory(
  env: Record<string, string | undefined> = process.env,
): TrustedReleaseTarget[] {
  const raw = String(env.FANJIN_RELEASE_CLB_TARGETS || "").trim();
  if (!raw) {
    inventoryError(
      "服务器尚未配置滚动发布目标",
      "RELEASE_DEPLOYMENT_TARGET_INVENTORY_MISSING",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    inventoryError(
      "服务器滚动发布目标配置无效",
      "RELEASE_DEPLOYMENT_TARGET_INVENTORY_INVALID",
    );
  }
  const entries: Array<Record<string, unknown>> = Array.isArray(parsed)
    ? parsed.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        inventoryError(
          "服务器滚动发布目标配置无效",
          "RELEASE_DEPLOYMENT_TARGET_INVENTORY_INVALID",
        );
      }
      return entry as Record<string, unknown>;
    })
    : parsed && typeof parsed === "object"
      ? Object.entries(parsed as Record<string, unknown>)
        .map(([nodeId, serverId]) => ({ nodeId, serverId }))
      : [];
  if (entries.length < 2 || entries.length > MAX_TARGETS) {
    inventoryError(
      "无感滚动发布至少需要两个受信 API 节点",
      "RELEASE_DEPLOYMENT_TARGET_INVENTORY_UNSAFE",
    );
  }
  const seenNodes = new Set<string>();
  const seenServers = new Set<string>();
  return entries.map((entry, index) => {
    const key = safeKey(entry.nodeId, `FANJIN_RELEASE_CLB_TARGETS[${index}].nodeId`);
    const serverId = safeKey(entry.serverId, `FANJIN_RELEASE_CLB_TARGETS[${index}].serverId`);
    if (seenNodes.has(key) || seenServers.has(serverId)) {
      inventoryError(
        "服务器滚动发布目标存在重复节点",
        "RELEASE_DEPLOYMENT_TARGET_INVENTORY_INVALID",
      );
    }
    seenNodes.add(key);
    seenServers.add(serverId);
    const label = entry.label == null ? key : nonEmptyText(entry.label, "target label", 160);
    const zone = entry.zone == null || String(entry.zone).trim() === ""
      ? undefined
      : nonEmptyText(entry.zone, "target zone", 128);
    return { key, label, role: "api" as const, serverId, ...(zone ? { zone } : {}), wave: index + 1 };
  });
}

export function resolveTrustedWorkerTargetInventory(
  env: Record<string, string | undefined> = process.env,
): TrustedReleaseTarget[] {
  const topology = String(env.FANJIN_RELEASE_WORKER_TOPOLOGY || "").trim().toLowerCase();
  if (topology === "none" || topology === "co-located") return [];
  if (topology !== "dedicated") {
    inventoryError(
      "服务器尚未确认 Worker 发布拓扑",
      "RELEASE_WORKER_TOPOLOGY_UNCONFIRMED",
    );
  }
  const raw = String(env.FANJIN_RELEASE_WORKER_TARGETS || "").trim();
  if (!raw) {
    inventoryError(
      "独立 Worker 发布清单尚未配置",
      "RELEASE_WORKER_TARGET_INVENTORY_MISSING",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    inventoryError("独立 Worker 发布清单无效", "RELEASE_WORKER_TARGET_INVENTORY_INVALID");
  }
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > MAX_TARGETS) {
    inventoryError(
      "无感滚动发布至少需要两个独立 Worker 节点",
      "RELEASE_WORKER_TARGET_INVENTORY_UNSAFE",
    );
  }
  const seenNodes = new Set<string>();
  const seenServers = new Set<string>();
  return parsed.map((rawEntry, index) => {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      inventoryError("独立 Worker 发布清单无效", "RELEASE_WORKER_TARGET_INVENTORY_INVALID");
    }
    const entry = rawEntry as Record<string, unknown>;
    const key = safeKey(entry.nodeId, `FANJIN_RELEASE_WORKER_TARGETS[${index}].nodeId`);
    const serverId = safeKey(entry.serverId, `FANJIN_RELEASE_WORKER_TARGETS[${index}].serverId`);
    if (seenNodes.has(key) || seenServers.has(serverId)) {
      inventoryError(
        "独立 Worker 发布清单存在重复节点",
        "RELEASE_WORKER_TARGET_INVENTORY_INVALID",
      );
    }
    seenNodes.add(key);
    seenServers.add(serverId);
    const label = entry.label == null ? key : nonEmptyText(entry.label, "worker target label", 160);
    const zone = entry.zone == null || String(entry.zone).trim() === ""
      ? undefined
      : nonEmptyText(entry.zone, "worker target zone", 128);
    return { key, label, role: "worker" as const, serverId, ...(zone ? { zone } : {}), wave: index + 1 };
  });
}
