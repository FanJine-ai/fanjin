import crypto from "node:crypto";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import {
  accountMfaGeneration,
  canReuseSessionStepUpAssurance,
  hashAuthToken,
  SESSION_STEP_UP_ASSURANCE_FORMAT,
  SESSION_STEP_UP_ASSURANCE_TOKEN_TYPE,
  sessionStepUpAssuranceTokenHash,
  upsertSessionStepUpAssurance,
  verifyPassword,
} from "@/lib/auth";
import { getAccountSecurityPolicy } from "@/lib/accountSecurity";
import { MfaError, verifyMfaCredential } from "@/lib/mfa";

type StepUpDb = Knex | Knex.Transaction;

export const stepUpScopes = [
  "account.security.update",
  "account.profile.sensitive",
  "account.oauth.unbind",
  "admin.user.create",
  "admin.user.profile",
  "admin.user.status",
  "admin.user.role",
  "admin.user.commercial",
  "admin.user.attribution",
  "admin.tenant_domain",
  "admin.tenant_certificate",
  "admin.tenant_ingress",
  "admin.tenant_reconciliation",
  "admin.billing.plan",
  "admin.billing.service_request",
  "admin.billing.reconciliation",
  "admin.finance.case",
  "admin.finance.gift_grant",
  "admin.finance.adjustment",
  "admin.model_route",
  "admin.portrait_asset_relay",
  "admin.portrait_review",
  "admin.pricing_rule",
  "admin.provider_channel",
  "admin.media_service",
  "admin.redemption",
  "admin.relay_task",
  "admin.release",
  "admin.deployment",
  "admin.backup.manage",
  "admin.backup.delete",
  "admin.backup.restore",
  "admin.request_log.export",
  "admin.request_log.purge",
  "admin.agent_runtime_config",
  "admin.system_settings",
  "admin.video_fulfillment",
  "api_key.create",
  "api_key.update",
  "api_key.rotate",
  "api_key.revoke",
  "workspace.member.manage",
  "workspace.owner.transfer",
  "legacy.vendor_config.manage",
  "legacy.agent_config.manage",
  "legacy.model_config.manage",
  "legacy.content_config.manage",
  "legacy.developer_config.manage",
  "legacy.memory_config.manage",
  "legacy.database.destructive",
] as const;
export type StepUpScope = (typeof stepUpScopes)[number];

export interface FinanceStepUpBindingV1 {
  bindingVersion: "finance-step-up/v1";
  operation:
    | "service_request_review"
    | "service_request_issue"
    | "service_request_recover";
  requestId: string;
  requestFingerprint: string;
  resourceType: "billing_service_request";
  resourceId: string;
  resourceFingerprint: string;
}

export interface ConsumedStepUpProof {
  proofRecordId: string;
  scope: StepUpScope;
  method: "password" | "totp" | "recovery";
  actorRole: string;
  authorizationRevision: number;
  expiresAt: number;
  consumedAt: number;
}

const mfaRequiredStepUpScopes = new Set<StepUpScope>([
  "admin.deployment",
  "admin.backup.delete",
  "admin.backup.restore",
]);

const STEP_UP_TOKEN_TYPE = "step_up_proof";
const STEP_UP_TTL_MS = 5 * 60 * 1000;
const STEP_UP_BATCH_TTL_MS = 45 * 60 * 1000;
const MAX_STEP_UP_BATCH_SIZE = 8;

export class StepUpError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "StepUpError";
    this.status = status;
    this.code = code;
  }
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function assertScope(scope: string): asserts scope is StepUpScope {
  if (!stepUpScopes.includes(scope as StepUpScope)) {
    throw new StepUpError("不支持的 step-up scope", 400, "STEP_UP_SCOPE_UNSUPPORTED");
  }
}

function currentMfaGeneration(row: any): string {
  return accountMfaGeneration(row);
}

async function lockStepUpTokenFamily(
  trx: Knex.Transaction,
  userId: number,
): Promise<any[]> {
  return await trx<any>("o_auth_token")
    .where({ userId, type: STEP_UP_TOKEN_TYPE })
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .forUpdate()
    .select("*");
}

