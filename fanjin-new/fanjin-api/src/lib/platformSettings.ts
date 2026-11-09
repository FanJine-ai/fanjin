import { Knex } from "knex";
import { db } from "@/utils/db";
import {
  DISTRIBUTED_RATE_LIMIT_SETTING_KEYS,
  MODEL_RATE_LIMIT_DURATION_KEY,
  MODEL_RATE_LIMIT_ENABLED_KEY,
  inspectDistributedRateLimitConfiguration,
  inspectDistributedRateLimitWindowSettings,
} from "@/lib/distributedRateLimit";
import { readRedisRateLimitCutoverState } from "@/lib/redisRateLimitCutover";
import { isSealedSecret, openSecret, sealSecret } from "@/lib/secretEnvelope";

export type PlatformSettingType = "string" | "textarea" | "number" | "boolean" | "select" | "secret";
export type PlatformSettingValue = string | number | boolean;

export interface PlatformSettingSection {
  id: string;
  title: string;
  description: string;
}

export interface PlatformSettingDefinition {
  key: string;
  section: string;
  label: string;
  description: string;
  type: PlatformSettingType;
  defaultValue: PlatformSettingValue;
  options?: Array<{ label: string; value: string }>;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  restartRequired?: boolean;
  secret?: boolean;
}

export interface PlatformSettingItem extends PlatformSettingDefinition {
  value: PlatformSettingValue;
  configured?: boolean;
}

export class PlatformSettingValidationError extends Error {
  readonly status = 422;
  readonly code: string;

  constructor(message: string, code = "platform_setting_invalid") {
    super(message);
    this.name = "PlatformSettingValidationError";
    this.code = code;
  }
}

// Online payment is enabled only when the tenant switch, a supported channel,
// callback URL and secret references are all configured. Provider callbacks
// remain authoritative; browser success pages never credit GU.
export const ONLINE_PAYMENT_GATEWAY_AVAILABLE = true;

/** 各场景默认模型配置位:platformSettings 中的 JSON 对象键。 */
export const PLATFORM_MODEL_DEFAULTS_KEY = "platform.model.defaults";

export const PLATFORM_MODEL_DEFAULT_SCENES = ["image", "video", "text", "agentChat"] as const;
export type PlatformModelDefaultScene = (typeof PLATFORM_MODEL_DEFAULT_SCENES)[number];

/** 值为 /api/workbench/models/catalog 返回条目的模型 id(agentChat 为对话模型目录 id)。 */
export type PlatformModelDefaults = Partial<Record<PlatformModelDefaultScene, string>>;

