export function redactSensitiveText(value?: unknown): string {
  const text = String(value || "");
  if (!text) return "";
  return text
    .replace(/fanjin_[A-Za-z0-9_-]+(?:_[A-Za-z0-9_-]+)?/g, "fanjin_[REDACTED]")
    .replace(/(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{12,}/g, "$1sk-[REDACTED]")
    .replace(/ark-[A-Za-z0-9-]{12,}/g, "ark-[REDACTED]")
    .replace(/AKLT[A-Za-z0-9%/_+-]{12,}/g, "AKLT[REDACTED]")
    .replace(/(Authorization['"]?\s*[:=]\s*['"]?Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
    .replace(/(^|[^A-Za-z0-9])(authorization['"]?\s*[:=]\s*['"]?)(?!Bearer\s+\[REDACTED\])[^'"\s,}]+/gi, "$1$2[REDACTED]")
    .replace(/(^|[^A-Za-z0-9])((?:cookie|token|password|secret|credential|signature|api[-_]?key|access[-_]?key|refresh[-_]?token|session)['"]?\s*[:=]\s*['"]?)[^'"\s,}]+/gi, "$1$2[REDACTED]");
}
