export interface PasswordResetEnvironment {
  [key: string]: string | undefined;
}

function envValue(environment: PasswordResetEnvironment, name: string): string {
  return String(environment[name] || "").trim();
}

export function resolvePasswordResetPublicBaseUrl(
  environment: PasswordResetEnvironment = process.env,
): string | null {
  const value = envValue(environment, "FANJIN_APP_PUBLIC_URL")
    || envValue(environment, "FANJIN_PUBLIC_BASE_URL");
  if (!value) return null;
  const normalized = value.replace(/\/+$/, "");
  try {
    const url = new URL(normalized);
    const production = envValue(environment, "NODE_ENV").toLowerCase() === "prod";
    if (!/^https?:$/.test(url.protocol) || (production && url.protocol !== "https:")) return null;
    return normalized;
  } catch {
    return null;
  }
}

/**
 * Password reset / verification delivery now uses Admin SMTP settings
 * (`platform.notification.smtp*`). Resend/Webhook env vars are no longer read.
 * This helper only reports whether a public base URL is available for link building.
 */
export function inspectPasswordResetDeliveryConfiguration(
  environment: PasswordResetEnvironment = process.env,
): { publicBaseUrl: string | null; configured: boolean; kind: "smtp" | null } {
  const publicBaseUrl = resolvePasswordResetPublicBaseUrl(environment);
  return {
    publicBaseUrl,
    configured: Boolean(publicBaseUrl),
    kind: publicBaseUrl ? "smtp" : null,
  };
}
