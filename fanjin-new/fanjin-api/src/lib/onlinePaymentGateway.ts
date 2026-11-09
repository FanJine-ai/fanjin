import crypto from "node:crypto";

import {
  assertHttpsUrl,
  cleanPaymentString,
  normalizePaymentProtocol,
  PaymentConfigError,
  resolvePaymentSecret,
  type RawPaymentChannel,
} from "@/lib/tenantPaymentConfig";

export type ProviderPaymentStatus = "pending" | "paid" | "closed" | "refunded";

export interface ProviderPaymentOrder {
  outTradeNo: string;
  amountMicros: number;
  description: string;
  notifyUrl: string;
  returnUrl?: string | null;
  expiresAt: number;
}

export interface ProviderPaymentResult {
  status: ProviderPaymentStatus;
  providerOrderId?: string | null;
  paymentUrl?: string | null;
  qrCodeUrl?: string | null;
  amountMicros?: number | null;
  currency?: string | null;
  eventKey?: string | null;
  payloadDigest: string;
}

export interface ProviderCallbackEvidence extends ProviderPaymentResult {
  outTradeNo: string;
  merchantId: string;
  appId?: string | null;
}

export class OnlinePaymentGatewayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly outcomeUnknown: boolean;

  constructor(message: string, status = 502, code = "PAYMENT_PROVIDER_ERROR", outcomeUnknown = false) {
    super(message);
    this.name = "OnlinePaymentGatewayError";
    this.status = status;
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}

let paymentFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export function setOnlinePaymentFetchForTests(next: typeof fetch | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("支付 fetch 仅允许在测试环境替换");
  paymentFetch = next || globalThis.fetch.bind(globalThis);
}

export function paymentPayloadDigest(payload: string | Buffer): string {
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function yuanMicrosToCents(amountMicros: number): number {
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0 || amountMicros % 10_000 !== 0) {
    throw new OnlinePaymentGatewayError("支付金额必须精确到分", 400, "PAYMENT_AMOUNT_INVALID");
  }
  return amountMicros / 10_000;
}

function centsToYuanMicros(cents: unknown): number {
  const value = Number(cents);
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value * 10_000)) {
    throw new OnlinePaymentGatewayError("支付平台返回金额无效", 502, "PAYMENT_PROVIDER_AMOUNT_INVALID");
  }
  return value * 10_000;
}

function yuanMicrosToText(amountMicros: number): string {
  const cents = yuanMicrosToCents(amountMicros);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function providerExpiry(expiresAt: number): { rfc3339: string; timeoutExpress: string } {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new OnlinePaymentGatewayError("支付订单过期时间无效", 400, "PAYMENT_EXPIRY_INVALID");
  }
  const remainingMinutes = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60_000));
  return {
    rfc3339: new Date(expiresAt).toISOString(),
    timeoutExpress: `${Math.min(1_440, remainingMinutes)}m`,
  };
}

function randomNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

function rsaSha256Sign(privateKey: string, message: string): string {
  return crypto.sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64");
}

