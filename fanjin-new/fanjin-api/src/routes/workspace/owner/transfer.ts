import { assertMembershipOwnerTransferable } from "@/lib/membership";
import { MembershipError } from "@/lib/membershipCatalog";
import crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit";
import { error, success } from "@/lib/responseFormat";
import {
  requireLiveWorkspaceAuthority,
  revokeWorkspaceMemberAccess,
  WorkspaceAuthorityError,
} from "@/lib/workspaceAccess";
import {
  readDeferredTransactionalStepUp,
} from "@/middleware/adminStepUp";
import { consumeStepUpProof, StepUpError } from "@/lib/stepUpAuth";
import { getConsistentWorkspaceRole } from "@/lib/workspaceOwnership";
import { db } from "@/utils/db";

const router = express.Router();
const OWNER_TRANSFER_COMMAND_TABLE = "o_workspace_owner_transfer_command";

const bodySchema = z.object({
  workspaceId: z.string().trim().min(1).optional().nullable(),
  targetUserId: z.number().int().positive(),
  formerOwnerRole: z.enum([
    "workspace_admin",
    "creator",
  ]).default("workspace_admin"),
  idempotencyKey: z.string().trim().min(8).max(128),
  reason: z.string().trim().max(500).optional().nullable(),
}).strict();

class WorkspaceOwnerTransferError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "WorkspaceOwnerTransferError";
  }
}

class WorkspaceOwnerTransferCommandPersistenceError extends Error {
  constructor() {
    super("workspace owner transfer command persistence unavailable");
    this.name = "WorkspaceOwnerTransferCommandPersistenceError";
  }
}

function ownerTransferPayloadHash(input: {
  workspaceId: string;
  actorUserId: number;
  targetUserId: number;
  formerOwnerRole: string;
  reason: string | null;
}): string {
  const canonicalPayload = JSON.stringify({
    version: 1,
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    targetUserId: input.targetUserId,
    formerOwnerRole: input.formerOwnerRole,
    reason: input.reason,
  });
  return crypto
    .createHash("sha256")
    .update("fanjin/workspace-owner-transfer/v1\0")
    .update(canonicalPayload)
    .digest("hex");
}

