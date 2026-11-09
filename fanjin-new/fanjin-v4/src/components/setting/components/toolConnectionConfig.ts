export const TOOL_READ_PERMISSIONS = ["mcp:connect", "project:read", "model:read", "billing:read", "asset:read", "generation:read"];
export const TOOL_CREATE_PERMISSIONS = [...TOOL_READ_PERMISSIONS, "project:create", "project:write", "asset:write", "asset:download", "generation:quote", "generation:create"];
export type ToolPermissionPreset = "read" | "create";

const TOOL_PERMISSION_SET = new Set(TOOL_CREATE_PERMISSIONS);

/** Changing an MCP preset must not silently revoke an existing API relay grant. */
export function applyToolPermissionPreset(permissions: readonly string[], preset: ToolPermissionPreset): string[] {
  return [
    ...permissions.filter((permission) => !TOOL_PERMISSION_SET.has(permission)),
    ...(preset === "read" ? TOOL_READ_PERMISSIONS : TOOL_CREATE_PERMISSIONS),
  ];
}

export function toolPermissionPreset(permissions: readonly string[]): ToolPermissionPreset | "custom" {
  const toolPermissions = permissions.filter((permission) => !permission.startsWith("relay:"));
  const same = (expected: string[]) => expected.length === new Set(toolPermissions).size && expected.every(p => toolPermissions.includes(p));
  return same(TOOL_READ_PERMISSIONS) ? "read" : same(TOOL_CREATE_PERMISSIONS) ? "create" : "custom";
}

export function toolApiBase(base: string): string {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("连接地址须使用 HTTPS；本机调试可使用 HTTP。请检查 API 地址设置。");
  }
  return url.toString().replace(/\/+$/, "").replace(/(?:\/api)?$/, "/api");
}

const quote = (value: string) => `'${value.split("'").join(`'"'"'`)}'`;
export function buildToolConnectionConfig(base: string, secret = "<YOUR_FANJIN_API_KEY>") {
  const apiBase = toolApiBase(base);
  return {
    apiBase,
    mcpUrl: `${apiBase}/mcp`,
    cli: [`export FANJIN_API_URL=${quote(apiBase)}`, `export FANJIN_API_KEY=${quote(secret)}`, "fanjin auth whoami"].join("\n"),
    stdio: JSON.stringify({ mcpServers: { fanjin: { command: "fanjin", args: ["mcp", "serve"], env: { FANJIN_API_URL: apiBase, FANJIN_API_KEY: secret } } } }, null, 2),
  };
}
