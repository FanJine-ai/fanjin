import { internalModelId } from "@/lib/minimaxH3PublicIdentity";
import {
  resolveProviderSpecificPricingRuleWithAudience,
  type PricingRule,
} from "@/lib/billing";
import {
  applyPricingAudienceDecision,
  resolveWorkspacePricingGroup,
} from "@/lib/pricingAudience";
import {
  selectChannelCandidates,
  selectPreferredModelRouteScope,
} from "@/lib/channelRouter";
import {
  isPreviewProviderDispatchDisabled,
  providerCredentialFallbackEnvNames,
  resolveChannelApiKey,
  resolveChannelBaseUrl,
} from "@/lib/relayChannelCredential";
import type { RelayEndpointType } from "@/lib/sharedTypes";
import {
  explainLogicalModelPriceAdmission,
  parseJsonRecord,
} from "@/lib/modelRouteGroups";
import { db } from "@/utils/db";

export interface UserVisibleModelOffer {
  endpointType: RelayEndpointType;
  model: string;
  provider: string;
  channelId: string;
  pricingRule: PricingRule;
}
function positiveSafeInteger(value: unknown): boolean {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0;
}

/**
 * A user-visible price must be usable by the fail-closed billing path.  The
 * catalog deliberately rejects zero/missing prices instead of advertising a
 * model that generation will refuse after the user has already selected it.
 */
export function isUserVisiblePricingRule(rule: PricingRule | null | undefined): rule is PricingRule {
  if (!rule || Number(rule.disabled || 0) !== 0) return false;
  if (!String(rule.currency || "").trim() || !String(rule.unit || "").trim()) return false;
  if (positiveSafeInteger(rule.unitPriceMicros)) return true;

  const inputPrice = Number(rule.ruleConfig?.inputPriceMicros);
  const outputPrice = Number(rule.ruleConfig?.outputPriceMicros);
  return positiveSafeInteger(inputPrice) || positiveSafeInteger(outputPrice);
}

function hasExecutableCredentials(channel: Record<string, any>): boolean {
  if (isPreviewProviderDispatchDisabled()) return false;
  if (!resolveChannelBaseUrl(channel as any)) return false;
  const fallbackEnvironmentKeys = providerCredentialFallbackEnvNames(
    channel.provider,
    channel.endpointType,
  );
  return Boolean(resolveChannelApiKey(channel, fallbackEnvironmentKeys));
}

/**
 * Resolve exactly the first route/provider that relay execution would use.
 * Capacity is intentionally ignored: a temporarily full queue is still an
 * available product, while missing routing, credentials or pricing is not.
 */
export async function resolveUserVisibleModelOffer(input: {
  workspaceId: string;
  pricingGroup?: string;
  endpointType: RelayEndpointType;
  model: string;
}): Promise<UserVisibleModelOffer | null> {
  const model = internalModelId(String(input.model || "").trim());
  if (!model) return null;

  const channels = await selectChannelCandidates({
    endpointType: input.endpointType,
    model,
    workspaceId: input.workspaceId,
    ignoreCapacity: true,
  });
  const channel = channels[0];
  if (!channel || !hasExecutableCredentials(channel as Record<string, any>)) return null;

  const pricingResolution = await resolveProviderSpecificPricingRuleWithAudience({
    workspaceId: input.workspaceId,
    endpointType: input.endpointType,
    provider: channel.provider,
    model,
    pricingGroup: input.pricingGroup,
  });
  const pricingRule = pricingResolution.rule;
  if (!isUserVisiblePricingRule(pricingRule) || !pricingResolution.baseRule || !pricingResolution.decision) return null;
  const routeRows = await db("o_model_route")
    .where({ endpointType: input.endpointType, model, channelId: channel.id, disabled: 0 })
    .andWhere((builder: any) => {
      builder.where((platform: any) => platform.where({ scope: "platform" }).whereNull("workspaceId"));
      if (input.workspaceId) builder.orWhere({ scope: "workspace", workspaceId: input.workspaceId });
    })
    .orderBy("priority", "asc")
    .orderBy("fallbackOrder", "asc");
  const route = selectPreferredModelRouteScope(routeRows, input.workspaceId)[0] || null;
  const logicalPriceAdmission = route
    ? await explainLogicalModelPriceAdmission(db, route, pricingResolution.baseRule)
    : { valid: true, reason: "", canonicalPrice: null };
  if (!logicalPriceAdmission.valid) return null;
  const visiblePricingRule = logicalPriceAdmission.canonicalPrice
    ? applyPricingAudienceDecision({
        ...pricingRule,
        ...logicalPriceAdmission.canonicalPrice,
        provider: null,
        ruleConfig: parseJsonRecord(logicalPriceAdmission.canonicalPrice.ruleConfig),
      } as PricingRule, pricingResolution.decision)
    : pricingRule;
  if (!isUserVisiblePricingRule(visiblePricingRule)) return null;

  return {
    endpointType: input.endpointType,
    model,
    provider: channel.provider,
    channelId: channel.id,
    pricingRule: visiblePricingRule,
  };
}

export async function resolveUserVisibleModelOffers(input: {
  workspaceId: string;
  pricingGroup?: string;
  models: Array<{ endpointType: RelayEndpointType; model: string }>;
}): Promise<Map<string, UserVisibleModelOffer>> {
  const pricingGroup = input.pricingGroup || await resolveWorkspacePricingGroup(db, input.workspaceId);
  const unique = Array.from(new Map(
    input.models
      .filter((item) => item.model && item.endpointType)
      .map((item) => [`${item.endpointType}:${item.model}`, item]),
  ).values());
  const resolved = await Promise.all(unique.map(async (item) => ({
    key: `${item.endpointType}:${item.model}`,
    offer: await resolveUserVisibleModelOffer({ ...item, workspaceId: input.workspaceId, pricingGroup }),
  })));
  return new Map(
    resolved.flatMap(({ key, offer }) => offer ? [[key, offer] as const] : []),
  );
}
