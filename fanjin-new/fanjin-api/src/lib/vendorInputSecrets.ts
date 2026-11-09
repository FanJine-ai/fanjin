import type { Knex } from "knex";
import {
  isSensitiveProviderConfigKey,
  mergeProviderChannelConfigForUpdate,
  parseProviderChannelConfig,
} from "@/lib/providerChannelSecrets";
import { isSealedSecret, openSecret, sealSecret } from "@/lib/secretEnvelope";

function purpose(vendorId: string, key: string): string {
  return `vendor-input:${vendorId}:${key}`;
}

export function sealVendorInputValues(vendorId: string, raw: unknown): Record<string, unknown> {
  const values = parseProviderChannelConfig(raw);
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!isSensitiveProviderConfigKey(key) || value === null || value === undefined || value === "") {
      output[key] = value;
      continue;
    }
    if (typeof value !== "string") throw new Error(`Vendor secret ${vendorId}.${key} must be a string`);
    output[key] = isSealedSecret(value) ? value : sealSecret(value, purpose(vendorId, key));
  }
  return output;
}

export function mergeAndSealVendorInputValues(vendorId: string, existing: unknown, incoming: Record<string, unknown>): Record<string, unknown> {
  return sealVendorInputValues(vendorId, mergeProviderChannelConfigForUpdate(existing, incoming));
}

export function openVendorInputValues(vendorId: string, raw: unknown): Record<string, unknown> {
  const values = parseProviderChannelConfig(raw);
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && isSealedSecret(value)) {
      output[key] = openSecret(value, purpose(vendorId, key));
    } else if (process.env.NODE_ENV === "prod" && isSensitiveProviderConfigKey(key) && value) {
      throw new Error(`Vendor secret ${vendorId}.${key} is not encrypted`);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export async function migrateVendorInputSecrets(database: Knex): Promise<{ migratedRows: number }> {
  const rows = await database<any>("o_vendorConfig").select("id", "inputValues");
  let migratedRows = 0;
  await database.transaction(async (trx) => {
    for (const row of rows) {
      const before = String(row.inputValues || "{}");
      let parsed: unknown;
      try {
        parsed = JSON.parse(before);
      } catch {
        throw new Error(`Vendor ${row.id} inputValues is invalid JSON; refusing to overwrite it`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Vendor ${row.id} inputValues must be a JSON object; refusing to overwrite it`);
      }
      const after = JSON.stringify(sealVendorInputValues(String(row.id), parsed));
      if (after === before) continue;
      await trx<any>("o_vendorConfig").where({ id: row.id }).update({ inputValues: after });
      migratedRows += 1;
    }
  });
  return { migratedRows };
}
