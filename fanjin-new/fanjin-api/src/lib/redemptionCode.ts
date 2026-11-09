import { guMicrosPerGu } from "@/lib/billingUnits";
// 兑换码系统：管理员生成兑换码，用户兑换充值
import { randomInt } from "node:crypto";
import { db } from "@/utils/db";
import { v4 as uuid } from "uuid";
import { applyAccountWalletCredit } from "@/lib/accountWallet";

const now = () => Date.now();
const MAX_REDEMPTION_BATCH_SIZE = 1000;
const MAX_BATCH_COLLISION_RETRIES = 5;
const REDEMPTION_INSERT_CHUNK_SIZE = 100;

function assertGenerationInput(input: {
  count: number;
  amountMicros: number;
  currency?: string;
  expiresAt?: number | null;
  operatorUserId: number;
}) {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_REDEMPTION_BATCH_SIZE) {
    throw new RangeError(`兑换码生成数量必须是 1–${MAX_REDEMPTION_BATCH_SIZE} 的整数`);
  }
  if (!Number.isInteger(input.amountMicros) || input.amountMicros <= 0) {
    throw new RangeError("兑换码面值必须是正整数 micros");
  }
  if (input.currency !== undefined && input.currency !== "GU") {
    throw new RangeError("兑换码仅支持 GU");
  }
  if (input.expiresAt != null && (!Number.isInteger(input.expiresAt) || input.expiresAt <= 0)) {
    throw new RangeError("兑换码到期时间必须是正整数时间戳");
  }
  if (!Number.isInteger(input.operatorUserId) || input.operatorUserId <= 0) {
    throw new RangeError("兑换码操作人无效");
  }
}

function isUniqueConstraintError(error: unknown) {
  const record = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {};
  const code = String(record.code || "");
  const message = String(record.message || "");
  return code === "23505"
    || code === "ER_DUP_ENTRY"
    || code.startsWith("SQLITE_CONSTRAINT")
    || /unique constraint|duplicate entry|duplicate key/i.test(message);
}

function generateUniqueCodeSet(count: number) {
  const codes = new Set<string>();
  const maxAttempts = Math.max(32, count * 20);
  for (let attempt = 0; codes.size < count && attempt < maxAttempts; attempt += 1) {
    codes.add(generateCode());
  }
  if (codes.size !== count) throw new Error("兑换码随机空间冲突过多，请重试");
  return [...codes];
}

// 管理员批量生成兑换码
export async function generateRedemptionCodes(input: {
  count: number;
  amountMicros: number; // 每张兑换码的面值（µs）
  currency?: string;
  expiresAt?: number | null;
  batchNote?: string;
  operatorUserId: number;
}): Promise<{ batchId: string; codes: string[] }> {
  assertGenerationInput(input);

  for (let batchAttempt = 0; batchAttempt < MAX_BATCH_COLLISION_RETRIES; batchAttempt += 1) {
    const batchId = uuid();
    const codes = generateUniqueCodeSet(input.count);
    const timestamp = now();
    const rows = codes.map((code) => ({
      id: uuid(),
      code,
      batchId,
      amountMicros: input.amountMicros,
      currency: input.currency || "GU",
      status: "unused",
      expiresAt: input.expiresAt ?? null,
      batchNote: input.batchNote?.trim() || null,
      createdBy: input.operatorUserId,
      createTime: timestamp,
      updateTime: timestamp,
    }));

    try {
      await db.transaction(async (trx) => {
        for (let offset = 0; offset < rows.length; offset += REDEMPTION_INSERT_CHUNK_SIZE) {
          await trx("o_redemption_code").insert(rows.slice(offset, offset + REDEMPTION_INSERT_CHUNK_SIZE));
        }
      });
      return { batchId, codes };
    } catch (error) {
      if (!isUniqueConstraintError(error) || batchAttempt === MAX_BATCH_COLLISION_RETRIES - 1) throw error;
    }
  }

  throw new Error("兑换码生成失败，请重试");
}

