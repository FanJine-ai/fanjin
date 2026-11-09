import { AGENT_LLM_RESERVATION_MICROS } from "@/agent-runtime/agentBillingPolicy";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import {
  AGENT_CHAT_MODEL_DEFAULT_ID,
  AGENT_CHAT_MODEL_CATALOG,
  defaultAgentChatModel,
  findAgentChatModel,
  type AgentChatModelDefinition,
} from "@/agent-runtime/runtimeConfigRegistry";
import {
  refundWorkspace,
  resolveProviderSpecificPricingRule,
  type PricingRule,
} from "@/lib/billing";
import { selectChannelCandidates } from "@/lib/channelRouter";
import { estimateRelayTextCost, estimateRelayTextUsage } from "@/lib/relayBillingSession";
import { readPlatformModelDefaults } from "@/lib/platformSettings";
import {
  explainWorkbenchModelRouteReadiness,
  isWorkbenchModelRouteConfiguredForCatalog,
  listWorkbenchConfiguredModels,
  type WorkbenchConfiguredModelSummary,
} from "@/lib/workbenchModelCatalog";
import { db } from "@/utils/db";

export { AGENT_LLM_RESERVATION_MICROS } from "@/agent-runtime/agentBillingPolicy";

/**
 * Agent LLM turns share the relay text-token settlement path. 100 GU is only
 * the initial authorization per upstream turn; the final debit comes from the
 * provider's authoritative input/output/cache token usage.
 *
 * `agent_chat`/`run` is retained only for historical Run refunds. New Runs do
 * not create a duplicate fixed-price charge.
 */
export const AGENT_CHAT_BILLING_ENDPOINT_TYPE = "agent_chat";
export const AGENT_CHAT_BILLING_UNIT = "run";

export interface AgentChatModelCatalogEntry {
  id: string;
  /** Concrete upstream model id, even when `id` is a stable platform alias. */
  modelId: string;
  displayName: string;
  description: string;
  billingMode: "token";
  available: boolean;
  reservationMicros: number;
  estimatedCostMicros: number | null;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  default: boolean;
}

export interface ResolvedAgentChatRunModel {
  definition: AgentChatModelDefinition;
  pricingRule: PricingRule | null;
  provider: string | null;
  available: boolean;
  estimatedCostMicros: number | null;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  reservationMicros: number;
  source: "route" | "channel" | "legacy";
}

function positiveInteger(value: unknown, fallback: number): number {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : fallback;
}

function humanizeModelId(value: string): string {
  const tokens = value.trim().split(/[-_\s]+/).filter(Boolean);
  return tokens.map((token, index) => {
    const lower = token.toLowerCase();
    if (lower === "gpt") return "GPT";
    if (lower === "claude") return "Claude";
    if (lower === "opus") return "Opus";
    if (lower === "sonnet") return "Sonnet";
    if (lower === "haiku") return "Haiku";
    if (lower === "luna") return "Luna";
    if (/^\d+$/.test(token) && index > 0 && /^\d+$/.test(tokens[index - 1] || "")) {
      return `.${token}`;
    }
    return token.charAt(0).toUpperCase() + token.slice(1);
  }).join(" ").replace(/ \./g, ".");
}

function routePreference(
  route: { id: string; resolvedModel: string; source: "route" | "channel" },
  preferred: readonly string[],
): number {
  for (let index = 0; index < preferred.length; index += 1) {
    if (route.id === preferred[index]) return index * 10;
    if (route.resolvedModel === preferred[index]) return index * 10 + 1;
  }
  if (route.id === AGENT_CHAT_MODEL_DEFAULT_ID) return 100;
  if (route.source === "route") return 105;
  if (route.id === route.resolvedModel) return 110;
  return 120;
}

type ConfiguredAgentChatModel = AgentChatModelDefinition & { source: "route" | "channel" };

