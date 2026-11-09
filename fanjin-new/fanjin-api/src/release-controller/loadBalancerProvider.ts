import { VolcengineClbAdapter, type VolcengineClbAdapterOptions } from "@/release-controller/volcengineClb";
import {
  VolcengineAlbAdapter,
  type AlbTargetInput,
  type VolcengineAlbAdapterOptions,
} from "@/release-controller/volcengineAlb";

export type LoadBalancerProvider = "volcengine_clb" | "volcengine_alb";

export class LoadBalancerProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LoadBalancerProviderError";
    this.code = code;
  }
}

/**
 * 0.1.4 通用负载均衡解析（设计文档 §16.1）：
 * - 新前缀 FANJIN_RELEASE_LB_*；旧 FANJIN_RELEASE_CLB_* 只读兼容一个版本。
 * - 新旧同时存在且不一致 → 启动立即失败（fail-closed，防止误用两组配置）。
 * - FANJIN_RELEASE_LB_PROVIDER 缺省时：配置了 LB_ 通用变量或 ALB 实例 ID 时选 ALB，
 *   否则回退 CLB（0.1.3 兼容行为）。
 */
export function resolveLoadBalancerProvider(env: NodeJS.ProcessEnv = process.env): LoadBalancerProvider {
  const declared = String(env.FANJIN_RELEASE_LB_PROVIDER || "").trim().toLowerCase();
  if (declared === "volcengine_alb" || declared === "volcengine_clb") return declared;
  if (declared) {
    throw new LoadBalancerProviderError(
      "LB_PROVIDER_INVALID",
      `FANJIN_RELEASE_LB_PROVIDER must be volcengine_clb or volcengine_alb, got: ${declared}`,
    );
  }
  const hasGeneric = Boolean(
    env.FANJIN_RELEASE_LB_REGION
    || env.FANJIN_RELEASE_LB_ID
    || env.FANJIN_RELEASE_LB_LISTENER_ID
    || env.FANJIN_RELEASE_LB_SERVER_GROUP_ID
    || env.FANJIN_RELEASE_LB_TARGETS,
  );
  if (hasGeneric && env.FANJIN_RELEASE_ALB_LOAD_BALANCER_ID) return "volcengine_alb";
  if (hasGeneric && !env.FANJIN_RELEASE_CLB_LOAD_BALANCER_ID) return "volcengine_alb";
  return "volcengine_clb";
}

type GenericField = "REGION" | "ID" | "LISTENER_ID" | "SERVER_GROUP_ID" | "TARGETS";

const GENERIC_TO_CLB: Readonly<Record<GenericField, string>> = Object.freeze({
  REGION: "FANJIN_RELEASE_CLB_REGION",
  ID: "FANJIN_RELEASE_CLB_LOAD_BALANCER_ID",
  LISTENER_ID: "FANJIN_RELEASE_CLB_LISTENER_ID",
  SERVER_GROUP_ID: "FANJIN_RELEASE_CLB_SERVER_GROUP_ID",
  TARGETS: "FANJIN_RELEASE_CLB_TARGETS",
});

/**
 * 新旧前缀冲突检测：同一字段同时配置且值不同 → 抛错。
 * 值相同视为显式冗余（允许），确保灰度切换期可双写。
 */
export function assertNoGenericClbConflict(env: NodeJS.ProcessEnv = process.env): void {
  for (const genericField of Object.keys(GENERIC_TO_CLB) as GenericField[]) {
    const genericKey = `FANJIN_RELEASE_LB_${genericField}`;
    const genericValue = String(env[genericKey] || "").trim();
    if (!genericValue) continue;
    const legacyKey = GENERIC_TO_CLB[genericField];
    const legacyValue = String(env[legacyKey] || "").trim();
    if (legacyValue && legacyValue !== genericValue) {
      throw new LoadBalancerProviderError(
        "LB_ENV_CONFLICT",
        `${genericKey}=${maskValue(genericValue)} conflicts with ${legacyKey}=${maskValue(legacyValue)}; resolve to a single value before startup`,
      );
    }
  }
}

function maskValue(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export type CreateLoadBalancerFromEnvOptions = {
  /** CLB/ALB 共有：最小健康后端数。 */
  minHealthyBackends?: number;
  /** CLB/ALB 共有：中止信号。 */
  signal?: AbortSignal;
  /** CLB 专用：排空宽限时间。 */
  drainGraceMs?: number;
  /** ALB 专用 transport：测试注入的 fetch 实现。 */
  albFetch?: VolcengineAlbAdapterOptions["fetch"];
  /** CLB 专用：可信维护观察者作为 canary gate。 */
  clbMaintenanceCanaryGate?: VolcengineClbAdapterOptions["maintenanceCanaryGate"];
};

export type CreatedLoadBalancer = {
  provider: LoadBalancerProvider;
  adapter: VolcengineClbAdapter | VolcengineAlbAdapter;
};

/**
 * 从环境变量构造负载均衡适配器（CLB/ALB 由 FANJIN_RELEASE_LB_PROVIDER 决定）。
 * 上层发布状态机只依赖 LoadBalancer 接口，不感知 provider 差异。
 */
export function createLoadBalancerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: CreateLoadBalancerFromEnvOptions = {},
): CreatedLoadBalancer {
  assertNoGenericClbConflict(env);
  const provider = resolveLoadBalancerProvider(env);
  if (provider === "volcengine_alb") {
    const adapter = new VolcengineAlbAdapter({
      env,
      minHealthyBackends: options.minHealthyBackends,
      signal: options.signal,
      fetch: options.albFetch,
    });
    return { provider, adapter };
  }
  const adapter = new VolcengineClbAdapter({
    env,
    minHealthyBackends: options.minHealthyBackends,
    drainGraceMs: options.drainGraceMs,
    signal: options.signal,
    maintenanceCanaryGate: options.clbMaintenanceCanaryGate,
  });
  return { provider, adapter };
}

export type { AlbTargetInput };
