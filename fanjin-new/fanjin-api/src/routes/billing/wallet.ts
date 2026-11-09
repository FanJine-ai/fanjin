import express from "express";
import type { Knex } from "knex";
import { z } from "zod";
import {
  allocateAccountWalletToWorkspaceInTransaction,
  BillingError,
  getBillingOverview,
} from "@/lib/billing";
import { formatAccountWalletLedger, readAccountWallet } from "@/lib/accountWallet";
import { normalizeActorRole, writeAuditLog } from "@/lib/audit";
import { success } from "@/lib/responseFormat";
import {
  requireLiveWorkspaceAuthority,
  WorkspaceAuthorityError,
} from "@/lib/workspaceAccess";
import { getConsistentWorkspaceRole } from "@/lib/workspaceOwnership";
import { db } from "@/utils/db";

const router = express.Router();

const protectedAllocationMetadataKeys = new Set([
  "source",
  "accountWalletUserId",
  "allocationDoesNotDebitOwnerWallet",
  "allocationOwnerUserId",
  "allocationRequestDigest",
  "status",
  "remainingMicros",
  "creditLimitMicros",
  "relatedLedgerId",
  "usageRecordId",
  "taskId",
  "apiKeyId",
  "requestId",
  "idempotencyKey",
]);

const allocationMetadataSchema = z.record(z.string(), z.unknown())
  .superRefine((metadata, context) => {
    for (const key of Object.keys(metadata)) {
      if (protectedAllocationMetadataKeys.has(key)) {
        context.addIssue({
          code: "custom",
          message: `metadata.${key} 为服务端保留字段`,
          path: [key],
        });
      }
    }
    try {
      if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 8_192) {
        context.addIssue({
          code: "too_big",
          maximum: 8_192,
          origin: "string",
          inclusive: true,
          message: "metadata 不能超过 8192 字节",
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        message: "metadata 必须是可序列化的 JSON 对象",
      });
    }
  });

const overviewSchema = z.object({
  // Legacy clients may echo the workspace id, but it is never authoritative.
  // It must agree with the server-owned session workspace below.
  workspaceId: z.string().trim().min(1).optional().nullable(),
  pageNum: z.number().int().positive().optional().default(1),
  pageSize: z.number().int().positive().max(100).optional().default(20),
}).strict();

const allocateSchema = z.object({
  workspaceId: z.string().trim().min(1).optional().nullable(),
  amountMicros: z.number().int().positive(),
  description: z.string().trim().max(300).optional().nullable(),
  idempotencyKey: z.string().trim().min(1).max(200).optional().nullable(),
  metadata: allocationMetadataSchema.optional(),
}).strict();

function authUserId(req: express.Request): number {
  return Number((req as any).auth?.user?.id ?? 0);
}

function serverWorkspaceId(
  req: express.Request,
  echoedWorkspaceId?: string | null,
): string {
  const workspaceId = String((req as any).auth?.workspaceId || "").trim();
  if (!workspaceId) {
    throw new WorkspaceAuthorityError(
      "当前会话没有可用的工作区上下文",
      "WORKSPACE_CONTEXT_REQUIRED",
      403,
    );
  }
  const echoed = String(echoedWorkspaceId || "").trim();
  if (echoed && echoed !== workspaceId) {
    throw new WorkspaceAuthorityError(
      "请求工作区与当前会话工作区不一致",
      "WORKSPACE_CONTEXT_MISMATCH",
      403,
    );
  }
  return workspaceId;
}

async function requireWalletWorkspaceAuthority(input: {
  trx: Knex.Transaction;
  req: express.Request;
  workspaceId: string;
}): Promise<{
  actor: any;
  role: string;
  ownerUserId: number;
}> {
  const actorUserId = authUserId(input.req);
  const ownerSnapshot = await input.trx("o_workspace")
    .where({ id: input.workspaceId })
    .select("ownerUserId")
    .first();
  const ownerUserId = Number(ownerSnapshot?.ownerUserId || 0);
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1) {
    throw new WorkspaceAuthorityError(
      "工作区所有者身份无效",
      "WORKSPACE_OWNER_INVARIANT_INVALID",
      403,
    );
  }

  const authority = await requireLiveWorkspaceAuthority({
    database: input.trx,
    actorUserId,
    additionalUserIds: [ownerUserId],
    additionalMemberUserIds: [ownerUserId],
    authenticatedWorkspaceId: String((input.req as any).auth?.workspaceId || ""),
    workspaceId: input.workspaceId,
    permission: "billing:read",
  });
  if (Number(authority.workspace.ownerUserId || 0) !== ownerUserId) {
    throw new WorkspaceAuthorityError(
      "工作区所有权已发生变化，请重试",
      "WORKSPACE_OWNER_CHANGED",
      409,
    );
  }

  const owner = authority.lockedUsers.find(
    (user: any) => Number(user.id) === ownerUserId,
  );
  if (!owner || owner.status !== "active") {
    throw new WorkspaceAuthorityError(
      "工作区所有者账号不可用",
      "WORKSPACE_OWNER_UNAVAILABLE",
      403,
    );
  }

  const ownerMember = authority.lockedMembers.find(
    (member: any) => Number(member.userId) === ownerUserId,
  );
  const ownerRole = ownerMember?.status === "active"
    ? getConsistentWorkspaceRole({
        userId: ownerMember.userId,
        memberRole: ownerMember.role,
        ownerUserId,
      })
    : null;
  if (ownerRole !== "owner") {
    throw new WorkspaceAuthorityError(
      "工作区所有权数据不一致",
      "WORKSPACE_OWNER_INVARIANT_INVALID",
      403,
    );
  }

  return {
    actor: authority.actor,
    role: authority.role,
    ownerUserId,
  };
}