async function listConfiguredAgentChatModels(workspaceId: string): Promise<ConfiguredAgentChatModel[]> {
  const [configuredModels, defaults] = await Promise.all([
    listWorkbenchConfiguredModels({ workspaceId, endpointTypes: ["text"] }),
    readPlatformModelDefaults(),
  ]);
  // The relay billing gate requires a persisted, certified route. Mirror that
  // gate here so a channel-only inventory item or an uncertified route can
  // never appear selectable and then fail only after the user submits it.
  const routeIds = configuredModels
    .filter((model) => model.canSubmit && model.source === "route" && model.routeId)
    .map((model) => model.routeId!);
  const routeRows = routeIds.length
    ? await db("o_model_route").whereIn("id", routeIds)
    : [];
  const readiness = await Promise.all(routeRows.map(async (route) => ({
    routeId: String(route.id),
    result: await explainWorkbenchModelRouteReadiness({ route, workspaceId }),
  })));
  const admittedRouteIds = new Set(
    readiness
      .filter(({ result }) => isWorkbenchModelRouteConfiguredForCatalog(result))
      .map(({ routeId }) => routeId),
  );
  const activeModels = configuredModels.filter((model) => (
    model.canSubmit
    && model.source === "route"
    && model.routeId != null
    && admittedRouteIds.has(model.routeId)
  ));
  if (!activeModels.length) return [];

  const preferred = [defaults.agentChat, defaults.text, AGENT_CHAT_MODEL_DEFAULT_ID]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const grouped = new Map<string, WorkbenchConfiguredModelSummary[]>();
  for (const route of activeModels) {
    const key = route.resolvedModel || route.model;
    const group = grouped.get(key) || [];
    group.push(route);
    grouped.set(key, group);
  }

  const selectedModels = Array.from(grouped.values()).map((group) => (
    [...group].sort((left, right) => routePreference(left, preferred) - routePreference(right, preferred))[0]
  ));
  const preferredDefault = preferred
    .map((target) => selectedModels.find((route) => route.id === target || route.resolvedModel === target))
    .find(Boolean);
  const defaultRoute = preferredDefault
    || selectedModels.find((route) => route.id === AGENT_CHAT_MODEL_DEFAULT_ID)
    || selectedModels[0];

  return selectedModels.map((route) => {
    const capabilities = route.capabilities || {};
    const concreteModel = route.resolvedModel || route.model;
    const description = typeof capabilities.description === "string" && capabilities.description.trim()
      ? capabilities.description.trim()
      : `平台已配置的 ${concreteModel} 对话模型`;
    return {
      id: route.id,
      modelId: concreteModel,
      displayName: route.displayName?.trim() || humanizeModelId(concreteModel),
      description,
      modelAlias: route.model,
      temperatureMilli: positiveInteger(capabilities.temperatureMilli, 300),
      maxOutputTokens: positiveInteger(capabilities.maxOutputTokens, 4_096),
      isDefault: route.id === defaultRoute?.id,
      source: route.source,
    };
  });
}

async function resolveTokenEstimate(
  workspaceId: string,
  definition: AgentChatModelDefinition,
): Promise<Omit<ResolvedAgentChatRunModel, "definition" | "source"> | null> {
  const candidates = await selectChannelCandidates({
    endpointType: "text",
    model: definition.modelAlias,
    workspaceId,
    ignoreCapacity: true,
    ignoreHealth: true,
  });
  // Price the same administrator-configured route that relay settlement will
  // use. Cached probe health is excluded from catalog pricing; live dispatch
  // still applies cooldown/fallback and performs the final provider check.
  const channel = candidates[0];
  if (!channel) return null;
  const pricingRule = await resolveProviderSpecificPricingRule({
    endpointType: "text",
    provider: channel.provider,
    model: definition.modelAlias,
    workspaceId,
  });
  if (!pricingRule || pricingRule.unit !== "token") return null;
  const usage = estimateRelayTextUsage({
    requestPayload: { model: definition.modelAlias, messages: [] },
    maxOutputTokens: definition.maxOutputTokens,
  });
  const estimatedCostMicros = estimateRelayTextCost(pricingRule, usage);
  if (estimatedCostMicros <= 0) return null;
  return {
    pricingRule,
    provider: channel.provider,
    available: true,
    estimatedCostMicros,
    estimatedInputTokens: usage.promptTokens,
    estimatedOutputTokens: usage.completionTokens,
    reservationMicros: AGENT_LLM_RESERVATION_MICROS,
  };
}