/** 宽容解析:非法 JSON / 非对象 / 未知场景键一律丢弃,读取路径永不抛错。 */
export function parsePlatformModelDefaults(raw: unknown): PlatformModelDefaults {
  let value = raw;
  if (typeof value === "string") {
    if (!value.trim()) return {};
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const defaults: PlatformModelDefaults = {};
  for (const scene of PLATFORM_MODEL_DEFAULT_SCENES) {
    const id = (value as Record<string, unknown>)[scene];
    if (typeof id === "string" && id.trim()) defaults[scene] = id.trim();
  }
  return defaults;
}

/** 严格校验:写入路径使用,非法输入抛错并阻止保存。 */
export function assertValidPlatformModelDefaults(raw: unknown): void {
  const text = String(raw ?? "").trim();
  if (!text) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("默认模型配置必须是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("默认模型配置必须是 JSON 对象");
  }
  for (const [scene, id] of Object.entries(parsed)) {
    if (!PLATFORM_MODEL_DEFAULT_SCENES.includes(scene as PlatformModelDefaultScene)) {
      throw new Error(`默认模型配置不支持场景：${scene}（仅支持 image / video / text / agentChat）`);
    }
    if (id !== null && (typeof id !== "string" || !id.trim())) {
      throw new Error(`默认模型配置 ${scene} 必须是非空字符串模型 id`);
    }
  }
}

export async function readPlatformModelDefaults(): Promise<PlatformModelDefaults> {
  return parsePlatformModelDefaults(await getPlatformSettingValue(PLATFORM_MODEL_DEFAULTS_KEY));
}

export const PLATFORM_SETTING_SECTIONS: PlatformSettingSection[] = [
  {
    id: "site",
    title: "站点与合规",
    description: "品牌、服务地址、API 文档、公告、用户协议和隐私政策。",
  },
  {
    id: "auth",
    title: "认证与注册",
    description: "登录注册开关、企业准入、邮箱校验和机器人防护。",
  },
  {
    id: "security",
    title: "安全与风控",
    description: "SSRF 防护、敏感词、私网访问和外链拉取边界。",
  },
  {
    id: "gateway",
    title: "API 网关",
    description: "请求限流、模型限流、失败重试和请求体上限。",
  },
  {
    id: "channels",
    title: "渠道监控",
    description: "供应商通道自动检测、自动禁用、恢复和失败判定。",
  },
  {
    id: "billing",
    title: "计费策略",
    description: "预扣额度、额度提醒、显示单位和倍率暴露策略。",
  },
  {
    id: "notification",
    title: "通知与邮件",
    description: "SMTP、任务通知、密码找回和额度提醒的发送配置。",
  },
  {
    id: "worker",
    title: "媒体 Worker",
    description: "媒体代理、远程图片拉取和高清视频无感增强链路。",
  },
  {
    id: "models",
    title: "模型目录",
    description: "创作台与各业务场景的默认模型配置。",
  },
];

function defaultRegistrationMode(): string {
  const raw = String(process.env.FANJIN_REGISTRATION_MODE || "").trim().toLowerCase();
  if (raw === "self_service" || raw === "invite" || raw === "closed") return raw;
  return process.env.NODE_ENV === "prod" ? "closed" : "self_service";
}

const DEFAULT_PAYMENT_CHANNELS = JSON.stringify([
  {
    key: "wechat_pay_v3",
    name: "微信支付 API v3",
    method: "online",
    protocol: "wechat_v3",
    scene: "native",
    enabled: false,
    default: false,
    autoConfirm: true,
    minAmountYuan: 1,
    maxAmountYuan: 50000,
    sort: 10,
  },
  {
    key: "wechat_pay_v2",
    name: "微信支付 API v2",
    method: "online",
    protocol: "wechat_v2",
    scene: "native",
    enabled: false,
    default: false,
    autoConfirm: true,
    minAmountYuan: 1,
    maxAmountYuan: 50000,
    sort: 20,
  },
  {
    key: "alipay",
    name: "支付宝",
    method: "online",
    protocol: "alipay",
    scene: "pc",
    alipayGateway: "https://openapi.alipay.com/gateway.do",
    enabled: false,
    default: false,
    autoConfirm: true,
    minAmountYuan: 1,
    maxAmountYuan: 50000,
    sort: 30,
  },
  {
    key: "bank_card",
    name: "银行卡转账",
    protocol: "offline_bank",
    method: "offline",
    enabled: true,
    default: false,
    autoConfirm: false,
    minAmountYuan: 100,
    maxAmountYuan: 1000000,
    sort: 40,
  },
  {
    key: "corporate_transfer",
    name: "公对公打款",
    protocol: "offline_corporate",
    method: "offline",
    enabled: true,
    default: true,
    autoConfirm: false,
    minAmountYuan: 100,
    maxAmountYuan: 5000000,
    sort: 50,
  },
]);

export const PLATFORM_SETTING_DEFINITIONS: PlatformSettingDefinition[] = [
  {
    key: "platform.site.systemName",
    section: "site",
    label: "系统名称",
    description: "用于登录页、浏览器标题和对外文档展示。",
    type: "string",
    defaultValue: "Fanjin",
  },
  {
    key: "platform.site.serverAddress",
    section: "site",
    label: "服务地址",
    description: "对外 API 根地址，生产环境应填写 HTTPS 域名。",
    type: "string",
    defaultValue: "",
    restartRequired: true,
  },
  {
    key: "platform.site.docsLink",
    section: "site",
    label: "API 文档地址",
    description: "开发者模块展示的官方兼容接口文档入口。",
    type: "string",
    defaultValue: "",
  },
  {
    key: "platform.site.notice",
    section: "site",
    label: "系统公告",
    description: "可用于发布维护、价格、模型能力变化等通知。",
    type: "textarea",
    defaultValue: "",
  },
  {
    key: "platform.legal.userAgreement",
    section: "site",
    label: "用户协议",
    description: "上线前建议填写正式的 SaaS 服务协议。",
    type: "textarea",
    defaultValue: "",
  },
  {
    key: "platform.legal.privacyPolicy",
    section: "site",
    label: "隐私政策",
    description: "上线前建议填写数据处理、日志、素材存储和第三方服务说明。",
    type: "textarea",
    defaultValue: "",
  },
  {
    key: "platform.auth.registrationMode",
    section: "auth",
    label: "注册模式",
    description: "自助注册、仅邀请注册或完全关闭注册。",
    type: "select",
    defaultValue: defaultRegistrationMode(),
    options: [
      { label: "自助注册", value: "self_service" },
      { label: "仅邀请注册", value: "invite" },
      { label: "关闭注册", value: "closed" },
    ],
  },
  {
    key: "platform.auth.passwordLoginEnabled",
    section: "auth",
    label: "允许密码登录",
    description: "关闭后仅保留后续接入的 SSO / Passkey 等登录方式。",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "platform.auth.passwordRegisterEnabled",
    section: "auth",
    label: "允许密码注册",
    description: "关闭后即使注册模式开放，也不能通过账号密码直接注册。",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "platform.auth.emailVerificationEnabled",
    section: "auth",
    label: "邮箱验证",
    description: "开启后注册和找回密码需要邮件通道完整可用。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.auth.emailDomainRestrictionEnabled",
    section: "auth",
    label: "限制邮箱域名",
    description: "用于企业准入，只允许白名单域名注册。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.auth.emailDomainWhitelist",
    section: "auth",
    label: "邮箱域名白名单",
    description: "逗号或换行分隔，例如 example.com, corp.cn。",
    type: "textarea",
    defaultValue: "",
  },
  {
    key: "platform.auth.turnstileCheckEnabled",
    section: "auth",
    label: "Turnstile 防机器人",
    description: "用于登录、注册、找回密码等高风险入口。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.auth.turnstileSiteKey",
    section: "auth",
    label: "Turnstile Site Key",
    description: "前端站点公钥。",
    type: "string",
    defaultValue: "",
  },
  {
    key: "platform.auth.turnstileSecretKey",
    section: "auth",
    label: "Turnstile Secret Key",
    description: "服务端校验密钥，保存后不会回显。",
    type: "secret",
    defaultValue: "",
    secret: true,
  },
  {
    key: "platform.auth.douyinLoginEnabled",
    section: "auth",
    label: "启用抖音登录",
    description: "开启后登录页显示抖音按钮。需同时配置 Client Key 与 Secret。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.auth.douyinClientKey",
    section: "auth",
    label: "抖音 Client Key",
    description: "抖音开放平台网站应用 Client Key。回调：/api/auth/oauth/douyin/callback",
    type: "string",
    defaultValue: "",
  },
  {
    key: "platform.auth.douyinClientSecret",
    section: "auth",
    label: "抖音 Client Secret",
    description: "抖音 Client Secret，保存后不会回显。",
    type: "secret",
    defaultValue: "",
    secret: true,
  },
  {
    key: "platform.auth.wechatLoginEnabled",
    section: "auth",
    label: "启用微信扫码登录",
    description: "开启后登录页显示微信按钮。需微信开放平台网站应用 AppID/Secret。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.auth.wechatAppId",
    section: "auth",
    label: "微信 AppID",
    description: "微信开放平台网站应用 AppID。回调 path：/api/auth/oauth/wechat/callback",
    type: "string",
    defaultValue: "",
  },
  {
    key: "platform.auth.wechatAppSecret",
    section: "auth",
    label: "微信 AppSecret",
    description: "微信 AppSecret，保存后不会回显。",
    type: "secret",
    defaultValue: "",
    secret: true,
  },
  {
    key: "platform.auth.googleLoginEnabled",
    section: "auth",
    label: "启用 Google 登录",
    description: "开启后登录页显示 Google 按钮。需 Google OAuth Web Client。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.auth.googleClientId",
    section: "auth",
    label: "Google Client ID",
    description: "Google Cloud OAuth 2.0 Web Client ID。回调：/api/auth/oauth/google/callback",
    type: "string",
    defaultValue: "",
  },
  {
    key: "platform.auth.googleClientSecret",
    section: "auth",
    label: "Google Client Secret",
    description: "Google Client Secret，保存后不会回显。",
    type: "secret",
    defaultValue: "",
    secret: true,
  },
  {
    key: "platform.auth.githubLoginEnabled",
    section: "auth",
    label: "启用 GitHub 登录",
    description: "开启后登录页显示 GitHub 按钮。需 GitHub OAuth App。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.auth.githubClientId",
    section: "auth",
    label: "GitHub Client ID",
    description: "GitHub OAuth App Client ID。回调：/api/auth/oauth/github/callback",
    type: "string",
    defaultValue: "",
  },
  {
    key: "platform.auth.githubClientSecret",
    section: "auth",
    label: "GitHub Client Secret",
    description: "GitHub Client Secret，保存后不会回显。",
    type: "secret",
    defaultValue: "",
    secret: true,
  },
  {
    key: "platform.security.enableSSRFProtection",
    section: "security",
    label: "启用 SSRF 防护",
    description: "用户提交图片、视频、音频 URL 时阻止访问内网和危险地址。",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "platform.security.allowPrivateIp",
    section: "security",
    label: "允许访问私网 IP",
    description: "生产环境建议关闭，除非内部素材服务明确需要。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.security.allowedPorts",
    section: "security",
    label: "允许端口",
    description: "逗号分隔，例如 80,443,8080,8443。",
    type: "string",
    defaultValue: "80,443,8080,8443",
  },
  {
    key: "platform.security.domainList",
    section: "security",
    label: "域名名单",
    description: "一行一个域名，支持后续扩展为黑白名单模式。",
    type: "textarea",
    defaultValue: "",
  },
  {
    key: "platform.security.ipList",
    section: "security",
    label: "IP / CIDR 名单",
    description: "一行一个 IP 或 CIDR，用于风控名单。",
    type: "textarea",
    defaultValue: "",
  },
  {
    key: "platform.security.checkSensitiveEnabled",
    section: "security",
    label: "启用敏感词检测",
    description: "用于 prompt、任务标题、项目内容等文本入口。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.security.checkSensitiveOnPromptEnabled",
    section: "security",
    label: "检测提示词",
    description: "打开后视频生成提示词也进入敏感词扫描。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.security.stopOnSensitiveEnabled",
    section: "security",
    label: "命中后阻断",
    description: "关闭时只记录风险；开启后直接拒绝请求。",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "platform.security.sensitiveWords",
    section: "security",
    label: "敏感词",
    description: "逗号或换行分隔。",
    type: "textarea",
    defaultValue: "",
  },
  {
    key: "platform.gateway.globalRateLimitPerMinute",
    section: "gateway",
    label: "全局 API 限流",
    description: "每分钟全局请求上限，0 表示不限制。",
    type: "number",
    defaultValue: 0,
    min: 0,
    step: 10,
    suffix: "次/分钟",
  },
  {
    key: "platform.gateway.modelRateLimitEnabled",
    section: "gateway",
    label: "启用模型限流",
    description: "对单用户、单模型的高频调用做保护。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.gateway.modelRateLimitCount",
    section: "gateway",
    label: "模型限流次数",
    description: "模型限流窗口内允许的请求数。",
    type: "number",
    defaultValue: 60,
    min: 1,
    suffix: "次",
  },
  {
    key: "platform.gateway.modelRateLimitDurationMinutes",
    section: "gateway",
    label: "模型限流窗口",
    description: "模型限流统计窗口。",
    type: "number",
    defaultValue: 1,
    min: 1,
    suffix: "分钟",
  },
  {
    key: "platform.gateway.retryTimes",
    section: "gateway",
    label: "失败重试次数",
    description: "上游失败后允许的自动重试次数。",
    type: "number",
    defaultValue: 2,
    min: 0,
    max: 10,
    suffix: "次",
  },
  {
    key: "platform.gateway.automaticRetryStatusCodes",
    section: "gateway",
    label: "自动重试状态码",
    description: "逗号分隔，例如 429,500,502,503,504。",
    type: "string",
    defaultValue: "429,500,502,503,504",
  },
  {
    key: "platform.gateway.requestBodyLimitMb",
    section: "gateway",
    label: "请求体上限",
    description: "Express 解析上限，修改后需要重启服务。",
    type: "number",
    defaultValue: 100,
    min: 1,
    max: 2048,
    suffix: "MB",
    restartRequired: true,
  },
  {
    key: "platform.channels.autoTestChannelEnabled",
    section: "channels",
    label: "自动测试渠道",
    description: "按固定间隔检查供应商渠道可用性。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.channels.autoTestChannelMinutes",
    section: "channels",
    label: "自动测试间隔",
    description: "渠道自动检测的间隔时间。",
    type: "number",
    defaultValue: 10,
    min: 1,
    suffix: "分钟",
  },
  {
    key: "platform.channels.automaticDisableChannelEnabled",
    section: "channels",
    label: "失败自动禁用渠道",
    description: "通道持续失败时自动从路由中剔除。",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "platform.channels.automaticEnableChannelEnabled",
    section: "channels",
    label: "恢复后自动启用",
    description: "通道健康检查恢复后允许自动启用。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.channels.channelDisableThreshold",
    section: "channels",
    label: "禁用阈值",
    description: "失败率达到阈值后触发自动禁用，0-1 之间。",
    type: "number",
    defaultValue: 0.5,
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: "platform.channels.automaticDisableStatusCodes",
    section: "channels",
    label: "禁用状态码",
    description: "逗号分隔，例如 401,403,429。",
    type: "string",
    defaultValue: "401,403,429",
  },
  {
    key: "platform.channels.automaticDisableKeywords",
    section: "channels",
    label: "禁用关键词",
    description: "错误信息包含这些词时可触发自动禁用。",
    type: "textarea",
    defaultValue: "",
  },
  {
    key: "platform.billing.preConsumedQuota",
    section: "billing",
    label: "API 预扣额度",
    description: "异步任务提交前先冻结的最小额度。",
    type: "number",
    defaultValue: 1,
    min: 0,
    suffix: "单位",
  },
  {
    key: "platform.billing.quotaRemindThreshold",
    section: "billing",
    label: "额度提醒阈值",
    description: "工作区余额低于该值时触发提醒。",
    type: "number",
    defaultValue: 100,
    min: 0,
    suffix: "单位",
  },
  {
    key: "platform.billing.quotaPerUnit",
    section: "billing",
    label: "GU 兑换比例",
    description: "1 元人民币对应的 GU 创作额度。",
    type: "number",
    defaultValue: 1000,
    min: 1,
    suffix: "GU / 元",
  },
  {
    key: "platform.billing.displayInCurrencyEnabled",
    section: "billing",
    label: "按人民币等值显示",
    description: "开启后在 GU 旁展示人民币等值，用户主视图仍优先显示 GU。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.billing.exposeRatioEnabled",
    section: "billing",
    label: "向用户暴露倍率",
    description: "建议关闭，用户只看到价格和额度，不看到内部倍率。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.billing.defaultCurrency",
    section: "billing",
    label: "默认计价单位",
    description: "用于后台定价、模型消耗和用户额度展示。",
    type: "select",
    defaultValue: "GU",
    options: [
      { label: "Fanjin GU", value: "GU" },
      { label: "人民币 CNY", value: "CNY" },
      { label: "美元 USD", value: "USD" },
      { label: "兼容额度 TOKEN", value: "TOKEN" },
    ],
  },
  {
    key: "platform.billing.pricePrecision",
    section: "billing",
    label: "价格小数位",
    description: "金额展示时保留的小数位。",
    type: "number",
    defaultValue: 4,
    min: 0,
    max: 8,
    suffix: "位",
  },
  {
    key: "platform.billing.newWorkspaceInitialCreditYuan",
    section: "billing",
    label: "新工作区初始额度",
    description: "创建企业工作区时默认授予的可用额度。",
    type: "number",
    defaultValue: 0,
    min: 0,
    suffix: "GU",
  },
  {
    key: "platform.payment.gatewayEnabled",
    section: "billing",
    label: "启用支付网关",
    description: "配置商户、签名密钥与 HTTPS 回调地址，并确认支付产品已开通、收款与退款验证通过后启用。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.payment.provider",
    section: "billing",
    label: "默认支付方式",
    description: "钱包充值入口默认选中的支付方式。",
    type: "select",
    defaultValue: "corporate_transfer",
    options: [
      { label: "人工确认", value: "manual" },
      { label: "支付宝", value: "alipay" },
      { label: "微信支付 API v3", value: "wechat_pay_v3" },
      { label: "微信支付 API v2", value: "wechat_pay_v2" },
      { label: "银行卡转账", value: "bank_card" },
      { label: "公对公打款", value: "corporate_transfer" },
      { label: "关闭", value: "disabled" },
    ],
  },
  {
    key: "platform.payment.merchantId",
    section: "billing",
    label: "商户号 / 应用 ID",
    description: "支付服务商分配的商户标识。",
    type: "string",
    defaultValue: "",
  },
  {
    key: "platform.payment.notifyUrl",
    section: "billing",
    label: "支付回调地址",
    description: "支付服务商异步通知地址，生产环境必须为 HTTPS。",
    type: "string",
    defaultValue: "",
  },
  {
    key: "platform.payment.secretKey",
    section: "billing",
    label: "支付密钥",
    description: "商户私钥或签名密钥，保存后不会回显。",
    type: "secret",
    defaultValue: "",
    secret: true,
  },
  {
    key: "platform.payment.channels",
    section: "billing",
    label: "支付通道配置",
    description: "JSON 格式，配置微信、支付宝、银行卡和公对公打款入口。",
    type: "textarea",
    defaultValue: DEFAULT_PAYMENT_CHANNELS,
  },
  {
    key: "platform.payment.channelSecrets",
    section: "billing",
    label: "支付通道密钥",
    description: "JSON 格式保存各通道签名密钥，保存后不会回显。",
    type: "secret",
    defaultValue: "",
    secret: true,
  },
  {
    key: "platform.payment.offlineReviewRequired",
    section: "billing",
    label: "线下付款人工审核",
    description: "银行卡和公对公打款需要管理员审核后才入账。",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "platform.payment.minTopupYuan",
    section: "billing",
    label: "最低充值金额",
    description: "用户钱包充值金额下限。",
    type: "number",
    defaultValue: 100,
    min: 0,
    suffix: "元",
  },
  {
    key: "platform.payment.amountOptions",
    section: "billing",
    label: "充值金额档位",
    description: "逗号分隔，例如 100,500,1000,5000。",
    type: "string",
    defaultValue: "100,500,1000,5000,10000",
  },
  {
    key: "platform.payment.settlementNote",
    section: "billing",
    label: "付款说明",
    description: "展示给企业客户的转账备注、到账时间、发票和对账说明。",
    type: "textarea",
    defaultValue: "公对公打款请备注工作区名称或订单号，提交付款申请后由平台财务审核入账。",
  },
  {
    key: "platform.checkin.enabled",
    section: "billing",
    label: "启用签到奖励",
    description: "允许用户每日签到领取随机额度。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.checkin.minCreditYuan",
    section: "billing",
    label: "签到最小奖励",
    description: "单次签到可获得的最小额度。",
    type: "number",
    defaultValue: 0,
    min: 0,
    suffix: "GU",
  },
  {
    key: "platform.checkin.maxCreditYuan",
    section: "billing",
    label: "签到最大奖励",
    description: "单次签到可获得的最大额度。",
    type: "number",
    defaultValue: 0,
    min: 0,
    suffix: "GU",
  },
  {
    key: "platform.checkin.dailyLimit",
    section: "billing",
    label: "每日签到次数",
    description: "每个用户每天最多可领取奖励的次数。",
    type: "number",
    defaultValue: 1,
    min: 1,
    max: 10,
    suffix: "次",
  },
  {
    key: "platform.notification.smtpServer",
    section: "notification",
    label: "SMTP 服务器",
    description: "用于注册验证、找回密码、任务通知。",
    type: "string",
    defaultValue: "",
  },
  {
    key: "platform.notification.smtpPort",
    section: "notification",
    label: "SMTP 端口",
    description: "常见端口为 465、587。",
    type: "number",
    defaultValue: 465,
    min: 1,
    max: 65535,
  },
  {
    key: "platform.notification.smtpAccount",
    section: "notification",
    label: "SMTP 账号",
    description: "发信账号。",
    type: "string",
    defaultValue: "",
  },
  {
    key: "platform.notification.smtpFrom",
    section: "notification",
    label: "发件人",
    description: "例如 Fanjin <notice@example.com>。",
    type: "string",
    defaultValue: "",
  },
  {
    key: "platform.notification.smtpToken",
    section: "notification",
    label: "SMTP 密钥",
    description: "授权码或密码，保存后不会回显。",
    type: "secret",
    defaultValue: "",
    secret: true,
  },
  {
    key: "platform.notification.smtpSSLEnabled",
    section: "notification",
    label: "启用 SSL",
    description: "465 通常开启，587 通常使用 STARTTLS。",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "platform.notification.smtpForceAuthLogin",
    section: "notification",
    label: "强制 AUTH LOGIN",
    description: "部分企业邮箱需要开启。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.worker.workerUrl",
    section: "worker",
    label: "媒体 Worker 地址",
    description: "用于后续视频镜像、下载代理和超分任务隔离。",
    type: "string",
    defaultValue: "",
  },
  {
    key: "platform.worker.workerValidKey",
    section: "worker",
    label: "Worker 校验密钥",
    description: "Worker 与主服务之间的共享密钥，保存后不会回显。",
    type: "secret",
    defaultValue: "",
    secret: true,
  },
  {
    key: "platform.worker.allowHttpImageRequestEnabled",
    section: "worker",
    label: "允许 HTTP 素材 URL",
    description: "生产环境建议关闭，只允许 HTTPS 资源。",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "platform.worker.directGenerationMaxResolution",
    section: "worker",
    label: "直出最高分辨率",
    description: "超过该分辨率时先生成低清版本，再走内部增强链路。",
    type: "select",
    defaultValue: "480p",
    options: [
      { label: "480p", value: "480p" },
      { label: "720p", value: "720p" },
      { label: "1080p", value: "1080p" },
    ],
  },
  {
    key: "platform.worker.videoEnhanceRequiredForHighRes",
    section: "worker",
    label: "高清请求强制增强",
    description: "用户无感，API 请求保持官方格式。",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "platform.worker.videoEnhanceMode",
    section: "worker",
    label: "视频增强模式",
    description: "内部使用，不向普通用户展示。",
    type: "select",
    defaultValue: "generative",
    options: [
      { label: "生成式超分", value: "generative" },
      { label: "标准超分", value: "standard" },
    ],
  },
  {
    key: "platform.operations.logConsumeEnabled",
    section: "gateway",
    label: "记录 API 请求日志",
    description: "关闭后不再写入请求审计日志。",
    type: "boolean",
    defaultValue: true,
  },
  {
    key: "platform.operations.logRetentionDays",
    section: "gateway",
    label: "日志保留天数",
    description: "用于后续自动清理策略，0 表示不自动清理。",
    type: "number",
    defaultValue: 90,
    min: 0,
    suffix: "天",
  },
  {
    key: PLATFORM_MODEL_DEFAULTS_KEY,
    section: "models",
    label: "默认模型配置",
    description: "JSON 对象，键为场景（image / video / text / agentChat），值为模型目录中的模型 id；未配置的场景回退系统内置默认。",
    type: "textarea",
    defaultValue: "{}",
  },
];

const definitionMap = new Map(PLATFORM_SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));

