import type { Knex } from "knex";

import {
  parsePortraitAssetRelayRequest,
  portraitAssetRelayReadActions,
  type PortraitAssetRelayAction,
} from "@/lib/portraitAssetRelayContract";
import {
  FORMAL_CANDIDATE_PORTRAIT_ASSET_RELAY_MODEL,
} from "@/lib/portraitRuntimeCapability";
import {
  isFormalCandidateCredentialRuntimeDeclared,
} from "@/lib/formalCandidateCredentialRuntime";
import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";
import {
  readProviderChannelPortraitCredentialMetadata,
} from "@/lib/providerChannelCredentials";
import { withPortraitChannelCredentialForDispatch } from "@/lib/relayChannelCredential";
import {
  assertProviderChannelPortraitNamespaceAvailable,
  ProviderChannelPortraitIdentityError,
} from "@/lib/providerChannelPortraitNamespace";
import {
  createVolcenginePortraitAssetsClientForCredentialDispatch,
  type VolcenginePortraitAssetsFetch,
  type VolcenginePortraitRelayResponse,
} from "@/lib/volcenginePortraitAssets";
import { KnexVolcenginePortraitIdempotencyStore } from "@/lib/volcenginePortraitIdempotencyStore";
import { db } from "@/utils/db";

type Database = Knex | Knex.Transaction;
type ChannelRow = Record<string, any>;

export interface PortraitAssetRelayExecutionInput {
  action: PortraitAssetRelayAction;
  actorUserId: number;
  body: unknown;
  consentConfirmed?: boolean;
  database?: Database;
  fetch?: VolcenginePortraitAssetsFetch;
  idempotencyKey?: string | null;
  signal?: AbortSignal;
  workspaceId: string;
}

export class PortraitAssetRelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PortraitAssetRelayError";
  }
}

function cleanString(value: unknown, maximum = 256): string {
  const parsed = typeof value === "string" ? value.trim() : "";
  return parsed && parsed.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(parsed)
    ? parsed
    : "";
}

function configuredScope(row: ChannelRow): {
  accountId: string;
  projectName: string;
} {
  const config = parseProviderChannelConfig(row.configJson);
  const accountId = cleanString(
    config.providerAccountId ?? config.volcengineAccountId ?? config.accountId,
    128,
  );
  const projectName = cleanString(config.assetsProjectName ?? config.projectName, 128);
  if (!accountId || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(accountId)) {
    throw new PortraitAssetRelayError(
      503,
      "portrait_asset_provider_account_missing",
      "工作区火山通道缺少人像资产账号标识",
    );
  }
  if (!projectName || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(projectName)) {
    throw new PortraitAssetRelayError(
      503,
      "portrait_asset_project_missing",
      "工作区火山通道缺少人像资产 ProjectName",
    );
  }
  return { accountId, projectName };
}

function enabledPortraitChannel(row: ChannelRow): boolean {
  const metadata = readProviderChannelPortraitCredentialMetadata(
    parseProviderChannelConfig(row.configJson),
  );
  return Boolean(
    metadata.enabled
    && metadata.binding
    && metadata.generation > 0
    && (
      isFormalCandidateCredentialRuntimeDeclared()
      || metadata.ciphertextPresent
    )
  );
}

/**
 * 0.1.5 deliberately permits only workspace-scoped channels. Without a local
 * ownership mirror, a shared platform ProjectName could make List/Get expose
 * another tenant's upstream resources.
 */
export async function selectPortraitAssetRelayChannel(input: {
  database?: Database;
  workspaceId: string;
}): Promise<ChannelRow> {
  const database = input.database ?? db;
  const workspaceId = cleanString(input.workspaceId);
  if (!workspaceId) {
    throw new PortraitAssetRelayError(
      400,
      "portrait_asset_workspace_required",
      "人像资产中转必须绑定工作区",
    );
  }
  const rows = await database("o_provider_channel")
    .where({
      disabled: 0,
      endpointType: "video_generation",
      provider: "volcano",
      scope: "workspace",
      workspaceId,
    })
    .orderBy("priority", "asc")
    .orderBy("createTime", "asc")
    .orderBy("id", "asc");
  const eligibleChannels = rows.filter(enabledPortraitChannel);
  if (eligibleChannels.length === 0) {
    throw new PortraitAssetRelayError(
      503,
      "portrait_asset_channel_unavailable",
      "当前工作区未配置独立人像中转通道，此结果不代表平台素材审核缺少 AK/SK。正常 MCP / CLI 创作请通过 fanjin_asset_get 查询已入库素材的 portraitAdmission，并使用 assetVersionId 引用；只有使用独立人像中转时才需要配置工作区专属通道。",
    );
  }
  if (eligibleChannels.length !== 1) {
    throw new PortraitAssetRelayError(
      409,
      "portrait_asset_channel_ambiguous",
      "当前工作区配置了多个可用的人像资产通道，请保留唯一通道后重试",
    );
  }
  const [channel] = eligibleChannels;

  const selectedScope = configuredScope(channel);
  try {
    await assertProviderChannelPortraitNamespaceAvailable({
      channelId: cleanString(channel.id),
      database,
      disabled: channel.disabled,
      namespace: {
        assetsProjectName: selectedScope.projectName,
        providerAccountId: selectedScope.accountId,
      },
      scope: "workspace",
      workspaceId,
    });
  } catch (caught) {
    if (!(caught instanceof ProviderChannelPortraitIdentityError)) throw caught;
    throw new PortraitAssetRelayError(
      409,
      "portrait_asset_namespace_conflict",
      "该火山账号与 ProjectName 已被平台或其他工作区占用，请配置独立命名空间",
    );
  }
  if (cleanString(channel.healthStatus) !== "ok") {
    throw new PortraitAssetRelayError(
      503,
      "portrait_asset_channel_unhealthy",
      "当前工作区唯一的人像资产通道未通过健康检查",
    );
  }
  return channel;
}