function rsaSha256Verify(publicKey: string, message: string, signature: string): boolean {
  try {
    return crypto.verify("RSA-SHA256", Buffer.from(message), publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

function wechatConfig(channel: RawPaymentChannel) {
  const mchId = cleanPaymentString(channel.mchId || channel.merchantId);
  const appId = cleanPaymentString(channel.appId);
  const serial = cleanPaymentString(channel.merchantSerialNo);
  if (!mchId || !appId || !serial) throw new PaymentConfigError("微信支付商户参数不完整");
  return {
    mchId,
    appId,
    serial,
    privateKey: resolvePaymentSecret(channel.privateKeyRef),
    platformCertificate: resolvePaymentSecret(channel.platformCertRef),
    apiV3Key: resolvePaymentSecret(channel.apiV3KeyRef),
    baseUrl: assertHttpsUrl(cleanPaymentString(channel.providerApiBase) || "https://api.mch.weixin.qq.com", "微信支付 API 地址").replace(/\/$/, ""),
  };
}

function wechatAuthorization(channel: RawPaymentChannel, method: string, pathWithQuery: string, body: string) {
  const config = wechatConfig(channel);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomNonce();
  const message = `${method}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = rsaSha256Sign(config.privateKey, message);
  return {
    config,
    value: `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.serial}",signature="${signature}"`,
  };
}

function verifyWechatResponse(channel: RawPaymentChannel, response: Response, body: string): void {
  const timestamp = cleanPaymentString(response.headers.get("Wechatpay-Timestamp"));
  const nonce = cleanPaymentString(response.headers.get("Wechatpay-Nonce"));
  const signature = cleanPaymentString(response.headers.get("Wechatpay-Signature"));
  const serial = cleanPaymentString(response.headers.get("Wechatpay-Serial"));
  if (!timestamp || !nonce || !signature || !serial) {
    throw new OnlinePaymentGatewayError("微信支付响应缺少验签头", 502, "PAYMENT_PROVIDER_SIGNATURE_MISSING");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) {
    throw new OnlinePaymentGatewayError("微信支付响应时间戳已过期", 502, "PAYMENT_PROVIDER_SIGNATURE_EXPIRED");
  }
  const publicCertificate = wechatConfig(channel).platformCertificate;
  if (!rsaSha256Verify(publicCertificate, `${timestamp}\n${nonce}\n${body}\n`, signature)) {
    throw new OnlinePaymentGatewayError("微信支付响应验签失败", 502, "PAYMENT_PROVIDER_SIGNATURE_INVALID");
  }
}

async function wechatRequest(channel: RawPaymentChannel, method: string, pathWithQuery: string, payload?: unknown) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const authorization = wechatAuthorization(channel, method, pathWithQuery, body);
  let response: Response;
  try {
    response = await paymentFetch(`${authorization.config.baseUrl}${pathWithQuery}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: authorization.value,
        "Content-Type": "application/json",
        "User-Agent": "fanjin-online-payment/0.1.0",
      },
      body: body || undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new OnlinePaymentGatewayError("微信支付请求结果未知，请查单确认", 503, "PAYMENT_PROVIDER_OUTCOME_UNKNOWN", true);
  }
  const raw = await response.text();
  verifyWechatResponse(channel, response, raw);
  if (!response.ok) {
    throw new OnlinePaymentGatewayError(`微信支付请求失败（HTTP ${response.status}）`, 502, "PAYMENT_PROVIDER_REJECTED");
  }
  try {
    return { raw, data: raw ? JSON.parse(raw) : {} };
  } catch {
    throw new OnlinePaymentGatewayError("微信支付响应不是有效 JSON", 502, "PAYMENT_PROVIDER_RESPONSE_INVALID");
  }
}

function wechatStatus(value: unknown): ProviderPaymentStatus {
  const state = cleanPaymentString(value).toUpperCase();
  if (state === "SUCCESS") return "paid";
  if (state === "CLOSED" || state === "REVOKED" || state === "PAYERROR") return "closed";
  if (state === "REFUND" || state === "ABNORMAL") return "refunded";
  return "pending";
}

async function createWechatOrder(channel: RawPaymentChannel, order: ProviderPaymentOrder): Promise<ProviderPaymentResult> {
  const config = wechatConfig(channel);
  const expiry = providerExpiry(order.expiresAt);
  const result = await wechatRequest(channel, "POST", "/v3/pay/transactions/native", {
    appid: config.appId,
    mchid: config.mchId,
    description: order.description.slice(0, 127),
    out_trade_no: order.outTradeNo,
    notify_url: order.notifyUrl,
    time_expire: expiry.rfc3339,
    amount: { total: yuanMicrosToCents(order.amountMicros), currency: "CNY" },
  });
  const codeUrl = cleanPaymentString(result.data.code_url);
  if (!codeUrl) throw new OnlinePaymentGatewayError("微信支付未返回付款二维码", 502, "PAYMENT_PROVIDER_RESPONSE_INVALID");
  return { status: "pending", qrCodeUrl: codeUrl, payloadDigest: paymentPayloadDigest(result.raw) };
}

async function queryWechatOrder(channel: RawPaymentChannel, outTradeNo: string): Promise<ProviderPaymentResult> {
  const config = wechatConfig(channel);
  const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(config.mchId)}`;
  const result = await wechatRequest(channel, "GET", path);
  return {
    status: wechatStatus(result.data.trade_state),
    providerOrderId: cleanPaymentString(result.data.transaction_id) || null,
    amountMicros: centsToYuanMicros(result.data.amount?.total),
    currency: cleanPaymentString(result.data.amount?.currency) || "CNY",
    payloadDigest: paymentPayloadDigest(result.raw),
  };
}

async function refundWechatOrder(channel: RawPaymentChannel, order: ProviderPaymentOrder): Promise<ProviderPaymentResult> {
  const result = await wechatRequest(channel, "POST", "/v3/refund/domestic/refunds", {
    out_trade_no: order.outTradeNo,
    out_refund_no: `R${order.outTradeNo}`.slice(0, 64),
    reason: "用户申请退还未使用充值",
    notify_url: order.notifyUrl,
    amount: {
      refund: yuanMicrosToCents(order.amountMicros),
      total: yuanMicrosToCents(order.amountMicros),
      currency: "CNY",
    },
  });
  const status = cleanPaymentString(result.data.status).toUpperCase();
  return {
    status: status === "SUCCESS" ? "refunded" : "pending",
    providerOrderId: cleanPaymentString(result.data.refund_id) || null,
    amountMicros: centsToYuanMicros(result.data.amount?.refund ?? yuanMicrosToCents(order.amountMicros)),
    currency: cleanPaymentString(result.data.amount?.currency) || "CNY",
    payloadDigest: paymentPayloadDigest(result.raw),
  };
}

async function queryWechatRefund(channel: RawPaymentChannel, order: ProviderPaymentOrder): Promise<ProviderPaymentResult> {
  const refundNo = `R${order.outTradeNo}`.slice(0, 64);
  const result = await wechatRequest(channel, "GET", `/v3/refund/domestic/refunds/${encodeURIComponent(refundNo)}`);
  const status = cleanPaymentString(result.data.status).toUpperCase();
  return {
    status: status === "SUCCESS" ? "refunded" : "pending",
    providerOrderId: cleanPaymentString(result.data.refund_id) || null,
    amountMicros: centsToYuanMicros(result.data.amount?.refund ?? yuanMicrosToCents(order.amountMicros)),
    currency: cleanPaymentString(result.data.amount?.currency) || "CNY",
    payloadDigest: paymentPayloadDigest(result.raw),
  };
}

export function verifyWechatCallback(channel: RawPaymentChannel, headers: Record<string, string | string[] | undefined>, rawBody: string): ProviderCallbackEvidence {
  const get = (name: string) => cleanPaymentString(headers[name] ?? headers[name.toLowerCase()]);
  const timestamp = get("wechatpay-timestamp");
  const nonce = get("wechatpay-nonce");
  const signature = get("wechatpay-signature");
  const serial = get("wechatpay-serial");
  if (!timestamp || !nonce || !signature || !serial || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) {
    throw new OnlinePaymentGatewayError("微信支付回调验签参数无效", 401, "PAYMENT_CALLBACK_SIGNATURE_INVALID");
  }
  const config = wechatConfig(channel);
  if (!rsaSha256Verify(config.platformCertificate, `${timestamp}\n${nonce}\n${rawBody}\n`, signature)) {
    throw new OnlinePaymentGatewayError("微信支付回调验签失败", 401, "PAYMENT_CALLBACK_SIGNATURE_INVALID");
  }
  let envelope: any;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    throw new OnlinePaymentGatewayError("微信支付回调正文无效", 400, "PAYMENT_CALLBACK_INVALID");
  }
  const resource = envelope?.resource;
  if (resource?.algorithm !== "AEAD_AES_256_GCM") {
    throw new OnlinePaymentGatewayError("微信支付回调加密算法不受支持", 400, "PAYMENT_CALLBACK_INVALID");
  }
  const key = Buffer.from(config.apiV3Key, "utf8");
  if (key.length !== 32) throw new PaymentConfigError("微信支付 APIv3 密钥必须为 32 字节");
  let data: any;
  try {
    const ciphertext = Buffer.from(resource.ciphertext, "base64");
    const authTag = ciphertext.subarray(ciphertext.length - 16);
    const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(resource.nonce, "utf8"));
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(resource.associated_data || "", "utf8"));
    data = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"));
  } catch {
    throw new OnlinePaymentGatewayError("微信支付回调解密失败", 401, "PAYMENT_CALLBACK_DECRYPT_FAILED");
  }
  return {
    outTradeNo: cleanPaymentString(data.out_trade_no),
    merchantId: cleanPaymentString(data.mchid),
    appId: cleanPaymentString(data.appid),
    status: wechatStatus(data.trade_state),
    providerOrderId: cleanPaymentString(data.transaction_id) || null,
    amountMicros: centsToYuanMicros(data.amount?.total),
    currency: cleanPaymentString(data.amount?.currency) || "CNY",
    eventKey: cleanPaymentString(envelope.id) || paymentPayloadDigest(rawBody),
    payloadDigest: paymentPayloadDigest(rawBody),
  };
}

