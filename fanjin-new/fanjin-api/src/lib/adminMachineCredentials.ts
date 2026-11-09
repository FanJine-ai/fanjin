import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Request } from "express";
import { z } from "zod";
import { ADMIN_MACHINE_ROLES } from "@/lib/adminMachineIdentity";
import { writeAuditLog } from "@/lib/audit";
import { getRolePermissions } from "@/middleware/permissions";
import { db } from "@/utils/db";
import {
  ADMIN_MACHINE_FORMAT, ADMIN_MACHINE_KEY_PATTERN, ADMIN_MACHINE_PATHS,
  ADMIN_MACHINE_TOKEN_TYPE, bindAdminMachineIdentity, type AdminMachineIdentity,
} from "@/lib/adminMachineIdentity";

export class AdminMachineCredentialError extends Error {
  constructor(readonly code: string, readonly status = 401) { super(code); }
}
export const hashAdminMachineKey = (value: string) => createHash("sha256").update(value).digest("hex");
const metadataSchema = z.object({
  format: z.literal(ADMIN_MACHINE_FORMAT), name: z.string().min(1).max(80),
  issuedRole: z.enum(ADMIN_MACHINE_ROLES), authorizationRevision: z.number().int().positive(),
  permissions: z.array(z.string().startsWith("fjadmin:")).min(1).max(256),
}).strict();
const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: z.array(z.string()).min(1).max(256),
  expiresAt: z.number().int().positive().optional(),
}).strict();
function parseMetadata(raw: unknown) {
  try { return metadataSchema.parse(typeof raw === "string" ? JSON.parse(raw) : raw); }
  catch { throw new AdminMachineCredentialError("ADMIN_MACHINE_KEY_INVALID"); }
}
/** Also used while financial mutations hold actor -> credential row locks. */
export function validateAdminMachineCredential(row: any, user: any, timestamp = Date.now()): AdminMachineIdentity {
  if (!row || row.type !== ADMIN_MACHINE_TOKEN_TYPE || row.revokedAt != null || row.usedAt != null
    || !Number.isSafeInteger(Number(row.expiresAt)) || Number(row.expiresAt) <= timestamp) throw new AdminMachineCredentialError("ADMIN_MACHINE_KEY_INVALID");
  const metadata = parseMetadata(row.metadata);
  if (!user || Number(user.id) !== Number(row.userId) || user.status !== "active"
    || !ADMIN_MACHINE_ROLES.includes(user.role) || user.role !== metadata.issuedRole
    || Number(user.authorizationRevision) !== metadata.authorizationRevision) throw new AdminMachineCredentialError("ADMIN_MACHINE_OWNER_REVOKED", 403);
  const granted = getRolePermissions(user.role);
  if (metadata.permissions.some(permission => !granted.includes(permission) || permission.includes("*"))) throw new AdminMachineCredentialError("ADMIN_MACHINE_PERMISSION_REVOKED", 403);
  return { id: String(row.id), ownerUserId: Number(user.id), role: user.role,
    authorizationRevision: metadata.authorizationRevision, permissions: metadata.permissions, expiresAt: Number(row.expiresAt) };
}
export async function authenticateAdminMachineRequest(req: Request): Promise<boolean> {
  const raw = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!raw.startsWith("fjadmin_")) return false;
  if (!/^Bearer\s+/i.test(String(req.headers.authorization || "")) || !ADMIN_MACHINE_KEY_PATTERN.test(raw)) throw new AdminMachineCredentialError("ADMIN_MACHINE_KEY_INVALID");
  if (!ADMIN_MACHINE_PATHS.has(req.path)) throw new AdminMachineCredentialError("ADMIN_MACHINE_ENDPOINT_FORBIDDEN", 403);
  const row = await db("o_auth_token").where({ type: ADMIN_MACHINE_TOKEN_TYPE, tokenHash: hashAdminMachineKey(raw) }).first();
  const user = row ? await db("o_user").where({ id: Number(row.userId) }).first() : null;
  const identity = validateAdminMachineCredential(row, user);
  bindAdminMachineIdentity(req, identity);
  const authUser = { id: identity.ownerUserId, name: user!.name, role: identity.role,
    status: user!.status, authorizationRevision: identity.authorizationRevision, workspaceId: null };
  (req as any).auth = { user: authUser, session: null, workspaceId: null, machineCredentialId: identity.id };
  (req as any).user = authUser;
  return true;
}
export async function issueAdminMachineCredential(req: Request, input: unknown) {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new AdminMachineCredentialError("ADMIN_MACHINE_INPUT_INVALID", 400);
  const actorId = Number((req as any).auth?.user?.id);
  return db.transaction(async trx => {
    const actor = await trx("o_user").where({ id: actorId }).forUpdate().first();
    if (!actor || actor.status !== "active" || !ADMIN_MACHINE_ROLES.includes(actor.role as any)) throw new AdminMachineCredentialError("PLATFORM_ADMIN_REQUIRED", 403);
    const permissions = [...new Set(parsed.data.permissions)];
    const allowed = getRolePermissions(String(actor.role));
    if (permissions.some(p => !p.startsWith("fjadmin:") || p.includes("*") || !allowed.includes(p))) throw new AdminMachineCredentialError("ADMIN_MACHINE_SCOPE_INVALID", 403);
    const now = Date.now();
    const expiresAt = parsed.data.expiresAt ?? now + 90 * 86_400_000;
    if (expiresAt <= now || expiresAt > now + 365 * 86_400_000) throw new AdminMachineCredentialError("ADMIN_MACHINE_EXPIRY_INVALID", 400);
    const id = randomUUID();
    const apiKey = `fjadmin_${randomBytes(32).toString("base64url")}`;
    const metadata = metadataSchema.parse({ format: ADMIN_MACHINE_FORMAT, name: parsed.data.name,
      permissions, issuedRole: actor.role, authorizationRevision: Number(actor.authorizationRevision) });
    await trx("o_auth_token").insert({ id, userId: actorId, workspaceId: null, type: ADMIN_MACHINE_TOKEN_TYPE,
      tokenHash: hashAdminMachineKey(apiKey), metadata: JSON.stringify(metadata), expiresAt, createdAt: now, revokedAt: null, usedAt: null });
    await writeAuditLog(req, { action: "admin.machine_key.create", resourceType: "admin_machine_key", resourceId: id,
      required: true, metadata: { name: metadata.name, permissions, expiresAt } }, trx);
    return { id, apiKey, name: metadata.name, permissions, expiresAt };
  });
}
export async function listAdminMachineCredentials(userId: number) {
  const rows = await db("o_auth_token").where({ userId, type: ADMIN_MACHINE_TOKEN_TYPE }).orderBy("createdAt", "desc").limit(100);
  return rows.map(row => {
    const metadata = parseMetadata(row.metadata);
    return { id: row.id, name: metadata.name, permissions: metadata.permissions,
      createdAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt };
  });
}
export async function revokeAdminMachineCredential(req: Request, id: string) {
  const actorId = Number((req as any).auth?.user?.id);
  return db.transaction(async trx => {
    // Actor -> key order matches finance authorization and issuance.
    await trx("o_user").where({ id: actorId }).forUpdate().first();
    const row = await trx("o_auth_token").where({ id, userId: actorId, type: ADMIN_MACHINE_TOKEN_TYPE }).forUpdate().first();
    if (!row) throw new AdminMachineCredentialError("ADMIN_MACHINE_KEY_NOT_FOUND", 404);
    await trx("o_auth_token").where({ id }).update({ revokedAt: row.revokedAt ?? Date.now() });
    await writeAuditLog(req, { action: "admin.machine_key.revoke", resourceType: "admin_machine_key", resourceId: id, required: true }, trx);
    return { id, revoked: true };
  });
}