async function markUnusedStepUpFamilyUsed(
  client: StepUpDb,
  userId: number,
  timestamp: number,
): Promise<void> {
  await (client as any)("o_auth_token")
    .where({ userId, type: STEP_UP_TOKEN_TYPE })
    .whereNull("usedAt")
    .update({ usedAt: timestamp });
}

async function issueVerifiedStepUpProofs(
  trx: Knex.Transaction,
  input: {
    user: any;
    session: any;
    securityRow: any;
    scopes: StepUpScope[];
    method: "password" | "totp" | "recovery";
  },
): Promise<Array<{
  proof: string;
  scope: StepUpScope;
  expiresAt: number;
  method: "password" | "totp" | "recovery";
}>> {
  const userId = Number(input.user.id);
  const sessionId = String(input.session.id);
  const proofs = input.scopes.map(() => crypto.randomBytes(32).toString("base64url"));
  const batchId = crypto.randomUUID();
  await lockStepUpTokenFamily(trx, userId);
  const timestamp = Date.now();
  const isBatch = input.scopes.length > 1;
  const expiresAt = timestamp + (isBatch ? STEP_UP_BATCH_TTL_MS : STEP_UP_TTL_MS);
  await markUnusedStepUpFamilyUsed(trx, userId, timestamp);
  await trx<any>("o_auth_token").insert(input.scopes.map((scope, index) => ({
    id: uuid(),
    userId,
    workspaceId: input.session.workspaceId ?? null,
    tokenHash: hashAuthToken(proofs[index]),
    type: STEP_UP_TOKEN_TYPE,
    metadata: JSON.stringify({
      sessionId,
      scope,
      passwordVersion: hashAuthToken(String(input.user.password || "")),
      authGeneration: Number(input.user.updatedAt || 0),
      mfaGeneration: currentMfaGeneration(input.securityRow),
      method: input.method,
      ...(isBatch ? {
        batchId,
        batchIndex: index,
        batchSize: input.scopes.length,
      } : {}),
    }),
    expiresAt,
    usedAt: null,
    createdAt: timestamp,
  })));
  return input.scopes.map((scope, index) => ({
    proof: proofs[index],
    scope,
    expiresAt,
    method: input.method,
  }));
}

export async function issueStepUpProof(
  knex: Knex,
  input: {
    userId: number;
    sessionId: string;
    scope: string;
    password: string;
    mfaCredential?: string | null;
  },
): Promise<{ proof: string; scope: StepUpScope; expiresAt: number; method: "password" | "totp" | "recovery" }> {
  const [issued] = await issueStepUpProofBatch(knex, {
    ...input,
    scopes: [input.scope],
  });
  return issued;
}

