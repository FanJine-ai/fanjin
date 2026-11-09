import { randomUUID, randomBytes } from "node:crypto";
import type { AdminMachineIdentity } from "@/lib/adminMachineIdentity";
import { ADMIN_MACHINE_OPERATION_TYPE } from "@/lib/adminMachineIdentity";
import { validateAdminMachineCredential, hashAdminMachineKey, AdminMachineCredentialError } from "@/lib/adminMachineCredentials";
import type { FinanceStepUpBindingV1 } from "@/lib/stepUpAuth";
import type { VerifiedFinanceStepUpContextV1 } from "@/lib/billingServiceRequestFinance";
import { db } from "@/utils/db";

/** Record a request-bound machine authorization; never manufacture a human MFA proof. */
export async function authorizeMachineFinanceOperation(
  machine: AdminMachineIdentity, scope: string, binding: FinanceStepUpBindingV1, requiredPermissions: readonly string[],
): Promise<VerifiedFinanceStepUpContextV1> {
  if (!["admin.billing.service_request", "admin.finance.case"].includes(scope)) throw new AdminMachineCredentialError("ADMIN_MACHINE_SCOPE_INVALID", 403);
  return db.transaction(async trx => {
    const actor = await trx("o_user").where({ id: machine.ownerUserId }).forUpdate().first();
    const key = await trx("o_auth_token").where({ id: machine.id }).forUpdate().first();
    const live = validateAdminMachineCredential(key, actor);
    if (!requiredPermissions.length || requiredPermissions.some(p => !live.permissions.includes(p))) throw new AdminMachineCredentialError("ADMIN_MACHINE_SCOPE_INVALID", 403);
    const consumedAt = Date.now();
    const expiresAt = Math.min(live.expiresAt, consumedAt + 5 * 60_000);
    const id = randomUUID();
    await trx("o_auth_token").insert({ id, userId: live.ownerUserId, workspaceId: null,
      type: ADMIN_MACHINE_OPERATION_TYPE, tokenHash: hashAdminMachineKey(randomBytes(32).toString("hex")),
      createdAt: consumedAt, usedAt: consumedAt, expiresAt, revokedAt: null,
      metadata: JSON.stringify({ ...binding, method: "machine", scope, machineCredentialId: live.id,
        requiredPermissions, authorizationRevision: live.authorizationRevision }),
    });
    return { verificationSource: "admin_machine_credential/v1", proofRecordId: id, machineCredentialId: live.id,
      actorUserId: live.ownerUserId, actorRole: live.role, authorizationRevision: live.authorizationRevision,
      method: "machine", scope: scope as VerifiedFinanceStepUpContextV1["scope"],
      operation: binding.operation, requestId: binding.requestId, requestFingerprint: binding.requestFingerprint,
      resourceType: binding.resourceType, resourceId: binding.resourceId, resourceFingerprint: binding.resourceFingerprint,
      expiresAt, consumedAt };
  });
}
