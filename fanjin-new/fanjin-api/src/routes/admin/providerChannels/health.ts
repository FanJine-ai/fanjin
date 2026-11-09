import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { relayEndpointTypes, relayProviders } from "@/lib/relay";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import {
  inspectProviderChannelConfiguration,
  probeProviderChannel,
  type ProviderChannelRecord,
} from "@/lib/providerChannelHealth";
import { runProviderChannelHealthCheck } from "@/lib/providerChannelHealthStore";
import { readProviderChannelCredentialCiphertext } from "@/lib/providerChannelCredentials";

const router = express.Router();
router.use(requirePlatformAdmin);

const draftSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  provider: z.enum(relayProviders),
  endpointType: z.enum(relayEndpointTypes),
  baseUrl: z.string().trim().min(1),
  credentialRef: z.string().trim().optional().nullable(),
  apiKey: z.string().max(16_384).optional(),
  configJson: z.record(z.string(), z.any()).default({}),
  timeoutMs: z.number().int().min(1000).default(600000),
  disabled: z.number().int().min(0).max(1).default(0),
});

const bodySchema = z.object({
  id: z.string().trim().min(1).optional(),
  draft: draftSchema.optional(),
  live: z.boolean().optional().default(true),
}).refine((value) => Boolean(value.id) !== Boolean(value.draft), {
  message: "id 和 draft 必须且只能提供一个",
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const { id, draft, live } = parsed.data;
  if (draft) {
    const persistedChannel = draft.id
      ? await db("o_provider_channel")
        .where({ id: draft.id })
        .select("provider", "baseUrl", "configJson")
        .first()
      : null;
    const canReusePersistedCredential = Boolean(
      persistedChannel
      && persistedChannel.provider === draft.provider
      && (persistedChannel.baseUrl || null) === (draft.baseUrl || null),
    );
    const channel: ProviderChannelRecord = {
      id: draft.id || "draft",
      name: draft.name || "未保存通道",
      provider: draft.provider,
      endpointType: draft.endpointType,
      baseUrl: draft.baseUrl,
      credentialRef: draft.credentialRef ?? null,
      credentialCiphertext: canReusePersistedCredential
        ? readProviderChannelCredentialCiphertext(persistedChannel?.configJson)
        : null,
      credentialPlaintext: draft.apiKey?.trim() || null,
      configJson: draft.configJson,
      timeoutMs: draft.timeoutMs,
      disabled: draft.disabled,
    };
    const result = live
      ? await probeProviderChannel(channel)
      : {
          ...inspectProviderChannelConfiguration(channel),
          healthStatus: null,
          latencyMs: null,
          errorMessage: null,
        };

    await writeAuditLog(req, {
      workspaceId: null,
      action: live
        ? "admin.provider_channel.draft_health_check"
        : "admin.provider_channel.draft_configuration_check",
      resourceType: "provider_channel_draft",
      resourceId: channel.id,
      metadata: {
        provider: channel.provider,
        endpointType: channel.endpointType,
        healthStatus: result.healthStatus,
        configurationStatus: result.status,
        live,
        latencyMs: result.latencyMs,
      },
    });

    const checkedAt = live ? Date.now() : null;
    return res.status(200).send(success({
      id: channel.id,
      name: channel.name,
      provider: channel.provider,
      endpointType: channel.endpointType,
      disabled: Boolean(Number(channel.disabled)),
      live,
      configurationStatus: result.status,
      credential: {
        credentialRef: channel.credentialRef ?? null,
        credentialReady: result.credentialReady,
      },
      healthStatus: result.healthStatus,
      lastHealthCheckAt: checkedAt,
      lastHealthLatencyMs: result.latencyMs,
      lastHealthError: result.errorMessage,
      checkedAt,
      persisted: false,
    }));
  }

  const persistedId = id as string;
  if (!live) {
    const channel = await db("o_provider_channel").where({ id: persistedId }).first() as ProviderChannelRecord | undefined;
    if (!channel) return res.status(404).send(error("Provider channel 不存在"));

    const configuration = inspectProviderChannelConfiguration(channel);
    await writeAuditLog(req, {
      workspaceId: channel.workspaceId ?? null,
      action: "admin.provider_channel.configuration_check",
      resourceType: "provider_channel",
      resourceId: channel.id,
      metadata: {
        provider: channel.provider,
        endpointType: channel.endpointType,
        configurationStatus: configuration.status,
        credentialReady: configuration.credentialReady,
        live: false,
      },
    });

    return res.status(200).send(success({
      id: channel.id,
      name: channel.name,
      provider: channel.provider,
      endpointType: channel.endpointType,
      disabled: Boolean(Number(channel.disabled)),
      live: false,
      configurationStatus: configuration.status,
      credential: {
        credentialRef: channel.credentialRef ?? null,
        credentialReady: configuration.credentialReady,
      },
      healthStatus: channel.healthStatus ?? null,
      lastHealthCheckAt: channel.lastHealthCheckAt ?? null,
      lastHealthLatencyMs: channel.lastHealthLatencyMs ?? null,
      lastHealthError: channel.lastHealthError ?? null,
      checkedAt: null,
      persisted: false,
    }));
  }

  const result = await runProviderChannelHealthCheck(persistedId);
  if (!result) return res.status(404).send(error("Provider channel 不存在"));

  const { channel } = result;
  await writeAuditLog(req, {
    workspaceId: channel.workspaceId ?? null,
    action: "admin.provider_channel.health_check",
    resourceType: "provider_channel",
    resourceId: channel.id,
    metadata: {
      provider: channel.provider,
      endpointType: channel.endpointType,
      healthStatus: result.healthStatus,
      configurationStatus: result.status,
      live: true,
      latencyMs: result.latencyMs,
      errorMessage: result.errorMessage,
    },
  });

  return res.status(200).send(success({
    id: channel.id,
    name: channel.name,
    provider: channel.provider,
    endpointType: channel.endpointType,
    disabled: Boolean(Number(channel.disabled)),
    live: true,
    configurationStatus: result.status,
    credential: {
      credentialRef: channel.credentialRef ?? null,
      credentialReady: result.credentialReady,
    },
    healthStatus: result.healthStatus,
    lastHealthCheckAt: result.checkedAt,
    lastHealthLatencyMs: result.latencyMs,
    lastHealthError: result.errorMessage,
    checkedAt: result.checkedAt,
    persisted: true,
  }));
});
