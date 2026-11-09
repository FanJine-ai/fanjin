import type { Knex } from "knex";

import {
  modelRouteCertificationPricingSnapshotHash,
  modelRouteCertificationRouteSnapshotHash,
} from "@/lib/modelRouteCertification";
import type { PricingRule } from "@/lib/billing";
import type { RelayChannel } from "@/lib/sharedTypes";

export const SEEDREAM45_CERTIFICATION_PROBE_VERSION =
  "seedream-4.5-quality-certification-probe/v1" as const;
export const SEEDREAM45_CERTIFICATION_MODEL =
  "doubao-seedream-4-5-251128" as const;
export const SEEDREAM45_CERTIFICATION_ROUTE_ID =
  "78949912-71d0-40ca-883f-017683883ec2" as const;
export const SEEDREAM45_CERTIFICATION_PRICING_RULE_ID =
  "fanjin-volcano-doubao-seedream-4-5-251128-pricing" as const;
export const SEEDREAM45_CERTIFICATION_WORKSPACE_NAME =
  "Release Smoke Workspace" as const;
export const SEEDREAM45_CERTIFICATION_FIXED_PROMPT =
  "A single matte white geometric sphere centered on a neutral light gray studio background, soft even lighting, no text, no people." as const;
export const SEEDREAM45_CERTIFICATION_MAX_TOTAL_GU_MICROS =
  1_000_000_000 as const;

export type Seedream45CertificationQuality = "2K" | "4K";

export const SEEDREAM45_CERTIFICATION_SIZES: Readonly<
  Record<Seedream45CertificationQuality, string>
> = Object.freeze({
  "2K": "2048x2048",
  "4K": "4096x4096",
});

export interface Seedream45CertificationProbePermit {
  version: typeof SEEDREAM45_CERTIFICATION_PROBE_VERSION;
  probeId: string;
  workspaceId: string;
  projectId: number;
  adminUserId: number;
  routeId: typeof SEEDREAM45_CERTIFICATION_ROUTE_ID;
  channelId: string;
  pricingRuleId: typeof SEEDREAM45_CERTIFICATION_PRICING_RULE_ID;
  model: typeof SEEDREAM45_CERTIFICATION_MODEL;
  provider: "volcano";
  taskIds: Record<Seedream45CertificationQuality, string>;
  routeSnapshotHash: string;
  pricingSnapshotHash: string;
  maxTotalGuMicros: number;
  releaseId: string;
  sourceCommit: string;
  artifactSha256: string;
  createdAt: number;
  expiresAt: number;
}

export interface Seedream45CertificationProbeTaskBinding {
  permit: Seedream45CertificationProbePermit;
  quality: Seedream45CertificationQuality;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, any>;
}

function parseJson(value: unknown): Record<string, any> {
  if (typeof value !== "string") return object(value);
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

function stableJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]));
    }
    return current;
  };
  return JSON.stringify(normalize(value));
}

function fail(code: string): never {
  const error: any = new Error(code);
  error.code = code;
  error.status = 409;
  throw error;
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
}

export function parseSeedream45CertificationProbeTaskBinding(
  value: unknown,
): Seedream45CertificationProbeTaskBinding | null {
  const binding = object(value);
  const permit = object(binding.permit);
  const quality = text(binding.quality).toUpperCase();
  if (
    permit.version !== SEEDREAM45_CERTIFICATION_PROBE_VERSION
    || !["2K", "4K"].includes(quality)
  ) return null;
  return {
    permit: permit as Seedream45CertificationProbePermit,
    quality: quality as Seedream45CertificationQuality,
  };
}

export function seedream45CertificationProbeRequest(
  quality: Seedream45CertificationQuality,
): Record<string, unknown> {
  return {
    model: SEEDREAM45_CERTIFICATION_MODEL,
    prompt: SEEDREAM45_CERTIFICATION_FIXED_PROMPT,
    n: 1,
    size: SEEDREAM45_CERTIFICATION_SIZES[quality],
    response_format: "url",
    quality,
    provider: "volcano",
  };
}