function parseSnapshot(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Catalog for the model picker. FJAdmin's effective text routes are
 * authoritative, and a model is exposed only when the selected provider has a
 * valid token price. The estimate is guidance, never a fixed quote.
 */
export async function listAgentChatModels(workspaceId: string): Promise<AgentChatModelCatalogEntry[]> {
  const configured = await listConfiguredAgentChatModels(workspaceId);
  const [resolved, modelDefaults] = await Promise.all([
    Promise.all(
      configured.map(async (definition) => {
        const estimate = await resolveTokenEstimate(workspaceId, definition);
        return { definition, estimate };
      }),
    ),
    readPlatformModelDefaults(),
  ]);
  const visible = resolved.filter((item): item is typeof item & {
    estimate: NonNullable<typeof item.estimate>;
  } => item.estimate !== null);
  const overrideDefaultId = visible.some(({ definition }) => definition.id === modelDefaults.agentChat)
    ? modelDefaults.agentChat
    : null;
  const fallbackDefaultId = visible.find(({ definition }) => definition.isDefault)?.definition.id
    || visible[0]?.definition.id
    || null;
  return visible.map(({ definition, estimate }) => ({
      id: definition.id,
      modelId: definition.modelId,
      displayName: definition.displayName,
      description: definition.description,
      billingMode: "token" as const,
      available: true,
      reservationMicros: AGENT_LLM_RESERVATION_MICROS,
      estimatedCostMicros: estimate.estimatedCostMicros,
      estimatedInputTokens: estimate.estimatedInputTokens,
      estimatedOutputTokens: estimate.estimatedOutputTokens,
      default: definition.id === (overrideDefaultId || fallbackDefaultId),
    }));
}

/**
 * Resolve the selected model against the same provider-specific token rule the
 * relay will settle. No per-Run charge is created here.
 */
export async function resolveAgentChatRunModel(input: {
  workspaceId: string;
  chatModelId?: string | null;
  requireAvailable?: boolean;
}): Promise<ResolvedAgentChatRunModel> {
  const requested = String(input.chatModelId ?? "").trim();
  const configured = await listConfiguredAgentChatModels(input.workspaceId);
  const configuredDefinition = configured.length
    ? (requested ? configured.find((item) => item.id === requested) ?? null : configured.find((item) => item.isDefault) ?? configured[0])
    : null;
  const definition = configured.length
    ? configuredDefinition
    : (requested ? findAgentChatModel(requested) : defaultAgentChatModel());
  if (!definition) {
    throw new AgentRuntimeError(400, "agent_chat_model_unknown", "所选对话模型不存在，请重新选择");
  }
  const estimate = await resolveTokenEstimate(input.workspaceId, definition);
  if (!estimate && input.requireAvailable === true) {
    throw new AgentRuntimeError(409, "agent_chat_model_unavailable", "所选对话模型暂未配置可用路由或 Token 定价，请联系管理员");
  }
  const source = configured.length ? configuredDefinition!.source : "legacy";
  if (estimate) return { definition, source, ...estimate };
  const usage = estimateRelayTextUsage({
    requestPayload: { model: definition.modelAlias, messages: [] },
    maxOutputTokens: definition.maxOutputTokens,
  });
  return {
    definition,
    pricingRule: null,
    provider: null,
    available: false,
    estimatedCostMicros: null,
    estimatedInputTokens: usage.promptTokens,
    estimatedOutputTokens: usage.completionTokens,
    reservationMicros: AGENT_LLM_RESERVATION_MICROS,
    source,
  };
}

/** Refund a previously charged Run. Idempotent per Run. */
export async function refundAgentChatRun(input: {
  workspaceId: string;
  runId: string;
  charge: { costMicros: number; ledgerId?: string | null; usageRecordId?: string | null };
  reason: string;
  operatorUserId?: number | null;
}): Promise<void> {
  if (input.charge.costMicros <= 0) return;
  await refundWorkspace({
    workspaceId: input.workspaceId,
    amountMicros: input.charge.costMicros,
    originalLedgerId: input.charge.ledgerId ?? null,
    usageRecordId: input.charge.usageRecordId ?? null,
    taskId: input.runId,
    idempotencyKey: `agent-chat:${input.runId}:refund`,
    description: input.reason,
    operatorUserId: input.operatorUserId ?? null,
    metadata: { agentChatRefund: true, runId: input.runId },
  });
}

/**
 * Auto-refund a failed/cancelled Run's chat-model charge. Best-effort and
 * idempotent: the refund ledger is deduped by idempotency key and the Run
 * snapshot is CAS-marked so concurrent terminal paths do not refund twice.
 */
export async function settleAgentChatBillingOnTerminalRun(input: {
  runId: string;
  now?: number;
}): Promise<boolean> {
  const run = await (db as any)("o_agent_run").where({ id: input.runId }).first();
  if (!run) return false;
  const status = String(run.status || "");
  if (status !== "failed" && status !== "cancelled") return false;

  const snapshot = parseSnapshot(run.policySnapshot);
  const billing = snapshot.chatBilling;
  if (!billing || typeof billing !== "object" || Array.isArray(billing)) return false;
  const record = billing as Record<string, unknown>;
  if (record.status !== "charged" || record.refundedAt != null) return false;
  const costMicros = Number(record.costMicros || 0);
  if (!Number.isSafeInteger(costMicros) || costMicros <= 0) return false;

  await refundAgentChatRun({
    workspaceId: String(run.workspaceId),
    runId: String(run.id),
    charge: {
      costMicros,
      ledgerId: typeof record.ledgerId === "string" ? record.ledgerId : null,
      usageRecordId: typeof record.usageRecordId === "string" ? record.usageRecordId : null,
    },
    reason: "Agent Run 未成功，自动退还对话模型费用",
  });

  const now = input.now ?? Date.now();
  const nextSnapshot = {
    ...snapshot,
    chatBilling: { ...record, refundedAt: now },
  };
  await (db as any)("o_agent_run")
    .where({ id: run.id, version: run.version })
    .update({
      policySnapshot: JSON.stringify(nextSnapshot),
      version: Number(run.version || 0) + 1,
      updatedAt: now,
    });
  return true;
}
