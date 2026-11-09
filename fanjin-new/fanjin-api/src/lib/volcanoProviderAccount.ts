import crypto from "node:crypto";
import type { Knex } from "knex";

import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";

export const VOLCANO_PROVIDER_ACCOUNT_EVIDENCE_VERSION =
  "volcano-provider-account-binding/v1" as const;

const PROVIDER_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/u;

export type VolcanoProviderAccountSnapshot = Readonly<{
  providerAccountId: string;
  binding: string;
}>;

export type VolcanoProviderAccountEvidence = Readonly<{
  version: typeof VOLCANO_PROVIDER_ACCOUNT_EVIDENCE_VERSION;
  binding: string;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function accountBinding(providerAccountId: string): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    provider: "volcano",
    providerAccountId,
    version: VOLCANO_PROVIDER_ACCOUNT_EVIDENCE_VERSION,
  })).digest("hex");
}

/**
 * Resolve the provider account from server-owned channel configuration.
 * Multiple legacy aliases are accepted only when every populated alias agrees;
 * silently preferring one alias would let a stale config conceal an account
 * rotation from trusted-output verification.
 */
export function resolveVolcanoProviderAccountSnapshot(
  configValue: unknown,
): VolcanoProviderAccountSnapshot | null {
  const config = parseProviderChannelConfig(configValue);
  const candidates = [
    config.providerAccountId,
    config.volcengineAccountId,
    config.accountId,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  const unique = [...new Set(candidates)];
  if (unique.length !== 1 || !PROVIDER_ACCOUNT_ID.test(unique[0])) return null;
  return Object.freeze({
    providerAccountId: unique[0],
    binding: accountBinding(unique[0]),
  });
}

export function createVolcanoProviderAccountEvidence(
  configValue: unknown,
): VolcanoProviderAccountEvidence | null {
  const snapshot = resolveVolcanoProviderAccountSnapshot(configValue);
  return snapshot
    ? Object.freeze({
        version: VOLCANO_PROVIDER_ACCOUNT_EVIDENCE_VERSION,
        binding: snapshot.binding,
      })
    : null;
}

export function readVolcanoProviderAccountEvidence(
  value: unknown,
): VolcanoProviderAccountEvidence | null {
  const evidence = record(value);
  if (
    !evidence
    || Object.keys(evidence).sort().join("\u0000") !== ["binding", "version"].sort().join("\u0000")
    || evidence.version !== VOLCANO_PROVIDER_ACCOUNT_EVIDENCE_VERSION
    || typeof evidence.binding !== "string"
    || !/^[a-f0-9]{64}$/u.test(evidence.binding)
  ) return null;
  return Object.freeze({
    version: VOLCANO_PROVIDER_ACCOUNT_EVIDENCE_VERSION,
    binding: evidence.binding,
  });
}

export async function resolveVolcanoProviderChannelAccount(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  channelId: string;
  endpointType: "image_generation" | "video_generation";
  lock?: boolean;
}): Promise<Readonly<{
  channelId: string;
  providerAccountId: string;
  binding: string;
}> | null> {
  const query = input.database("o_provider_channel")
    .where({
      id: input.channelId,
      provider: "volcano",
      endpointType: input.endpointType,
      disabled: 0,
    })
    .where((builder) => builder
      .where((workspace) => workspace
        .where({ scope: "workspace", workspaceId: input.workspaceId }))
      .orWhere((platform) => platform
        .where("scope", "platform")
        .whereNull("workspaceId")))
    .select("id", "configJson")
    .limit(2);
  if (input.lock) query.forUpdate();
  const rows = await query;
  if (rows.length !== 1) return null;
  const channelId = String(rows[0].id || "").trim();
  const snapshot = resolveVolcanoProviderAccountSnapshot(rows[0].configJson);
  if (!channelId || !snapshot) return null;
  return Object.freeze({ channelId, ...snapshot });
}
