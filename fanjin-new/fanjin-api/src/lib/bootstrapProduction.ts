import fs from "node:fs";
import path from "node:path";
import type { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { creditBillingAccount } from "@/lib/billing";
import { generateApiKey, maskApiKey } from "@/middleware/apiKeyAuth";
import { RELAY_PRICING_UNITS } from "@/lib/productionPricing";
import {
  CACHE_STORAGE_CERTIFICATION_METADATA,
  certifiedCacheWriteAccountingContract,
} from "@/lib/cacheStorageCertifiedPricing";
import { db, dbReady } from "@/utils/db";
import { DEFAULT_PASSWORD_POLICY, validatePasswordAgainstPolicy } from "@/lib/accountSecurity";
import { assertSupportedObjectStorageConfiguration } from "@/lib/objectStorageConfig";
import { insertAndReturnId, isPostgresClient } from "@/lib/dbDialect";
import { DEFAULT_RELAY_API_KEY_PERMISSIONS } from "@/lib/relayApiKeyPermissions";
import {
  VOLCENGINE_MODEL_MANIFEST,
  buildVolcengineRouteConfig,
  findVolcengineModel,
  volcengineModelsByEndpoint,
  type VolcengineEndpointType,
  type VolcengineModel,
} from "@/lib/volcengineModelManifest";
import {
  modelRouteBootstrapIdentityKey,
  readModelRouteBootstrapTombstones,
} from "@/lib/modelRouteBootstrapTombstones";
import { SEEDANCE_25_MODEL_ID } from "@/lib/seedance25Adapter";
import { SEEDANCE_25_PRODUCTION_OPERATOR } from "@/lib/seedance25ProductionConfig";
import { volcengineProviderCostReferenceForModel } from "@/lib/volcengineProviderCostCatalog";
import { upsertManagedProviderChannel } from "@/lib/providerChannelManagedUpsert";

export interface BootstrapProductionOptions {
  adminEmail: string;
  adminName: string;
  adminPassword: string;
  rotateAdminPassword?: boolean;
  secretsFile?: string;
  workspaceId?: string;
  workspaceName?: string;
  apiKeyName?: string;
  volcanoCredentialRef?: string;
  textModel?: string;
  imageModel?: string;
  videoModel?: string;
  multimodalEmbeddingModel?: string;
  textUnitPriceMicros?: number;
  imageUnitPriceMicros?: number;
  videoUnitPriceMicros?: number;
  multimodalEmbeddingUnitPriceMicros?: number;
}

interface BootstrapProductionResult {
  adminUserId: number;
  workspaceId: string;
  apiKeyPrefix: string;
  apiKeyMasked: string;
  apiKeyCreatedThisRun: boolean;
  apiKeySecretsFileWritten: boolean;
  channelIds: string[];
  routeIds: string[];
  pricingRuleIds: string[];
  vendorId: string;
  agentDeployCount: number;
}

export const VOLCANO_ARK_CREDENTIAL_REF = "VOLCANO_ARK_API_KEY";
export const VOLCANO_ARK_ROOT_URL = "https://ark.cn-beijing.volces.com";
export const VOLCANO_ARK_API_BASE_URL = `${VOLCANO_ARK_ROOT_URL}/api/v3`;
export const VOLCANO_ARK_HEALTH_PROBE_URL = `${VOLCANO_ARK_API_BASE_URL}/models`;
export const BOOTSTRAP_DEFAULT_TEXT_UNIT_PRICE_MICROS = 2_000;
export const BOOTSTRAP_DEFAULT_IMAGE_UNIT_PRICE_MICROS = 200_000_000;
export const BOOTSTRAP_DEFAULT_VIDEO_UNIT_PRICE_MICROS = 2_000_000_000;
// Provisional only: at 500 micros/token the worst-case 128K reservation is
// 65.536 GU, so a fresh 100 GU bootstrap workspace can dispatch one request.
// priceReviewRequired remains mandatory before commercial launch.
export const BOOTSTRAP_DEFAULT_MULTIMODAL_EMBEDDING_UNIT_PRICE_MICROS = 500;

export interface BootstrapPricingSeed {
  id: string;
  name: string;
  endpointType: "text" | "image_generation" | "video_generation" | "multimodal_embedding";
  provider: "volcano";
  model: string;
  unit: "token" | "image" | "video";
  unitPriceMicros: number;
  ruleConfig: Record<string, unknown>;
}

function positiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return resolved;
}

