import { ADMIN_MACHINE_ROLES } from "@/lib/adminMachineIdentity";
import { createHash } from "node:crypto";
import type { AdminOperationPolicy } from "@/lib/adminOperationPolicyCatalog";
import { listAdminOperationPolicies } from "@/middleware/adminOperationPolicy";
import { getRolePermissions, hasExactPermission } from "@/middleware/permissions";

export const ADMIN_AUTOMATION_PREFIX = "/api/admin/automation";
const platformRoles = new Set<string>(ADMIN_MACHINE_ROLES);
export function isAdminAutomationRole(role: unknown): role is string {
  return typeof role === "string" && platformRoles.has(role);
}
export interface AdminAutomationOperation {
  name: string;
  method: string;
  pathPattern: string;
  policies: AdminOperationPolicy[];
}
function toolName(method: string, path: string): string {
  const full = `admin_${method}_${path.slice("/api/admin/".length)}`
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase();
  return full.length <= 64 ? full : `${full.slice(0, 51)}_${createHash("sha256").update(full).digest("hex").slice(0, 12)}`;
}
export function adminAutomationOperations(): AdminAutomationOperation[] {
  const operations = new Map<string, AdminAutomationOperation>();
  for (const policy of listAdminOperationPolicies()) {
    if (policy.status !== "ACTIVE" || !policy.pathPattern.startsWith("/api/admin/")
      || policy.pathPattern.startsWith(ADMIN_AUTOMATION_PREFIX)) continue;
    const key = `${policy.method} ${policy.pathPattern}`;
    const operation = operations.get(key) ?? {
      name: toolName(policy.method, policy.pathPattern), method: policy.method,
      pathPattern: policy.pathPattern, policies: [],
    };
    operation.policies.push(policy);
    operations.set(key, operation);
  }
  const result = [...operations.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(result.map(item => item.name)).size !== result.length) throw new Error("Duplicate admin tool name");
  return result;
}
export function canDiscoverAdminOperation(role: unknown, operation: AdminAutomationOperation, keyPermissions?: readonly string[]): boolean {
  if (!isAdminAutomationRole(role)) return false;
  const permissions = getRolePermissions(role);
  // Discovery is advisory; normal policy middleware reclassifies every call,
  // including parameter-dependent permissions (for example updating a Root user).
  return operation.policies.some(policy => (!policy.hardGate || role === "root")
    && policy.permissions.every(permission => hasExactPermission(permissions, permission) && (!keyPermissions || keyPermissions.includes(permission))));
}
const pathKeys = (operation: AdminAutomationOperation) =>
  [...operation.pathPattern.matchAll(/:([A-Za-z0-9_]+)/g)].map(match => match[1]);
export function describeAdminOperation(operation: AdminAutomationOperation, machine = false) {
  const scopes = [...new Set(operation.policies.flatMap(policy => policy.stepUpScope ? [policy.stepUpScope] : []))];
  const properties: Record<string, unknown> = {
    query: { type: "object", description: "Query parameters accepted by the canonical admin API.", additionalProperties: {
      anyOf: [{ type: ["string", "number", "boolean"] }, { type: "array", items: { type: ["string", "number", "boolean"] } }],
    } },
  };
  const keys = pathKeys(operation);
  if (keys.length) properties.path = {
    type: "object", properties: Object.fromEntries(keys.map(key => [key, { type: "string", pattern: "^[A-Za-z0-9_-]+$", maxLength: 200 }])),
    required: keys, additionalProperties: false,
  };
  if (operation.method !== "GET") properties.body = {
    type: "object", description: "JSON body of the canonical admin API; its field validation still applies.", additionalProperties: true,
  };
  return {
    name: operation.name,
    description: `${operation.method} ${operation.pathPattern}. ${operation.policies.map(p => p.auditAction).join(" / ")}.`
      + (!machine && scopes.length ? ` Requires fresh step-up proof: ${scopes.join(", ")}; obtain it outside the model.` : "")
      + (machine ? " Scoped administrator machine key; no interactive MFA. Permissions, Root gates and audit remain enforced." : " Platform administrator session required; operation permissions and audit remain enforced."),
    inputSchema: { type: "object" as const, properties, additionalProperties: false, ...(keys.length ? { required: ["path"] } : {}) },
    annotations: {
      readOnlyHint: operation.policies.every(policy => !policy.mutates && !policy.stepUpScope),
      destructiveHint: operation.policies.some(policy => policy.mutates),
      idempotentHint: operation.method === "GET" && operation.policies.every(policy => !policy.mutates),
      openWorldHint: true,
    },
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** A closed envelope: callers never supply a method, URL or headers. */
export function resolveAdminAutomationCall(name: unknown, args: unknown) {
  const operation = adminAutomationOperations().find(item => item.name === name);
  if (!operation) throw new Error("ADMIN_TOOL_UNKNOWN");
  if (!isRecord(args) || Object.keys(args).some(key => !["body", "query", "path"].includes(key))) throw new Error("ADMIN_TOOL_ARGUMENTS_INVALID");
  if ((args.body !== undefined && (!isRecord(args.body) || operation.method === "GET"))
    || (args.query !== undefined && !isRecord(args.query))
    || (args.path !== undefined && !isRecord(args.path))) throw new Error("ADMIN_TOOL_ARGUMENTS_INVALID");
  const keys = pathKeys(operation);
  const params = (args.path ?? {}) as Record<string, unknown>;
  if (Object.keys(params).some(key => !keys.includes(key))
    || keys.some(key => typeof params[key] !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(params[key] as string))) throw new Error("ADMIN_TOOL_ARGUMENTS_INVALID");
  const path = operation.pathPattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => encodeURIComponent(params[key] as string));
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(args.query ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(key) || ["constructor", "prototype", "__proto__"].includes(key)) throw new Error("ADMIN_TOOL_ARGUMENTS_INVALID");
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!["string", "number", "boolean"].includes(typeof item)
        || (typeof item === "number" && !Number.isFinite(item))) throw new Error("ADMIN_TOOL_ARGUMENTS_INVALID");
      query.append(key, String(item));
    }
  }
  if (query.size > 100 || query.toString().length > 16_384) throw new Error("ADMIN_TOOL_ARGUMENTS_INVALID");
  return { operation, url: `${path}${query.size ? `?${query}` : ""}`, body: args.body ?? {} };
}
