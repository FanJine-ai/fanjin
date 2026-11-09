export type AdminSettingDisposition = "KEEP" | "HIDE" | "MIGRATE" | "DELETE";
export type AdminSettingOwner = "Claude" | "Codex" | "Frok" | "MiMo";

const KEEP_KEYS = [
  "platform.site.systemName",
  "platform.site.serverAddress",
  "platform.site.docsLink",
  "platform.site.notice",
  "platform.auth.registrationMode",
  "platform.auth.passwordLoginEnabled",
  "platform.auth.passwordRegisterEnabled",
  "platform.auth.douyinLoginEnabled",
  "platform.auth.douyinClientKey",
  "platform.auth.douyinClientSecret",
  "platform.auth.wechatLoginEnabled",
  "platform.auth.wechatAppId",
  "platform.auth.wechatAppSecret",
  "platform.auth.googleLoginEnabled",
  "platform.auth.googleClientId",
  "platform.auth.googleClientSecret",
  "platform.auth.githubLoginEnabled",
  "platform.auth.githubClientId",
  "platform.auth.githubClientSecret",
  "platform.gateway.globalRateLimitPerMinute",
  "platform.gateway.modelRateLimitEnabled",
  "platform.gateway.modelRateLimitCount",
  "platform.gateway.modelRateLimitDurationMinutes",
  "platform.notification.smtpServer",
  "platform.notification.smtpPort",
  "platform.notification.smtpAccount",
  "platform.notification.smtpFrom",
  "platform.notification.smtpToken",
  "platform.notification.smtpSSLEnabled",
  "platform.notification.smtpForceAuthLogin",
] as const;

const HIDE_KEYS = [
  "platform.legal.userAgreement",
  "platform.legal.privacyPolicy",
  "platform.auth.emailVerificationEnabled",
  "platform.auth.emailDomainRestrictionEnabled",
  "platform.auth.emailDomainWhitelist",
  "platform.auth.turnstileCheckEnabled",
  "platform.auth.turnstileSiteKey",
  "platform.auth.turnstileSecretKey",
  "platform.gateway.retryTimes",
  "platform.gateway.automaticRetryStatusCodes",
] as const;

const MIGRATE_KEYS = [
  "platform.security.enableSSRFProtection",
  "platform.security.allowPrivateIp",
  "platform.security.allowedPorts",
  "platform.security.domainList",
  "platform.security.ipList",
  "platform.security.checkSensitiveEnabled",
  "platform.security.checkSensitiveOnPromptEnabled",
  "platform.security.stopOnSensitiveEnabled",
  "platform.security.sensitiveWords",
  "platform.gateway.requestBodyLimitMb",
  "platform.operations.logConsumeEnabled",
  "platform.operations.logRetentionDays",
  "platform.channels.autoTestChannelEnabled",
  "platform.channels.autoTestChannelMinutes",
  "platform.channels.automaticDisableChannelEnabled",
  "platform.channels.automaticEnableChannelEnabled",
  "platform.channels.channelDisableThreshold",
  "platform.channels.automaticDisableStatusCodes",
  "platform.channels.automaticDisableKeywords",
  "platform.billing.preConsumedQuota",
  "platform.billing.quotaRemindThreshold",
  "platform.billing.displayInCurrencyEnabled",
  "platform.billing.exposeRatioEnabled",
  "platform.billing.pricePrecision",
  "platform.billing.newWorkspaceInitialCreditYuan",
  "platform.payment.gatewayEnabled",
  "platform.payment.provider",
  "platform.payment.merchantId",
  "platform.payment.notifyUrl",
  "platform.payment.secretKey",
  "platform.payment.channels",
  "platform.payment.channelSecrets",
  "platform.payment.offlineReviewRequired",
  "platform.payment.minTopupYuan",
  "platform.payment.amountOptions",
  "platform.payment.settlementNote",
  "platform.worker.workerUrl",
  "platform.worker.workerValidKey",
  "platform.worker.allowHttpImageRequestEnabled",
  "platform.worker.directGenerationMaxResolution",
  "platform.worker.videoEnhanceRequiredForHighRes",
  "platform.worker.videoEnhanceMode",
  "platform.model.defaults",
] as const;

const DELETE_KEYS = [
  "platform.billing.quotaPerUnit",
  "platform.billing.defaultCurrency",
  "platform.checkin.enabled",
  "platform.checkin.minCreditYuan",
  "platform.checkin.maxCreditYuan",
  "platform.checkin.dailyLimit",
] as const;

const MIMO_KEYS = new Set<string>([
  "platform.security.enableSSRFProtection",
  "platform.security.allowPrivateIp",
  "platform.security.allowedPorts",
  "platform.security.domainList",
  "platform.security.ipList",
  "platform.security.checkSensitiveEnabled",
  "platform.security.checkSensitiveOnPromptEnabled",
  "platform.security.stopOnSensitiveEnabled",
  "platform.security.sensitiveWords",
]);

const FROK_KEYS = new Set<string>([
  "platform.gateway.requestBodyLimitMb",
  "platform.operations.logConsumeEnabled",
  "platform.operations.logRetentionDays",
  "platform.worker.workerUrl",
  "platform.worker.workerValidKey",
  "platform.worker.allowHttpImageRequestEnabled",
]);