export function buildBootstrapPricingSeeds(input: {
  textModel: string;
  imageModel: string;
  videoModel: string;
  textUnitPriceMicros?: number;
  imageUnitPriceMicros?: number;
  videoUnitPriceMicros?: number;
}): BootstrapPricingSeed[] {
  const textUnitPriceMicros = positiveSafeInteger(
    input.textUnitPriceMicros,
    BOOTSTRAP_DEFAULT_TEXT_UNIT_PRICE_MICROS,
    "textUnitPriceMicros",
  );
  const imageUnitPriceMicros = positiveSafeInteger(
    input.imageUnitPriceMicros,
    BOOTSTRAP_DEFAULT_IMAGE_UNIT_PRICE_MICROS,
    "imageUnitPriceMicros",
  );
  const videoUnitPriceMicros = positiveSafeInteger(
    input.videoUnitPriceMicros,
    BOOTSTRAP_DEFAULT_VIDEO_UNIT_PRICE_MICROS,
    "videoUnitPriceMicros",
  );
  const models = {
    text: String(input.textModel || "").trim(),
    image: String(input.imageModel || "").trim(),
    video: String(input.videoModel || "").trim(),
  };
  if (!models.text || !models.image || !models.video) {
    throw new Error("bootstrap pricing models must not be empty");
  }

  return [
    {
      id: "fanjin-default-text-pricing",
      name: "Fanjin 默认文本生成",
      endpointType: "text",
      provider: "volcano",
      model: models.text,
      unit: RELAY_PRICING_UNITS.text[0],
      unitPriceMicros: textUnitPriceMicros,
      ruleConfig: {
        label: "文本/提示词生成",
        pricingLayer: "retail",
        providerCostReference: volcengineProviderCostReferenceForModel(models.text),
        minimumMicros: 0,
        inputPriceMicros: textUnitPriceMicros,
        outputPriceMicros: textUnitPriceMicros,
        cacheReadPriceMicros: textUnitPriceMicros,
        cacheWriteAccounting: certifiedCacheWriteAccountingContract(),
        cacheStorageCertification: CACHE_STORAGE_CERTIFICATION_METADATA,
        pricingContract: "provider-model-token",
        pricingExpr: `cr*${Math.round(textUnitPriceMicros * 0.1)} + (p-cr)*${textUnitPriceMicros} + c*${textUnitPriceMicros}`,
      },
    },
    {
      id: "fanjin-default-image-pricing",
      name: "Fanjin 默认分镜图片生成",
      endpointType: "image_generation",
      provider: "volcano",
      model: models.image,
      unit: RELAY_PRICING_UNITS.image_generation[0],
      unitPriceMicros: imageUnitPriceMicros,
      ruleConfig: {
        label: "分镜图片生成",
        pricingLayer: "retail",
        providerCostReference: volcengineProviderCostReferenceForModel(models.image),
        minimumMicros: 0,
        pricingContract: "provider-model-image",
        pricingExpr: `max(img*${imageUnitPriceMicros}, ${imageUnitPriceMicros})`,
      },
    },
    {
      id: "fanjin-default-video-pricing",
      name: "Fanjin 默认视频生成",
      endpointType: "video_generation",
      provider: "volcano",
      model: models.video,
      unit: RELAY_PRICING_UNITS.video_generation[1],
      unitPriceMicros: videoUnitPriceMicros,
      ruleConfig: {
        label: "视频生成",
        pricingLayer: "retail",
        providerCostReference: volcengineProviderCostReferenceForModel(models.video),
        minimumMicros: 0,
        pricingContract: "provider-model-video",
        pricingExpr: `${videoUnitPriceMicros}`,
      },
    },
  ];
}

function manifestPricingRuleId(entry: VolcengineModel): string {
  const canonicalIds: Record<string, string> = {
    "doubao-seed-2-0-pro-260215": "fanjin-default-text-pricing",
    "doubao-seedream-5-0-260128": "fanjin-default-image-pricing",
    "doubao-seedance-2-0-fast-260128": "fanjin-default-video-pricing",
    "doubao-seedance-2-0-mini-260615": "fanjin-default-video-mini-pricing",
  };
  return canonicalIds[entry.model] || `fanjin-volcano-${entry.model}-pricing`;
}