export async function assertSeedream45CertificationProbeForBilling(input: {
  database: Knex | Knex.Transaction;
  binding: Seedream45CertificationProbeTaskBinding;
  taskId: string | null | undefined;
  workspaceId: string;
  principalId: string | null | undefined;
  requestPayload: unknown;
  channel: RelayChannel;
  pricingRule: PricingRule;
  reservedCostMicros: number;
  now?: number;
}): Promise<void> {
  const now = Number(input.now ?? Date.now());
  const { permit, quality } = input.binding;
  const taskId = text(input.taskId);
  if (
    permit.version !== SEEDREAM45_CERTIFICATION_PROBE_VERSION
    || !isUuid(text(permit.probeId))
    || permit.routeId !== SEEDREAM45_CERTIFICATION_ROUTE_ID
    || permit.pricingRuleId !== SEEDREAM45_CERTIFICATION_PRICING_RULE_ID
    || permit.model !== SEEDREAM45_CERTIFICATION_MODEL
    || permit.provider !== "volcano"
    || !taskId
    || taskId !== text(permit.taskIds?.[quality])
    || !isUuid(text(permit.taskIds?.["2K"]))
    || !isUuid(text(permit.taskIds?.["4K"]))
    || text(permit.taskIds?.["2K"]) === text(permit.taskIds?.["4K"])
    || !Number.isSafeInteger(permit.projectId)
    || permit.projectId <= 0
    || !Number.isSafeInteger(permit.adminUserId)
    || permit.adminUserId <= 0
    || !Number.isSafeInteger(permit.createdAt)
    || !Number.isSafeInteger(permit.expiresAt)
    || permit.createdAt > now
    || permit.expiresAt <= now
    || permit.expiresAt - permit.createdAt > 30 * 60_000
    || permit.maxTotalGuMicros !== SEEDREAM45_CERTIFICATION_MAX_TOTAL_GU_MICROS
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(text(permit.releaseId))
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(text(permit.sourceCommit))
    || !/^[a-f0-9]{64}$/u.test(text(permit.artifactSha256))
  ) fail("SEEDREAM45_CERTIFICATION_PROBE_PERMIT_INVALID");
  if (
    input.workspaceId !== permit.workspaceId
    || text(input.principalId) !== `seedream45-certification-admin:${permit.adminUserId}`
    || input.channel.id !== permit.channelId
    || input.channel.provider !== "volcano"
    || input.channel.endpointType !== "image_generation"
    || input.pricingRule.id !== permit.pricingRuleId
    || input.pricingRule.endpointType !== "image_generation"
    || input.pricingRule.provider !== "volcano"
    || input.pricingRule.model !== SEEDREAM45_CERTIFICATION_MODEL
    || input.pricingRule.unit !== "image"
    || input.pricingRule.currency !== "GU"
    || !Number.isSafeInteger(input.reservedCostMicros)
    || input.reservedCostMicros <= 0
    || input.reservedCostMicros * 2 > permit.maxTotalGuMicros
    || stableJson(input.requestPayload) !== stableJson(seedream45CertificationProbeRequest(quality))
  ) fail("SEEDREAM45_CERTIFICATION_PROBE_BILLING_BINDING_MISMATCH");

  const [route, channel, pricing, actor, workspace, project, tasks] = await Promise.all([
    input.database("o_model_route").where({ id: permit.routeId }).first(),
    input.database("o_provider_channel").where({ id: permit.channelId }).first(),
    input.database("o_pricing_rule").where({ id: permit.pricingRuleId }).first(),
    input.database("o_user").where({ id: permit.adminUserId }).first(),
    input.database("o_workspace").where({ id: permit.workspaceId }).first(),
    input.database("o_project").where({ id: permit.projectId, workspaceId: permit.workspaceId }).first(),
    input.database("o_relay_task").whereIn("id", [permit.taskIds["2K"], permit.taskIds["4K"]]),
  ]);
  if (
    !route
    || text(route.endpointType) !== "image_generation"
    || text(route.model) !== SEEDREAM45_CERTIFICATION_MODEL
    || text(route.provider) !== "volcano"
    || text(route.channelId) !== permit.channelId
    || Number(route.disabled || 0) !== 0
    || modelRouteCertificationRouteSnapshotHash(route) !== permit.routeSnapshotHash
    || !channel
    || text(channel.endpointType) !== "image_generation"
    || text(channel.provider) !== "volcano"
    || Number(channel.disabled || 0) !== 0
    || text(channel.healthStatus).toLowerCase() !== "ok"
    || !pricing
    || text(pricing.id) !== permit.pricingRuleId
    || Number(pricing.disabled || 0) !== 0
    || modelRouteCertificationPricingSnapshotHash(pricing) !== permit.pricingSnapshotHash
    || !actor
    || text(actor.status).toLowerCase() !== "active"
    || !["root", "admin", "super_admin"].includes(text(actor.role).toLowerCase())
    || !workspace
    || text(workspace.name) !== SEEDREAM45_CERTIFICATION_WORKSPACE_NAME
    || text(workspace.status).toLowerCase() !== "active"
    || !project
    || text(project.deletionState).toLowerCase() !== "active"
    || tasks.length !== 2
  ) fail("SEEDREAM45_CERTIFICATION_PROBE_DATABASE_BINDING_MISMATCH");
  for (const task of tasks) {
    const request = parseJson(task.requestPayload);
    const metadata = object(request.quickCreate);
    const taskBinding = parseSeedream45CertificationProbeTaskBinding(
      metadata.seedream45CertificationProbe,
    );
    const taskQuality = text(taskBinding?.quality).toUpperCase() as Seedream45CertificationQuality;
    if (
      !taskBinding
      || stableJson(taskBinding.permit) !== stableJson(permit)
      || text(task.id) !== text(permit.taskIds[taskQuality])
      || text(task.workspaceId) !== permit.workspaceId
      || Number(task.projectId) !== permit.projectId
      || text(task.endpointType) !== "image_generation"
      || text(task.model) !== SEEDREAM45_CERTIFICATION_MODEL
      || stableJson(request.generation) !== stableJson(seedream45CertificationProbeRequest(taskQuality))
    ) fail("SEEDREAM45_CERTIFICATION_PROBE_TASK_SET_MISMATCH");
  }
}
