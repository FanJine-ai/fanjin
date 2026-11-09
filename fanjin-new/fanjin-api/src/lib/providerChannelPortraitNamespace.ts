import type { Knex } from "knex";

import {
  PROVIDER_CHANNEL_PORTRAIT_ACCOUNT_ID_CONFIG_KEY,
  PROVIDER_CHANNEL_PORTRAIT_PROJECT_NAME_CONFIG_KEY,
  readProviderChannelPortraitCredentialMetadata,
} from "@/lib/providerChannelCredentials";
import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";

export type ProviderChannelPortraitNamespace = Readonly<{
  assetsProjectName: string;
  providerAccountId: string;
}>;

type Database = Knex | Knex.Transaction;

type ProviderChannelIdentity = Readonly<{
  endpointType: string;
  provider: string;
  scope: string;
  workspaceId: string | null;
}>;

export class ProviderChannelPortraitNamespaceError extends Error {
  constructor(
    readonly field: "assetsProjectName" | "providerAccountId",
    message: string,
  ) {
    super(message);
    this.name = "ProviderChannelPortraitNamespaceError";
  }
}

export class ProviderChannelPortraitIdentityError extends Error {
  constructor(
    readonly field:
      | "assetsProjectName"
      | "endpointType"
      | "provider"
      | "providerAccountId"
      | "scope"
      | "workspaceId",
    message: string,
    readonly conflictId: string | null = null,
  ) {
    super(message);
    this.name = "ProviderChannelPortraitIdentityError";
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readProviderChannelPortraitNamespace(
  config: Record<string, unknown>,
  options: { allowLegacyAliases?: boolean } = {},
): ProviderChannelPortraitNamespace {
  const allowLegacyAliases = options.allowLegacyAliases === true;
  const canonicalProjectName = cleanString(
    config[PROVIDER_CHANNEL_PORTRAIT_PROJECT_NAME_CONFIG_KEY],
  );
  const canonicalProviderAccountId = cleanString(
    config[PROVIDER_CHANNEL_PORTRAIT_ACCOUNT_ID_CONFIG_KEY],
  );
  return Object.freeze({
    assetsProjectName: canonicalProjectName
      || (allowLegacyAliases ? cleanString(config.projectName) : ""),
    providerAccountId: canonicalProviderAccountId
      || (allowLegacyAliases
        ? cleanString(config.volcengineAccountId) || cleanString(config.accountId)
        : ""),
  });
}

function workspaceOwnerId(input: { scope: unknown; workspaceId: unknown }): string {
  return cleanString(input.scope) === "workspace" ? cleanString(input.workspaceId) : "";
}

function normalizedIdentity(input: Record<string, unknown>): ProviderChannelIdentity {
  const scope = cleanString(input.scope);
  return Object.freeze({
    endpointType: cleanString(input.endpointType),
    provider: cleanString(input.provider),
    scope,
    workspaceId: scope === "workspace" ? cleanString(input.workspaceId) || null : null,
  });
}

function isVolcanoVideoIdentity(input: Record<string, unknown>): boolean {
  return cleanString(input.provider) === "volcano"
    && cleanString(input.endpointType) === "video_generation";
}

export function hasProviderChannelPortraitIdentity(
  config: Record<string, unknown>,
  row: Record<string, unknown>,
): boolean {
  const namespace = readProviderChannelPortraitNamespace(config, {
    allowLegacyAliases: isVolcanoVideoIdentity(row),
  });
  const credential = readProviderChannelPortraitCredentialMetadata(config);
  return Boolean(
    namespace.providerAccountId
    || namespace.assetsProjectName
    || credential.enabled
    || credential.ciphertextPresent
    || credential.binding
    || credential.generation > 0,
  );
}

/**
 * A channel row is the schema-neutral ownership reservation for upstream
 * portrait assets. Once it has a namespace or credential history, neither its
 * tenant identity nor an already-populated namespace component may move.
 */
export function assertProviderChannelPortraitIdentityImmutable(input: {
  assetsProjectName?: string;
  existingConfig: Record<string, unknown>;
  existingRow: Record<string, unknown>;
  nextConfig: Record<string, unknown>;
  nextRow: Record<string, unknown>;
  providerAccountId?: string;
}): void {
  const existingNamespace = readProviderChannelPortraitNamespace(input.existingConfig, {
    allowLegacyAliases: isVolcanoVideoIdentity(input.existingRow),
  });
  const nextNamespaceFromConfig = readProviderChannelPortraitNamespace(input.nextConfig, {
    allowLegacyAliases: isVolcanoVideoIdentity(input.nextRow),
  });
  const nextNamespace = {
    assetsProjectName: input.assetsProjectName === undefined
      ? nextNamespaceFromConfig.assetsProjectName
      : cleanString(input.assetsProjectName),
    providerAccountId: input.providerAccountId === undefined
      ? nextNamespaceFromConfig.providerAccountId
      : cleanString(input.providerAccountId),
  };

  if (hasProviderChannelPortraitIdentity(input.existingConfig, input.existingRow)) {
    const existingIdentity = normalizedIdentity(input.existingRow);
    const nextIdentity = normalizedIdentity(input.nextRow);
    for (const field of ["scope", "workspaceId", "provider", "endpointType"] as const) {
      if (existingIdentity[field] !== nextIdentity[field]) {
        throw new ProviderChannelPortraitIdentityError(
          field,
          "已建立人像资产身份的通道不可变更 scope/workspace/provider/endpoint；请停用旧通道并在同一工作区新建通道",
        );
      }
    }
  }

  for (const field of ["providerAccountId", "assetsProjectName"] as const) {
    if (existingNamespace[field] && existingNamespace[field] !== nextNamespace[field]) {
      throw new ProviderChannelPortraitIdentityError(
        field,
        "人像资产账号与 ProjectName 已形成永久历史归属，不可修改或清空",
      );
    }
  }
}

/**
 * Reservations include disabled rows and platform rows. The same workspace may
 * reuse a namespace when rotating channels, but a platform owner or another
 * workspace may never share it.
 */
export async function assertProviderChannelPortraitNamespaceAvailable(input: {
  channelId?: string;
  database: Database;
  disabled: unknown;
  namespace: ProviderChannelPortraitNamespace;
  scope: unknown;
  workspaceId: unknown;
}): Promise<void> {
  if (!input.namespace.providerAccountId || !input.namespace.assetsProjectName) return;
  const requestedWorkspaceId = workspaceOwnerId(input);
  const rows = await input.database("o_provider_channel")
    .select("id", "scope", "workspaceId", "provider", "endpointType", "disabled", "configJson");
  for (const row of rows) {
    const rowId = cleanString(row.id);
    if (input.channelId && rowId === cleanString(input.channelId)) continue;
    const namespace = readProviderChannelPortraitNamespace(parseProviderChannelConfig(row.configJson), {
      allowLegacyAliases: isVolcanoVideoIdentity(row),
    });
    if (
      namespace.providerAccountId !== input.namespace.providerAccountId
      || namespace.assetsProjectName !== input.namespace.assetsProjectName
    ) continue;
    const rowWorkspaceId = workspaceOwnerId(row);
    const sameWorkspaceRotation = Boolean(
      requestedWorkspaceId
      && rowWorkspaceId === requestedWorkspaceId
      && (Number(input.disabled) === 1 || Number(row.disabled) === 1),
    );
    if (sameWorkspaceRotation) continue;
    throw new ProviderChannelPortraitIdentityError(
      "assetsProjectName",
      "该火山账号与 ProjectName 已被平台、其他工作区或同工作区的启用通道占用",
      rowId || null,
    );
  }
}

export function withProviderChannelPortraitNamespace(input: {
  allowLegacyAliases?: boolean;
  assetsProjectName?: string;
  config: Record<string, unknown>;
  providerAccountId?: string;
  required: boolean;
}): Record<string, unknown> {
  const current = readProviderChannelPortraitNamespace(input.config, {
    allowLegacyAliases: input.allowLegacyAliases,
  });
  const providerAccountId = input.providerAccountId === undefined
    ? current.providerAccountId
    : cleanString(input.providerAccountId);
  const assetsProjectName = input.assetsProjectName === undefined
    ? current.assetsProjectName
    : cleanString(input.assetsProjectName);
  const configured = Boolean(providerAccountId || assetsProjectName);

  if ((input.required || configured) && !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(providerAccountId)) {
    throw new ProviderChannelPortraitNamespaceError(
      "providerAccountId",
      "请输入有效的火山账号标识（providerAccountId）",
    );
  }
  if ((input.required || configured) && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(assetsProjectName)) {
    throw new ProviderChannelPortraitNamespaceError(
      "assetsProjectName",
      "请输入有效的人像资产 ProjectName",
    );
  }
  if (!configured) return { ...input.config };
  return {
    ...input.config,
    [PROVIDER_CHANNEL_PORTRAIT_PROJECT_NAME_CONFIG_KEY]: assetsProjectName,
    [PROVIDER_CHANNEL_PORTRAIT_ACCOUNT_ID_CONFIG_KEY]: providerAccountId,
  };
}