export async function issueStepUpProofBatch(
  knex: Knex,
  input: {
    userId: number;
    sessionId: string;
    scopes: string[];
    password: string;
    mfaCredential?: string | null;
  },
): Promise<Array<{
  proof: string;
  scope: StepUpScope;
  expiresAt: number;
  method: "password" | "totp" | "recovery";
}>> {
  if (!Array.isArray(input.scopes) || input.scopes.length < 1 || input.scopes.length > MAX_STEP_UP_BATCH_SIZE) {
    throw new StepUpError(
      `step-up 批次必须包含 1-${MAX_STEP_UP_BATCH_SIZE} 个操作`,
      400,
      "STEP_UP_BATCH_SIZE_INVALID",
    );
  }
  input.scopes.forEach(assertScope);
  const scopes = input.scopes as StepUpScope[];
  return await knex.transaction(async (trx) => {
    const user = await trx<any>("o_user")
      .where({ id: input.userId })
      .forUpdate()
      .first();
    const session = await trx<any>("o_user_session")
      .where({ id: input.sessionId, userId: input.userId })
      .whereNull("revokedAt")
      .forUpdate()
      .first();
    if (!user || String(user.status || "") !== "active" || !session) {
      throw new StepUpError("当前登录会话无效", 401, "STEP_UP_SESSION_INVALID");
    }
    if (!(await verifyPassword(input.password, user.password))) {
      throw new StepUpError("当前密码错误", 403, "STEP_UP_PASSWORD_INVALID");
    }
    const securityRow = await trx<any>("o_account_security")
      .where({ userId: input.userId })
      .forUpdate()
      .first();
    const security = await getAccountSecurityPolicy(trx, input.userId);
    if (scopes.some((scope) => mfaRequiredStepUpScopes.has(scope)) && !security.mfaEnabled) {
      throw new StepUpError(
        "此敏感操作要求账号先启用 MFA",
        403,
        "STEP_UP_MFA_ENROLLMENT_REQUIRED",
      );
    }
    if (security.mfaEnabled && !String(input.mfaCredential || "").trim()) {
      throw new StepUpError("此账号必须提供 TOTP 验证码或恢复码", 401, "STEP_UP_MFA_REQUIRED");
    }
    let verifiedMethod: "password" | "totp" | "recovery" = "password";
    if (security.mfaEnabled) {
      let verified: Awaited<ReturnType<typeof verifyMfaCredential>>;
      try {
        verified = await verifyMfaCredential(trx, {
          userId: input.userId,
          credential: String(input.mfaCredential || ""),
          // A TOTP may authorize at most one step-up proof during its replay
          // window. Keep this domain shared across every step-up scope so the
          // same code cannot mint several independent high-risk proofs.
          totpReplayDomain: "step-up-proof",
        });
      } catch (error) {
        if (error instanceof MfaError) throw new StepUpError(error.message, error.status, error.code);
        throw error;
      }
      if (!verified.valid || !verified.method) {
        throw new StepUpError("TOTP 验证码或恢复码错误", 401, "STEP_UP_MFA_INVALID");
      }
      verifiedMethod = verified.method;
    }
    if (canReuseSessionStepUpAssurance(user.role)) {
      await upsertSessionStepUpAssurance(trx, {
        user,
        session,
        securityRow,
        method: verifiedMethod,
      });
    }
    return await issueVerifiedStepUpProofs(trx, {
      user,
      session,
      securityRow,
      scopes,
      method: verifiedMethod,
    });
  });
}

export async function issueSessionStepUpProofBatch(
  knex: Knex,
  input: {
    userId: number;
    sessionId: string;
    scopes: string[];
  },
): Promise<Array<{
  proof: string;
  scope: StepUpScope;
  expiresAt: number;
  method: "password" | "totp" | "recovery";
}>> {
  if (!Array.isArray(input.scopes) || input.scopes.length < 1 || input.scopes.length > MAX_STEP_UP_BATCH_SIZE) {
    throw new StepUpError(
      `step-up 批次必须包含 1-${MAX_STEP_UP_BATCH_SIZE} 个操作`,
      400,
      "STEP_UP_BATCH_SIZE_INVALID",
    );
  }
  input.scopes.forEach(assertScope);
  const scopes = input.scopes as StepUpScope[];
  return await knex.transaction(async (trx) => {
    const user = await trx<any>("o_user")
      .where({ id: input.userId })
      .forUpdate()
      .first();
    const session = await trx<any>("o_user_session")
      .where({ id: input.sessionId, userId: input.userId })
      .whereNull("revokedAt")
      .forUpdate()
      .first();
    if (!user || String(user.status || "") !== "active" || !session) {
      throw new StepUpError("当前登录会话无效", 401, "STEP_UP_SESSION_INVALID");
    }
    if (!canReuseSessionStepUpAssurance(user.role)) {
      throw new StepUpError(
        "当前账号不能复用管理员登录验证",
        403,
        "STEP_UP_SESSION_REUSE_FORBIDDEN",
      );
    }
    const securityRow = await trx<any>("o_account_security")
      .where({ userId: input.userId })
      .forUpdate()
      .first();
    const security = await getAccountSecurityPolicy(trx, input.userId);
    if (scopes.some((scope) => mfaRequiredStepUpScopes.has(scope)) && !security.mfaEnabled) {
      throw new StepUpError(
        "此敏感操作要求账号先启用 MFA",
        403,
        "STEP_UP_MFA_ENROLLMENT_REQUIRED",
      );
    }

    const assurance = await trx<any>("o_auth_token")
      .where({
        userId: input.userId,
        type: SESSION_STEP_UP_ASSURANCE_TOKEN_TYPE,
        tokenHash: sessionStepUpAssuranceTokenHash(input.sessionId),
      })
      .whereNull("usedAt")
      .forUpdate()
      .first();
    const metadata = parseMetadata(assurance?.metadata);
    const method = String(metadata.method || "") as "password" | "totp" | "recovery";
    const authorizationRevision = Number(user.authorizationRevision ?? 1);
    const valid = Boolean(
      assurance
      && Number(assurance.expiresAt || 0) > Date.now()
      && String(assurance.workspaceId || "") === String(session.workspaceId || "")
      && metadata.format === SESSION_STEP_UP_ASSURANCE_FORMAT
      && String(metadata.sessionId || "") === input.sessionId
      && String(metadata.passwordVersion || "") === hashAuthToken(String(user.password || ""))
      && String(metadata.mfaGeneration || "") === currentMfaGeneration(securityRow)
      && Number(metadata.authorizationRevision) === authorizationRevision
      && ["password", "totp", "recovery"].includes(method)
      && (!security.mfaEnabled || method === "totp" || method === "recovery")
    );
    if (!valid) {
      if (assurance?.id) {
        await trx<any>("o_auth_token")
          .where({ id: assurance.id })
          .whereNull("usedAt")
          .update({ usedAt: Date.now() });
      }
      throw new StepUpError(
        "本次登录尚未完成可复用的管理员身份验证",
        401,
        "STEP_UP_SESSION_ASSURANCE_REQUIRED",
      );
    }
    return await issueVerifiedStepUpProofs(trx, {
      user,
      session,
      securityRow,
      scopes,
      method,
    });
  });
}

