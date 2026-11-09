import { configureTokenhexPortraitCredential, isTokenhexPortraitOrigin } from "@/lib/tokenhexPortraitChannel";
import { responsesTransportConfigError } from "@/lib/responsesTransport";
import express from "express";
import { z } from "zod";
import { db } from "@/utils/db";
import { success, error } from "@/lib/responseFormat";
import { relayEndpointTypes, relayProviders, relayScopes } from "@/lib/relay";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import {
  containsInlineProviderSecret,
  mergeProviderChannelConfigForUpdate,
  parseProviderChannelConfig,
  redactProviderChannelConfig,
} from "@/lib/providerChannelSecrets";
import {
  hasSealedProviderChannelCredential,
  inspectProviderChannelPortraitCredential,
  TOKENHEX_PORTRAIT_CREDENTIAL_VERSION,
  readProviderChannelCredentialCiphertext,
  sealProviderChannelCredential,
  withProviderChannelCredentialCiphertext,
  withProviderChannelPortraitAssetsEnabled,
  withProviderChannelPortraitCredential,
} from "@/lib/providerChannelCredentials";
import {
  providerCredentialFallbackEnvNames,
  resolveChannelCredential,
} from "@/lib/relayChannelCredential";
import {
  assertProviderChannelMutationAllowed,
  lockRelayConfigTablesForMutation,
  normalizeAndValidateProviderChannel,
  RelayConfigValidationError,
  relayConfigValidationErrorBody,
  serializeRelayConfigMutation,
} from "@/lib/relayConfigValidation";
import {
  assertProviderChannelPortraitIdentityImmutable,
  assertProviderChannelPortraitNamespaceAvailable,
  ProviderChannelPortraitIdentityError,
  ProviderChannelPortraitNamespaceError,
  readProviderChannelPortraitNamespace,
  withProviderChannelPortraitNamespace,
} from "@/lib/providerChannelPortraitNamespace";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  scope: z.enum(relayScopes).optional(),
  workspaceId: z.string().trim().optional().nullable(),
  provider: z.enum(relayProviders).optional(),
  endpointType: z.enum(relayEndpointTypes).optional(),
  baseUrl: z.string().trim().optional().nullable(),
  credentialRef: z.string().trim().optional().nullable(),
  apiKey: z.string().max(16_384).optional(),
  portraitCredentialSource: z.literal("tokenhex_channel_api_key").optional(),
  portraitAssetsEnabled: z.boolean().optional(),
  providerAccountId: z.string().max(128).optional(),
  assetsProjectName: z.string().max(128).optional(),
  portraitAccessKeyId: z.string().max(256).optional(),
  portraitSecretAccessKey: z.string().max(512).optional(),
  portraitSessionToken: z.string().max(768).optional(),
  configJson: z.record(z.string(), z.any()).optional(),
  modelNames: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
  weight: z.number().int().optional(),
  timeoutMs: z.number().int().optional(),
  concurrencyLimit: z.number().int().optional().nullable(),
  disabled: z.number().int().min(0).max(1).optional(),
});

function parseModelNames(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function providerChannelResponse(row: Record<string, unknown>): Record<string, unknown> {
  const config = parseProviderChannelConfig(row.configJson);
  const credential = resolveChannelCredential({
    id: String(row.id || ""),
    provider: typeof row.provider === "string" ? row.provider : null,
    endpointType: typeof row.endpointType === "string" ? row.endpointType : null,
    credentialRef: typeof row.credentialRef === "string" ? row.credentialRef : null,
    config,
  }, providerCredentialFallbackEnvNames(row.provider, row.endpointType));
  const portraitCredential = inspectProviderChannelPortraitCredential(String(row.id || ""), config);
  const portraitNamespace = readProviderChannelPortraitNamespace(config, {
    allowLegacyAliases: row.provider === "volcano" && row.endpointType === "video_generation",
  });
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    workspaceId: row.workspaceId ?? null,
    provider: row.provider,
    endpointType: row.endpointType,
    baseUrl: row.baseUrl ?? null,
    credentialRef: row.credentialRef ?? null,
    credentialConfigured: Boolean(credential.value),
    credentialSource: credential.source,
    portraitAssetsEnabled:
      row.provider === "volcano"
      && row.endpointType === "video_generation"
      && portraitCredential.enabled,
    portraitCredentialConfigured: portraitCredential.configured,
    portraitCredentialGeneration: portraitCredential.generation || null,
    providerAccountId: portraitNamespace.providerAccountId || null,
    assetsProjectName: portraitNamespace.assetsProjectName || null,
    configJson: redactProviderChannelConfig(config),
    modelNames: parseModelNames(row.modelNames),
    priority: Number(row.priority),
    weight: Number(row.weight),
    timeoutMs: Number(row.timeoutMs),
    concurrencyLimit: row.concurrencyLimit == null ? null : Number(row.concurrencyLimit),
    disabled: Number(row.disabled),
    createTime: Number(row.createTime),
    updateTime: Number(row.updateTime),
  };
}