async function listWorkspaceAccountWalletLedger(input: {
  trx: Knex.Transaction;
  userId: number;
  workspaceId: string;
  pageNum: number;
  pageSize: number;
}) {
  const query = input.trx("o_account_wallet_ledger").where({
    userId: input.userId,
    workspaceId: input.workspaceId,
  });
  const countRow = await query.clone().count<{ total: number }[]>({ total: "*" }).first();
  const rows = await query
    .clone()
    .orderBy("createdAt", "desc")
    .limit(input.pageSize)
    .offset((input.pageNum - 1) * input.pageSize);
  return {
    items: rows.map(formatAccountWalletLedger),
    total: Number((countRow as any)?.total || 0),
    pageNum: input.pageNum,
    pageSize: input.pageSize,
  };
}

function sendWalletError(res: express.Response, err: unknown) {
  if (err instanceof WorkspaceAuthorityError) {
    return res.status(err.status).send({ message: err.message, code: err.code });
  }
  if (err instanceof BillingError) return res.status(err.status).send({ message: err.message });
  const message = err instanceof Error ? err.message : "账号钱包操作失败";
  if (/不足/.test(message)) return res.status(402).send({ message });
  if (message.startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
    return res.status(503).send({
      message: "审计服务暂不可用",
      code: "FJADMIN_AUDIT_UNAVAILABLE",
    });
  }
  const errorValue = err as { code?: unknown; name?: unknown };
  console.error(
    "[billing-wallet] operation failed",
    JSON.stringify({
      code: String(errorValue?.code || "BILLING_WALLET_OPERATION_FAILED"),
      errorClass: String(errorValue?.name || "Error"),
    }),
  );
  return res.status(500).send({
    message: "账号钱包操作失败",
    code: "BILLING_WALLET_OPERATION_FAILED",
  });
}

router.post("/", async (req, res) => {
  const parsed = overviewSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  try {
    const userId = authUserId(req);
    if (!userId) return res.status(401).send({ message: "未登录" });
    const workspaceId = serverWorkspaceId(req, parsed.data.workspaceId);
    const [wallet, ledger, billingOverview] = await db.transaction(async (trx) => {
      await requireWalletWorkspaceAuthority({ trx, req, workspaceId });
      const accountLedger = await listWorkspaceAccountWalletLedger({
        trx,
        userId,
        workspaceId,
        pageNum: parsed.data.pageNum,
        pageSize: parsed.data.pageSize,
      });
      const accountWallet = await readAccountWallet(trx, userId);
      const overview = await getBillingOverview(workspaceId, trx);
      return [accountWallet, accountLedger, overview] as const;
    });
    return res.status(200).send(success({ wallet, ledger, billingOverview }));
  } catch (err) {
    return sendWalletError(res, err);
  }
});

router.post("/ledger/list", async (req, res) => {
  const parsed = overviewSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  try {
    const userId = authUserId(req);
    if (!userId) return res.status(401).send({ message: "未登录" });
    const workspaceId = serverWorkspaceId(req, parsed.data.workspaceId);
    const ledger = await db.transaction(async (trx) => {
      await requireWalletWorkspaceAuthority({ trx, req, workspaceId });
      return await listWorkspaceAccountWalletLedger({
        trx,
        userId,
        workspaceId,
        pageNum: parsed.data.pageNum,
        pageSize: parsed.data.pageSize,
      });
    });
    return res.status(200).send(success(ledger));
  } catch (err) {
    return sendWalletError(res, err);
  }
});

router.post("/allocate", async (req, res) => {
  const parsed = allocateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  try {
    const userId = authUserId(req);
    if (!userId) return res.status(401).send({ message: "未登录" });
    const workspaceId = serverWorkspaceId(req, parsed.data.workspaceId);
    const result = await db.transaction(async (trx) => {
      const authority = await requireWalletWorkspaceAuthority({
        trx,
        req,
        workspaceId,
      });
      if (authority.ownerUserId !== userId) {
        throw new WorkspaceAuthorityError(
          "只能从账号钱包分配额度到自己拥有的工作区",
          "WORKSPACE_OWNER_REQUIRED",
          403,
        );
      }

      const allocation = await allocateAccountWalletToWorkspaceInTransaction(trx, {
        userId: authority.ownerUserId,
        workspaceId,
        amountMicros: parsed.data.amountMicros,
        description: parsed.data.description || "分配工作区消费额度",
        metadata: {
          ...(parsed.data.metadata || {}),
          source: "billing_wallet_api",
        },
        idempotencyKey: parsed.data.idempotencyKey,
        operatorUserId: userId,
      });
      await writeAuditLog(req, {
        workspaceId,
        action: "billing.wallet.allocate",
        resourceType: "billing_workspace_quota",
        resourceId: allocation.workspaceLedger.id,
        required: true,
        actor: {
          actorUserId: Number(authority.actor.id),
          actorRole: normalizeActorRole(authority.role),
          actorKind: "authenticated",
        },
        metadata: {
          amountMicros: parsed.data.amountMicros,
          workspaceLedgerId: allocation.workspaceLedger.id,
          allocationOwnerUserId: authority.ownerUserId,
          allocationRequestDigest:
            allocation.workspaceLedger.metadata.allocationRequestDigest,
        },
      }, trx);
      return allocation;
    });
    return res.status(200).send(success(result));
  } catch (err) {
    return sendWalletError(res, err);
  }
});

export default router;