export function buildVolcengineManifestPricingSeeds(input: {
  textUnitPriceMicros?: number;
  imageUnitPriceMicros?: number;
  videoUnitPriceMicros?: number;
  multimodalEmbeddingUnitPriceMicros?: number;
} = {}): BootstrapPricingSeed[] {
  const textUnitPriceMicros = positiveSafeInteger(
    input.textUnitPriceMicros,
    BOOTSTRAP_DEFAULT_TEXT_UNIT_PRICE_MICROS,
    "textUnitPriceMicros",
  );
  const imageUnitPriceMicros = positiveSafeInteger(
    input.imageUnitPriceMicros,
    BOOTSTRAP_DEFAULT_IMAGE_UNIT_PRICE_MICROS,
    "imageUnitPriceMicros",
  );
  const videoUnitPriceMicros = positiveSafeInteger(
    input.videoUnitPriceMicros,
    BOOTSTRAP_DEFAULT_VIDEO_UNIT_PRICE_MICROS,
    "videoUnitPriceMicros",
  );
  const multimodalEmbeddingUnitPriceMicros = positiveSafeInteger(
    input.multimodalEmbeddingUnitPriceMicros,
    BOOTSTRAP_DEFAULT_MULTIMODAL_EMBEDDING_UNIT_PRICE_MICROS,
    "multimodalEmbeddingUnitPriceMicros",
  );

  // Exact Seedance 2.5 pricing cannot use a guessed modality-wide bootstrap
  // price or reservation ceiling. The dedicated operator staging command
  // persists its disabled 70/42 token contract only after explicit evidence.
  return VOLCENGINE_MODEL_MANIFEST
    .filter((entry) => (
      entry.model !== SEEDANCE_25_MODEL_ID
      && entry.accountModelDirectoryStatus !== "absent"
    ))
    .map((entry): BootstrapPricingSeed => {
      const sharedRuleConfig = {
        label: `${entry.label}（Bootstrap 临时价格）`,
        pricingLayer: "retail",
        providerCostReference: volcengineProviderCostReferenceForModel(entry.model),
        pricingSource: "bootstrap-modality-default",
        priceReviewRequired: true,
        manifestModel: entry.model,
      };
      if (entry.endpointType === "text") {
        return {
          id: manifestPricingRuleId(entry),
          name: `Fanjin ${entry.label} 文本生成`,
          endpointType: "text",
          provider: "volcano",
          model: entry.model,
          unit: RELAY_PRICING_UNITS.text[0],
          unitPriceMicros: textUnitPriceMicros,
          ruleConfig: {
            ...sharedRuleConfig,
            minimumMicros: 0,
            inputPriceMicros: textUnitPriceMicros,
            outputPriceMicros: textUnitPriceMicros,
            cacheReadPriceMicros: textUnitPriceMicros,
            cacheWriteAccounting: certifiedCacheWriteAccountingContract(),
            cacheStorageCertification: CACHE_STORAGE_CERTIFICATION_METADATA,
            pricingContract: "provider-model-token",
            pricingExpr: `cr*${Math.round(textUnitPriceMicros * 0.1)} + (p-cr)*${textUnitPriceMicros} + c*${textUnitPriceMicros}`,
          },
        };
      }
      if (entry.endpointType === "image_generation") {
        return {
          id: manifestPricingRuleId(entry),
          name: `Fanjin ${entry.label} 图片生成`,
          endpointType: "image_generation",
          provider: "volcano",
          model: entry.model,
          unit: RELAY_PRICING_UNITS.image_generation[0],
          unitPriceMicros: imageUnitPriceMicros,
          ruleConfig: {
            ...sharedRuleConfig,
            minimumMicros: 0,
            pricingContract: "provider-model-image",
            pricingExpr: `max(img*${imageUnitPriceMicros}, ${imageUnitPriceMicros})`,
          },
        };
      }
      if (entry.endpointType === "multimodal_embedding") {
        // Bootstrap stays provisional, but its expression must preserve the
        // text/visual usage split used by the runtime. The single configured
        // unit price is the conservative visual price; operators may lower the
        // text bucket after certifying the official commercial price.
        const textUnitPriceMicros = Math.max(1, Math.round(multimodalEmbeddingUnitPriceMicros * 7 / 18));
        return {
          id: manifestPricingRuleId(entry),
          name: `Fanjin ${entry.label} 多模态向量`,
          endpointType: "multimodal_embedding",
          provider: "volcano",
          model: entry.model,
          unit: RELAY_PRICING_UNITS.multimodal_embedding[0],
          unitPriceMicros: multimodalEmbeddingUnitPriceMicros,
          ruleConfig: {
            ...sharedRuleConfig,
            minimumMicros: 0,
            pricingContract: "provider-model-multimodal-token-breakdown",
            textTokenPriceMicros: textUnitPriceMicros,
            mediaTokenPriceMicros: multimodalEmbeddingUnitPriceMicros,
            pricingExpr: `p*${textUnitPriceMicros} + img*${multimodalEmbeddingUnitPriceMicros}`,
            provisionalReason: "Official Ark billing price requires production review before launch",
            provisionalPriceRationale: "Keep the 128K safety reservation within the initial 100 GU bootstrap credit",
            reservationUpperBoundTokens: 131_072,
            sourceUpdatedAt: "2026-07-13",
          },
        };
      }
      return {
        id: manifestPricingRuleId(entry),
        name: `Fanjin ${entry.label} 视频生成`,
        endpointType: "video_generation",
        provider: "volcano",
        model: entry.model,
        unit: RELAY_PRICING_UNITS.video_generation[1],
        unitPriceMicros: videoUnitPriceMicros,
        ruleConfig: {
          ...sharedRuleConfig,
          minimumMicros: 0,
          pricingContract: "provider-model-video",
          pricingExpr: `${videoUnitPriceMicros}`,
        },
      };
    });
}