function alipayConfig(channel: RawPaymentChannel) {
  const appId = cleanPaymentString(channel.alipayAppId || channel.merchantId);
  if (!appId) throw new PaymentConfigError("支付宝应用 ID 未配置");
  return {
    appId,
    privateKey: resolvePaymentSecret(channel.alipayPrivateKeyRef),
    publicKey: resolvePaymentSecret(channel.alipayPublicKeyRef),
    gateway: assertHttpsUrl(cleanPaymentString(channel.alipayGateway) || "https://openapi.alipay.com/gateway.do", "支付宝网关地址"),
  };
}

function formatAlipayTimestamp(at = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(at).reduce<Record<string, string>>((acc, item) => ({ ...acc, [item.type]: item.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function alipaySignedParams(channel: RawPaymentChannel, method: string, bizContent: Record<string, unknown>, extra: Record<string, string> = {}) {
  const config = alipayConfig(channel);
  const params: Record<string, string> = {
    app_id: config.appId,
    method,
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: formatAlipayTimestamp(),
    version: "1.0",
    biz_content: JSON.stringify(bizContent),
    ...extra,
  };
  const canonical = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("&");
  params.sign = rsaSha256Sign(config.privateKey, canonical);
  return { config, params };
}

function extractJsonObject(raw: string, property: string): string {
  const marker = `"${property}":`;
  const start = raw.indexOf(marker);
  if (start < 0) throw new OnlinePaymentGatewayError("支付宝响应缺少业务结果", 502, "PAYMENT_PROVIDER_RESPONSE_INVALID");
  const objectStart = raw.indexOf("{", start + marker.length);
  if (objectStart < 0) throw new OnlinePaymentGatewayError("支付宝业务结果无效", 502, "PAYMENT_PROVIDER_RESPONSE_INVALID");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = objectStart; index < raw.length; index += 1) {
    const char = raw[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") quoted = false;
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return raw.slice(objectStart, index + 1);
  }
  throw new OnlinePaymentGatewayError("支付宝业务结果截断", 502, "PAYMENT_PROVIDER_RESPONSE_INVALID");
}

function parseAlipayResponse(channel: RawPaymentChannel, method: string, raw: string): any {
  let envelope: any;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new OnlinePaymentGatewayError("支付宝响应不是有效 JSON", 502, "PAYMENT_PROVIDER_RESPONSE_INVALID");
  }
  const property = `${method.replace(/\./g, "_")}_response`;
  const responseText = extractJsonObject(raw, property);
  if (!rsaSha256Verify(alipayConfig(channel).publicKey, responseText, cleanPaymentString(envelope.sign))) {
    throw new OnlinePaymentGatewayError("支付宝响应验签失败", 502, "PAYMENT_PROVIDER_SIGNATURE_INVALID");
  }
  const data = envelope[property];
  if (cleanPaymentString(data?.code) !== "10000") {
    throw new OnlinePaymentGatewayError(`支付宝请求失败：${cleanPaymentString(data?.sub_msg || data?.msg) || "未知原因"}`, 502, "PAYMENT_PROVIDER_REJECTED");
  }
  return data;
}

async function alipayRequest(channel: RawPaymentChannel, method: string, bizContent: Record<string, unknown>) {
  const signed = alipaySignedParams(channel, method, bizContent);
  let response: Response;
  try {
    response = await paymentFetch(signed.config.gateway, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: new URLSearchParams(signed.params),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new OnlinePaymentGatewayError("支付宝请求结果未知，请查单确认", 503, "PAYMENT_PROVIDER_OUTCOME_UNKNOWN", true);
  }
  const raw = await response.text();
  if (!response.ok) throw new OnlinePaymentGatewayError(`支付宝网关失败（HTTP ${response.status}）`);
  return { raw, data: parseAlipayResponse(channel, method, raw) };
}

function alipayMoneyToMicros(value: unknown): number {
  const text = cleanPaymentString(value);
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new OnlinePaymentGatewayError("支付宝金额无效", 502);
  const [yuan, decimal = ""] = text.split(".");
  const amount = BigInt(yuan) * 1_000_000n + BigInt(decimal.padEnd(2, "0")) * 10_000n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new OnlinePaymentGatewayError("支付宝金额超出安全范围", 502);
  return Number(amount);
}

function alipayStatus(value: unknown): ProviderPaymentStatus {
  const state = cleanPaymentString(value).toUpperCase();
  if (state === "TRADE_SUCCESS" || state === "TRADE_FINISHED") return "paid";
  if (state === "TRADE_CLOSED") return "closed";
  return "pending";
}

async function createAlipayOrder(channel: RawPaymentChannel, order: ProviderPaymentOrder): Promise<ProviderPaymentResult> {
  const expiry = providerExpiry(order.expiresAt);
  const signed = alipaySignedParams(channel, "alipay.trade.page.pay", {
    out_trade_no: order.outTradeNo,
    total_amount: yuanMicrosToText(order.amountMicros),
    subject: order.description.slice(0, 128),
    product_code: "FAST_INSTANT_TRADE_PAY",
    timeout_express: expiry.timeoutExpress,
  }, {
    notify_url: order.notifyUrl,
    ...(order.returnUrl ? { return_url: order.returnUrl } : {}),
  });
  const paymentUrl = `${signed.config.gateway}?${new URLSearchParams(signed.params).toString()}`;
  return { status: "pending", paymentUrl, payloadDigest: paymentPayloadDigest(paymentUrl) };
}

async function queryAlipayOrder(channel: RawPaymentChannel, outTradeNo: string): Promise<ProviderPaymentResult> {
  const result = await alipayRequest(channel, "alipay.trade.query", { out_trade_no: outTradeNo });
  return {
    status: alipayStatus(result.data.trade_status),
    providerOrderId: cleanPaymentString(result.data.trade_no) || null,
    amountMicros: alipayMoneyToMicros(result.data.total_amount),
    currency: "CNY",
    payloadDigest: paymentPayloadDigest(result.raw),
  };
}

async function refundAlipayOrder(channel: RawPaymentChannel, order: ProviderPaymentOrder): Promise<ProviderPaymentResult> {
  const result = await alipayRequest(channel, "alipay.trade.refund", {
    out_trade_no: order.outTradeNo,
    refund_amount: yuanMicrosToText(order.amountMicros),
    out_request_no: `R${order.outTradeNo}`.slice(0, 64),
    refund_reason: "用户申请退还未使用充值",
  });
  return {
    status: cleanPaymentString(result.data.fund_change) === "Y" ? "refunded" : "pending",
    providerOrderId: cleanPaymentString(result.data.trade_no) || null,
    amountMicros: alipayMoneyToMicros(result.data.refund_fee || yuanMicrosToText(order.amountMicros)),
    currency: "CNY",
    payloadDigest: paymentPayloadDigest(result.raw),
  };
}

async function queryAlipayRefund(channel: RawPaymentChannel, order: ProviderPaymentOrder): Promise<ProviderPaymentResult> {
  const result = await alipayRequest(channel, "alipay.trade.fastpay.refund.query", {
    out_trade_no: order.outTradeNo,
    out_request_no: `R${order.outTradeNo}`.slice(0, 64),
  });
  const refundAmount = cleanPaymentString(result.data.refund_amount);
  const refunded = cleanPaymentString(result.data.refund_status).toUpperCase() === "REFUND_SUCCESS"
    || (refundAmount ? alipayMoneyToMicros(refundAmount) >= order.amountMicros : false);
  return {
    status: refunded ? "refunded" : "pending",
    providerOrderId: cleanPaymentString(result.data.trade_no) || null,
    amountMicros: refundAmount ? alipayMoneyToMicros(refundAmount) : null,
    currency: "CNY",
    payloadDigest: paymentPayloadDigest(result.raw),
  };
}

export function verifyAlipayCallback(channel: RawPaymentChannel, rawBody: string): ProviderCallbackEvidence {
  const params = new URLSearchParams(rawBody);
  const signature = cleanPaymentString(params.get("sign"));
  params.delete("sign");
  params.delete("sign_type");
  const entries = Array.from(params.entries()).filter(([, value]) => value !== "").sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const canonical = entries.map(([key, value]) => `${key}=${value}`).join("&");
  if (!signature || !rsaSha256Verify(alipayConfig(channel).publicKey, canonical, signature)) {
    throw new OnlinePaymentGatewayError("支付宝回调验签失败", 401, "PAYMENT_CALLBACK_SIGNATURE_INVALID");
  }
  return {
    outTradeNo: cleanPaymentString(params.get("out_trade_no")),
    merchantId: cleanPaymentString(params.get("seller_id") || params.get("app_id")),
    appId: cleanPaymentString(params.get("app_id")) || null,
    status: alipayStatus(params.get("trade_status")),
    providerOrderId: cleanPaymentString(params.get("trade_no")) || null,
    amountMicros: alipayMoneyToMicros(params.get("total_amount")),
    currency: "CNY",
    eventKey: cleanPaymentString(params.get("notify_id")) || paymentPayloadDigest(rawBody),
    payloadDigest: paymentPayloadDigest(rawBody),
  };
}

export async function createProviderOrder(channel: RawPaymentChannel, order: ProviderPaymentOrder): Promise<ProviderPaymentResult> {
  const protocol = normalizePaymentProtocol(channel);
  if (protocol === "wechat_v3") return createWechatOrder(channel, order);
  if (protocol === "alipay") return createAlipayOrder(channel, order);
  throw new OnlinePaymentGatewayError("支付协议不受支持", 400, "PAYMENT_PROTOCOL_UNSUPPORTED");
}

export async function queryProviderOrder(channel: RawPaymentChannel, outTradeNo: string): Promise<ProviderPaymentResult> {
  const protocol = normalizePaymentProtocol(channel);
  if (protocol === "wechat_v3") return queryWechatOrder(channel, outTradeNo);
  if (protocol === "alipay") return queryAlipayOrder(channel, outTradeNo);
  throw new OnlinePaymentGatewayError("支付协议不受支持", 400, "PAYMENT_PROTOCOL_UNSUPPORTED");
}

export async function refundProviderOrder(channel: RawPaymentChannel, order: ProviderPaymentOrder): Promise<ProviderPaymentResult> {
  const protocol = normalizePaymentProtocol(channel);
  if (protocol === "wechat_v3") return refundWechatOrder(channel, order);
  if (protocol === "alipay") return refundAlipayOrder(channel, order);
  throw new OnlinePaymentGatewayError("支付协议不受支持", 400, "PAYMENT_PROTOCOL_UNSUPPORTED");
}

export async function queryProviderRefund(channel: RawPaymentChannel, order: ProviderPaymentOrder): Promise<ProviderPaymentResult> {
  const protocol = normalizePaymentProtocol(channel);
  if (protocol === "wechat_v3") return queryWechatRefund(channel, order);
  if (protocol === "alipay") return queryAlipayRefund(channel, order);
  throw new OnlinePaymentGatewayError("支付协议不受支持", 400, "PAYMENT_PROTOCOL_UNSUPPORTED");
}
