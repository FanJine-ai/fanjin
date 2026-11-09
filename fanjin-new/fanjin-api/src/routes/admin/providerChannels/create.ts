import { configureTokenhexPortraitCredential, isTokenhexPortraitOrigin } from "@/lib/tokenhexPortraitChannel";
import { responsesTransportConfigError } from "@/lib/responsesTransport";
import express from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { relayEndpointTypes, relayProviders, relayScopes } from "@/lib/relay";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { containsInlineProviderSecret, redactProviderChannelConfig } from "@/lib/providerChannelSecrets";
import {
  inspectProviderChannelPortraitCredential,
  TOKENHEX_PORTRAIT_CREDENTIAL_VERSION,
  sealProviderChannelCredential,
  withoutProviderChannelReservedConfig,
  withProviderChannelCredentialCiphertext,
  withProviderChannelPortraitAssetsEnabled,
  withProviderChannelPortraitCredential,
} from "@/lib/providerChannelCredentials";
import {
  providerCredentialFallbackEnvNames,
  resolveChannelCredential,
} from "@/lib/relayChannelCredential";
import {
  lockRelayConfigTablesForMutation,
  normalizeAndValidateProviderChannel,
  RelayConfigValidationError,
  relayConfigValidationErrorBody,
  serializeRelayConfigMutation,
} from "@/lib/relayConfigValidation";
import {
  assertProviderChannelPortraitNamespaceAvailable,
  ProviderChannelPortraitIdentityError,
  ProviderChannelPortraitNamespaceError,
  readProviderChannelPortraitNamespace,
  withProviderChannelPortraitNamespace,
} from "@/lib/providerChannelPortraitNamespace";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  name: z.string().trim().min(1),
  scope: z.enum(relayScopes).default("platform"),
  workspaceId: z.string().trim().optional().nullable(),
  provider: z.enum(relayProviders),
  endpointType: z.enum(relayEndpointTypes),
  baseUrl: z.string().trim().optional().nullable(),
  credentialRef: z.string().trim().optional().nullable(),
  apiKey: z.string().max(16_384).optional(),
  portraitCredentialSource: z.literal("tokenhex_channel_api_key").optional(),
  portraitAssetsEnabled: z.boolean().default(false),
  providerAccountId: z.string().max(128).optional(),
  assetsProjectName: z.string().max(128).optional(),
  portraitAccessKeyId: z.string().max(256).optional(),
  portraitSecretAccessKey: z.string().max(512).optional(),
  portraitSessionToken: z.string().max(768).optional(),
  configJson: z.record(z.string(), z.any()).default({}),
  modelNames: z.array(z.string()).default([]),
  priority: z.number().int().default(100),
  weight: z.number().int().default(1),
  timeoutMs: z.number().int().default(600000),
  concurrencyLimit: z.number().int().optional().nullable(),
  disabled: z.number().int().min(0).max(1).default(0),
});