export function buildVolcanoChannelCredentialSeed(endpointType: string) {
  return {
    baseUrl: endpointType === "video_generation" ? VOLCANO_ARK_ROOT_URL : VOLCANO_ARK_API_BASE_URL,
    credentialRef: VOLCANO_ARK_CREDENTIAL_REF,
    config: {
      seeded: true,
      credentialStorage: "environment-reference-only",
      healthProbeUrl: VOLCANO_ARK_HEALTH_PROBE_URL,
    },
  } as const;
}

export function buildVolcengineBootstrapChannelSeeds(): Array<{
  name: string;
  endpointType: VolcengineEndpointType;
  modelNames: string[];
}> {
  const channels: Array<{ name: string; endpointType: VolcengineEndpointType }> = [
    { name: "Volcano Ark Text", endpointType: "text" },
    { name: "Volcano Ark Image", endpointType: "image_generation" },
    { name: "Volcano Seedance Video", endpointType: "video_generation" },
    { name: "Volcano Ark Multimodal Embedding", endpointType: "multimodal_embedding" },
  ];
  return channels.map((seed) => ({
    ...seed,
    modelNames: volcengineModelsByEndpoint(seed.endpointType)
      .filter((entry) => entry.accountModelDirectoryStatus !== "absent")
      .map((entry) => entry.model),
  }));
}

export function buildVolcengineVendorMetadata() {
  return {
    credentialRef: VOLCANO_ARK_CREDENTIAL_REF,
    baseUrl: VOLCANO_ARK_API_BASE_URL,
  } as const;
}

function resolveVolcanoCredentialRef(requested?: string): string {
  if (requested && requested.trim() !== VOLCANO_ARK_CREDENTIAL_REF) {
    throw new Error("Volcano bootstrap only accepts the VOLCANO_ARK_API_KEY credential reference");
  }
  return VOLCANO_ARK_CREDENTIAL_REF;
}

function now() {
  return Date.now();
}

export async function ensureBootstrapAdmin(
  database: any,
  options: Required<Pick<BootstrapProductionOptions, "adminEmail" | "adminName" | "adminPassword">>
    & Pick<BootstrapProductionOptions, "rotateAdminPassword">
    & { workspaceId: string },
): Promise<number> {
  const existing = await database("o_user").where("email", options.adminEmail).first();
  const timestamp = now();
  if (existing) {
    const passwordMatches = await verifyPassword(options.adminPassword, existing.password);
    if (!passwordMatches && !options.rotateAdminPassword) {
      throw new Error(
        "FANJIN_BOOTSTRAP_ADMIN_PASSWORD 与现有管理员密码不一致；若确认轮换，请显式设置 FANJIN_BOOTSTRAP_ROTATE_ADMIN_PASSWORD=1",
      );
    }
    const patch: Record<string, unknown> = {
      name: options.adminName,
      displayName: options.adminName,
      role: "root",
      status: "active",
      emailVerifiedAt: existing.emailVerifiedAt || timestamp,
      currentWorkspaceId: options.workspaceId,
      defaultWorkspaceId: options.workspaceId,
      updatedAt: timestamp,
    };
    if (!passwordMatches) {
      patch.password = await hashPassword(options.adminPassword);
      patch.passwordChangedAt = timestamp;
    }
    await database.transaction(async (trx: any) => {
      await trx("o_user").where("id", existing.id).update(patch);
      if (!passwordMatches) {
        await trx("o_user_session")
          .where({ userId: existing.id })
          .whereNull("revokedAt")
          .update({ revokedAt: timestamp, updatedAt: timestamp });
      }
    });
    return Number(existing.id);
  }

  const id = await insertAndReturnId(database, "o_user", {
    name: options.adminName,
    email: options.adminEmail,
    displayName: options.adminName,
    password: await hashPassword(options.adminPassword),
    passwordChangedAt: timestamp,
    role: "root",
    status: "active",
    emailVerifiedAt: timestamp,
    currentWorkspaceId: options.workspaceId,
    defaultWorkspaceId: options.workspaceId,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastLoginAt: null,
  });
  if (!id) throw new Error("生产管理员创建失败");
  return id;
}

export interface BootstrapApiKeyDeliveryPlan {
  existing: { keyPrefix: string } | null;
  secretsFile: string | null;
}

async function findActiveBootstrapApiKey(
  database: any,
  input: { name: string; workspaceId: string },
  timestamp = now(),
): Promise<any | null> {
  return await database("o_api_key")
    .where({ name: input.name, workspaceId: input.workspaceId })
    .where((builder: any) => builder.whereNull("revokedAt").orWhere("revokedAt", 0))
    .where((builder: any) => builder.whereNull("disabled").orWhere("disabled", 0))
    .where((builder: any) => builder.whereNull("expiresAt").orWhere("expiresAt", 0).orWhere("expiresAt", ">", timestamp))
    .first();
}