function serializeSettingValue(value: PlatformSettingValue): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value ?? "");
}

function parseBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  const value = String(raw ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  return fallback;
}

function parseStoredValue(definition: PlatformSettingDefinition, raw: unknown): PlatformSettingValue {
  const fallback = definition.defaultValue;
  if (raw === undefined || raw === null || raw === "") return fallback;
  switch (definition.type) {
    case "boolean":
      return parseBoolean(raw, Boolean(fallback));
    case "number": {
      const num = Number(raw);
      if (!Number.isFinite(num)) return fallback;
      const min = definition.min ?? -Infinity;
      const max = definition.max ?? Infinity;
      return Math.min(max, Math.max(min, num));
    }
    default:
      return String(raw);
  }
}

function normalizeIncomingValue(definition: PlatformSettingDefinition, value: unknown): { skip: boolean; value?: PlatformSettingValue } {
  if (definition.secret && (value === undefined || value === null || String(value).trim() === "")) {
    return { skip: true };
  }

  switch (definition.type) {
    case "boolean":
      return { skip: false, value: parseBoolean(value, Boolean(definition.defaultValue)) };
    case "number": {
      const num = Number(value);
      if (!Number.isFinite(num)) throw new Error(`${definition.label} 必须是数字`);
      const min = definition.min ?? -Infinity;
      const max = definition.max ?? Infinity;
      if (num < min || num > max) throw new Error(`${definition.label} 必须在 ${min} 到 ${max} 之间`);
      return { skip: false, value: num };
    }
    case "select": {
      const next = String(value ?? "").trim();
      if (!definition.options?.some((option) => option.value === next)) {
        throw new Error(`${definition.label} 的取值无效`);
      }
      return { skip: false, value: next };
    }
    default:
      return { skip: false, value: String(value ?? "") };
  }
}

