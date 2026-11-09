import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { relayEndpointTypes, relayProviders } from "@/lib/relay";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { readProviderChannelCredentialCiphertext } from "@/lib/providerChannelCredentials";
import {
  discoverProviderChannelModels,
  ProviderChannelModelDiscoveryError,
} from "@/lib/providerChannelModels";
import type { ProviderChannelRecord } from "@/lib/providerChannelHealth";

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
});

const bodySchema = z.object({ draft: draftSchema });

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const draft = parsed.data.draft;
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
  };

  try {
    const result = await discoverProviderChannelModels(channel);
    await writeAuditLog(req, {
      workspaceId: null,
      action: "admin.provider_channel.model_discovery",
      resourceType: "provider_channel",
      resourceId: channel.id,
      metadata: {
        provider: channel.provider,
        endpointType: channel.endpointType,
        modelCount: result.models.length,
        upstreamTotal: result.total,
        truncated: result.truncated,
      },
    });
    return res.status(200).send(success({
      ...result,
      persisted: false,
    }));
  } catch (caught) {
    if (caught instanceof ProviderChannelModelDiscoveryError) {
      return res.status(caught.statusCode).send({ message: caught.message });
    }
    throw caught;
  }
});