export default router.post("/", async (req, res) => {
  if (req.body?.endpointType === "video_upscale" || Object.keys(req.body || {}).some((key) => key.startsWith("imagex"))) {
    return res.status(400).send({ message: "模型通道只接入上游模型；请在媒体服务页配置超分和 ImageX" });
  }
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const now = Date.now();
  const id = uuid();
  const data = parsed.data;
  let created: Record<string, unknown>;
  try {
    created = await serializeRelayConfigMutation(async () => db.transaction(async (trx) => {
      await lockRelayConfigTablesForMutation(trx);
      const integrity = await normalizeAndValidateProviderChannel(trx, data);
      const publicConfig = withoutProviderChannelReservedConfig(data.configJson);
      const transportError = responsesTransportConfigError(data.provider, data.endpointType, publicConfig);
      if (transportError) throw new RelayConfigValidationError({
        message: transportError, issues: [{ path: ["configJson", "responsesTransport"], message: transportError }],
      });
      if (process.env.NODE_ENV === "prod" && containsInlineProviderSecret(publicConfig)) {
        throw new RelayConfigValidationError({
          message: "生产环境禁止在高级配置 JSON 中保存明文密钥，请使用 API Key 字段（加密保存）或环境变量引用",
          issues: [{ path: ["configJson"], message: "请改用 API Key 字段或 credentialRef" }],
        });
      }
      let storedConfig = data.apiKey?.trim()
        ? withProviderChannelCredentialCiphertext(
            publicConfig,
            sealProviderChannelCredential(id, data.apiKey),
          )
        : publicConfig;
      const useTokenhex = data.portraitCredentialSource === "tokenhex_channel_api_key";
      const portraitAccessKeyId = data.portraitAccessKeyId?.trim() || "";
      const portraitSecretAccessKey = data.portraitSecretAccessKey || "";
      const portraitSessionToken = data.portraitSessionToken || "";
      const akSubmitted = Boolean(portraitAccessKeyId || portraitSecretAccessKey || portraitSessionToken);
      if (useTokenhex && akSubmitted) {
        throw new RelayConfigValidationError({ message: "Tokenhex 使用本通道 API Key，不可同时提交 AK/SK", issues: [{ path: ["portraitCredentialSource"], message: "请勿混用凭据类型" }] });
      }
      const portraitCredentialSubmitted = akSubmitted || useTokenhex;
      if (
        (akSubmitted && (!portraitAccessKeyId || !portraitSecretAccessKey))
        || (data.portraitAssetsEnabled && !portraitCredentialSubmitted)
      ) {
        throw new RelayConfigValidationError({
          message: "启用人像资产时必须同时配置独立的 Access Key ID 与 Secret Access Key",
          issues: [{ path: ["portraitSecretAccessKey"], message: "请完整填写独立 AK/SK" }],
        });
      }
      if (
        (data.portraitAssetsEnabled || portraitCredentialSubmitted)
        && (
          data.provider !== "volcano"
          || data.endpointType !== "video_generation"
        )
      ) {
        throw new RelayConfigValidationError({
          message: "人像资产仅支持 Volcano 视频生成通道",
          issues: [{ path: ["portraitAssetsEnabled"], message: "请选择 Volcano 视频生成通道" }],
        });
      }
      try {
        storedConfig = withProviderChannelPortraitNamespace({
          assetsProjectName: data.assetsProjectName,
          config: storedConfig,
          providerAccountId: data.providerAccountId,
          required: data.portraitAssetsEnabled || portraitCredentialSubmitted,
        });
      } catch (caught) {
        if (!(caught instanceof ProviderChannelPortraitNamespaceError)) throw caught;
        throw new RelayConfigValidationError({
          message: caught.message,
          issues: [{ path: [caught.field], message: caught.message }],
        });
      }
      if (portraitCredentialSubmitted) {
        try {
          storedConfig = useTokenhex ? configureTokenhexPortraitCredential({
            id, provider: data.provider, endpointType: data.endpointType,
            baseUrl: data.baseUrl, config: storedConfig,
          }) : withProviderChannelPortraitCredential(id, storedConfig, {
            accessKeyId: portraitAccessKeyId,
            secretAccessKey: portraitSecretAccessKey,
            ...(portraitSessionToken ? { sessionToken: portraitSessionToken } : {}),
          });
        } catch {
          throw new RelayConfigValidationError({
            message: useTokenhex ? "Tokenhex 人像凭据配置失败，请检查通道地址与 API Key" : "人像资产 AK/SK 格式无效或超过安全大小限制",
            issues: [{ path: [useTokenhex ? "portraitCredentialSource" : "portraitAccessKeyId"], message: "请检查对应通道凭据" }],
          });
        }
      }
      storedConfig = withProviderChannelPortraitAssetsEnabled(
        storedConfig,
        data.portraitAssetsEnabled,
      );
      const portraitCredential = inspectProviderChannelPortraitCredential(id, storedConfig);
      const portraitNamespace = readProviderChannelPortraitNamespace(storedConfig);
      if (
        (portraitNamespace.providerAccountId || portraitNamespace.assetsProjectName)
        && (data.provider !== "volcano" || data.endpointType !== "video_generation")
      ) {
        throw new RelayConfigValidationError({
          message: "人像资产命名空间仅支持 Volcano 视频生成通道",
          issues: [{ path: ["providerAccountId"], message: "请选择 Volcano 视频生成通道" }],
        });
      }
      if (data.portraitAssetsEnabled && !portraitCredential.configured) {
        throw new RelayConfigValidationError({
          message: "人像资产凭据验证失败",
          issues: [{ path: ["portraitSecretAccessKey"], message: "请重新输入独立 AK/SK" }],
        });
      }
      await assertProviderChannelPortraitNamespaceAvailable({
        channelId: id,
        database: trx,
        disabled: integrity.disabled,
        namespace: portraitNamespace,
        scope: integrity.scope,
        workspaceId: integrity.workspaceId,
      });

      const row = {
        id,
        name: data.name,
        ...integrity,
        baseUrl: data.baseUrl || null,
        credentialRef: data.credentialRef || null,
        configJson: JSON.stringify(storedConfig),
        modelNames: JSON.stringify(data.modelNames),
        priority: data.priority,
        weight: data.weight,
        timeoutMs: data.timeoutMs,
        concurrencyLimit: data.concurrencyLimit ?? null,
        createTime: now,
        updateTime: now,
      };
      await trx("o_provider_channel").insert(row);
      const credential = resolveChannelCredential({
        id: row.id,
        provider: row.provider,
        endpointType: row.endpointType,
        credentialRef: row.credentialRef,
        config: storedConfig,
      }, providerCredentialFallbackEnvNames(row.provider, row.endpointType));
      return {
        id: row.id,
        name: row.name,
        scope: row.scope,
        workspaceId: row.workspaceId,
        provider: row.provider,
        endpointType: row.endpointType,
        baseUrl: row.baseUrl,
        credentialRef: row.credentialRef,
        credentialConfigured: Boolean(credential.value),
        credentialSource: credential.source,
        portraitAssetsEnabled: portraitCredential.enabled,
        portraitCredentialConfigured: portraitCredential.configured,
        portraitCredentialGeneration: portraitCredential.generation || null,
        providerAccountId: portraitNamespace.providerAccountId || null,
        assetsProjectName: portraitNamespace.assetsProjectName || null,
        configJson: redactProviderChannelConfig(storedConfig),
        modelNames: data.modelNames,
        priority: row.priority,
        weight: row.weight,
        timeoutMs: row.timeoutMs,
        concurrencyLimit: row.concurrencyLimit,
        disabled: row.disabled,
        createTime: row.createTime,
        updateTime: row.updateTime,
      };
    }));
  } catch (caught) {
    if (caught instanceof ProviderChannelPortraitIdentityError) {
      const validation = new RelayConfigValidationError({
        statusCode: 409,
        message: caught.message,
        issues: [{ path: [caught.field], message: caught.message }],
        conflictId: caught.conflictId,
      });
      return res.status(validation.statusCode).send(relayConfigValidationErrorBody(validation));
    }
    if (caught instanceof RelayConfigValidationError) {
      return res.status(caught.statusCode).send(relayConfigValidationErrorBody(caught));
    }
    throw caught;
  }

  await writeAuditLog(req, {
    workspaceId: typeof created.workspaceId === "string" ? created.workspaceId : null,
    action: "admin.provider_channel.create",
    resourceType: "provider_channel",
    resourceId: id,
    metadata: {
      ...created,
    },
  });

  res.status(200).send(success(created));
});
