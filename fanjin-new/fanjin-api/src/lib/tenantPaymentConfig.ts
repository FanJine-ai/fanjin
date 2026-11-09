import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type { CommercialTenant } from "@/lib/commercialTenant";
import { DEFAULT_COMMERCIAL_TENANT_ID } from "@/lib/commercialTenant";
import { guPerYuan } from "@/lib/billing";
import { ONLINE_PAYMENT_GATEWAY_AVAILABLE, readPlatformSettings } from "@/lib/platformSettings";

export type PaymentMethod = "online" | "offline" | "manual";
export type OnlinePaymentProtocol = "wechat_v3" | "alipay";

export interface RawPaymentChannel {
  key?: string;
  name?: string;
  method?: string;
  protocol?: string;
  scene?: string;
  enabled?: boolean;
  default?: boolean;
  autoConfirm?: boolean;
  minAmountYuan?: number;
  maxAmountYuan?: number;
  sort?: number;
  merchantId?: string;
  appId?: string;
  mchId?: string;
  merchantSerialNo?: string;
  apiV3KeyRef?: string;
  privateKeyRef?: string;
  platformCertRef?: string;
  providerApiBase?: string;
  notifyUrl?: string;
  alipayAppId?: string;
  alipayGateway?: string;
  alipayPrivateKeyRef?: string;
  alipayPublicKeyRef?: string;
  accountName?: string;
  accountNo?: string;
  bankName?: string;
  qrCodeUrl?: string;
  remark?: string;
  /**
   * 0.1.4 真实收款租户：该通道商户号所属的商业主体。
   * 未配置时默认为承载该通道配置的入口租户。
   */
  collectorTenantId?: string;
}

export interface TenantPaymentConfiguration {
  gatewayEnabled: boolean;
  provider: string;
  notifyUrlConfigured: boolean;
  minTopupYuan: number;
  amountOptions: number[];
  settlementNote: string;
  guPerYuan: number;
  channels: RawPaymentChannel[];
}

export class PaymentConfigError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 503, code = "PAYMENT_CONFIG_INVALID") {
    super(message);
    this.name = "PaymentConfigError";
    this.status = status;
    this.code = code;
  }
}

export function cleanPaymentString(value?: unknown): string {
  return String(value || "").trim();
}

export function normalizePaymentMethod(value?: string): PaymentMethod {
  if (value === "offline" || value === "manual") return value;
  return "online";
}

export function normalizePaymentProtocol(channel: RawPaymentChannel): string {
  const protocol = cleanPaymentString(channel.protocol);
  if (protocol) return protocol;
  const key = cleanPaymentString(channel.key);
  if (key === "wechat_pay" || key === "wechat_pay_v3") return "wechat_v3";
  if (key === "alipay") return "alipay";
  if (key === "bank_card") return "offline_bank";
  if (key === "corporate_transfer") return "offline_corporate";
  return normalizePaymentMethod(channel.method);
}

function hasAnyField(channel: RawPaymentChannel, keys: Array<keyof RawPaymentChannel>): boolean {
  return keys.some((key) => Boolean(cleanPaymentString(channel[key])));
}

function assertUsablePublicKey(value: string): void {
  try {
    crypto.createPublicKey(value);
  } catch {
    // WeChat normally distributes an X.509 platform certificate rather than a
    // bare SPKI key. Accept either representation while still parsing it now.
    void new crypto.X509Certificate(value).publicKey;
  }
}

