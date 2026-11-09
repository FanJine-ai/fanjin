import { platformRoles, financeRoles } from "@/lib/sharedTypes";
import type { Request } from "express";

export const ADMIN_MACHINE_ROLES = [...platformRoles, ...financeRoles] as const;
export const ADMIN_MACHINE_TOKEN_TYPE = "admin_machine_credential";
export const ADMIN_MACHINE_FORMAT = "admin-machine/v1";
export const ADMIN_MACHINE_OPERATION_TYPE = "admin_machine_operation";
export const ADMIN_MACHINE_KEY_PATTERN = /^fjadmin_[A-Za-z0-9_-]{43}$/;
export const ADMIN_MACHINE_PATHS = new Set([
  "/api/admin/automation/tools", "/api/admin/automation/call", "/api/admin/automation/revoke-self",
]);
export interface AdminMachineIdentity {
  readonly id: string;
  readonly ownerUserId: number;
  readonly role: string;
  readonly authorizationRevision: number;
  readonly permissions: readonly string[];
  readonly expiresAt: number;
}
const identities = new WeakMap<Request, AdminMachineIdentity>();
export const readAdminMachineIdentity = (req: Request) => identities.get(req);
// Server-owned request identity; never infer this from a body, header or req.user flag.
export function bindAdminMachineIdentity(req: Request, identity: AdminMachineIdentity) {
  identities.set(req, Object.freeze({ ...identity, permissions: Object.freeze([...identity.permissions]) }));
}