export async function acquireBootstrapApiKeyDeliveryLock(
  database: any,
  input: { name: string; workspaceId: string },
): Promise<void> {
  if (!isPostgresClient(database)) return;
  // Production bootstrap requires PostgreSQL. A transaction-scoped advisory
  // lock serializes the query/create/publish sequence across release processes
  // without imposing a uniqueness rule on historical revoked keys.
  await database.raw(
    "SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))",
    ["fanjin-bootstrap-api-key", JSON.stringify([input.workspaceId, input.name])],
  );
}

export function validateBootstrapSecretsFile(rawPath: string | undefined): string {
  const configured = String(rawPath || "").trim();
  if (!configured) {
    throw new Error(
      "首次创建 bootstrap API Key 必须设置 FANJIN_BOOTSTRAP_SECRETS_FILE，以 0600 文件安全接收明文",
    );
  }
  if (process.env.NODE_ENV === "prod" && !path.isAbsolute(configured)) {
    throw new Error("FANJIN_BOOTSTRAP_SECRETS_FILE 在生产环境必须使用绝对路径");
  }
  const resolved = path.resolve(configured);
  const parent = path.dirname(resolved);
  let parentStat: fs.Stats;
  try {
    parentStat = fs.statSync(parent);
  } catch {
    throw new Error("FANJIN_BOOTSTRAP_SECRETS_FILE 的父目录不存在");
  }
  if (!parentStat.isDirectory()) throw new Error("FANJIN_BOOTSTRAP_SECRETS_FILE 的父路径不是目录");
  try {
    fs.accessSync(parent, fs.constants.W_OK);
  } catch {
    throw new Error("FANJIN_BOOTSTRAP_SECRETS_FILE 的父目录不可写");
  }
  if (fs.existsSync(resolved)) {
    throw new Error(
      "FANJIN_BOOTSTRAP_SECRETS_FILE 已存在；为避免覆盖或丢失旧密钥，请使用新的空路径",
    );
  }
  return resolved;
}

export async function prepareBootstrapApiKeyDelivery(
  database: any,
  input: { name: string; workspaceId: string; secretsFile?: string },
): Promise<BootstrapApiKeyDeliveryPlan> {
  const existing = await findActiveBootstrapApiKey(database, input);
  if (existing) return { existing: { keyPrefix: String(existing.keyPrefix) }, secretsFile: null };
  return {
    existing: null,
    secretsFile: validateBootstrapSecretsFile(input.secretsFile),
  };
}

