import type { BadgeTone } from "../../../../ui/console";
import type { AuditLogFilters, AuditLogRecord, AuditLogRow } from "./types";

export const emptyAuditLogFilters: AuditLogFilters = {
  keyword: "", action: "", resourceType: "", actorUserId: "", workspaceId: "", startDate: "", endDate: "",
};

export function dateBoundary(value: string, edge: "start" | "end") {
  if (!value) return undefined;
  const suffix = edge === "start" ? "T00:00:00.000" : "T23:59:59.999";
  const timestamp = new Date(`${value}${suffix}`).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function displayValue(value: unknown) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}
export function formatDate(value: unknown) {
  if (!value) return "-";
  const numeric = Number(value);
  const date = new Date(Number.isFinite(numeric) && numeric < 10_000_000_000 ? numeric * 1000 : value as string | number);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

function redactText(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\b(fj|fnj|fanjin)_[A-Za-z0-9._-]{12,}\b/gi, "$1_[REDACTED]")
    .replace(/\b(?:authorization|cookie|token|apiKey|api_key|providerKey|provider_key|accessKey|access_key|privateKey|private_key|clientSecret|client_secret|credential|secret|password|signature)=([^;,\s&]+)/gi, (match) => `${match.split("=")[0]}=[REDACTED]`);
}

export function redactAuditValue(value: unknown, key = ""): unknown {
  if (/authorization|cookie|token|api.?key|provider.?key|access.?key|private.?key|client.?secret|secret|password|credential|signature/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactAuditValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, redactAuditValue(childValue, childKey)]));
  }
  return value;
}

export function normalizeMetadata(value: AuditLogRecord["metadata"]) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return redactAuditValue(value) as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return redactAuditValue(parsed) as Record<string, unknown>;
    } catch { return { value: redactText(value) }; }
  }
  return { value: redactAuditValue(value) };
}

export function maskIp(value: unknown) {
  const ip = displayValue(value);
  if (ip === "-") return ip;
  if (ip.includes("×") || ip.includes("…") || ip === "[REDACTED]") return ip;
  if (ip.includes(":")) return `${ip.split(":").slice(0, 3).join(":")}:…`;
  const segments = ip.split(".");
  return segments.length === 4 ? `${segments[0]}.${segments[1]}.×.×` : "[REDACTED]";
}

export function normalizeAuditLog(item: AuditLogRecord, index: number): AuditLogRow {
  const numeric = Number(item.createdAt || 0);
  const timestamp = Number.isFinite(numeric) && numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  return {
    id: String(item.id || index), source: item,
    action: displayValue(item.action), resourceType: displayValue(item.resourceType), resourceId: displayValue(item.resourceId),
    actorUserId: displayValue(item.actorUserId), actorRole: displayValue(item.actorRole), workspaceId: displayValue(item.workspaceId),
    ip: maskIp(item.ip), userAgent: displayValue(redactAuditValue(item.userAgent)),
    timestamp: Number.isFinite(timestamp) ? timestamp : 0, time: formatDate(item.createdAt), metadata: normalizeMetadata(item.metadata),
  };
}

export function actionTone(action: string): BadgeTone {
  if (/delete|disable|cancel|revoke|reject|reset/i.test(action)) return "danger";
  if (/create|enable|approve|success|grant/i.test(action)) return "success";
  if (/update|adjust|change|refresh/i.test(action)) return "warning";
  return "info";
}

export function safeJson(value: unknown) {
  try { return JSON.stringify(redactAuditValue(value), null, 2); } catch { return String(value); }
}

export function auditDiff(metadata: Record<string, unknown>) {
  const before = metadata.before ?? metadata.previous ?? metadata.from;
  const after = metadata.after ?? metadata.next ?? metadata.to;
  const changes = metadata.changes ?? metadata.diff;
  return { before, after, changes, hasDiff: before !== undefined || after !== undefined || changes !== undefined };
}
