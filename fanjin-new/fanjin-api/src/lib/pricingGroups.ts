import { v4 as uuid } from "uuid";
import type { Knex } from "knex";
import {
  DEFAULT_PRICING_GROUP,
  normalizePricingGroup,
  readPricingAudienceContract,
} from "@/lib/pricingAudience";
import { PRICING_GROUP_TABLE } from "@/lib/migrations/pricingGroupRegistry";

type Database = Knex | Knex.Transaction;

export type PricingGroupStatus = "active" | "disabled";

export interface PricingGroupView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: PricingGroupStatus;
  sortOrder: number;
  memberCount: number;
  pricingTargetCount: number;
  isDefault: boolean;
  canDelete: boolean;
  createdAt: number | null;
  updatedAt: number | null;
}

export class PricingGroupError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "PricingGroupError";
  }
}

function clean(value: unknown): string {
  return String(value || "").trim();
}

function object(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function validatePricingGroupCode(value: unknown): string | null {
  const raw = clean(value);
  const code = normalizePricingGroup(raw);
  if (!raw || code === DEFAULT_PRICING_GROUP) return "分组代码不能为空，且 default 为系统保留分组";
  if (code.length > 48 || /[\u0000-\u001f\u007f]/u.test(code)) {
    return "分组代码需为 1-48 个非控制字符";
  }
  return null;
}

function pricingTargetKeys(rows: Array<Record<string, unknown>>): Map<string, Set<string>> {
  const byGroup = new Map<string, Set<string>>();
  for (const row of rows) {
    const contract = readPricingAudienceContract(object(row.ruleConfig));
    if (!contract) continue;
    const targetKey = [
      clean(row.scope),
      clean(row.workspaceId),
      clean(row.endpointType),
      clean(row.model),
    ].join(":");
    for (const group of contract.groups) {
      const targets = byGroup.get(group.group) ?? new Set<string>();
      targets.add(targetKey);
      byGroup.set(group.group, targets);
    }
  }
  return byGroup;
}

export async function listPricingGroups(database: Database): Promise<PricingGroupView[]> {
  const [rows, profiles, users, pricingRows] = await Promise.all([
    database(PRICING_GROUP_TABLE).orderBy("sortOrder", "asc").orderBy("code", "asc"),
    database("o_user_commercial_profile").select("userId", "pricingGroup"),
    database("o_user").select("id"),
    database("o_pricing_rule").select("scope", "workspaceId", "endpointType", "model", "ruleConfig"),
  ]);
  const profileByUser = new Map(profiles.map((row: Record<string, unknown>) => [Number(row.userId), normalizePricingGroup(row.pricingGroup)]));
  const memberCounts = new Map<string, number>();
  for (const user of users) {
    const group = profileByUser.get(Number(user.id)) || DEFAULT_PRICING_GROUP;
    memberCounts.set(group, (memberCounts.get(group) || 0) + 1);
  }
  const priceTargets = pricingTargetKeys(pricingRows);
  const custom = rows.map((row: Record<string, unknown>): PricingGroupView => {
    const code = normalizePricingGroup(row.code);
    const memberCount = memberCounts.get(code) || 0;
    const pricingTargetCount = priceTargets.get(code)?.size || 0;
    return {
      id: clean(row.id),
      code,
      name: clean(row.name) || code,
      description: clean(row.description) || null,
      status: row.status === "disabled" ? "disabled" : "active",
      sortOrder: Number(row.sortOrder || 0),
      memberCount,
      pricingTargetCount,
      isDefault: false,
      canDelete: memberCount === 0 && pricingTargetCount === 0,
      createdAt: Number(row.createdAt || 0) || null,
      updatedAt: Number(row.updatedAt || 0) || null,
    };
  });
  return [{
    id: DEFAULT_PRICING_GROUP,
    code: DEFAULT_PRICING_GROUP,
    name: "默认分组",
    description: "未分配自定义定价分组的所有用户",
    status: "active",
    sortOrder: -1,
    memberCount: memberCounts.get(DEFAULT_PRICING_GROUP) || 0,
    pricingTargetCount: 0,
    isDefault: true,
    canDelete: false,
    createdAt: null,
    updatedAt: null,
  }, ...custom];
}

export async function requireActivePricingGroup(
  database: Database,
  value: unknown,
): Promise<string | null> {
  const raw = clean(value);
  if (!raw || normalizePricingGroup(raw) === DEFAULT_PRICING_GROUP) return null;
  const code = normalizePricingGroup(raw);
  const query = database(PRICING_GROUP_TABLE).where({ code });
  if ((database as Knex.Transaction).isTransaction) query.forUpdate();
  const row = await query.first();
  if (!row) throw new PricingGroupError("定价分组不存在，请先创建分组", "PRICING_GROUP_NOT_FOUND", 409);
  if (row.status !== "active") throw new PricingGroupError("定价分组已停用，不能继续分配或引用", "PRICING_GROUP_DISABLED", 409);
  return code;
}

export async function validatePricingGroupReferences(
  database: Database,
  ruleConfig: unknown,
): Promise<Array<{ group: string; message: string }>> {
  const contract = readPricingAudienceContract(ruleConfig);
  if (!contract) return [];
  const codes = [...new Set(contract.groups.map((group) => group.group))];
  if (!codes.length) return [];
  const query = database(PRICING_GROUP_TABLE).whereIn("code", codes);
  if ((database as Knex.Transaction).isTransaction) query.forUpdate();
  const rows = await query.select("code", "status");
  const byCode = new Map(rows.map((row: Record<string, unknown>) => [normalizePricingGroup(row.code), row.status]));
  return codes.flatMap((code) => {
    const status = byCode.get(code);
    if (!status) return [{ group: code, message: `定价分组 ${code} 尚未创建` }];
    if (status !== "active") return [{ group: code, message: `定价分组 ${code} 已停用` }];
    return [];
  });
}

export async function createPricingGroup(
  database: Database,
  input: { code: string; name: string; description?: string | null; sortOrder?: number; actorUserId: number },
): Promise<PricingGroupView> {
  const codeError = validatePricingGroupCode(input.code);
  if (codeError) throw new PricingGroupError(codeError, "PRICING_GROUP_CODE_INVALID");
  const code = normalizePricingGroup(input.code);
  const now = Date.now();
  try {
    await database(PRICING_GROUP_TABLE).insert({
      id: uuid(),
      code,
      name: clean(input.name) || code,
      description: clean(input.description) || null,
      status: "active",
      sortOrder: Number.isSafeInteger(input.sortOrder) ? input.sortOrder : 0,
      createdByUserId: input.actorUserId || null,
      updatedByUserId: input.actorUserId || null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (/unique|duplicate|constraint/i.test(String((error as Error)?.message || ""))) {
      throw new PricingGroupError("分组代码已经存在", "PRICING_GROUP_CODE_CONFLICT", 409);
    }
    throw error;
  }
  return (await listPricingGroups(database)).find((group) => group.code === code)!;
}

export async function updatePricingGroup(
  database: Database,
  input: { code: string; name?: string; description?: string | null; status?: PricingGroupStatus; sortOrder?: number; actorUserId: number },
): Promise<PricingGroupView> {
  const code = normalizePricingGroup(input.code);
  if (code === DEFAULT_PRICING_GROUP) throw new PricingGroupError("默认分组不能修改", "PRICING_GROUP_DEFAULT_IMMUTABLE", 409);
  const current = await database(PRICING_GROUP_TABLE).where({ code }).forUpdate().first();
  if (!current) throw new PricingGroupError("定价分组不存在", "PRICING_GROUP_NOT_FOUND", 404);
  if (input.status === "disabled") {
    const members = await database("o_user_commercial_profile").whereRaw("LOWER(TRIM(??)) = ?", ["pricingGroup", code]).count({ total: "userId" }).first();
    if (Number(members?.total || 0) > 0) {
      throw new PricingGroupError("该分组仍有用户，请先迁移成员后再停用", "PRICING_GROUP_HAS_MEMBERS", 409);
    }
  }
  const patch: Record<string, unknown> = { updatedAt: Date.now(), updatedByUserId: input.actorUserId || null };
  if (input.name !== undefined) patch.name = clean(input.name) || code;
  if (input.description !== undefined) patch.description = clean(input.description) || null;
  if (input.status !== undefined) patch.status = input.status;
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
  await database(PRICING_GROUP_TABLE).where({ code }).update(patch);
  return (await listPricingGroups(database)).find((group) => group.code === code)!;
}

export async function deletePricingGroup(database: Database, codeValue: unknown): Promise<void> {
  const code = normalizePricingGroup(codeValue);
  if (code === DEFAULT_PRICING_GROUP) throw new PricingGroupError("默认分组不能删除", "PRICING_GROUP_DEFAULT_IMMUTABLE", 409);
  const current = await database(PRICING_GROUP_TABLE).where({ code }).forUpdate().first();
  if (!current) throw new PricingGroupError("定价分组不存在", "PRICING_GROUP_NOT_FOUND", 404);
  const group = (await listPricingGroups(database)).find((candidate) => candidate.code === code);
  if (!group) throw new PricingGroupError("定价分组读取失败", "PRICING_GROUP_READBACK_FAILED", 500);
  if (!group.canDelete) {
    throw new PricingGroupError(
      `分组仍被 ${group.memberCount} 个用户和 ${group.pricingTargetCount} 个发布目标引用`,
      "PRICING_GROUP_IN_USE",
      409,
    );
  }
  await database(PRICING_GROUP_TABLE).where({ code }).delete();
}

export async function assignUsersToPricingGroup(
  database: Database,
  input: { userIds: number[]; code?: string | null },
): Promise<{ code: string; assigned: number }> {
  const userIds = [...new Set(input.userIds)];
  const code = await requireActivePricingGroup(database, input.code);
  const normalized = code || DEFAULT_PRICING_GROUP;
  const users = await database("o_user").whereIn("id", userIds).orderBy("id", "asc").forUpdate().select("id");
  if (users.length !== userIds.length) {
    throw new PricingGroupError("部分用户不存在，请刷新列表后重试", "PRICING_GROUP_USER_NOT_FOUND", 409);
  }
  const now = Date.now();
  for (const userId of userIds) {
    const existing = await database("o_user_commercial_profile").where({ userId }).first();
    if (existing) {
      await database("o_user_commercial_profile").where({ userId }).update({ pricingGroup: code, updatedAt: now });
    } else {
      await database("o_user_commercial_profile").insert({
        id: String(userId),
        userId,
        accountType: "personal",
        commercialGroup: "default",
        pricingGroup: code,
        rechargeDiscountBps: 10_000,
        billingMode: "prepaid",
        settlementType: "online",
        notes: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  return { code: normalized, assigned: userIds.length };
}