async function writeBootstrapApiKeySecrets(
  targetPath: string,
  input: { name: string; workspaceId: string; keyPrefix: string; plainKey: string; createdAt: number },
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${uuid()}.tmp`,
  );
  let handle: fs.promises.FileHandle | null = null;
  let published = false;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({
      version: 1,
      createdAt: new Date(input.createdAt).toISOString(),
      apiKey: {
        name: input.name,
        workspaceId: input.workspaceId,
        keyPrefix: input.keyPrefix,
        plainKey: input.plainKey,
      },
    }, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.chmod(temporaryPath, 0o600);
    // Hard-link publication is atomic and fails with EEXIST instead of
    // replacing a previously delivered secret file.
    await fs.promises.link(temporaryPath, targetPath);
    published = true;
    await fs.promises.unlink(temporaryPath);
    await fs.promises.chmod(targetPath, 0o600);
    if (process.platform !== "win32") {
      const directoryHandle = await fs.promises.open(path.dirname(targetPath), "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
    if (published) await fs.promises.unlink(targetPath).catch(() => undefined);
    throw error;
  }
}

async function ensureWorkspace(workspaceId: string, workspaceName: string, ownerUserId: number): Promise<void> {
  const timestamp = now();
  const existing = await (db as any)("o_workspace").where("id", workspaceId).first();
  if (existing) {
    await (db as any)("o_workspace").where("id", workspaceId).update({
      name: workspaceName,
      ownerUserId,
      status: "active",
      updatedAt: timestamp,
    });
  } else {
    await (db as any)("o_workspace").insert({
      id: workspaceId,
      name: workspaceName,
      slug: workspaceId,
      ownerUserId,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  const member = await (db as any)("o_workspace_member").where({ workspaceId, userId: ownerUserId }).first();
  if (member) {
    await (db as any)("o_workspace_member").where("id", member.id).update({
      role: "owner",
      status: "active",
      updatedAt: timestamp,
    });
  } else {
    await (db as any)("o_workspace_member").insert({
      id: uuid(),
      workspaceId,
      userId: ownerUserId,
      role: "owner",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
}

async function ensureBootstrapCredits(workspaceId: string, ownerUserId: number): Promise<void> {
  await creditBillingAccount({
    workspaceId,
    amountMicros: 100_000_000,
    type: "topup",
    description: "生产初始化测试 GU：用于分镜图片和视频生成",
    createdBy: ownerUserId,
    idempotencyKey: "fanjin-dev-topup-100-gu",
  });
}

export async function ensureBootstrapApiKey(
  database: any,
  plan: BootstrapApiKeyDeliveryPlan,
  input: { name: string; workspaceId: string; ownerUserId: number },
): Promise<{
  prefix: string;
  masked: string;
  createdThisRun: boolean;
  secretsFileWritten: boolean;
}> {
  const secretsFile = plan.secretsFile;
  let secretsFileWritten = false;
  try {
    return await database.transaction(async (trx: any) => {
      await acquireBootstrapApiKeyDeliveryLock(trx, input);
      const existing = await findActiveBootstrapApiKey(trx, input);
      if (existing) {
        const keyPrefix = String(existing.keyPrefix);
        return {
          prefix: keyPrefix,
          masked: maskApiKey(keyPrefix),
          createdThisRun: false,
          secretsFileWritten: false,
        };
      }
      if (!secretsFile) {
        throw new Error("bootstrap API Key 交付计划缺少 secrets 文件路径；请重新运行 bootstrap 预检");
      }

      const timestamp = now();
      const { plainKey, keyPrefix, keyHash } = generateApiKey();
      await trx("o_api_key").insert({
        id: uuid(),
        name: input.name,
        keyPrefix,
        keyHash,
        scope: "workspace",
        workspaceId: input.workspaceId,
        ownerUserId: input.ownerUserId,
        permissions: JSON.stringify(DEFAULT_RELAY_API_KEY_PERMISSIONS),
        quotaLimit: null,
        quotaUsed: 0,
        rateLimitPerMinute: null,
        expiresAt: null,
        lastUsedAt: null,
        disabled: 0,
        revokedAt: null,
        createTime: timestamp,
        updateTime: timestamp,
      });
      await writeBootstrapApiKeySecrets(secretsFile, {
        name: input.name,
        workspaceId: input.workspaceId,
        keyPrefix,
        plainKey,
        createdAt: timestamp,
      });
      secretsFileWritten = true;
      return {
        prefix: keyPrefix,
        masked: maskApiKey(keyPrefix),
        createdThisRun: true,
        secretsFileWritten: true,
      };
    });
  } catch (error) {
    if (secretsFileWritten && typeof secretsFile === "string") {
      const secretsFileToRemove = secretsFile;
      await fs.promises.unlink(secretsFileToRemove).catch(() => undefined);
    }
    throw error;
  }
}

export async function ensureBootstrapProviderChannel(
  database: Knex,
  name: string,
  endpointType: string,
  modelNames: string[],
): Promise<string> {
  const timestamp = now();
  const credentialSeed = buildVolcanoChannelCredentialSeed(endpointType);
  return upsertManagedProviderChannel({
    database,
    match: { name, endpointType },
    name,
    now: timestamp,
    data: {
      scope: "platform",
      workspaceId: null,
      provider: "volcano",
      endpointType,
      baseUrl: credentialSeed.baseUrl,
      credentialRef: credentialSeed.credentialRef,
      modelNames: JSON.stringify(modelNames),
      priority: 10,
      weight: 1,
      timeoutMs: endpointType === "video_generation" ? 900000 : 600000,
      concurrencyLimit: null,
      configJson: JSON.stringify(credentialSeed.config),
      disabled: 0,
    },
  });
}

async function ensureChannel(name: string, endpointType: string, modelNames: string[]): Promise<string> {
  return ensureBootstrapProviderChannel(db as Knex, name, endpointType, modelNames);
}

function parseSeededRouteConfig(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function ensureRoute(input: {
  name: string;
  endpointType: VolcengineEndpointType;
  model: string;
  channelId: string;
  routeConfig: Record<string, unknown>;
  priority: number;
  disabled?: 0 | 1;
}): Promise<string> {
  const candidates = await (db as any)("o_model_route")
    .where({
      scope: "platform",
      endpointType: input.endpointType,
      model: input.model,
      provider: "volcano",
    })
    .whereNull("workspaceId")
    .orderBy("createTime", "asc");
  const existing = candidates.find((candidate: any) => candidate.name === input.name)
    || candidates.find((candidate: any) => {
      const config = parseSeededRouteConfig(candidate.routeConfig);
      return config.seeded === true || config.managedBy === "production-bootstrap";
    });
  if (input.model === SEEDANCE_25_MODEL_ID && candidates.length > 1) {
    throw new Error("存在多个 Seedance 2.5 平台路由，bootstrap 拒绝自动选择或覆盖");
  }
  if (input.model === SEEDANCE_25_MODEL_ID && existing) {
    const existingConfig = parseSeededRouteConfig(existing.routeConfig);
    if (existingConfig.managedBy === SEEDANCE_25_PRODUCTION_OPERATOR) {
      // A later operator-controlled activation must never be silently reverted
      // by the generic production bootstrap.
      return existing.id;
    }
    if (
      Number(existing.disabled || 0) !== 1
      || existingConfig.managedBy !== "production-bootstrap"
    ) {
      throw new Error("现有 Seedance 2.5 路由不是 bootstrap staging 或 operator 管理配置，拒绝覆盖");
    }
  }
  const timestamp = now();
  const row = {
    name: input.name,
    scope: "platform",
    workspaceId: null,
    endpointType: input.endpointType,
    model: input.model,
    provider: "volcano",
    channelId: input.channelId,
    priority: input.priority,
    fallbackOrder: 0,
    routeConfig: JSON.stringify(input.routeConfig),
    disabled: input.disabled ?? 0,
    updateTime: timestamp,
  };
  if (existing) {
    await (db as any)("o_model_route").where("id", existing.id).update(row);
    return existing.id;
  }

  const id = uuid();
  await (db as any)("o_model_route").insert({ id, ...row, createTime: timestamp });
  return id;
}

function requireBootstrapModel(model: string, endpointType: VolcengineEndpointType): VolcengineModel {
  const entry = findVolcengineModel(model, endpointType);
  if (!entry) {
    throw new Error(
      `生产初始化模型 ${model} 不在 ${endpointType} 火山模型 Manifest 中；请先补齐 capability 和价格后再启用`,
    );
  }
  return entry;
}

function routeName(entry: VolcengineModel, defaultModels: Record<VolcengineEndpointType, string>): string {
  if (entry.model === defaultModels[entry.endpointType]) {
    if (entry.endpointType === "text") return "Default Volcano Text";
    if (entry.endpointType === "image_generation") return "Default Volcano Image";
    if (entry.endpointType === "multimodal_embedding") return "Default Volcano Multimodal Embedding";
    return "Default Seedance Video";
  }
  if (entry.model === "doubao-seedance-2-0-mini-260615") return "Seedance 2.0 Mini Video";
  if (entry.model === SEEDANCE_25_MODEL_ID) return "Seedance 2.5 Catalog Staging";
  return `Volcano ${entry.label}`;
}

async function ensurePricingRule(input: BootstrapPricingSeed): Promise<string> {
  const timestamp = now();
  const row = {
    name: input.name,
    scope: "platform",
    workspaceId: null,
    endpointType: input.endpointType,
    provider: input.provider,
    model: input.model,
    unit: input.unit,
    unitPriceMicros: input.unitPriceMicros,
    currency: "GU",
    ruleConfig: JSON.stringify(input.ruleConfig),
    disabled: 0,
    updateTime: timestamp,
  };
  const existing = await (db as any)("o_pricing_rule").where("id", input.id).first();
  if (existing) {
    await (db as any)("o_pricing_rule").where("id", input.id).update(row);
  } else {
    await (db as any)("o_pricing_rule").insert({ id: input.id, ...row, createTime: timestamp });
  }
  return input.id;
}

async function ensureVolcengineVendor(): Promise<string> {
  const existing = await (db as any)("o_vendorConfig").where("id", "volcengine").first();
  const row = {
    // Legacy vendor metadata may describe where a credential is resolved, but
    // it must never contain the credential value itself.
    inputValues: JSON.stringify(buildVolcengineVendorMetadata()),
    models: existing?.models || "[]",
    enable: 1,
  };

  if (existing) {
    await (db as any)("o_vendorConfig").where("id", "volcengine").update(row);
  } else {
    await (db as any)("o_vendorConfig").insert({ id: "volcengine", ...row });
  }
  return "volcengine";
}

async function ensureAgentDeployModels(textModel: string, vendorId: string): Promise<number> {
  const modelName = `${vendorId}:${textModel}`;
  const rows = await (db as any)("o_agentDeploy").select("id", "key", "disabled");
  const enabledRows = rows.filter((row: any) => row.disabled === 0 || row.disabled === false || row.disabled == null);
  const targetRows = enabledRows.length ? enabledRows : rows;
  for (const row of targetRows) {
    await (db as any)("o_agentDeploy").where("id", row.id).update({
      model: textModel,
      modelName,
      vendorId,
      disabled: row.disabled ?? 0,
    });
  }

  const agentUseMode = await (db as any)("o_setting").where("key", "agentUseMode").first();
  if (agentUseMode) {
    await (db as any)("o_setting").where("key", "agentUseMode").update({ value: "0" });
  } else {
    await (db as any)("o_setting").insert({ key: "agentUseMode", value: "0" });
  }

  return targetRows.length;
}

export async function bootstrapProduction(options: BootstrapProductionOptions): Promise<BootstrapProductionResult> {
  assertSupportedObjectStorageConfiguration();
  await dbReady;

  const workspaceId = options.workspaceId || "default";
  const workspaceName = options.workspaceName || "Fanjin Production";
  const apiKeyName = options.apiKeyName || "Fanjin production relay key";
  resolveVolcanoCredentialRef(options.volcanoCredentialRef);
  const textModel = options.textModel || "doubao-seed-2-0-pro-260215";
  const imageModel = options.imageModel || "doubao-seedream-5-0-260128";
  const videoModel = options.videoModel || "doubao-seedance-2-0-fast-260128";
  const multimodalEmbeddingModel = options.multimodalEmbeddingModel || "doubao-embedding-vision-251215";
  requireBootstrapModel(textModel, "text");
  requireBootstrapModel(imageModel, "image_generation");
  requireBootstrapModel(videoModel, "video_generation");
  requireBootstrapModel(multimodalEmbeddingModel, "multimodal_embedding");
  const pricingSeeds = buildVolcengineManifestPricingSeeds({
    textUnitPriceMicros: options.textUnitPriceMicros,
    imageUnitPriceMicros: options.imageUnitPriceMicros,
    videoUnitPriceMicros: options.videoUnitPriceMicros,
    multimodalEmbeddingUnitPriceMicros: options.multimodalEmbeddingUnitPriceMicros,
  });

  if (!options.adminEmail || !options.adminName || !options.adminPassword) {
    throw new Error("adminEmail, adminName, and adminPassword are required");
  }
  const adminPasswordError = validatePasswordAgainstPolicy(options.adminPassword, DEFAULT_PASSWORD_POLICY);
  if (adminPasswordError) throw new Error(`生产管理员${adminPasswordError}`);

  // This preflight must happen before creating or mutating bootstrap business
  // records so a first-run key can never be created without a delivery target.
  const apiKeyDeliveryPlan = await prepareBootstrapApiKeyDelivery(db as any, {
    name: apiKeyName,
    workspaceId,
    secretsFile: options.secretsFile,
  });

  const adminUserId = await ensureBootstrapAdmin(db as any, {
    adminEmail: options.adminEmail,
    adminName: options.adminName,
    adminPassword: options.adminPassword,
    rotateAdminPassword: options.rotateAdminPassword,
    workspaceId,
  });
  await ensureWorkspace(workspaceId, workspaceName, adminUserId);
  await ensureBootstrapCredits(workspaceId, adminUserId);
  const apiKey = await ensureBootstrapApiKey(db as any, apiKeyDeliveryPlan, {
    name: apiKeyName,
    workspaceId,
    ownerUserId: adminUserId,
  });
  const channelSeeds = buildVolcengineBootstrapChannelSeeds();
  const channelByEndpoint = {} as Record<VolcengineEndpointType, string>;
  for (const seed of channelSeeds) {
    channelByEndpoint[seed.endpointType] = await ensureChannel(
      seed.name,
      seed.endpointType,
      seed.modelNames,
    );
  }
  const vendorId = await ensureVolcengineVendor();
  const agentDeployCount = await ensureAgentDeployModels(textModel, vendorId);
  const defaultModels: Record<VolcengineEndpointType, string> = {
    text: textModel,
    image_generation: imageModel,
    video_generation: videoModel,
    multimodal_embedding: multimodalEmbeddingModel,
  };
  const orderedManifest = [...VOLCENGINE_MODEL_MANIFEST].sort((left, right) => {
    const leftDefault = Number(left.model === defaultModels[left.endpointType]);
    const rightDefault = Number(right.model === defaultModels[right.endpointType]);
    return rightDefault - leftDefault;
  });
  const routeIds: string[] = [];
  const deletedBootstrapRoutes = await readModelRouteBootstrapTombstones(db as any);
  for (const entry of orderedManifest) {
    if (deletedBootstrapRoutes.has(modelRouteBootstrapIdentityKey({
      endpointType: entry.endpointType,
      model: entry.model,
      provider: "volcano",
    }))) continue;
    routeIds.push(await ensureRoute({
      name: routeName(entry, defaultModels),
      endpointType: entry.endpointType,
      model: entry.model,
      channelId: channelByEndpoint[entry.endpointType],
      routeConfig: buildVolcengineRouteConfig(entry),
      priority: entry.model === defaultModels[entry.endpointType] ? 0 : 10,
      disabled: entry.model === SEEDANCE_25_MODEL_ID
        || entry.accountModelDirectoryStatus === "absent"
        || entry.capabilityStatus === "catalogued"
        ? 1
        : 0,
    }));
  }
  const pricingRuleIds: string[] = [];
  for (const seed of pricingSeeds) pricingRuleIds.push(await ensurePricingRule(seed));

  return {
    adminUserId,
    workspaceId,
    apiKeyPrefix: apiKey.prefix,
    apiKeyMasked: apiKey.masked,
    apiKeyCreatedThisRun: apiKey.createdThisRun,
    apiKeySecretsFileWritten: apiKey.secretsFileWritten,
    channelIds: channelSeeds.map((seed) => channelByEndpoint[seed.endpointType]),
    routeIds,
    pricingRuleIds,
    vendorId,
    agentDeployCount,
  };
}