export default router.post("/", async (req, res) => {
  if (req.body?.endpointType === "video_upscale" || Object.keys(req.body || {}).some((key) => key.startsWith("imagex"))) {
    return res.status(400).send({ message: "模型通道只接入上游模型；请在媒体服务页配置超分和 ImageX" });
  }
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const {
    id,
    apiKey,
    portraitAssetsEnabled,
    portraitCredentialSource,
    providerAccountId,
    assetsProjectName,
    portraitAccessKeyId,
    portraitSecretAccessKey,
    portraitSessionToken,
    configJson,
    modelNames,
    ...rest
  } = parsed.data;
  let result:
    | { kind: "missing" }
    | { kind: "updated"; responseData: Record<string, unknown>; auditPatch: Record<string, unknown> };
  try {
    result = await serializeRelayConfigMutation(async () => db.transaction(async (trx) => {
      await lockRelayConfigTablesForMutation(trx);
      const existing = await trx("o_provider_channel").where({ id }).forUpdate().first();
      if (!existing) return { kind: "missing" as const };
      if (existing.endpointType === "video_upscale") throw new RelayConfigValidationError({ message: "请在媒体服务页维护超分服务", issues: [{ path: ["id"], message: "超分不属于模型通道" }] });

      const integrity = await normalizeAndValidateProviderChannel(trx, {
        scope: rest.scope ?? existing.scope,
        workspaceId: rest.workspaceId !== undefined ? rest.workspaceId : existing.workspaceId,
        provider: rest.provider ?? existing.provider,
        endpointType: rest.endpointType ?? existing.endpointType,
        credentialRef: rest.credentialRef !== undefined ? rest.credentialRef : existing.credentialRef,
        disabled: rest.disabled ?? existing.disabled,
      });
      await assertProviderChannelMutationAllowed(
        trx,
        existing as unknown as Record<string, unknown>,
        integrity,
      );

      const existingConfig = parseProviderChannelConfig(existing.configJson);
      const transportError = responsesTransportConfigError(integrity.provider, integrity.endpointType, configJson !== undefined ? mergeProviderChannelConfigForUpdate(existingConfig, configJson) : existingConfig);
      if (transportError) throw new RelayConfigValidationError({
        message: transportError, issues: [{ path: ["configJson", "responsesTransport"], message: transportError }],
      });
      assertProviderChannelPortraitIdentityImmutable({
        existingConfig,
        existingRow: existing,
        nextConfig: existingConfig,
        nextRow: { ...existing, ...integrity },
      });
      const existingPortraitCredential = inspectProviderChannelPortraitCredential(id, existingConfig);
      const existingCredentialCiphertext = typeof existing.credentialCiphertext === "string"
        ? existing.credentialCiphertext
        : readProviderChannelCredentialCiphertext(existingConfig);
      const storedCredentialIdentityChanged = hasSealedProviderChannelCredential(existingCredentialCiphertext) && (
        (rest.provider !== undefined && rest.provider !== existing.provider)
        || (rest.baseUrl !== undefined && (rest.baseUrl || null) !== (existing.baseUrl || null))
      );
      if (storedCredentialIdentityChanged && !apiKey?.trim()) {
        throw new RelayConfigValidationError({
          message: "修改供应商或 Base URL 时必须重新输入 API Key，避免把已保存密钥发送到新的上游地址",
          issues: [{ path: ["apiKey"], message: "请重新输入 API Key" }],
        });
      }

      const nextBaseUrl = rest.baseUrl !== undefined ? rest.baseUrl : existing.baseUrl;
      const useTokenhex = portraitCredentialSource === "tokenhex_channel_api_key"
        || existingPortraitCredential.credential?.version === TOKENHEX_PORTRAIT_CREDENTIAL_VERSION;
      if (useTokenhex && !isTokenhexPortraitOrigin(nextBaseUrl)) {
        throw new RelayConfigValidationError({ message: "Tokenhex 人像凭据不可用于其他上游地址", issues: [{ path: ["baseUrl"], message: "必须保留 https://api.tokenhex.com" }] });
      }
      const portraitAccessKey = portraitAccessKeyId?.trim() || "";
      const portraitSecretKey = portraitSecretAccessKey || "";
      const portraitSecurityToken = portraitSessionToken || "";
      const akSubmitted = Boolean(portraitAccessKey || portraitSecretKey || portraitSecurityToken);
      if (useTokenhex && akSubmitted) {
        throw new RelayConfigValidationError({ message: "Tokenhex 使用本通道 API Key，不可同时提交 AK/SK", issues: [{ path: ["portraitCredentialSource"], message: "请勿混用凭据类型" }] });
      }
      const portraitCredentialSubmitted = akSubmitted || Boolean(portraitCredentialSource)
        || (useTokenhex && Boolean(apiKey?.trim()));
      if (akSubmitted && (!portraitAccessKey || !portraitSecretKey)) {
        throw new RelayConfigValidationError({
          message: "更新人像资产凭据时必须同时填写 Access Key ID 与 Secret Access Key",
          issues: [{ path: ["portraitSecretAccessKey"], message: "请完整填写独立 AK/SK" }],
        });
      }
      const nextPortraitEnabled = portraitAssetsEnabled ?? existingPortraitCredential.enabled;
      const nextProvider = rest.provider ?? existing.provider;
      const nextEndpointType = rest.endpointType ?? existing.endpointType;
      if (
        (nextPortraitEnabled || portraitCredentialSubmitted)
        && (
          nextProvider !== "volcano"
          || nextEndpointType !== "video_generation"
        )
      ) {
        throw new RelayConfigValidationError({
          message: "人像资产仅支持 Volcano 视频生成通道",
          issues: [{ path: ["portraitAssetsEnabled"], message: "请先关闭人像资产能力，或切换为 Volcano 视频生成通道" }],
        });
      }

      const updateData: Record<string, unknown> = {
        ...rest,
        ...integrity,
        updateTime: Date.now(),
      };
      if (
        configJson !== undefined
        || apiKey?.trim()
        || portraitCredentialSubmitted
        || portraitAssetsEnabled !== undefined
        || providerAccountId !== undefined
        || assetsProjectName !== undefined
        || rest.disabled !== undefined
      ) {
        let nextConfig = configJson !== undefined
          ? mergeProviderChannelConfigForUpdate(existingConfig, configJson)
          : existingConfig;
        if (apiKey?.trim()) {
          nextConfig = withProviderChannelCredentialCiphertext(
            nextConfig,
            sealProviderChannelCredential(id, apiKey),
          );
        }
        assertProviderChannelPortraitIdentityImmutable({
          assetsProjectName,
          existingConfig,
          existingRow: existing,
          nextConfig,
          nextRow: { ...existing, ...integrity },
          providerAccountId,
        });
        try {
          nextConfig = withProviderChannelPortraitNamespace({
            allowLegacyAliases: nextProvider === "volcano" && nextEndpointType === "video_generation",
            assetsProjectName,
            config: nextConfig,
            providerAccountId,
            required: nextPortraitEnabled || portraitCredentialSubmitted,
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
            nextConfig = useTokenhex ? configureTokenhexPortraitCredential({
              id, provider: nextProvider, endpointType: nextEndpointType,
              baseUrl: nextBaseUrl,
              config: nextConfig,
            }) : withProviderChannelPortraitCredential(id, nextConfig, {
              accessKeyId: portraitAccessKey,
              secretAccessKey: portraitSecretKey,
              ...(portraitSecurityToken ? { sessionToken: portraitSecurityToken } : {}),
            });
          } catch {
            throw new RelayConfigValidationError({
              message: useTokenhex ? "Tokenhex 人像凭据配置失败，请检查本通道已加密保存的 API Key" : "人像资产 AK/SK 格式无效或超过安全大小限制",
              issues: [{ path: [useTokenhex ? "portraitCredentialSource" : "portraitAccessKeyId"], message: "请检查对应通道凭据" }],
            });
          }
        }
        nextConfig = withProviderChannelPortraitAssetsEnabled(nextConfig, nextPortraitEnabled);
        const nextPortraitCredential = inspectProviderChannelPortraitCredential(id, nextConfig);
        const nextPortraitNamespace = readProviderChannelPortraitNamespace(nextConfig);
        if (
          (nextPortraitNamespace.providerAccountId || nextPortraitNamespace.assetsProjectName)
          && (nextProvider !== "volcano" || nextEndpointType !== "video_generation")
        ) {
          throw new RelayConfigValidationError({
            message: "人像资产命名空间仅支持 Volcano 视频生成通道",
            issues: [{ path: ["providerAccountId"], message: "请选择 Volcano 视频生成通道" }],
          });
        }
        if (nextPortraitEnabled && !nextPortraitCredential.configured) {
          throw new RelayConfigValidationError({
            message: "启用人像资产前必须配置有效的独立 AK/SK",
            issues: [{ path: ["portraitSecretAccessKey"], message: "请输入独立 AK/SK" }],
          });
        }
        await assertProviderChannelPortraitNamespaceAvailable({
          channelId: id,
          database: trx,
          disabled: integrity.disabled,
          namespace: nextPortraitNamespace,
          scope: integrity.scope,
          workspaceId: integrity.workspaceId,
        });
        if (process.env.NODE_ENV === "prod" && containsInlineProviderSecret(nextConfig)) {
          throw new RelayConfigValidationError({
            message: "生产环境禁止在高级配置 JSON 中保存明文密钥，请使用 API Key 字段（加密保存）或环境变量引用",
            issues: [{ path: ["configJson"], message: "请改用 API Key 字段或 credentialRef" }],
          });
        }
        updateData.configJson = JSON.stringify(nextConfig);
      }
      if (modelNames !== undefined) updateData.modelNames = JSON.stringify(modelNames);

      const count = await trx("o_provider_channel").where({ id }).update(updateData);
      if (!count) return { kind: "missing" as const };
      const persisted = await trx("o_provider_channel").where({ id }).first();
      if (!persisted) return { kind: "missing" as const };

      const auditPatch = {
        ...updateData,
        ...(apiKey?.trim() ? { credentialUpdated: true } : {}),
        ...(portraitCredentialSubmitted ? { portraitCredentialUpdated: true } : {}),
        ...(portraitAssetsEnabled !== undefined ? { portraitAssetsEnabled } : {}),
        ...(providerAccountId !== undefined ? { providerAccountId: providerAccountId.trim() } : {}),
        ...(assetsProjectName !== undefined ? { assetsProjectName: assetsProjectName.trim() } : {}),
        ...(configJson !== undefined
          ? { configJson: redactProviderChannelConfig(parseProviderChannelConfig(updateData.configJson)) }
          : {}),
      };
      if (configJson === undefined) delete auditPatch.configJson;
      return {
        kind: "updated" as const,
        responseData: providerChannelResponse(persisted as unknown as Record<string, unknown>),
        auditPatch,
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

  if (result.kind === "missing") return res.status(404).send(error("Provider channel 不存在"));
  await writeAuditLog(req, {
    workspaceId: typeof result.responseData.workspaceId === "string" ? result.responseData.workspaceId : null,
    action: "admin.provider_channel.update",
    resourceType: "provider_channel",
    resourceId: id,
    metadata: result.auditPatch,
  });
  res.status(200).send(success(result.responseData));
});
