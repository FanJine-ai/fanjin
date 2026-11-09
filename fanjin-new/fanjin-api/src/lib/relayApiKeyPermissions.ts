export const RELAY_API_KEY_PERMISSIONS = [
  "usage:read", "usage:read:workspace", "account:read",
  "relay:text",
  "relay:image_generation",
  "relay:video_generation",
  "relay:portrait_assets:read",
  "relay:portrait_assets:write",
  "relay:portrait_assets:liveness",
  "mcp:connect", "project:read", "project:create", "project:write", "model:read", "billing:read",
  "asset:read", "asset:write", "asset:download", "generation:quote", "generation:create", "generation:read",
  "project:delete", "workflow:execute", "workspace:write", "member:read", "member:write", "billing:request:create", "account:write",
] as const;

export type RelayApiKeyPermission =
  (typeof RELAY_API_KEY_PERMISSIONS)[number];

/**
 * Preserve the 0.1.4 omitted-permissions behavior. New capabilities must be
 * added to the allowlist above without becoming ambient grants for new keys.
 */
export const DEFAULT_RELAY_API_KEY_PERMISSIONS = [
  "relay:video_generation",
] as const satisfies readonly RelayApiKeyPermission[];

const RELAY_API_KEY_PERMISSION_SET = new Set<string>(
  RELAY_API_KEY_PERMISSIONS,
);

export function isRelayApiKeyPermission(
  value: unknown,
): value is RelayApiKeyPermission {
  return (
    typeof value === "string"
    && RELAY_API_KEY_PERMISSION_SET.has(value)
  );
}

export function normalizeRelayApiKeyPermissions(
  permissions: readonly RelayApiKeyPermission[],
): RelayApiKeyPermission[] {
  const requested = new Set<RelayApiKeyPermission>(permissions);
  return RELAY_API_KEY_PERMISSIONS.filter((permission) => (
    requested.has(permission)
  ));
}

export function parseStoredRelayApiKeyPermissions(
  raw: unknown,
): RelayApiKeyPermission[] | null {
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed)
    || parsed.some((permission) => !isRelayApiKeyPermission(permission))
  ) {
    return null;
  }
  return normalizeRelayApiKeyPermissions(parsed);
}

export function hasRelayApiKeyPermission(
  permissions: readonly RelayApiKeyPermission[],
  required: unknown,
): boolean {
  return (
    isRelayApiKeyPermission(required)
    && permissions.includes(required)
  );
}