function withPortraitRelayClient<T>(input: {
  actorUserId: number;
  channel: ChannelRow;
  database: Database;
  fetch?: VolcenginePortraitAssetsFetch;
  operation: (
    client: ReturnType<typeof createVolcenginePortraitAssetsClientForCredentialDispatch>,
  ) => Promise<T>;
  workspaceId: string;
}): Promise<T> {
  const channelId = cleanString(input.channel.id);
  if (!channelId) {
    throw new PortraitAssetRelayError(503, "portrait_asset_channel_invalid", "人像资产通道 ID 无效");
  }
  const credentialChannel = {
    id: channelId,
    provider: "volcano",
    endpointType: "video_generation",
    credentialRef: input.channel.credentialRef,
    config: parseProviderChannelConfig(input.channel.configJson),
  } as const;
  const client = createVolcenginePortraitAssetsClientForCredentialDispatch({
    baseUrl: input.channel.baseUrl,
    id: channelId,
    provider: "volcano",
    endpointType: "video_generation",
    credentialRef: input.channel.credentialRef,
    configJson: input.channel.configJson,
  }, {
    ...(input.fetch ? { fetch: input.fetch } : {}),
    idempotencyStore: new KnexVolcenginePortraitIdempotencyStore({
      actorUserId: input.actorUserId,
      database: input.database,
      workspaceId: input.workspaceId,
    }),
  }, (use) => withPortraitChannelCredentialForDispatch(
    credentialChannel,
    {
      channelId,
      provider: "volcano",
      endpointType: "video_generation",
      model: FORMAL_CANDIDATE_PORTRAIT_ASSET_RELAY_MODEL,
    },
    (credentialEnvelope) => {
      // The client validates an empty or damaged envelope as a definite,
      // not-dispatched credential failure. Keeping that validation inside
      // `use` ensures the durable mutation claim already exists, while no
      // provider fetch can start until parsing and signing both succeed.
      return use(credentialEnvelope);
    },
  ));
  // For writes, executeAction completes its durable claim before the client
  // opens FD6. The credential callback only signs and starts one fetch, and
  // returns a non-thenable holder without reusable credential material.
  return input.operation(client);
}

export async function executePortraitAssetRelayAction(
  input: PortraitAssetRelayExecutionInput,
): Promise<VolcenginePortraitRelayResponse> {
  const database = input.database ?? db;
  const workspaceId = cleanString(input.workspaceId);
  if (!workspaceId) {
    throw new PortraitAssetRelayError(400, "portrait_asset_workspace_required", "人像资产请求缺少工作区");
  }
  if (!Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0) {
    throw new PortraitAssetRelayError(403, "portrait_asset_actor_invalid", "人像资产请求缺少有效调用主体");
  }
  const channel = await selectPortraitAssetRelayChannel({ database, workspaceId });
  const scope = configuredScope(channel);
  const parsed = parsePortraitAssetRelayRequest(input.action, input.body);
  const requestedProject = cleanString(parsed.ProjectName, 128);
  if (requestedProject && requestedProject !== scope.projectName) {
    throw new PortraitAssetRelayError(
      403,
      "portrait_asset_project_forbidden",
      "ProjectName 不属于当前工作区人像资产命名空间",
    );
  }
  if (input.action === "CreateAsset" && input.consentConfirmed !== true) {
    throw new PortraitAssetRelayError(
      428,
      "portrait_asset_consent_required",
      "创建人像资产前必须确认已取得合法肖像和素材授权",
    );
  }
  const readOnly = (portraitAssetRelayReadActions as readonly string[]).includes(input.action);
  const idempotencyKey = cleanString(input.idempotencyKey, 128);
  if (!readOnly && !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(idempotencyKey)) {
    throw new PortraitAssetRelayError(
      400,
      "portrait_asset_idempotency_invalid",
      "写操作必须提供 8 到 128 字符的 Idempotency-Key",
    );
  }
  const body = { ...parsed, ProjectName: scope.projectName };
  return await withPortraitRelayClient({
    actorUserId: input.actorUserId,
    channel,
    database,
    fetch: input.fetch,
    workspaceId,
    operation: (client) => client.executeAction({
      action: input.action,
      body,
      ...(readOnly ? {} : { idempotencyKey }),
      signal: input.signal,
    }),
  });
}