function readOwnerTransferCommandResult(row: any) {
  let persisted: any;
  try {
    persisted = JSON.parse(String(row.resultJson));
  } catch {
    persisted = null;
  }
  const formerOwnerUserId = Number(row.formerOwnerUserId);
  const targetUserId = Number(row.targetUserId);
  if (
    !persisted
    || typeof persisted !== "object"
    || Array.isArray(persisted)
    || !Number.isSafeInteger(formerOwnerUserId)
    || formerOwnerUserId < 1
    || !Number.isSafeInteger(targetUserId)
    || targetUserId < 1
    || String(persisted.workspaceId || "") !== String(row.workspaceId)
    || Number(persisted.formerOwnerUserId) !== formerOwnerUserId
    || Number(persisted.ownerUserId) !== targetUserId
    || String(persisted.formerOwnerRole || "") !== String(row.formerOwnerRole)
    || !["workspace.owner.transfer", "workspace.owner.transfer.breakglass"]
      .includes(String(row.action || ""))
    || (
      persisted.revoked !== null
      && (
        typeof persisted.revoked !== "object"
        || Array.isArray(persisted.revoked)
      )
    )
  ) {
    throw new WorkspaceOwnerTransferError(
      "owner transfer command ledger 数据损坏",
      500,
      "WORKSPACE_OWNER_TRANSFER_COMMAND_INVALID",
    );
  }
  return {
    workspaceId: String(row.workspaceId),
    formerOwnerUserId,
    ownerUserId: targetUserId,
    formerOwnerRole: String(row.formerOwnerRole),
    idempotent: true,
    revoked: persisted.revoked,
  };
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).send({
      message: "参数错误",
      errors: parsed.error.issues,
    });
  }

  const actorUserId = Number(
    (req as any).auth?.user?.id
    || (req as any).user?.id
    || 0,
  );
  const deferredStepUp = readDeferredTransactionalStepUp(res);
  if (
    !deferredStepUp
    || deferredStepUp.scope !== "workspace.owner.transfer"
    || deferredStepUp.userId !== actorUserId
  ) {
    return res.status(401).send(error("敏感操作需要事务级 step-up proof", {
      code: "STEP_UP_REQUIRED",
    }));
  }
  const authenticatedWorkspaceId = String(
    (req as any).auth?.workspaceId || "",
  ).trim();
  const workspaceId = String(
    parsed.data.workspaceId || authenticatedWorkspaceId,
  ).trim();
  if (!workspaceId) {
    return res.status(403).send(error("缺少工作区上下文", {
      code: "WORKSPACE_CONTEXT_REQUIRED",
    }));
  }
  const reason = parsed.data.reason || null;
  const payloadHash = ownerTransferPayloadHash({
    workspaceId,
    actorUserId,
    targetUserId: parsed.data.targetUserId,
    formerOwnerRole: parsed.data.formerOwnerRole,
    reason,
  });

  try {
    // The current owner is mutable, so read an optimistic snapshot only to
    // know every user row that must be locked before the workspace. The
    // transaction verifies the snapshot after acquiring all locks.
    const ownerSnapshot = await db("o_workspace")
      .where({ id: workspaceId })
      .select("ownerUserId")
      .first();
    const snapshotOwnerUserId = Number(ownerSnapshot?.ownerUserId || 0);
    if (!Number.isSafeInteger(snapshotOwnerUserId) || snapshotOwnerUserId < 1) {
      throw new WorkspaceOwnerTransferError(
        "工作区不存在或所有权数据无效",
        404,
        "WORKSPACE_OWNER_INVARIANT_INVALID",
      );
    }

    const result = await db.transaction(async (trx) => {
      // The exact live session, credential generations, one-time proof,
      // authority mutation, revocations, and required audit share one commit.
      // A logout/reset that commits first makes this fail before any owner
      // state changes; a later revocation serializes behind these locks.
      await consumeStepUpProof(trx, {
        proof: deferredStepUp.proof,
        userId: actorUserId,
        sessionId: deferredStepUp.sessionId,
        scope: "workspace.owner.transfer",
      });
      const authority = await requireLiveWorkspaceAuthority({
        database: trx,
        actorUserId,
        additionalUserIds: [
          snapshotOwnerUserId,
          parsed.data.targetUserId,
        ],
        lockAllWorkspaceMembers: true,
        authenticatedWorkspaceId,
        workspaceId,
        // Every allowed post-transfer role retains workspace:read. This keeps
        // a same-actor retry replayable after the first commit has downgraded
        // the former owner, while the mutation path below still requires the
        // actor to be the live authoritative owner (or root breakglass).
        permission: "workspace:read",
      });
      const currentOwnerUserId = Number(authority.workspace.ownerUserId || 0);

      let previous: any;
      try {
        previous = await trx(OWNER_TRANSFER_COMMAND_TABLE)
          .where({
            workspaceId,
            actorUserId,
            idempotencyKey: parsed.data.idempotencyKey,
          })
          .first();
      } catch {
        throw new WorkspaceOwnerTransferCommandPersistenceError();
      }
      if (previous) {
        if (
          String(previous.payloadHash || "") !== payloadHash
          || Number(previous.targetUserId || 0) !== parsed.data.targetUserId
          || String(previous.formerOwnerRole || "") !== parsed.data.formerOwnerRole
        ) {
          throw new WorkspaceOwnerTransferError(
            "owner transfer 幂等键已被不同请求使用",
            409,
            "WORKSPACE_OWNER_TRANSFER_IDEMPOTENCY_CONFLICT",
          );
        }
        return readOwnerTransferCommandResult(previous);
      }

      if (currentOwnerUserId !== snapshotOwnerUserId) {
        throw new WorkspaceOwnerTransferError(
          "工作区所有权已变化，请重试",
          409,
          "WORKSPACE_OWNER_CHANGED",
        );
      }

      if (parsed.data.targetUserId === currentOwnerUserId) {
        throw new WorkspaceOwnerTransferError(
          "目标用户已经是当前 owner",
          409,
          "WORKSPACE_OWNER_TRANSFER_TARGET_UNCHANGED",
        );
      }

      const actorRole = String(authority.actor.role || "").toLowerCase();
      const rootBreakglass = (
        actorRole === "root"
        && actorUserId !== currentOwnerUserId
      );
      if (actorUserId !== currentOwnerUserId && !rootBreakglass) {
        throw new WorkspaceOwnerTransferError(
          "只有当前 owner 可以转移所有权",
          403,
          "WORKSPACE_CURRENT_OWNER_REQUIRED",
        );
      }
      if (rootBreakglass && String(reason || "").length < 12) {
        throw new WorkspaceOwnerTransferError(
          "Root breakglass 转移必须填写不少于 12 个字符的原因",
          400,
          "WORKSPACE_OWNER_BREAKGLASS_REASON_REQUIRED",
        );
      }

      const currentOwnerUser = authority.lockedUsers.find(
        (row: any) => Number(row.id) === currentOwnerUserId,
      );
      const targetUser = authority.lockedUsers.find(
        (row: any) => Number(row.id) === parsed.data.targetUserId,
      );
      if (!currentOwnerUser) {
        throw new WorkspaceOwnerTransferError(
          "当前 owner 账号不存在",
          409,
          "WORKSPACE_OWNER_INVARIANT_INVALID",
        );
      }
      if (!targetUser || targetUser.status !== "active") {
        throw new WorkspaceOwnerTransferError(
          "目标账号不存在或不可用",
          409,
          "WORKSPACE_OWNER_TARGET_UNAVAILABLE",
        );
      }

      const ownerRoleRows = authority.lockedMembers.filter(
        (member: any) => String(member.role || "").toLowerCase() === "owner",
      );
      const currentOwnerMember = authority.lockedMembers.find(
        (member: any) => Number(member.userId) === currentOwnerUserId,
      );
      const targetMember = authority.lockedMembers.find(
        (member: any) => Number(member.userId) === parsed.data.targetUserId,
      );
      if (
        ownerRoleRows.length !== 1
        || !currentOwnerMember
        || getConsistentWorkspaceRole({
          userId: currentOwnerMember.userId,
          memberRole: currentOwnerMember.role,
          ownerUserId: currentOwnerUserId,
        }) !== "owner"
        || (!rootBreakglass && currentOwnerMember.status !== "active")
      ) {
        throw new WorkspaceOwnerTransferError(
          "工作区 owner 数据不一致，禁止自动修复",
          409,
          "WORKSPACE_OWNER_INVARIANT_INVALID",
        );
      }
      if (!targetMember || targetMember.status !== "active") {
        throw new WorkspaceOwnerTransferError(
          "目标用户必须是当前工作区的启用成员",
          409,
          "WORKSPACE_OWNER_TARGET_MEMBER_REQUIRED",
        );
      }
      if (String(targetMember.role || "").toLowerCase() === "owner") {
        throw new WorkspaceOwnerTransferError(
          "目标成员存在 phantom owner 数据",
          409,
          "WORKSPACE_OWNER_INVARIANT_INVALID",
        );
      }

      await assertMembershipOwnerTransferable(trx, workspaceId);
      const timestamp = Date.now();
      await trx("o_workspace_member")
        .where({ id: currentOwnerMember.id })
        .update({
          role: parsed.data.formerOwnerRole,
          status: "active",
          permissions: null,
          updatedAt: timestamp,
        });
      await trx("o_workspace_member")
        .where({ id: targetMember.id })
        .update({
          role: "owner",
          status: "active",
          permissions: null,
          updatedAt: timestamp,
        });
      await trx("o_workspace")
        .where({ id: workspaceId, ownerUserId: currentOwnerUserId })
        .update({
          ownerUserId: parsed.data.targetUserId,
          updatedAt: timestamp,
        });

      const revokedByUserId = new Map<number, Awaited<ReturnType<
        typeof revokeWorkspaceMemberAccess
      >>>();
      for (const userId of [currentOwnerUserId, parsed.data.targetUserId]
        .sort((left, right) => left - right)) {
        revokedByUserId.set(userId, await revokeWorkspaceMemberAccess({
          workspaceId,
          userId,
          database: trx,
        }));
      }
      const revoked = {
        formerOwner: revokedByUserId.get(currentOwnerUserId),
        targetOwner: revokedByUserId.get(parsed.data.targetUserId),
      };

      const action = rootBreakglass
        ? "workspace.owner.transfer.breakglass"
        : "workspace.owner.transfer";
      await writeAuditLog(req, {
        workspaceId,
        action,
        resourceType: "workspace",
        resourceId: workspaceId,
        required: true,
        metadata: {
          idempotencyKey: parsed.data.idempotencyKey,
          formerOwnerUserId: currentOwnerUserId,
          targetUserId: parsed.data.targetUserId,
          formerOwnerRole: parsed.data.formerOwnerRole,
          reason,
          before: {
            ownerUserId: currentOwnerUserId,
            formerOwnerMemberRole: currentOwnerMember.role,
            targetMemberRole: targetMember.role,
          },
          after: {
            ownerUserId: parsed.data.targetUserId,
            formerOwnerMemberRole: parsed.data.formerOwnerRole,
            targetMemberRole: "owner",
          },
          revoked,
        },
      }, trx);

      const commandResult = {
        workspaceId,
        formerOwnerUserId: currentOwnerUserId,
        ownerUserId: parsed.data.targetUserId,
        formerOwnerRole: parsed.data.formerOwnerRole,
        idempotent: false,
        revoked,
      };
      try {
        await trx(OWNER_TRANSFER_COMMAND_TABLE).insert({
          id: crypto.randomUUID(),
          workspaceId,
          actorUserId,
          idempotencyKey: parsed.data.idempotencyKey,
          payloadHash,
          action,
          formerOwnerUserId: currentOwnerUserId,
          targetUserId: parsed.data.targetUserId,
          formerOwnerRole: parsed.data.formerOwnerRole,
          resultJson: JSON.stringify(commandResult),
          createdAt: timestamp,
        });
      } catch {
        throw new WorkspaceOwnerTransferCommandPersistenceError();
      }

      return commandResult;
    });

    return res.status(200).send(success(result, "工作区所有权已转移"));
  } catch (err: unknown) {
    if (err instanceof MembershipError) return res.status(err.status).send(error(err.message, { code: err.code }));
    if (err instanceof StepUpError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    if (err instanceof WorkspaceAuthorityError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    if (err instanceof WorkspaceOwnerTransferError) {
      return res.status(err.status).send(error(err.message, { code: err.code }));
    }
    if (err instanceof WorkspaceOwnerTransferCommandPersistenceError) {
      return res.status(503).send(error(
        "owner transfer command ledger 不可用，所有权未转移",
        { code: "WORKSPACE_OWNER_TRANSFER_COMMAND_UNAVAILABLE" },
      ));
    }
    if (String((err as Error)?.message || "").startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
      return res.status(503).send(error("审计写入失败，所有权未转移", {
        code: "FJADMIN_AUDIT_UNAVAILABLE",
      }));
    }
    throw err;
  }
});
