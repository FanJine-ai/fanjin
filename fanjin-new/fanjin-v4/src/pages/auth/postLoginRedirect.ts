export const DEFAULT_POST_LOGIN_REDIRECT = "/workbench/create";

export function isWorkspaceInvitationRedirect(value: string) {
  if (!value.startsWith("/auth/register")) return false;

  const [pathname, search = ""] = value.split("?", 2);
  if (pathname !== "/auth/register") return false;
  return Boolean(new URLSearchParams(search).get("invite")?.trim());
}

export function resolvePostLoginRedirect(value: string | null) {
  const raw = String(value || "").trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f]/.test(raw)) return DEFAULT_POST_LOGIN_REDIRECT;
  const pathname = raw.split(/[?#]/, 1)[0];
  if (isWorkspaceInvitationRedirect(raw)) return raw;
  if (raw.startsWith("/auth/tenant-transfer?")) return raw;
  if (pathname === "/login" || pathname.startsWith("/auth/")) return DEFAULT_POST_LOGIN_REDIRECT;
  return raw;
}
