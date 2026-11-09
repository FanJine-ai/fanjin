import crypto from "node:crypto";
import type { Knex } from "knex";

import {
  CommercialTenantError,
  normalizeCommercialHost,
  runtimeCommercialTenantByHost,
  runtimeCommercialTenantById,
} from "@/lib/commercialTenant";
import { createSession } from "@/lib/auth";
import { db } from "@/utils/db";

const TABLE = "o_tenant_auth_transfer";
const DEFAULT_TTL_MS = 90_000;

function codeHash(code: string) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function normalizeRedirectPath(value: unknown): string {
  const path = String(value || "/").trim() || "/";
  if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path)) return "/";
  return path.slice(0, 1500);
}

async function validatedTargetOrigin(value: unknown, expectedTenantId?: string | null) {
  let url: URL;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new CommercialTenantError("目标域名无效", 400, "TENANT_TRANSFER_TARGET_INVALID");
  }
  const host = normalizeCommercialHost(url.hostname);
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new CommercialTenantError("跨域登录目标必须使用 HTTPS", 400, "TENANT_TRANSFER_TARGET_INVALID");
  }
  const tenant = await runtimeCommercialTenantByHost(db, host);
  if (!tenant.hosts.includes(host) && !local) {
    throw new CommercialTenantError("跨域登录目标未登记", 400, "TENANT_TRANSFER_TARGET_INVALID");
  }
  if (expectedTenantId) {
    const expectedTenant = await runtimeCommercialTenantById(db, expectedTenantId);
    if (tenant.id !== expectedTenant.id) {
      throw new CommercialTenantError("目标域名与租户不匹配", 400, "TENANT_TRANSFER_TARGET_MISMATCH");
    }
  }
  return { origin: url.origin, tenant };
}

export async function createTenantAuthTransfer(input: {
  userId: number;
  sourceTenantId: string;
  targetOrigin: string;
  targetTenantId?: string | null;
  redirectPath?: string | null;
}) {
  const sourceTenant = await runtimeCommercialTenantById(db, input.sourceTenantId);
  const target = await validatedTargetOrigin(input.targetOrigin, input.targetTenantId);
  const userId = Number(input.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new CommercialTenantError("登录用户无效", 401, "TENANT_TRANSFER_USER_INVALID");
  }
  const user = await db("o_user").where({ id: userId, status: "active" }).first();
  if (!user) throw new CommercialTenantError("账号不可用", 401, "TENANT_TRANSFER_USER_INVALID");

  const code = crypto.randomBytes(32).toString("base64url");
  const timestamp = Date.now();
  const ttl = Number(process.env.FANJIN_TENANT_AUTH_CODE_TTL_MS || DEFAULT_TTL_MS);
  const expiresAt = timestamp + (Number.isSafeInteger(ttl) && ttl >= 30_000 && ttl <= 300_000 ? ttl : DEFAULT_TTL_MS);
  const redirectPath = normalizeRedirectPath(input.redirectPath);
  await db(TABLE).insert({
    id: crypto.randomUUID(),
    codeHash: codeHash(code),
    userId,
    sourceTenantId: sourceTenant.id,
    targetTenantId: target.tenant.id,
    targetOrigin: target.origin,
    redirectPath,
    expiresAt,
    usedAt: null,
    createdAt: timestamp,
  });
  const params = new URLSearchParams({ tenant_code: code, redirect: redirectPath });
  return {
    targetTenantId: target.tenant.id,
    expiresAt,
    redirectUrl: `${target.origin}/#/auth/oauth/callback?${params.toString()}`,
  };
}

export async function exchangeTenantAuthTransfer(input: {
  code: string;
  requestTenantId: string;
  requestOrigin: string;
  userAgent?: string | null;
  ip?: string | null;
}) {
  const code = String(input.code || "").trim();
  if (!code || code.length > 200) {
    throw new CommercialTenantError("跨域登录码无效", 400, "TENANT_TRANSFER_CODE_INVALID");
  }
  const requestTenant = await runtimeCommercialTenantById(db, input.requestTenantId);
  const requestTarget = await validatedTargetOrigin(input.requestOrigin, requestTenant.id);
  const timestamp = Date.now();
  return await db.transaction(async (trx: Knex.Transaction) => {
    const row = await trx(TABLE).where({ codeHash: codeHash(code) }).first();
    if (!row || row.usedAt || Number(row.expiresAt || 0) <= timestamp) {
      throw new CommercialTenantError("跨域登录码已失效", 400, "TENANT_TRANSFER_CODE_EXPIRED");
    }
    if (String(row.targetTenantId) !== requestTenant.id || String(row.targetOrigin) !== requestTarget.origin) {
      throw new CommercialTenantError("跨域登录码不能在当前域名使用", 403, "TENANT_TRANSFER_TARGET_MISMATCH");
    }
    const claimed = await trx(TABLE)
      .where({ id: row.id, codeHash: row.codeHash })
      .whereNull("usedAt")
      .andWhere("expiresAt", ">", timestamp)
      .update({ usedAt: timestamp });
    if (Number(claimed || 0) !== 1) {
      throw new CommercialTenantError("跨域登录码已被使用", 409, "TENANT_TRANSFER_CODE_REPLAYED");
    }
    const user = await trx("o_user").where({ id: Number(row.userId), status: "active" }).first();
    if (!user) throw new CommercialTenantError("账号不可用", 401, "TENANT_TRANSFER_USER_INVALID");
    const session = await createSession(trx, user, {
      userAgent: input.userAgent || undefined,
      ip: input.ip || undefined,
    });
    const { rawToken: _rawToken, ...publicSession } = session as any;
    return publicSession;
  });
}