export function sanitizeSettingDefinition(definition: PlatformSettingDefinition): PlatformSettingDefinition {
  return { ...definition };
}

export async function readPlatformSettings(
  database: Knex | Knex.Transaction = db,
): Promise<{ settings: Record<string, PlatformSettingValue>; items: PlatformSettingItem[] }> {
  const keys = PLATFORM_SETTING_DEFINITIONS.map((definition) => definition.key);
  const rows = await database("o_setting").whereIn("key", keys).select("key", "value");
  const rowMap = new Map(rows.map((row: any) => [String(row.key), row.value]));
  const settings: Record<string, PlatformSettingValue> = {};
  const items = PLATFORM_SETTING_DEFINITIONS.map((definition) => {
    const storedValue = rowMap.get(definition.key);
    const configured = storedValue !== undefined && storedValue !== null && String(storedValue) !== "";
    const value = definition.secret
      ? ""
      : definition.key === "platform.payment.gatewayEnabled" && !ONLINE_PAYMENT_GATEWAY_AVAILABLE
        ? false
        : parseStoredValue(definition, storedValue);
    settings[definition.key] = value;
    return {
      ...sanitizeSettingDefinition(definition),
      value,
      configured: definition.secret ? configured : undefined,
    };
  });
  return { settings, items };
}

