import { createHash } from "node:crypto";
import type { Knex } from "knex";

export const PRICING_GROUP_TABLE = "o_pricing_group" as const;
export const PRICING_GROUP_CODE_INDEX = "uq_o_pricing_group_code" as const;
export const PRICING_GROUP_STATUS_INDEX = "idx_o_pricing_group_status_order" as const;

export const PRICING_GROUP_REGISTRY_REQUIRED_CONSTRAINTS = [
  `table:${PRICING_GROUP_TABLE}`,
  `primary-key:${PRICING_GROUP_TABLE}.id`,
  `not-null:${PRICING_GROUP_TABLE}.code`,
  `not-null:${PRICING_GROUP_TABLE}.name`,
  `not-null:${PRICING_GROUP_TABLE}.status`,
  `not-null:${PRICING_GROUP_TABLE}.sortOrder`,
  `not-null:${PRICING_GROUP_TABLE}.createdAt`,
  `not-null:${PRICING_GROUP_TABLE}.updatedAt`,
  `index:${PRICING_GROUP_TABLE}.${PRICING_GROUP_CODE_INDEX}`,
  `index:${PRICING_GROUP_TABLE}.${PRICING_GROUP_STATUS_INDEX}`,
] as const;

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

function normalize(value: unknown): string {
  const code = String(value || "").trim().toLowerCase();
  return code
    && code !== "default"
    && code.length <= 48
    && !/[\u0000-\u001f\u007f]/u.test(code)
    ? code
    : "";
}

function deterministicId(code: string): string {
  return `pricing-group-${createHash("sha256").update(code).digest("hex")}`;
}

async function legacyGroupCodes(trx: Knex.Transaction): Promise<string[]> {
  const groups = new Set<string>();
  if (await trx.schema.hasTable("o_user_commercial_profile")) {
    const profiles = await trx("o_user_commercial_profile").whereNotNull("pricingGroup").select("pricingGroup");
    for (const profile of profiles) {
      const code = normalize(profile.pricingGroup);
      if (code) groups.add(code);
    }
  }
  if (await trx.schema.hasTable("o_pricing_rule")) {
    const rows = await trx("o_pricing_rule").select("ruleConfig");
    for (const row of rows) {
      const config = object(row.ruleConfig);
      const audience = object(config?.audiencePricing);
      if (!Array.isArray(audience?.groups)) continue;
      for (const candidate of audience.groups) {
        const code = normalize(object(candidate)?.group);
        if (code) groups.add(code);
      }
    }
  }
  return [...groups].sort();
}

export async function upPricingGroupRegistry(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(PRICING_GROUP_TABLE))) {
    await trx.schema.createTable(PRICING_GROUP_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.text("code").notNullable().unique(PRICING_GROUP_CODE_INDEX);
      table.text("name").notNullable();
      table.text("description");
      table.text("status").notNullable().defaultTo("active");
      table.bigInteger("sortOrder").notNullable().defaultTo(0);
      table.bigInteger("createdByUserId");
      table.bigInteger("updatedByUserId");
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
      table.index(["status", "sortOrder", "code"], PRICING_GROUP_STATUS_INDEX);
      table.check("\"status\" IN ('active', 'disabled')", {}, "chk_o_pricing_group_status");
      table.check(
        "\"code\" = lower(trim(\"code\")) AND length(\"code\") BETWEEN 1 AND 48 AND \"code\" <> 'default'",
        {},
        "chk_o_pricing_group_code",
      );
      table.check("\"sortOrder\" BETWEEN -10000 AND 10000", {}, "chk_o_pricing_group_sort_order");
    });
  }

  const now = Date.now();
  for (const code of await legacyGroupCodes(trx)) {
    const existing = await trx(PRICING_GROUP_TABLE).where({ code }).first();
    if (existing) continue;
    await trx(PRICING_GROUP_TABLE).insert({
      id: deterministicId(code),
      code,
      name: code,
      description: "由历史用户或模型价格规则自动导入",
      status: "active",
      sortOrder: 0,
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (await trx.schema.hasTable("o_user_commercial_profile")) {
    const profiles = await trx("o_user_commercial_profile").whereNotNull("pricingGroup").select("userId", "pricingGroup");
    for (const profile of profiles) {
      const code = normalize(profile.pricingGroup);
      await trx("o_user_commercial_profile").where({ userId: profile.userId }).update({
        pricingGroup: code || null,
      });
    }
  }
}

export async function downPricingGroupRegistry(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(PRICING_GROUP_TABLE)) {
    await trx.schema.dropTable(PRICING_GROUP_TABLE);
  }
}