export function channelCredentialConfigured(channel: RawPaymentChannel): boolean {
  const protocol = normalizePaymentProtocol(channel);
  if (protocol === "wechat_v3") {
    const structurallyComplete = Boolean(
      ONLINE_PAYMENT_GATEWAY_AVAILABLE
      && cleanPaymentString(channel.appId)
      && hasAnyField(channel, ["mchId", "merchantId"])
      && cleanPaymentString(channel.merchantSerialNo)
      && cleanPaymentString(channel.apiV3KeyRef)
      && cleanPaymentString(channel.privateKeyRef)
      && cleanPaymentString(channel.platformCertRef),
    );
    if (!structurallyComplete) return false;
    try {
      const apiV3Key = resolvePaymentSecret(channel.apiV3KeyRef);
      crypto.createPrivateKey(resolvePaymentSecret(channel.privateKeyRef));
      assertUsablePublicKey(resolvePaymentSecret(channel.platformCertRef));
      return Buffer.byteLength(apiV3Key, "utf8") === 32;
    } catch {
      return false;
    }
  }
  if (protocol === "alipay") {
    const structurallyComplete = Boolean(
      ONLINE_PAYMENT_GATEWAY_AVAILABLE
      && hasAnyField(channel, ["alipayAppId", "merchantId"])
      && cleanPaymentString(channel.alipayPrivateKeyRef)
      && cleanPaymentString(channel.alipayPublicKeyRef),
    );
    if (!structurallyComplete) return false;
    try {
      crypto.createPrivateKey(resolvePaymentSecret(channel.alipayPrivateKeyRef));
      assertUsablePublicKey(resolvePaymentSecret(channel.alipayPublicKeyRef));
      return true;
    } catch {
      return false;
    }
  }
  if (normalizePaymentMethod(channel.method) === "offline") {
    return Boolean(
      cleanPaymentString(channel.accountName)
      && ((cleanPaymentString(channel.accountNo) && cleanPaymentString(channel.bankName)) || cleanPaymentString(channel.qrCodeUrl)),
    );
  }
  return false;
}

export function parsePaymentChannels(raw: unknown): RawPaymentChannel[] {
  let parsed = raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((item) => item && typeof item === "object") as RawPaymentChannel[]
    : [];
}

function parseAmountOptions(raw: unknown, minTopupYuan: number): number[] {
  const values = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const unique = Array.from(new Set(values
    .map((item) => Number(String(item).trim()))
    .filter((item) => Number.isFinite(item) && item > 0)));
  return unique.length ? unique : [Math.max(1, minTopupYuan || 100), 500, 1000, 5000];
}

function tenantPaymentConfig(tenantId: string): Record<string, unknown> {
  const raw = cleanPaymentString(process.env.FANJIN_TENANT_PAYMENT_CONFIG_JSON);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const config = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)[tenantId]
      : null;
    return config && typeof config === "object" && !Array.isArray(config)
      ? config as Record<string, unknown>
      : {};
  } catch {
    throw new PaymentConfigError("租户支付配置不是有效 JSON");
  }
}

export async function resolveTenantPaymentConfiguration(tenant: CommercialTenant): Promise<TenantPaymentConfiguration> {
  const { settings } = await readPlatformSettings();
  const custom = tenant.id === DEFAULT_COMMERCIAL_TENANT_ID ? null : tenantPaymentConfig(tenant.id);
  const minTopupYuan = Number(custom ? custom.minTopupYuan ?? 100 : settings["platform.payment.minTopupYuan"] ?? 100);
  const allChannels = parsePaymentChannels(custom ? custom.channels : settings["platform.payment.channels"]);
  const channels = tenant.rechargeEnabled
    ? allChannels
      .filter((channel) => cleanPaymentString(channel.key) && Boolean(channel.enabled) && channelCredentialConfigured(channel))
      .sort((left, right) => Number(left.sort || 0) - Number(right.sort || 0))
    : [];
  const configuredProvider = cleanPaymentString(custom ? custom.provider : settings["platform.payment.provider"]);
  const provider = cleanPaymentString(channels.find((channel) => channel.key === configuredProvider)?.key)
    || cleanPaymentString(channels.find((channel) => channel.default)?.key)
    || cleanPaymentString(channels[0]?.key);
  const onlineChannels = channels.filter((channel) => normalizePaymentMethod(channel.method) === "online");
  const gatewaySetting = custom
    ? custom.gatewayEnabled === true
    : Boolean(settings["platform.payment.gatewayEnabled"] ?? false);
  const notifyUrlsReady = onlineChannels.length > 0
    && onlineChannels.every((channel) => Boolean(resolvePaymentNotifyUrl(tenant.id, channel)));
  const gatewayEnabled = Boolean(
    ONLINE_PAYMENT_GATEWAY_AVAILABLE
    && tenant.rechargeEnabled
    && gatewaySetting
    && notifyUrlsReady,
  );
  return {
    gatewayEnabled,
    provider,
    notifyUrlConfigured: gatewayEnabled,
    minTopupYuan,
    amountOptions: parseAmountOptions(custom ? custom.amountOptions : settings["platform.payment.amountOptions"], minTopupYuan),
    settlementNote: cleanPaymentString(custom ? custom.settlementNote : settings["platform.payment.settlementNote"]),
    guPerYuan,
    channels: channels.filter((channel) => normalizePaymentMethod(channel.method) !== "online" || gatewayEnabled),
  };
}