async function assertRedisRateLimitWindowUpdate(
  trx: Knex.Transaction,
  entries: Array<{ key: string; value: PlatformSettingValue }>,
): Promise<void> {
  const submittedRateLimitSetting = entries.some((entry) => (
    entry.key === MODEL_RATE_LIMIT_ENABLED_KEY || entry.key === MODEL_RATE_LIMIT_DURATION_KEY
  ));
  if (!submittedRateLimitSetting) return;

  const configuration = inspectDistributedRateLimitConfiguration();
  // Preserve existing setting behavior until Redis-backed rate limiting is an
  // explicit deployment concern.
  if (!configuration.redisEnabled) return;

  const client = String((trx as any)?.client?.config?.client || "").toLowerCase();
  if (client.includes("pg") || client.includes("postgres")) {
    // Serialize multi-node admin updates even if one of the setting rows has
    // not been materialized yet; row locks alone cannot lock a missing row.
    await trx.raw("SELECT pg_advisory_xact_lock(?::bigint)", [0x464a524c]);
  }
  const rows = await trx("o_setting")
    .whereIn("key", [...DISTRIBUTED_RATE_LIMIT_SETTING_KEYS])
    .select("key", "value");
  const currentValues = new Map(rows.map((row: any) => [String(row.key), row.value]));
  const finalValues = new Map(currentValues);
  for (const entry of entries) {
    if ((DISTRIBUTED_RATE_LIMIT_SETTING_KEYS as readonly string[]).includes(entry.key)) {
      finalValues.set(entry.key, entry.value);
    }
  }
  const inspection = inspectDistributedRateLimitWindowSettings({
    configuration,
    modelEnabled: finalValues.get(MODEL_RATE_LIMIT_ENABLED_KEY),
    modelDurationMinutes: finalValues.get(MODEL_RATE_LIMIT_DURATION_KEY),
  });
  if (!inspection.valid) {
    throw new PlatformSettingValidationError(
      `模型限流窗口未列入 FANJIN_REDIS_RATE_LIMIT_WINDOWS_MS，设置未保存`,
      "redis_rate_limit_window_not_declared",
    );
  }

  const durationWasSubmitted = entries.some((entry) => entry.key === MODEL_RATE_LIMIT_DURATION_KEY);
  const currentDurationMinutes = Number(currentValues.get(MODEL_RATE_LIMIT_DURATION_KEY) ?? 1);
  const finalDurationMinutes = Number(finalValues.get(MODEL_RATE_LIMIT_DURATION_KEY) ?? 1);
  if (
    durationWasSubmitted
    && Number.isSafeInteger(currentDurationMinutes)
    && currentDurationMinutes > 0
    && finalDurationMinutes !== currentDurationMinutes
  ) {
    const cutover = await readRedisRateLimitCutoverState(trx);
    if (cutover.state !== "active") {
      throw new PlatformSettingValidationError(
        "Redis 限流切换尚未激活，为避免 PostgreSQL 窗口中途重置并保持 0.0.3 滚动兼容，暂不允许修改模型限流窗口",
        "redis_rate_limit_duration_change_requires_active_cutover",
      );
    }
  }
}

