import type { Knex } from "knex";
import { inspectProviderChannelPortraitCredential } from "./providerChannelCredentials";

export async function preferredVolcanoPortraitChannel(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  model?: string;
  /** Server-selected dispatch channel; never fall back to another account. */
  channelId?: string;
  requireModelRoute?: boolean;
}): Promise<string | null> {
  const firstReady = (rows: Array<Record<string, unknown>>): string | null => {
    for (const row of rows) {
      const id = String(row.id || "").trim();
      const portraitCredential = id
        ? inspectProviderChannelPortraitCredential(id, row.configJson)
        : null;
      if (portraitCredential?.enabled && portraitCredential.configured) return id;
    }
    return null;
  };
  if (input.model) {
    const routes = await input.database("o_model_route as route")
      .innerJoin("o_provider_channel as channel", "channel.id", "route.channelId")
      .where({
        "route.model": input.model,
        "route.endpointType": "video_generation",
        "route.disabled": 0,
        "channel.endpointType": "video_generation",
        "channel.provider": "volcano",
        "channel.disabled": 0,
      })
      .where((builder) => builder
        .where((workspace) => workspace
          .where("route.scope", "workspace")
          .where("route.workspaceId", input.workspaceId))
        .orWhere((platform) => platform
          .where("route.scope", "platform")
          .whereNull("route.workspaceId")))
      .where((builder) => builder
        .where((workspace) => workspace
          .where("channel.scope", "workspace")
          .where("channel.workspaceId", input.workspaceId))
        .orWhere((platform) => platform
          .where("channel.scope", "platform")
          .whereNull("channel.workspaceId")))
      .modify((query) => { if (input.channelId) query.where("channel.id", input.channelId); })
      .orderByRaw("CASE WHEN route.scope = 'workspace' THEN 0 ELSE 1 END")
      .orderBy("route.priority", "asc")
      .orderBy("route.fallbackOrder", "asc")
      .select("channel.id", "channel.configJson");
    const routeChannel = firstReady(routes);
    if (routeChannel) return routeChannel;
    if (input.requireModelRoute) return null;
  }
  const channels = await input.database("o_provider_channel")
    .where({ provider: "volcano", endpointType: "video_generation", disabled: 0 })
    .where((builder) => builder
      .where((workspace) => workspace.where({ scope: "workspace", workspaceId: input.workspaceId }))
      .orWhere((platform) => platform.where("scope", "platform").whereNull("workspaceId")))
    .modify((query) => { if (input.channelId) query.where("id", input.channelId); })
    .where((builder) => builder.whereNull("healthStatus").orWhereNot("healthStatus", "failed"))
    .orderByRaw("CASE WHEN scope = 'workspace' THEN 0 ELSE 1 END")
    .orderBy("priority", "asc")
    .orderBy("weight", "desc")
    .select("id", "configJson");
  return firstReady(channels);
}
