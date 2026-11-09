import { db } from "@/utils/db";
import { redactSensitive } from "@/lib/requestLog";
import {
  probeProviderChannel,
  type ProviderChannelProbeResult,
  type ProviderChannelRecord,
} from "@/lib/providerChannelHealth";

export interface PersistedProviderChannelProbe extends ProviderChannelProbeResult {
  channel: ProviderChannelRecord;
  checkedAt: number;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

export async function runProviderChannelHealthCheck(channelId: string): Promise<PersistedProviderChannelProbe | null> {
  const channel = await db("o_provider_channel").where({ id: channelId }).first() as ProviderChannelRecord | undefined;
  if (!channel) return null;

  const result = await probeProviderChannel(channel);
  const checkedAt = Date.now();
  await db("o_provider_channel").where({ id: channel.id }).update({
    healthStatus: result.healthStatus,
    lastHealthCheckAt: checkedAt,
    lastHealthLatencyMs: result.latencyMs,
    lastHealthError: result.errorMessage,
    lastHealthPayload: safeJson(redactSensitive(result.payload)),
    updateTime: checkedAt,
  });
  return { ...result, channel, checkedAt };
}