export async function updatePlatformSettings(
  input: Record<string, unknown>,
  transaction?: Knex.Transaction,
): Promise<Record<string, PlatformSettingValue>> {
  const entries: Array<{ key: string; value: PlatformSettingValue; secret: boolean }> = [];
  for (const [key, rawValue] of Object.entries(input || {})) {
    const definition = definitionMap.get(key);
    if (!definition) throw new Error(`未知设置项：${key}`);
    const normalized = normalizeIncomingValue(definition, rawValue);
    if (
      key === "platform.payment.gatewayEnabled"
      && normalized.value === true
      && !ONLINE_PAYMENT_GATEWAY_AVAILABLE
    ) {
      throw new Error("线上支付闭环尚未实现，支付网关不能启用；请继续使用线下付款人工核验");
    }
    if (key === PLATFORM_MODEL_DEFAULTS_KEY && !normalized.skip && normalized.value !== undefined) {
      assertValidPlatformModelDefaults(normalized.value);
    }
    if (!normalized.skip && normalized.value !== undefined) {
      entries.push({ key, value: normalized.value, secret: Boolean(definition.secret) });
    }
  }

  const persist = async (trx: Knex.Transaction) => {
    if (entries.length) {
      await assertRedisRateLimitWindowUpdate(trx, entries);
      for (const entry of entries) {
        const rawValue = serializeSettingValue(entry.value);
        const value = entry.secret ? sealSecret(rawValue, `platform-setting:${entry.key}`) : rawValue;
        const existing = await trx("o_setting").where({ key: entry.key }).first();
        if (existing) {
          await trx("o_setting").where({ key: entry.key }).update({ value });
        } else {
          await trx("o_setting").insert({ key: entry.key, value });
        }
      }
    }
    return (await readPlatformSettings(trx)).settings;
  };

  if (transaction) return await persist(transaction);
  return await db.transaction(persist);
}