const CLAUDE_KEYS = new Set<string>([
  "platform.channels.autoTestChannelEnabled",
  "platform.channels.autoTestChannelMinutes",
  "platform.channels.automaticDisableChannelEnabled",
  "platform.channels.automaticEnableChannelEnabled",
  "platform.channels.channelDisableThreshold",
  "platform.channels.automaticDisableStatusCodes",
  "platform.channels.automaticDisableKeywords",
  "platform.worker.directGenerationMaxResolution",
  "platform.worker.videoEnhanceRequiredForHighRes",
  "platform.worker.videoEnhanceMode",
  "platform.model.defaults",
]);

export interface AdminSettingPartitionEntry {
  key: string;
  disposition: AdminSettingDisposition;
  owner: AdminSettingOwner;
  genericReadable: boolean;
  genericWritable: boolean;
}

function ownerForKey(key: string): AdminSettingOwner {
  if (MIMO_KEYS.has(key)) return "MiMo";
  if (FROK_KEYS.has(key)) return "Frok";
  if (CLAUDE_KEYS.has(key)) return "Claude";
  return "Codex";
}

function entries(
  keys: readonly string[],
  disposition: AdminSettingDisposition,
): AdminSettingPartitionEntry[] {
  const generic = disposition === "KEEP";
  return keys.map((key) => ({
    key,
    disposition,
    owner: ownerForKey(key),
    genericReadable: generic,
    genericWritable: generic,
  }));
}

export const ADMIN_SETTING_PARTITION: readonly AdminSettingPartitionEntry[] = [
  ...entries(KEEP_KEYS, "KEEP"),
  ...entries(HIDE_KEYS, "HIDE"),
  ...entries(MIGRATE_KEYS, "MIGRATE"),
  ...entries(DELETE_KEYS, "DELETE"),
];

export const ADMIN_SETTING_PARTITION_COUNTS = {
  KEEP: KEEP_KEYS.length,
  HIDE: HIDE_KEYS.length,
  MIGRATE: MIGRATE_KEYS.length,
  DELETE: DELETE_KEYS.length,
  total: ADMIN_SETTING_PARTITION.length,
} as const;

const partitionByKey = new Map(
  ADMIN_SETTING_PARTITION.map((entry) => [entry.key, entry] as const),
);

if (
  partitionByKey.size !== ADMIN_SETTING_PARTITION.length
  || ADMIN_SETTING_PARTITION_COUNTS.KEEP !== 30
  || ADMIN_SETTING_PARTITION_COUNTS.HIDE !== 10
  || ADMIN_SETTING_PARTITION_COUNTS.MIGRATE !== 43
  || ADMIN_SETTING_PARTITION_COUNTS.DELETE !== 6
  || ADMIN_SETTING_PARTITION_COUNTS.total !== 89
) {
  throw new Error("FJADMIN_SETTINGS_PARTITION_INVALID");
}

export type AdminSettingKeyClassification =
  | {
    status: "ALLOW";
    code: null;
    entry: AdminSettingPartitionEntry;
  }
  | {
    status: "REJECT";
    code:
      | "FJADMIN_SETTING_CROSS_DOMAIN"
      | "FJADMIN_SETTING_HIDDEN"
      | "FJADMIN_SETTING_RETIRED"
      | "FJADMIN_SETTING_UNKNOWN";
    entry: AdminSettingPartitionEntry | null;
  };

export function classifyGenericAdminSettingKey(
  rawKey: unknown,
): AdminSettingKeyClassification {
  const key = typeof rawKey === "string" ? rawKey : "";
  const entry = partitionByKey.get(key) || null;
  if (!entry) {
    return {
      status: "REJECT",
      code: "FJADMIN_SETTING_UNKNOWN",
      entry: null,
    };
  }
  if (entry.disposition === "KEEP") {
    return { status: "ALLOW", code: null, entry };
  }
  if (entry.disposition === "HIDE") {
    return { status: "REJECT", code: "FJADMIN_SETTING_HIDDEN", entry };
  }
  if (entry.disposition === "DELETE") {
    return { status: "REJECT", code: "FJADMIN_SETTING_RETIRED", entry };
  }
  return { status: "REJECT", code: "FJADMIN_SETTING_CROSS_DOMAIN", entry };
}

export class AdminSettingPartitionError extends Error {
  readonly status = 403;
  readonly code = "FJADMIN_SETTINGS_KEY_REJECTED";
  readonly reasonCode: Exclude<AdminSettingKeyClassification["code"], null>;
  readonly key: string;

  constructor(key: string, reasonCode: Exclude<AdminSettingKeyClassification["code"], null>) {
    const messages = {
      FJADMIN_SETTING_CROSS_DOMAIN: "该设置已迁移到专用控制面，通用设置入口拒绝读写",
      FJADMIN_SETTING_HIDDEN: "该设置尚无已验证消费者，通用设置入口保持隐藏",
      FJADMIN_SETTING_RETIRED: "该旧设置已退出通用控制面，拒绝继续写入",
      FJADMIN_SETTING_UNKNOWN: "未知通用设置项",
    } as const;
    super(messages[reasonCode]);
    this.name = "AdminSettingPartitionError";
    this.reasonCode = reasonCode;
    this.key = key;
  }
}

export function assertGenericAdminSettingKeys(keys: readonly string[]): void {
  for (const key of keys) {
    const classification = classifyGenericAdminSettingKey(key);
    if (classification.status === "REJECT") {
      throw new AdminSettingPartitionError(key, classification.code);
    }
  }
}

export function isGenericAdminSettingKey(key: string): boolean {
  return classifyGenericAdminSettingKey(key).status === "ALLOW";
}