export async function consumeStepUpProof(
  client: StepUpDb,
  input: {
    proof: string;
    userId: number;
    sessionId: string;
    scope: string;
    financeBinding?: FinanceStepUpBindingV1;
  },
): Promise<ConsumedStepUpProof> {
  if (!(client as Knex.Transaction).isTransaction) {
    return await (client as Knex).transaction(
      (trx) => consumeStepUpProof(trx, input),
    );
  }
  assertScope(input.scope);
  const proof = String(input.proof || "").trim();
  if (!proof) throw new StepUpError("敏感操作需要 step-up proof", 401, "STEP_UP_REQUIRED");
  const user = await (client as any)("o_user")
    .where({ id: input.userId, status: "active" })
    .forUpdate()
    .first();
  if (!user) {
    throw new StepUpError(
      "账号不可用，请重新登录",
      401,
      "STEP_UP_SESSION_INVALID",
    );
  }
  const session = await (client as any)("o_user_session")
    .where({ id: input.sessionId, userId: input.userId })
    .whereNull("revokedAt")
    .forUpdate()
    .first();
  if (!session) {
    throw new StepUpError(
      "当前登录会话已失效",
      401,
      "STEP_UP_SESSION_INVALID",
    );
  }
  const securityRow = await (client as any)("o_account_security")
    .where({ userId: input.userId })
    .forUpdate()
    .first();
  const family = await lockStepUpTokenFamily(client as Knex.Transaction, input.userId);
  const row = family.find((item: any) => (
    String(item.tokenHash) === hashAuthToken(proof)
    && item.usedAt === null
  ));
  if (!row) throw new StepUpError("step-up proof 无效或已使用", 401, "STEP_UP_PROOF_INVALID");
  const timestamp = Date.now();
  if (Number(row.expiresAt || 0) <= timestamp) {
    await markUnusedStepUpFamilyUsed(client, input.userId, timestamp);
    throw new StepUpError("step-up proof 已过期", 401, "STEP_UP_PROOF_EXPIRED");
  }
  const metadata = parseMetadata(row.metadata);
  if (String(metadata.scope || "") !== input.scope) {
    throw new StepUpError("step-up proof scope 不匹配", 403, "STEP_UP_SCOPE_MISMATCH");
  }
  if (String(metadata.sessionId || "") !== input.sessionId) {
    throw new StepUpError("step-up proof 与当前会话不匹配", 403, "STEP_UP_SESSION_MISMATCH");
  }
  if (String(row.workspaceId || "") !== String(session.workspaceId || "")) {
    throw new StepUpError(
      "step-up proof 的工作区上下文已变化",
      403,
      "STEP_UP_SESSION_MISMATCH",
    );
  }
  if (
    String(metadata.passwordVersion || "") !== hashAuthToken(String(user.password || ""))
    || Number(metadata.authGeneration) !== Number(user.updatedAt || 0)
  ) {
    await markUnusedStepUpFamilyUsed(client, input.userId, timestamp);
    throw new StepUpError("账号凭据已变化，请重新验证", 401, "STEP_UP_CREDENTIAL_CHANGED");
  }
  const currentMfaVersion = currentMfaGeneration(securityRow);
  const proofMethod = String(metadata.method || "password");
  if (!["password", "totp", "recovery"].includes(proofMethod)) {
    await markUnusedStepUpFamilyUsed(client, input.userId, timestamp);
    throw new StepUpError(
      "step-up proof method 无效",
      401,
      "STEP_UP_PROOF_INVALID",
    );
  }
  if (
    mfaRequiredStepUpScopes.has(input.scope)
    && (!securityRow?.mfaEnabled || !["totp", "recovery"].includes(proofMethod))
  ) {
    await markUnusedStepUpFamilyUsed(client, input.userId, timestamp);
    throw new StepUpError(
      "此敏感操作必须使用已启用 MFA 的凭据重新验证",
      401,
      "STEP_UP_MFA_REQUIRED",
    );
  }
  if (String(metadata.mfaGeneration || "") !== currentMfaVersion) {
    await markUnusedStepUpFamilyUsed(client, input.userId, timestamp);
    throw new StepUpError("MFA 凭据状态已变化，请重新验证", 401, "STEP_UP_CREDENTIAL_CHANGED");
  }
  const authorizationRevision = Number(
    user.authorizationRevision ?? (input.financeBinding ? 0 : 1),
  );
  if (
    !Number.isSafeInteger(authorizationRevision) ||
    authorizationRevision < 1
  ) {
    await markUnusedStepUpFamilyUsed(client, input.userId, timestamp);
    throw new StepUpError(
      "账号授权版本无效，请重新登录",
      401,
      "STEP_UP_CREDENTIAL_CHANGED",
    );
  }
  const consumedMetadata = input.financeBinding
    ? { ...metadata, ...input.financeBinding, authorizationRevision }
    : metadata;
  const consumed = await (client as any)("o_auth_token")
    .where({ id: row.id, userId: input.userId, type: STEP_UP_TOKEN_TYPE })
    .whereNull("usedAt")
    .update({
      metadata: JSON.stringify(consumedMetadata),
      usedAt: timestamp,
    });
  if (Number(consumed) !== 1) {
    throw new StepUpError(
      "step-up proof 已被并发消费",
      401,
      "STEP_UP_PROOF_INVALID",
    );
  }
  const batchId = String(metadata.batchId || "");
  const siblingIds = batchId
    ? family
      .filter((item: any) => (
        item.usedAt === null
        && String(item.id) !== String(row.id)
        && String(parseMetadata(item.metadata).batchId || "") === batchId
      ))
      .map((item: any) => String(item.id))
    : [];
  await (client as any)("o_auth_token")
    .where({ userId: input.userId, type: STEP_UP_TOKEN_TYPE })
    .whereNot({ id: row.id })
    .modify((query: any) => {
      if (siblingIds.length) query.whereNotIn("id", siblingIds);
    })
    .whereNull("usedAt")
    .update({ usedAt: timestamp });
  return {
    proofRecordId: String(row.id),
    scope: input.scope,
    method: proofMethod as "password" | "totp" | "recovery",
    actorRole: String(user.role || ""),
    authorizationRevision,
    expiresAt: Number(row.expiresAt),
    consumedAt: timestamp,
  };
}
