import { selectChannelCandidates } from "./channelRouter";
import { inspectProviderChannelPortraitCredential } from "./providerChannelCredentials";

export async function resolvePortraitVideoRoutePolicy(workspaceId: string, model: string) {
  const channels = await selectChannelCandidates({
    workspaceId, model, endpointType: "video_generation", ignoreCapacity: true,
  });
  const channel = channels[0];
  if (!channel) return { available: false, enabled: false, configured: false };
  if (channel.provider !== "volcano") {
    return { available: true, enabled: false, configured: false };
  }
  const credential = inspectProviderChannelPortraitCredential(channel.id, channel.config);
  return { available: true, enabled: true, configured: credential.enabled && credential.configured };
}