// 用户兑换
export async function redeemCode(input: {
  code: string;
  userId: number;
  workspaceId?: string;
}): Promise<{ ok: boolean; amountMicros: number; message: string }> {
  const code = input.code.trim().toUpperCase();
  if (!code) return { ok: false, amountMicros: 0, message: "兑换码不能为空" };

  const row = await db("o_redemption_code").where({ code }).first();
  if (!row) return { ok: false, amountMicros: 0, message: "兑换码不存在" };
  if (row.status === "redeemed") return { ok: false, amountMicros: 0, message: "兑换码已被使用" };
  if (row.status === "disabled") return { ok: false, amountMicros: 0, message: "兑换码已被禁用" };
  if (row.expiresAt && row.expiresAt < now()) return { ok: false, amountMicros: 0, message: "兑换码已过期" };

  // 在同一事务内完成「标记已用 + 充值」，避免扣码成功但充值失败导致的「扣码不到账」。
  // CAS 更新（status=unused -> redeemed）防重复兑换；充值带幂等键，确保即使重试也不会重复到账。
  try {
    await db.transaction(async (trx) => {
      const updated = await trx("o_redemption_code")
        .where({ id: row.id, status: "unused" })
        .update({
          status: "redeemed",
          redeemedBy: input.userId,
          redeemedAt: now(),
          updateTime: now(),
        });

      if (!updated) {
        throw Object.assign(new Error("兑换码已被使用"), { code: "ALREADY_REDEEMED" });
      }

      await applyAccountWalletCredit(trx, {
        userId: input.userId,
        amountMicros: row.amountMicros,
        currency: row.currency,
        type: "recharge",
        description: `兑换码充值: ${code}`,
        idempotencyKey: `redeem:${row.id}`,
        metadata: { redemptionCodeId: row.id, code },
      });
    });
  } catch (err: any) {
    if (err?.code === "ALREADY_REDEEMED") {
      return { ok: false, amountMicros: 0, message: "兑换码已被使用" };
    }
    throw err;
  }

  return { ok: true, amountMicros: row.amountMicros, message: `兑换成功，获得 ${(row.amountMicros / guMicrosPerGu).toFixed(2)} ${row.currency}` };
}

// 管理员查询兑换码列表
export async function listRedemptionCodes(input: {
  page?: number;
  pageSize?: number;
  status?: string;
  batchId?: string;
}): Promise<{ total: number; items: any[] }> {
  const page = Math.max(1, input.page || 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize || 20));
  const offset = (page - 1) * pageSize;

  let query = db("o_redemption_code");
  if (input.status) query = query.where({ status: input.status });
  if (input.batchId) query = query.where({ batchId: input.batchId });

  const [{ total }] = await query.clone().count({ total: "*" });
  // A batch can contain many rows created in the same millisecond. The id
  // tiebreaker keeps offset pagination deterministic so clients cannot receive
  // duplicates or miss codes while fetching the complete batch.
  const items = await query.orderBy("createTime", "desc").orderBy("id", "desc").offset(offset).limit(pageSize);

  return { total: Number(total), items };
}

// 管理员禁用兑换码
export async function disableRedemptionCode(id: string): Promise<
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_unused"; status: string }
> {
  const count = await db("o_redemption_code").where({ id, status: "unused" }).update({ status: "disabled", updateTime: now() });
  if (Number(count) > 0) return { ok: true };
  const existing = await db("o_redemption_code").select("status").where({ id }).first();
  if (!existing) return { ok: false, reason: "not_found" };
  return { ok: false, reason: "not_unused", status: String(existing.status || "unknown") };
}

// 生成兑换码：FJ-XXXX-XXXX-XXXX 格式（大写字母+数字，排除易混淆字符）
function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const segments: string[] = [];
  for (let s = 0; s < 3; s++) {
    let seg = "";
    for (let i = 0; i < 4; i++) seg += chars[randomInt(chars.length)];
    segments.push(seg);
  }
  return `FJ-${segments.join("-")}`;
}
