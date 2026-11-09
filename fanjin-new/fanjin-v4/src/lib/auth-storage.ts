import type { AuthUser } from "@/types";

const AUTH_KEY = "custom_auth";

export function buildInviteLink(inviteCode?: string) {
  return inviteCode ? `https://morningapi.com/login?inviteCode=${encodeURIComponent(inviteCode)}` : "";
}

export function readAuth(): AuthUser | null {
  const raw = localStorage.getItem(AUTH_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.isLoggedIn || !parsed?.userId) return null;
    return {
      isLoggedIn: true,
      userId: parsed.userId,
      apiKey: parsed.apiKey || "",
      phone: parsed.phone || "",
      points: Number(parsed.points ?? parsed.grains ?? 0),
      grains: Number(parsed.grains ?? parsed.points ?? 0),
      nickname: parsed.nickname || `用户_${String(parsed.phone || "").slice(0, 6)}`,
      avatarUrl: parsed.avatarUrl || "",
      inviteCode: parsed.inviteCode || "",
      inviteLink: buildInviteLink(parsed.inviteCode),
      loginTime: parsed.loginTime || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function writeAuth(user: AuthUser) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(user));
  window.dispatchEvent(new Event("storage"));
}

export function clearAuth() {
  localStorage.removeItem(AUTH_KEY);
  window.dispatchEvent(new Event("storage"));
}

export function authPayload() {
  const auth = readAuth();
  if (!auth) return {};
  return { userId: auth.userId, apiKey: auth.apiKey };
}

export function apiKeyPayload() {
  const auth = readAuth();
  if (!auth?.apiKey) return {};
  return { apiKey: auth.apiKey };
}
