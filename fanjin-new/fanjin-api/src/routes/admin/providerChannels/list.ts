import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { relayEndpointTypes, relayProviders, relayScopes } from "@/lib/relay";
import { parseProviderChannelConfig, redactProviderChannelConfig } from "@/lib/providerChannelSecrets";
import {
  providerCredentialFallbackEnvNames,
  resolveChannelCredential,
} from "@/lib/relayChannelCredential";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { providerChannelHealthFreshness } from "@/lib/providerChannelHealth";
import {
  inspectProviderChannelPortraitCredential,
} from "@/lib/providerChannelCredentials";
import { readProviderChannelPortraitNamespace } from "@/lib/providerChannelPortraitNamespace";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  scope: z.enum(relayScopes).optional(),
  workspaceId: z.string().optional(),
  provider: z.enum(relayProviders).optional(),
  endpointType: z.enum(relayEndpointTypes).optional(),
  includeDisabled: z.boolean().optional(),
});

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function activeTaskCounts(channelIds: string[]): Promise<Record<string, number>> {
  if (!channelIds.length) return {};
  const rows = await db("o_relay_task")
    .select("channelId")
    .count({ total: "*" })
    .whereIn("channelId", channelIds)
    .whereIn("status", ["queued", "running", "enhancing"])
    .groupBy("channelId");
  return rows.reduce((acc: Record<string, number>, row: any) => {
    acc[row.channelId] = Number(row.total || 0);
    return acc;
  }, {});
}

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const query = db("o_provider_channel").whereNot({ endpointType: "video_upscale" }).orderBy("priority", "asc").orderBy("createTime", "desc");
  const data = parsed.data;
  if (data.scope) query.where("scope", data.scope);
  if (data.workspaceId) query.where("workspaceId", data.workspaceId);
  if (data.provider) query.where("provider", data.provider);
  if (data.endpointType) query.where("endpointType", data.endpointType);
  if (!data.includeDisabled) query.where("disabled", 0);

  const rows = await query;
  const counts = await activeTaskCounts(rows.map((row: any) => row.id).filter(Boolean));
  res.status(200).send(
    success(
      rows.map((row) => {
        const configJson = parseProviderChannelConfig(row.configJson);
        const credential = resolveChannelCredential(
          {
            id: row.id,
            provider: row.provider,
            endpointType: row.endpointType,
            credentialCiphertext: row.credentialCiphertext ?? null,
            credentialRef: row.credentialRef ?? null,
            config: configJson,
          },
          providerCredentialFallbackEnvNames(row.provider, row.endpointType),
        );
        const portraitCredential = inspectProviderChannelPortraitCredential(row.id, configJson);
        const portraitNamespace = readProviderChannelPortraitNamespace(configJson, {
          allowLegacyAliases: row.provider === "volcano" && row.endpointType === "video_generation",
        });
        const { credentialCiphertext: _credentialCiphertext, ...safeRow } = row;
        const recordedHealthStatus = row.healthStatus ?? null;
        const healthFreshness = providerChannelHealthFreshness(row.lastHealthCheckAt);
        const effectiveHealthStatus = Number(row.disabled) === 1
          ? "disabled"
          : healthFreshness === "unchecked"
            ? "unchecked"
            : healthFreshness === "stale" && recordedHealthStatus !== "failed"
              ? "stale"
              : recordedHealthStatus;
        return {
          ...safeRow,
          credentialConfigured: Boolean(credential.value),
          credentialSource: credential.source,
          portraitAssetsEnabled:
            row.provider === "volcano"
            && row.endpointType === "video_generation"
            && portraitCredential.enabled,
          portraitCredentialConfigured: portraitCredential.configured,
          portraitCredentialGeneration: portraitCredential.generation || null,
          providerAccountId: portraitNamespace.providerAccountId || null,
          assetsProjectName: portraitNamespace.assetsProjectName || null,
          configJson: redactProviderChannelConfig(configJson),
          modelNames: parseJson<string[]>(row.modelNames, []),
          lastHealthPayload: parseJson<Record<string, unknown>>(row.lastHealthPayload, {}),
          healthStatus: effectiveHealthStatus,
          recordedHealthStatus,
          healthFreshness,
          lastHealthCheckAt: row.lastHealthCheckAt ?? null,
          lastHealthLatencyMs: row.lastHealthLatencyMs ?? null,
          lastHealthError: row.lastHealthError ?? null,
          activeTaskCount: counts[row.id] || 0,
          health: {
            credentialRef: row.credentialRef ?? null,
            credentialReady: Boolean(credential.value),
            credentialSource: credential.source,
            status: effectiveHealthStatus,
            recordedStatus: recordedHealthStatus,
            freshness: healthFreshness,
            checkedAt: row.lastHealthCheckAt ?? null,
            latencyMs: row.lastHealthLatencyMs ?? null,
            errorMessage: row.lastHealthError ?? null,
          },
        };
      }),
    ),
  );
});