export async function getPlatformSettingValue(key: string): Promise<PlatformSettingValue | undefined> {
  const definition = definitionMap.get(key);
  if (!definition) return undefined;
  if (definition.secret) return undefined;
  const row = await db("o_setting").where({ key }).select("value").first();
  if (key === "platform.payment.gatewayEnabled" && !ONLINE_PAYMENT_GATEWAY_AVAILABLE) return false;
  return parseStoredValue(definition, row?.value);
}

export async function getPlatformSecretValue(key: string): Promise<string | undefined> {
  const definition = definitionMap.get(key);
  if (!definition?.secret) return undefined;
  const row = await db("o_setting").where({ key }).select("value").first();
  const stored = String(row?.value || "");
  if (!stored) return undefined;
  if (isSealedSecret(stored)) return openSecret(stored, `platform-setting:${key}`);
  if (process.env.NODE_ENV === "prod") throw new Error(`Platform secret ${key} is not encrypted`);
  return stored;
}

export async function migratePlatformSettingSecrets(): Promise<{ migrated: number; alreadySealed: number }> {
  const secretKeys = PLATFORM_SETTING_DEFINITIONS.filter((definition) => definition.secret).map((definition) => definition.key);
  let migrated = 0;
  let alreadySealed = 0;
  await db.transaction(async (trx: Knex.Transaction) => {
    const rows = await trx("o_setting").whereIn("key", secretKeys).select("key", "value");
    for (const row of rows) {
      const stored = String(row.value || "");
      if (!stored) continue;
      if (isSealedSecret(stored)) {
        alreadySealed += 1;
        continue;
      }
      await trx("o_setting").where({ key: row.key }).update({
        value: sealSecret(stored, `platform-setting:${row.key}`),
      });
      migrated += 1;
    }
  });
  return { migrated, alreadySealed };
}

export async function getBooleanPlatformSetting(key: string, fallback = false): Promise<boolean> {
  const definition = definitionMap.get(key);
  if (!definition) return fallback;
  const value = await getPlatformSettingValue(key);
  return parseBoolean(value, fallback);
}

// Video input authorization and output-label policy are platform settings, but
// they are intentionally owned by the dedicated model/policy control plane
// instead of the frozen 89-key generic FJ Admin partition.
export {
  VIDEO_ASSET_POLICY_SETTING_DEFINITIONS,
  updateVideoAssetPolicySettings,
  type VideoAssetPolicySettingDefinition,
} from "@/lib/videoAssetPolicy";

export function isKnownPlatformSetting(key: string): boolean {
  return definitionMap.has(key);
}
