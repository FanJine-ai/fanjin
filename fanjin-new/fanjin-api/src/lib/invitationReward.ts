// 邀请奖励系统：用户邀请他人注册，双方获得奖励额度
import { db } from "@/utils/db";
import { v4 as uuid } from "uuid";
import { applyAccountWalletCredit } from "@/lib/accountWallet";
import { guMicrosPerGu } from "@/lib/billingUnits";

const now = () => Date.now();

// 邀请奖励配置（可从平台设置读取，这里给默认值）
const DEFAULT_INVITER_REWARD_MICROS = 10_000_000; // 0.1 GU (¥0.01); retain the original reward value.
const DEFAULT_INVITEE_REWARD_MICROS = 5_000_000; // 0.05 GU (¥0.005)

// 生成用户的邀请码（注册时调用）
export async function ensureInvitationCode(userId: number): Promise<string> {
  const existing = await db("o_user").where({ id: userId }).select("invitationCode").first();
  if (existing?.invitationCode) return existing.invitationCode;

  const code = generateInvitationCode();
  await db("o_user").where({ id: userId }).update({ invitationCode: code });
  return code;
}

// 用户注册时使用邀请码
export async function processInvitation(input: {
  inviteeUserId: number;
  invitationCode: string;
}): Promise<{ ok: boolean; inviterRewardMicros: number; inviteeRewardMicros: number; message: string }> {
  const code = input.invitationCode.trim().toUpperCase();
  if (!code) return { ok: false, inviterRewardMicros: 0, inviteeRewardMicros: 0, message: "邀请码为空" };

  // 找到邀请人
  const inviter = await db("o_user").where({ invitationCode: code }).select("id", "name").first();
  if (!inviter) return { ok: false, inviterRewardMicros: 0, inviteeRewardMicros: 0, message: "邀请码无效" };
  if (inviter.id === input.inviteeUserId) return { ok: false, inviterRewardMicros: 0, inviteeRewardMicros: 0, message: "不能邀请自己" };

  // 提前查重做快速失败（友好提示）；真正的并发防线是 o_invitation_record.inviteeUserId 的唯一约束。
  const existing = await db("o_invitation_record").where({ inviteeUserId: input.inviteeUserId }).first();
  if (existing) return { ok: false, inviterRewardMicros: 0, inviteeRewardMicros: 0, message: "该用户已有邀请记录" };

  const inviterRewardMicros = Number(process.env.FANJIN_INVITER_REWARD_MICROS) || DEFAULT_INVITER_REWARD_MICROS;
  const inviteeRewardMicros = Number(process.env.FANJIN_INVITEE_REWARD_MICROS) || DEFAULT_INVITEE_REWARD_MICROS;
  const recordId = uuid();

  // 在同一事务内完成「插入邀请记录 + 两笔奖励发放」，避免出现「记录已插但奖励漏发」或
  // 「只发了一方」的不一致。两笔奖励各带幂等键，唯一约束冲突时优雅转为「已有邀请记录」。
  try {
    await db.transaction(async (trx) => {
      await trx("o_invitation_record").insert({
        id: recordId,
        inviterUserId: inviter.id,
        inviteeUserId: input.inviteeUserId,
        invitationCode: code,
        inviterRewardMicros,
        inviteeRewardMicros,
        status: "rewarded",
        createTime: now(),
      });

      if (inviterRewardMicros > 0) {
        await applyAccountWalletCredit(trx, {
          userId: inviter.id,
          amountMicros: inviterRewardMicros,
          currency: "GU",
          type: "recharge",
          description: `邀请奖励: 用户 ${input.inviteeUserId} 通过你的邀请码注册`,
          idempotencyKey: `invite:${recordId}:inviter`,
          metadata: { inviteeUserId: input.inviteeUserId, invitationCode: code },
        });
      }

      if (inviteeRewardMicros > 0) {
        await applyAccountWalletCredit(trx, {
          userId: input.inviteeUserId,
          amountMicros: inviteeRewardMicros,
          currency: "GU",
          type: "recharge",
          description: `注册奖励: 使用邀请码 ${code}`,
          idempotencyKey: `invite:${recordId}:invitee`,
          metadata: { inviterUserId: inviter.id, invitationCode: code },
        });
      }
    });
  } catch (err: any) {
    // 并发下唯一约束冲突：说明已被另一请求处理
    if (/unique|constraint|duplicate/i.test(String(err?.message || ""))) {
      return { ok: false, inviterRewardMicros: 0, inviteeRewardMicros: 0, message: "该用户已有邀请记录" };
    }
    throw err;
  }

  return {
    ok: true,
    inviterRewardMicros,
    inviteeRewardMicros,
    message: `邀请成功！你获得 ${(inviteeRewardMicros / guMicrosPerGu).toFixed(2)} GU，邀请人获得 ${(inviterRewardMicros / guMicrosPerGu).toFixed(2)} GU`,
  };
}

// 查询用户的邀请记录
export async function listInvitations(userId: number, page = 1, pageSize = 20): Promise<{ total: number; items: any[] }> {
  const offset = (page - 1) * pageSize;
  const [{ total }] = await db("o_invitation_record").where({ inviterUserId: userId }).count({ total: "*" });
  const items = await db("o_invitation_record")
    .where({ inviterUserId: userId })
    .join("o_user", "o_invitation_record.inviteeUserId", "o_user.id")
    .select(
      "o_invitation_record.id",
      "o_invitation_record.inviteeUserId",
      "o_user.name as inviteeName",
      "o_invitation_record.inviterRewardMicros",
      "o_invitation_record.inviteeRewardMicros",
      "o_invitation_record.status",
      "o_invitation_record.createTime",
    )
    .orderBy("o_invitation_record.createTime", "desc")
    .offset(offset)
    .limit(pageSize);
  return { total: Number(total), items };
}

// 统计用户邀请数据
export async function getInvitationStats(userId: number): Promise<{
  totalInvited: number;
  totalRewardMicros: number;
}> {
  const row = await db("o_invitation_record")
    .where({ inviterUserId: userId })
    .count({ total: "*" })
    .sum({ reward: "inviterRewardMicros" })
    .first();
  return {
    totalInvited: Number(row?.total || 0),
    totalRewardMicros: Number(row?.reward || 0),
  };
}

function generateInvitationCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
