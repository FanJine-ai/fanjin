import type { Knex } from "knex";
import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";
import { PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_CONFIG_KEY, PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_GENERATION_CONFIG_KEY, PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_BINDING_CONFIG_KEY, PROVIDER_CHANNEL_IMAGEX_REVIEW_ENABLED_CONFIG_KEY } from "@/lib/providerChannelCredentials";

export const MEDIA_SERVICE_TABLE = "o_media_service";
export const MEDIA_SERVICES_MIGRATION_IDENTITY = Object.freeze({ version: 53, name: "media_services", immutableRevision: "2026-09-05.1" });
export const IMAGEX_SERVICE_CONFIG_KEYS = Object.freeze([
  PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_CONFIG_KEY,
  PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_GENERATION_CONFIG_KEY,
  PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_BINDING_CONFIG_KEY,
  PROVIDER_CHANNEL_IMAGEX_REVIEW_ENABLED_CONFIG_KEY,
]);

/** Additive copy: keep identity/envelope purpose and old binaries' data intact.
 * No provider calls, price changes, credential rotation or automatic activation.
 * Old channel rows are rollback evidence, not the new runtime's source of truth.
 */
export async function upMediaServices(trx: Knex | Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(MEDIA_SERVICE_TABLE))) {
    await trx.schema.createTable(MEDIA_SERVICE_TABLE, (table) => {
      table.text("id").primary();
      table.text("kind").notNullable();
      table.text("name").notNullable();
      table.text("provider").notNullable().defaultTo("volcano");
      table.text("endpointType").notNullable();
      table.text("scope").notNullable().defaultTo("platform");
      table.text("workspaceId");
      table.text("baseUrl");
      table.text("credentialRef");
      table.text("credentialCiphertext");
      table.text("configJson").notNullable().defaultTo("{}");
      table.text("modelNames").notNullable().defaultTo("[]");
      table.bigInteger("priority").notNullable().defaultTo(100);
      table.bigInteger("weight").notNullable().defaultTo(100);
      table.bigInteger("timeoutMs").notNullable().defaultTo(1200000);
      table.bigInteger("concurrencyLimit");
      table.bigInteger("disabled").notNullable().defaultTo(1);
      table.text("healthStatus");
      table.text("healthMessage");
      table.bigInteger("lastHealthCheckAt");
      table.text("legacyChannelId");
      table.bigInteger("createTime").notNullable();
      table.bigInteger("updateTime").notNullable();
      table.index(["kind", "disabled"], "idx_media_service_kind_enabled");
    });
  }
  if (!(await trx.schema.hasTable("o_provider_channel"))) return;
  const rows = await trx("o_provider_channel").where({ provider: "volcano" }).orderBy("id");
  for (const row of rows) {
    const config = parseProviderChannelConfig(row.configJson);
    const upscale = row.endpointType === "video_upscale";
    const imagex = row.endpointType === "video_generation" && IMAGEX_SERVICE_CONFIG_KEYS.some((key) => Boolean(config[key]));
    if (!upscale && !imagex) continue;
    // Same id is deliberate: in-flight jobs and encrypted envelopes bind it.
    if (await trx(MEDIA_SERVICE_TABLE).where({ id: row.id }).first()) continue;
    await trx(MEDIA_SERVICE_TABLE).insert({
      id: row.id, kind: upscale ? "mediakit" : "imagex", name: upscale ? row.name : `${row.name} · ImageX`,
      provider: "volcano", endpointType: upscale ? "video_upscale" : "imagex_review",
      scope: row.scope, workspaceId: row.workspaceId ?? null,
      baseUrl: upscale ? row.baseUrl : "https://imagex.volcengineapi.com",
      credentialRef: upscale ? row.credentialRef : null,
      credentialCiphertext: upscale ? row.credentialCiphertext ?? null : null,
      configJson: JSON.stringify(upscale ? config : Object.fromEntries(IMAGEX_SERVICE_CONFIG_KEYS.filter((key) => key in config).map((key) => [key, config[key]]))),
      priority: row.priority ?? 100, weight: row.weight ?? 100, timeoutMs: row.timeoutMs ?? 1200000,
      concurrencyLimit: row.concurrencyLimit ?? null, disabled: row.disabled ?? 1,
      healthStatus: null, healthMessage: "已迁移配置，尚未通过独立服务验证", lastHealthCheckAt: null,
      legacyChannelId: row.id, createTime: row.createTime ?? Date.now(), updateTime: row.updateTime ?? Date.now(),
    });
  }
}

export async function downMediaServices(): Promise<void> {
  throw new Error("Media service credentials and job identities must not be dropped. Rollback requires an explicit schema-compatibility and in-flight-task plan.");
}
