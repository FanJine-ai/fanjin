import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { MembershipError, membershipScopeForModel } from "./membershipCatalog";
import { MEMBERSHIP_TABLES as T } from "./migrations/membershipEntitlements";
import { resolveTimePricing } from "./timePricing";

export const membershipFundingRuleSchema = z.object({
  scope: z.enum(["seedance", "h3"]), model: z.string().trim().min(1), channelId: z.string().min(1), pricingRuleId: z.string().min(1),
  resolutions: z.array(z.enum(["720p", "768p", "1080p", "2k"])).min(1).max(4),
  supplierCostBps: z.number().int().positive().max(10000), operatingCostBps: z.number().int().positive().max(10000),
  evidenceRef: z.string().trim().min(8).max(500), expiresAt: z.number().int().positive(),
  contractHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type MembershipFundingRule = z.infer<typeof membershipFundingRuleSchema>;
type Client = Knex | Knex.Transaction;
function json(value: any): any { if (typeof value === "string") { try { return JSON.parse(value); } catch { return null; } } return value; }

/** Hash only persisted routing/pricing configuration, never health counters or secrets. */
export async function membershipFundingContract(client: Client, channelId: string, pricingRuleId: string) {
  const channel = await client("o_provider_channel").where({ id: channelId, disabled: 0 }).first();
  const pricing = await client("o_pricing_rule").where({ id: pricingRuleId, disabled: 0 }).first();
  if (!channel || !pricing || pricing.endpointType !== "video_generation" || channel.endpointType !== "video_generation") return null;
  const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const routes = await client("o_model_route").where({ channelId, model: pricing.model }).orderBy("id").select("id", "routeConfig", "disabled", "scope", "workspaceId");
  if (!routes.some(row => Number(row.disabled) === 0)) return null;
  const snapshot = { routes: routes.map(row => ({ ...row, disabled: Number(row.disabled), routeConfig: json(row.routeConfig) })), channel: { id: channel.id, provider: channel.provider, baseUrl: channel.baseUrl, credentialRef: channel.credentialRef, model: channel.model,
    models: json(channel.modelNames), config: json(channel.configJson) },
    pricing: { id: pricing.id, provider: pricing.provider, model: pricing.model, unit: pricing.unit, currency: pricing.currency,
      scope: pricing.scope, workspaceId: pricing.workspaceId, unitPriceMicros: Number(pricing.unitPriceMicros), ruleConfig: json(pricing.ruleConfig) } };
  return { hash: createHash("sha256").update(JSON.stringify(stable(snapshot))).digest("hex"), pricingModel: pricing.model };
}

export function parseMembershipFundingRules(value: unknown): MembershipFundingRule[] {
  const result = z.array(membershipFundingRuleSchema).max(100).safeParse(json(value) ?? []);
  if (!result.success) throw new MembershipError("会员适用规格配置无效", "MEMBERSHIP_FUNDING_INVALID", 409);
  return result.data;
}

export async function validateMembershipFundingRules(client: Client, rules: MembershipFundingRule[], requireBoth = true) {
  for (const rule of rules) {
    // Lowest sale price per GU including the annual discount: Seedance .98*.95; H3 .50*.95.
    const lowestRevenueBps = rule.scope === "seedance" ? 9310 : 4750;
    if (membershipScopeForModel(rule.model, "video_generation") !== rule.scope || rule.expiresAt <= Date.now()
      || rule.supplierCostBps + rule.operatingCostBps >= lowestRevenueBps) {
      throw new MembershipError("适用规格的成本、有效期或模型范围未通过校验", "MEMBERSHIP_COST_NOT_APPROVED", 409);
    }
    const contract = await membershipFundingContract(client, rule.channelId, rule.pricingRuleId);
    if (!contract || contract.hash !== rule.contractHash || contract.pricingModel !== rule.model) {
      throw new MembershipError("模型通道或定价已变化，请重新核对会员成本", "MEMBERSHIP_FUNDING_STALE", 409);
    }
  }
  if (requireBoth && !["seedance", "h3"].every(scope => rules.some(rule => rule.scope === scope))) {
    throw new MembershipError("Seedance 和 H3 均须具备已核验的可用规格", "MEMBERSHIP_FUNDING_INCOMPLETE", 409);
  }
}

/** Public purchase information contains model names and resolutions, never channel or credential details. */
export async function readMembershipEligibleModels(client: Client, tenantId: string) {
  const control = await client(T.control).where({ tenantId }).first();
  const models: Array<{ model: string; scope: "seedance" | "h3"; resolutions: string[] }> = [];
  for (const rule of parseMembershipFundingRules(control?.fundingRules)) {
    try { await validateMembershipFundingRules(client, [rule], false); }
    catch (error) { if (error instanceof MembershipError) continue; throw error; }
    const existing = models.find(item => item.model === rule.model && item.scope === rule.scope);
    if (existing) existing.resolutions = [...new Set([...existing.resolutions, ...rule.resolutions])];
    else models.push({ model: rule.model, scope: rule.scope, resolutions: [...rule.resolutions] });
  }
  return models;
}

export async function resolveMembershipFunding(client: Client, input: {
  model?: string | null; endpointType: string; channelId?: string | null; pricingRuleId?: string | null; resolution?: unknown; effectiveRuleConfig?: Record<string, unknown>;
}) {
  const audience = input.effectiveRuleConfig?.audiencePricingEffective as { discountBps?: number } | undefined;
  if (audience && audience.discountBps !== 10000) return null;
  if (resolveTimePricing(input.effectiveRuleConfig).multiplierBps < 10000) return null;
  const scope = membershipScopeForModel(input.model, input.endpointType);
  if (!scope || !input.channelId || !input.pricingRuleId || !await client.schema.hasTable(T.control)) return null;
  const control = await client(T.control).where({ tenantId: "FANJIN" }).first();
  const rules = parseMembershipFundingRules(control?.fundingRules);
  const rule = rules.find(rule => rule.scope === scope && rule.model === input.model && rule.channelId === input.channelId
    && rule.pricingRuleId === input.pricingRuleId && rule.resolutions.includes(String(input.resolution).toLowerCase() as any));
  if (!rule) return null;
  try { await validateMembershipFundingRules(client, [rule], false); }
  catch (error) { if (error instanceof MembershipError) return null; throw error; }
  return { tenantId: "FANJIN", scope, contractHash: rule.contractHash, resolution: input.resolution };
}

/** Recheck only before the first upstream dispatch, never during uncertain-task recovery. */
export async function assertMembershipFundingBeforeDispatch(client: Client, reservationId: string | null) {
  if (!reservationId) return;
  const row = await client("o_billing_ledger").where({ id: reservationId }).first();
  const metadata = json(row?.metadata) || {};
  const funding = metadata.membershipFunding;
  if (!funding) return;
  const ids = (metadata.ownerSpendBreakdown || []).filter((item: any) => item.source === "gift" && item.grantId).map((item: any) => item.grantId);
  if (!ids.length) return;
  const grants = await client("o_account_gift_grant").whereIn("id", ids).select("metadata");
  if (!grants.some(grant => json(grant.metadata)?.membership)) return;
  const current = await resolveMembershipFunding(client, { model: metadata.model, endpointType: metadata.endpointType,
    channelId: metadata.channelId, pricingRuleId: metadata.pricingRuleId, resolution: funding.resolution });
  if (!current || current.contractHash !== funding.contractHash) throw new MembershipError("当前模型规格暂不可使用专属额度，已停止生成并退回预留额度", "MEMBERSHIP_FUNDING_CHANGED", 409);
}
