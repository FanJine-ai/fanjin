import { Request } from "express";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import {
  financeRoles,
  platformRoles,
  workspaceRoles,
  type LegacyUserRole,
} from "@/lib/sharedTypes";

import { readAdminMachineIdentity } from "@/lib/adminMachineIdentity";

export type AuditActorRole = LegacyUserRole | null;
export type CanonicalAuditActorKind = "user" | "api_key" | "system" | "worker";
export type LegacyAuditActorKind = "authenticated" | "anonymous-registration";
export type AuditActorKind = CanonicalAuditActorKind | LegacyAuditActorKind;

export interface AuditActor {
  actorUserId?: number | null;
  actorRole?: AuditActorRole;
  actorKind?: AuditActorKind;
}

export interface AuditContext {
  ip?: string | null;
  userAgent?: string | null;
  workspaceId?: string | null;
  actor?: AuditActor;
  stepUpScope?: string;
}

export interface AuditLogInput {
  workspaceId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | number | null;
  metadata?: Record<string, unknown>;
  required?: boolean;
  actor?: AuditActor;
}

const CANONICAL_ROLES: ReadonlySet<string> = new Set([
  ...platformRoles,
  ...financeRoles,
  ...workspaceRoles,
  "user",
  // member 是全局普通账号身份，不是可分配的工作区角色。
  "member",
]);

export function normalizeActorRole(role: string | null | undefined): AuditActorRole {
  if (typeof role !== "string" || role.length === 0) return null;
  return CANONICAL_ROLES.has(role) ? (role as LegacyUserRole) : null;
}

export function normalizeAuditActorKind(
  kind: AuditActorKind | null | undefined,
  actorUserId?: number | null,
): CanonicalAuditActorKind {
  if (kind === "api_key" || kind === "system" || kind === "worker" || kind === "user") {
    return kind;
  }
  if (kind === "authenticated" || kind === "anonymous-registration") return "user";
  return Number(actorUserId || 0) > 0 ? "user" : "system";
}

function isRequest(value: unknown): value is Request {
  return Boolean(value) && typeof (value as { header?: unknown }).header === "function";
}

function actorFromRequest(req: Request): { actorUserId: number | null; actorRole: AuditActorRole } {
  const request = req as unknown as {
    auth?: { user?: { id?: unknown; role?: unknown } };
    user?: { id?: unknown; role?: unknown };
  };
  const user = request.auth?.user || request.user || {};
  const id = Number(user.id || 0);
  return {
    actorUserId: id || null,
    actorRole: normalizeActorRole(typeof user.role === "string" ? user.role : null),
  };
}

export function hasAuditLogWritten(req: Request): boolean {
  return isRequest(req) && Boolean((req as unknown as Record<string, unknown>).__fanjinAuditLogWritten);
}

function markAuditLogWritten(req: Request): void {
  (req as unknown as Record<string, unknown>).__fanjinAuditLogWritten = true;
}

function outermostTransaction(trx: Knex.Transaction): Knex.Transaction {
  let current = trx;
  while (current.parentTransaction) current = current.parentTransaction;
  return current;
}

function markAuditLogWrittenAfterCommit(
  req: Request,
  trx?: Knex.Transaction | null,
): void {
  if (!trx) {
    markAuditLogWritten(req);
    return;
  }
  // A successful INSERT inside a transaction is not durable until the
  // outermost transaction commits. Marking the request earlier can suppress
  // the response-level fallback audit after a later rollback.
  void outermostTransaction(trx).executionPromise.then(
    () => markAuditLogWritten(req),
    () => undefined,
  );
}