export async function configuredOnlinePaymentChannel(tenant: CommercialTenant, channelKey: string): Promise<RawPaymentChannel> {
  const config = await resolveTenantPaymentConfiguration(tenant);
  if (!config.gatewayEnabled) throw new PaymentConfigError("当前租户线上支付未启用", 409, "PAYMENT_GATEWAY_DISABLED");
  const channel = config.channels.find((item) => cleanPaymentString(item.key) === cleanPaymentString(channelKey));
  if (!channel || normalizePaymentMethod(channel.method) !== "online") {
    throw new PaymentConfigError("支付渠道不存在或不可用", 400, "PAYMENT_CHANNEL_UNAVAILABLE");
  }
  const protocol = normalizePaymentProtocol(channel);
  if (protocol !== "wechat_v3" && protocol !== "alipay") {
    throw new PaymentConfigError("该线上支付协议尚未支持", 400, "PAYMENT_PROTOCOL_UNSUPPORTED");
  }
  return channel;
}

export function resolvePaymentSecret(reference: unknown): string {
  const key = cleanPaymentString(reference);
  if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(key)) {
    throw new PaymentConfigError("支付密钥引用必须是环境变量名");
  }
  const configured = cleanPaymentString(process.env[key]);
  if (!configured) throw new PaymentConfigError(`支付密钥 ${key} 未配置`);
  if (!configured.startsWith("file:")) return configured.replace(/\\n/g, "\n");
  const filePath = path.resolve(configured.slice(5));
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new PaymentConfigError(`支付密钥文件 ${key} 无效`);
  return fs.readFileSync(filePath, "utf8").trim();
}

export function resolvePaymentNotifyUrl(tenantId: string, channel: RawPaymentChannel): string {
  const explicit = cleanPaymentString(channel.notifyUrl);
  if (explicit) return assertHttpsUrl(explicit, "支付回调地址");
  const origin = cleanPaymentString(process.env.FANJIN_PUBLIC_API_ORIGIN).replace(/\/$/, "");
  if (!origin) return "";
  const protocol = normalizePaymentProtocol(channel);
  return assertHttpsUrl(
    `${origin}/api/billing/payment/callbacks/${protocol}/${encodeURIComponent(tenantId)}/${encodeURIComponent(cleanPaymentString(channel.key))}`,
    "支付回调地址",
  );
}

export function assertHttpsUrl(raw: string, field: string): string {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new PaymentConfigError(`${field}无效`);
  }
  const local = value.hostname === "localhost" || value.hostname === "127.0.0.1";
  if (value.protocol !== "https:" && !(process.env.NODE_ENV === "test" && local)) {
    throw new PaymentConfigError(`${field}必须使用 HTTPS`);
  }
  value.username = "";
  value.password = "";
  value.hash = "";
  return value.toString();
}

export function publicPaymentChannel(channel: RawPaymentChannel) {
  const method = normalizePaymentMethod(channel.method);
  const common = {
    key: cleanPaymentString(channel.key),
    name: cleanPaymentString(channel.name) || cleanPaymentString(channel.key),
    method,
    protocol: normalizePaymentProtocol(channel),
    scene: cleanPaymentString(channel.scene) || undefined,
    enabled: Boolean(channel.enabled),
    default: Boolean(channel.default),
    autoConfirm: Boolean(channel.autoConfirm),
    minAmountYuan: Number(channel.minAmountYuan || 0),
    maxAmountYuan: Number(channel.maxAmountYuan || 0),
    sort: Number(channel.sort || 0),
    credentialConfigured: channelCredentialConfigured(channel),
    remark: cleanPaymentString(channel.remark) || undefined,
  };
  return method === "offline"
    ? {
        ...common,
        accountName: cleanPaymentString(channel.accountName) || undefined,
        accountNo: cleanPaymentString(channel.accountNo) || undefined,
        bankName: cleanPaymentString(channel.bankName) || undefined,
        qrCodeUrl: cleanPaymentString(channel.qrCodeUrl) || undefined,
      }
    : common;
}
