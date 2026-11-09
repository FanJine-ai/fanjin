import type { BadgeTone } from "../../../../ui/console";
import type { RequestLogRecord, RequestLogRow } from "./types";

export function displayRequestLogValue(value: unknown) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

export function formatRequestLogDate(value: unknown) {
  if (!value) return "-";
  const numeric = Number(value);
  const date = new Date(Number.isFinite(numeric) && numeric < 10_000_000_000 ? numeric * 1000 : value as string | number);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

export function formatRequestLogDuration(value: unknown) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) return "-";
  if (duration < 1000) return `${Math.round(duration)} ms`;
  return `${(duration / 1000).toFixed(duration < 10_000 ? 2 : 1)} s`;
}

export function redactRequestLogText(value: unknown) {
  let text = "";
  try {
    text = typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2);
  } catch {
    text = String(value ?? "");
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\b(fj|fnj|fanjin)_[A-Za-z0-9._-]{12,}\b/gi, "$1_[REDACTED]")
    .replace(/("(?:authorization|cookie|token|apiKey|api_key|providerKey|provider_key|secret|password)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/\b(?:authorization|cookie|token|apiKey|api_key|providerKey|provider_key|secret|password)=([^;,\s]+)/gi, (match) => `${match.split("=")[0]}=[REDACTED]`);
}

export function maskRequestLogIp(value: unknown) {
  const ip = displayRequestLogValue(value);
  if (ip === "-") return ip;
  if (ip.includes(":")) return `${ip.split(":").slice(0, 3).join(":")}:…`;
  const segments = ip.split(".");
  return segments.length === 4 ? `${segments[0]}.${segments[1]}.×.×` : "[REDACTED]";
}

function metadataRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function requestLogFailureReason(item: RequestLogRecord) {
  const metadata = metadataRecord(item.metadata);
  const candidate = item.errorMessage
    ?? metadata.errorMessage
    ?? metadata.error
    ?? metadata.message
    ?? metadata.reason
    ?? item.errorCode;
  return candidate === null || candidate === undefined || candidate === "" ? "-" : redactRequestLogText(candidate);
}

export function normalizeRequestLogRow(item: RequestLogRecord, index: number): RequestLogRow {
  const createdAt = Number(item.createdAt || 0);
  const statusCode = Number(item.statusCode || 0);
  const durationMs = Number(item.durationMs || 0);
  return {
    id: String(item.id ?? item.requestId ?? index),
    requestId: displayRequestLogValue(item.requestId),
    time: formatRequestLogDate(item.createdAt),
    timestamp: Number.isFinite(createdAt) ? createdAt : 0,
    method: displayRequestLogValue(item.method),
    path: displayRequestLogValue(item.path),
    statusCode: Number.isFinite(statusCode) ? statusCode : 0,
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    duration: formatRequestLogDuration(item.durationMs),
    workspaceId: displayRequestLogValue(item.workspaceId),
    actorUserId: displayRequestLogValue(item.actorUserId),
    apiKeyPrefix: displayRequestLogValue(item.apiKeyPrefix),
    model: displayRequestLogValue(item.model),
    targetResolution: displayRequestLogValue(item.targetResolution),
    relayTaskId: displayRequestLogValue(item.relayTaskId),
    errorCode: displayRequestLogValue(item.errorCode),
    failureReason: requestLogFailureReason(item),
    ip: maskRequestLogIp(item.ip),
    userAgent: redactRequestLogText(item.userAgent),
    metadata: redactRequestLogText(item.metadata),
  };
}

export function requestLogStatusTone(statusCode: number): BadgeTone {
  if (statusCode >= 200 && statusCode < 300) return "success";
  if (statusCode >= 500) return "danger";
  if (statusCode >= 400) return "warning";
  return "neutral";
}