function resolveContext(reqOrContext: Request | AuditContext | null | undefined): AuditContext {
  if (!reqOrContext) return {};
  if (!isRequest(reqOrContext)) return reqOrContext;

  const req = reqOrContext;
  const request = req as unknown as {
    auth?: { workspaceId?: string | null };
    adminStepUpScope?: unknown;
  };
  const actor = actorFromRequest(req);
  return {
    ip: req.ip || null,
    userAgent: req.header("user-agent") || null,
    workspaceId: request.auth?.workspaceId ?? null,
    stepUpScope: String(request.adminStepUpScope || "").trim() || undefined,
    actor: {
      actorUserId: actor.actorUserId,
      actorRole: actor.actorRole,
      actorKind: readAdminMachineIdentity(req) ? "api_key" : actor.actorUserId ? "user" : undefined,
    },
  };
}

function scrubAuditError(err: unknown): { errorCode: string; errorClass: string } {
  const value = err as { code?: unknown; errno?: unknown; name?: unknown; constructor?: { name?: string } };
  const rawCode = value?.code ?? value?.errno;
  return {
    errorCode:
      typeof rawCode === "string" || typeof rawCode === "number"
        ? String(rawCode)
        : "AUDIT_WRITE_FAILED",
    errorClass: String(value?.constructor?.name || value?.name || "Error"),
  };
}

export async function writeAuditLog(
  reqOrContext: Request | AuditContext | null | undefined,
  input: AuditLogInput,
  trx?: Knex.Transaction | null,
): Promise<void> {
  const context = resolveContext(reqOrContext);
  const actor = {
    actorUserId:
      input.actor?.actorUserId !== undefined
        ? input.actor.actorUserId
        : context.actor?.actorUserId ?? null,
    actorRole:
      input.actor?.actorRole !== undefined
        ? input.actor.actorRole
        : context.actor?.actorRole ?? null,
    actorKind: normalizeAuditActorKind(
      input.actor?.actorKind ?? context.actor?.actorKind,
      input.actor?.actorUserId !== undefined
        ? input.actor.actorUserId
        : context.actor?.actorUserId,
    ),
  };
  const workspaceId = input.workspaceId ?? context.workspaceId ?? null;
  const resourceId =
    input.resourceId === undefined || input.resourceId === null
      ? null
      : String(input.resourceId);
  const metadata = {
    ...(input.metadata || {}),
    ...(isRequest(reqOrContext) && readAdminMachineIdentity(reqOrContext)
      ? { authenticationMethod: "admin_machine_key", machineCredentialId: readAdminMachineIdentity(reqOrContext)!.id } : {}),
    ...(isRequest(reqOrContext) && (reqOrContext as any).adminAutomation
      ? { adminAutomation: (reqOrContext as any).adminAutomation } : {}),
    ...(context.stepUpScope ? { stepUpScope: context.stepUpScope } : {}),
    ...(actor.actorKind ? { actorKind: actor.actorKind } : {}),
  };
  const writer = trx || db;

  try {
    await writer("o_audit_log").insert({
      id: uuid(),
      workspaceId,
      actorUserId: actor.actorUserId,
      actorRole: actor.actorRole,
      action: input.action,
      resourceType: input.resourceType,
      resourceId,
      ip: context.ip || null,
      userAgent: context.userAgent || null,
      metadata: JSON.stringify(metadata),
      createdAt: Date.now(),
    });
    if (isRequest(reqOrContext)) markAuditLogWrittenAfterCommit(reqOrContext, trx);
  } catch (err) {
    const scrubbed = scrubAuditError(err);
    console.error(
      "[audit] write failed",
      JSON.stringify({
        action: input.action,
        resourceType: input.resourceType,
        resourceId,
        workspaceId,
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
        actorKind: actor.actorKind,
        required: Boolean(input.required),
        errorCode: scrubbed.errorCode,
        errorClass: scrubbed.errorClass,
        inTransaction: Boolean(trx),
      }),
    );
    if (input.required) {
      throw new Error(
        `AUDIT_REQUIRED_WRITE_FAILED: ${input.action} (${scrubbed.errorCode})`,
      );
    }
  }
}

export function parseAuditMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
