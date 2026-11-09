import type { ProviderHealthRecord } from "./types";

export function normalizedProviderStatus(provider: ProviderHealthRecord) {
  if (provider.disabled) return "disabled";
  return String(provider.healthStatus || provider.health?.status || "unknown").trim().toLowerCase();
}

export function providerTone(status: string) {
  // Match complete statuses: "unhealthy" must never match "healthy".
  if (/^(error|failed|down|unhealthy)$/.test(status)) return "danger" as const;
  if (/^(ok|healthy|success|online)$/.test(status)) return "success" as const;
  if (/^(checking|pending|degraded|warning)$/.test(status)) return "warning" as const;
  return "neutral" as const;
}

export function providerStatusLabel(status: string) {
  if (status === "disabled") return "已停用";
  if (providerTone(status) === "danger") return "异常";
  if (providerTone(status) === "success") return "健康";
  if (/^(checking|pending)$/.test(status)) return "检查中";
  if (/^(degraded|warning)$/.test(status)) return "性能下降";
  return "未检查";
}

export function summarizeProviderHealth(providers: ProviderHealthRecord[], unavailable = false) {
  const enabled = providers.filter((provider) => !provider.disabled);
  const statuses = enabled.map(normalizedProviderStatus);
  const failed = statuses.filter((status) => providerTone(status) === "danger").length;
  const degraded = statuses.filter((status) => /^(degraded|warning)$/.test(status)).length;
  const healthy = statuses.filter((status) => providerTone(status) === "success").length;
  const unknown = enabled.length - failed - degraded - healthy;
  const attention = failed + degraded;
  const tone = unavailable ? "warning" : failed ? "danger" : degraded || unknown ? "warning" : "neutral";
  const label = unavailable ? "通道状态暂不可用"
    : attention ? `${attention} 个通道需要关注`
      : unknown ? `${unknown} 个通道待确认`
        : enabled.length ? "已检查通道运行正常" : "尚无启用通道";
  return { enabled: enabled.length, failed, degraded, healthy, unknown, attention, tone, label };
}
