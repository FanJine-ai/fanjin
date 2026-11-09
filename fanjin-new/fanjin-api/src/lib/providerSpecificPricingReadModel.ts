import type { Knex } from "knex";
import {
  applyPricingAudienceForGroup,
  applyPricingAudienceForWorkspace,
  type AudiencePricingResolution,
} from "@/lib/pricingAudience";

export type ProviderSpecificPricingDatabase = Knex | Knex.Transaction;

export interface ProviderSpecificPricingInput {
  workspaceId?: string | null;
  pricingGroup?: string | null;
  endpointType: string;
  provider: string;
  model?: string | null;
}

export interface PricingRule {
  id: string;
  name: string;
  scope: string;
  workspaceId: string | null;
  endpointType: string;
  provider: string | null;
  model: string | null;
  unit: string;
  unitPriceMicros: number;
  currency: string;
  ruleConfig: Record<string, unknown>;
  disabled: number;
  createTime: number;
  updateTime: number;
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function formatPricingRule(row: Record<string, any>): PricingRule {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope || "platform",
    workspaceId: row.workspaceId ?? null,
    endpointType: row.endpointType,
    provider: row.provider ?? null,
    model: row.model ?? null,
    unit: row.unit || "task",
    unitPriceMicros: Number(row.unitPriceMicros || 0),
    currency: String(row.currency || "GU").trim().toUpperCase() || "GU",
    ruleConfig: parseRecord(row.ruleConfig),
    disabled: Number(row.disabled || 0),
    createTime: Number(row.createTime || 0),
    updateTime: Number(row.updateTime || 0),
  };
}

/**
 * Read-only, client-required pricing resolver. It deliberately has no global
 * database fallback so importing it cannot create a pool or start dbReady.
 */
export async function resolveProviderSpecificPricingRuleWithAudience(
  input: ProviderSpecificPricingInput,
  database: ProviderSpecificPricingDatabase,
): Promise<AudiencePricingResolution<PricingRule>> {
  const provider = String(input.provider || "").trim();
  if (!provider) return { baseRule: null, rule: null, decision: null };

  const query = database("o_pricing_rule")
    .where({ endpointType: input.endpointType, provider, disabled: 0 })
    .where((builder: Knex.QueryBuilder) => {
      builder.whereNull("model");
      if (input.model) builder.orWhere("model", input.model);
    })
    .where((builder: Knex.QueryBuilder) => {
      builder.where("scope", "platform");
      if (input.workspaceId) {
        builder.orWhere({
          scope: "workspace",
          workspaceId: input.workspaceId,
        });
      }
    });

  const rules = (await query).map((row: Record<string, any>) => (
    formatPricingRule(row)
  ));
  rules.sort((left: PricingRule, right: PricingRule) => {
    const score = (rule: PricingRule) => (
      rule.scope === "workspace"
      && input.workspaceId
      && rule.workspaceId === input.workspaceId
        ? 100
        : 0
    ) + (
      rule.model && input.model && rule.model === input.model
        ? 10
        : !rule.model ? 1 : 0
    );
    return score(right) - score(left) || right.updateTime - left.updateTime;
  });
  return input.pricingGroup
    ? applyPricingAudienceForGroup(rules[0] ?? null, input.pricingGroup)
    : await applyPricingAudienceForWorkspace(
        database,
        input.workspaceId,
        rules[0] ?? null,
      );
}

export async function resolveProviderSpecificPricingRule(
  input: ProviderSpecificPricingInput,
  database: ProviderSpecificPricingDatabase,
): Promise<PricingRule | null> {
  return (await resolveProviderSpecificPricingRuleWithAudience(input, database)).rule;
}
