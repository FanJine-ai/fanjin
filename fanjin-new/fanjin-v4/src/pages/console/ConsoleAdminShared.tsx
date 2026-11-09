import { GU_MICROS_PER_GU, formatGuMicros } from "@/utils/billingUnits";
export function unwrapPayload(value: any) {
  return value?.data ?? value ?? {};
}

export function extractItems(value: any): any[] {
  const payload = unwrapPayload(value);
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

export function formatGu(micros?: number | string | null, rounding: "up" | "down" = "up") {
  const value = Number(micros || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 GU";
  return formatGuMicros(micros, 2, rounding);
}

export function formatCny(micros?: number | string | null) {
  const value = Number(micros || 0);
  if (!Number.isFinite(value)) return "¥0.00";
  return `¥${(value / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function guToMicros(value: string) {
  const gu = Number(value);
  if (!Number.isFinite(gu) || gu < 0) return 0;
  return Math.round(gu * GU_MICROS_PER_GU);
}

export function yuanToMicros(value: string) {
  const yuan = Number(value);
  if (!Number.isFinite(yuan) || yuan < 0) return 0;
  return Math.round(yuan * 1_000_000);
}

export function formatDate(value?: number | string | null) {
  if (!value) return "-";
  const d = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value);
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseListText(value: string) {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

export function parseIntegerField(value: string, fallback: number) {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) ? numberValue : fallback;
}

export function redactLogText(value: unknown) {
  let text = "";
  try {
    text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  } catch {
    text = String(value ?? "");
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\b(fj|fnj|fanjin)_[A-Za-z0-9._-]{12,}\b/gi, "$1_[REDACTED]")
    .replace(/("(?:authorization|cookie|token|apiKey|api_key|providerKey|provider_key)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/\b(?:authorization|cookie|token|apiKey|api_key|providerKey|provider_key)=([^;,\s]+)/gi, (match) => `${match.split("=")[0]}=[REDACTED]`);
}

export function dateInputToMillis(value: string) {
  const raw = value.trim();
  if (!raw) return null;
  const time = new Date(`${raw}T23:59:59`).getTime();
  return Number.isFinite(time) ? time : null;
}
