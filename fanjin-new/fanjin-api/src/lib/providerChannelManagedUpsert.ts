import { v4 as uuid } from "uuid";
import type { Knex } from "knex";

import {
  assertProviderChannelPortraitIdentityImmutable,
  hasProviderChannelPortraitIdentity,
} from "@/lib/providerChannelPortraitNamespace";
import {
  mergeProviderChannelConfigForUpdate,
  parseProviderChannelConfig,
} from "@/lib/providerChannelSecrets";
import {
  lockRelayConfigTablesForMutation,
  serializeRelayConfigMutation,
} from "@/lib/relayConfigValidation";

/**
 * Internal deployment tools may maintain ordinary channel fields, but they
 * share the same portrait ownership boundary as FJ Admin. Reserved config is
 * preserved, established identity cannot move, and a disabled portrait
 * channel is never implicitly reactivated.
 */
export async function upsertManagedProviderChannel(input: {
  data: Record<string, unknown>;
  database: Knex;
  match?: Record<string, unknown>;
  name: string;
  now?: number;
}): Promise<string> {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("managed provider channel name is required");
  const timestamp = input.now ?? Date.now();
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error("managed provider channel timestamp is invalid");
  }

  return serializeRelayConfigMutation(async () => input.database.transaction(async (trx) => {
    await lockRelayConfigTablesForMutation(trx);
    const existing = await trx("o_provider_channel")
      .where(input.match ?? { name })
      .forUpdate()
      .first();
    if (!existing) {
      const id = uuid();
      await trx("o_provider_channel").insert({
        id,
        name,
        ...input.data,
        createTime: timestamp,
        updateTime: timestamp,
      });
      return id;
    }

    const existingConfig = parseProviderChannelConfig(existing.configJson);
    const nextConfig = mergeProviderChannelConfigForUpdate(
      existingConfig,
      parseProviderChannelConfig(input.data.configJson),
    );
    const portraitIdentityEstablished = hasProviderChannelPortraitIdentity(
      existingConfig,
      existing,
    );
    const updateData = {
      ...input.data,
      configJson: JSON.stringify(nextConfig),
      disabled: portraitIdentityEstablished
        ? (Number(existing.disabled) === 0 ? 0 : 1)
        : (input.data.disabled ?? existing.disabled),
      updateTime: timestamp,
    };
    assertProviderChannelPortraitIdentityImmutable({
      existingConfig,
      existingRow: existing,
      nextConfig,
      nextRow: { ...existing, ...updateData },
    });
    await trx("o_provider_channel").where({ id: existing.id }).update(updateData);
    return String(existing.id);
  }));
}
