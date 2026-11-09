import { AuthError } from "@/lib/auth";

interface OAuthErrorDefinition {
  message: string;
  status: number;
}

export const OAUTH_PUBLIC_ERRORS = {
  UNSUPPORTED_OAUTH_PROVIDER: { message: "不支持的登录方式", status: 400 },
  OAUTH_PROVIDER_DISABLED: { message: "该登录方式未启用或未配置完成", status: 400 },
  PUBLIC_BASE_URL_MISSING: { message: "站点公网地址未配置", status: 503 },
  OAUTH_REQUEST_INVALID: { message: "第三方登录请求参数无效", status: 400 },
  OAUTH_MODE_INVALID: { message: "第三方登录模式无效", status: 400 },
  OAUTH_BIND_STEP_UP_REQUIRED: { message: "绑定新的第三方登录方式需要先完成安全验证", status: 403 },
  OAUTH_CALLBACK_INVALID: { message: "授权回调参数不完整", status: 400 },
  OAUTH_DENIED: { message: "用户取消了第三方授权", status: 400 },
  OAUTH_STATE_INVALID: { message: "登录状态无效，请重试", status: 400 },
  OAUTH_STATE_EXPIRED: { message: "登录状态已过期，请重试", status: 400 },
  OAUTH_STATE_PROVIDER_MISMATCH: { message: "登录状态不匹配，请重试", status: 400 },
  OAUTH_BROWSER_BINDING_INVALID: { message: "登录浏览器校验失败，请重试", status: 400 },
  OAUTH_TOKEN_EXCHANGE_FAILED: { message: "第三方授权失败，请重试", status: 502 },
  OAUTH_PROFILE_FETCH_FAILED: { message: "无法获取第三方账号信息", status: 502 },
  OAUTH_PROFILE_INVALID: { message: "无法获取第三方账号信息", status: 400 },
  OAUTH_CODE_MISSING: { message: "缺少授权码", status: 400 },
  OAUTH_IDENTITY_CHANGED: { message: "登录身份已变化，请重试", status: 409 },
  OAUTH_PRIMARY_FACTOR_CHANGED: { message: "第三方登录身份已变化，请重试", status: 401 },
  OAUTH_REGISTRATION_CLOSED: { message: "当前暂未开放第三方账号自助注册", status: 403 },
  OAUTH_EXCHANGE_INVALID: { message: "登录交换码无效", status: 400 },
  OAUTH_EXCHANGE_EXPIRED: { message: "登录交换码已过期，请重试", status: 400 },
  MFA_REQUIRED: { message: "请输入 MFA 验证码或恢复码完成登录", status: 401 },
  MFA_CODE_INVALID: { message: "MFA 验证码或恢复码错误", status: 401 },
  MFA_CHALLENGE_INVALID: { message: "MFA challenge 无效或已使用", status: 401 },
  MFA_CHALLENGE_EXPIRED: { message: "MFA challenge 已过期", status: 401 },
  MFA_CHALLENGE_CONTEXT_MISMATCH: { message: "MFA challenge 请求上下文不匹配", status: 401 },
  ACCOUNT_UNAVAILABLE: { message: "账号不可用", status: 403 },
  INVALID_CREDENTIALS: { message: "账号或密码错误", status: 401 },
  AUTH_CREDENTIAL_CHANGED: { message: "账号凭据状态已变化，请重新验证", status: 409 },
  EMAIL_NOT_VERIFIED: { message: "请先完成邮箱验证", status: 403 },
  PASSWORD_EXPIRED: { message: "密码已过期，请通过密码重置流程设置新密码", status: 403 },
  LOGIN_IP_NOT_ALLOWED: { message: "当前 IP 不在账号登录白名单中", status: 403 },
  LOGIN_POLICY_INVALID: { message: "账号登录安全策略配置无效，请联系管理员", status: 503 },
  LOGIN_LOCKED: { message: "登录尝试过多，请稍后重试", status: 429 },
  OAUTH_ACCOUNT_MERGE_OFFLINE_REQUIRED: {
    message: "在线账号合并已停用，请联系管理员进行离线核验处理",
    status: 409,
  },
  OAUTH_IDENTITY_MISSING: { message: "未绑定该登录方式", status: 404 },
  OAUTH_IDENTITY_TAKEN: { message: "该第三方身份已绑定其他账号", status: 409 },
  OAUTH_LAST_LOGIN_METHOD: { message: "请先设置密码或绑定其他登录方式后再解绑", status: 400 },
  STEP_UP_REQUIRED: { message: "敏感操作需要 step-up proof", status: 401 },
  STEP_UP_PROOF_INVALID: { message: "step-up proof 无效或已使用", status: 401 },
  STEP_UP_PROOF_EXPIRED: { message: "step-up proof 已过期", status: 401 },
  STEP_UP_SCOPE_MISMATCH: { message: "step-up proof scope 不匹配", status: 403 },
  STEP_UP_SESSION_MISMATCH: { message: "step-up proof 与当前会话不匹配", status: 403 },
  STEP_UP_SESSION_INVALID: { message: "当前登录会话无效", status: 401 },
  STEP_UP_CREDENTIAL_CHANGED: { message: "账号凭据已变化，请重新验证", status: 401 },
  STEP_UP_PASSWORD_INVALID: { message: "当前密码错误", status: 403 },
  STEP_UP_MFA_REQUIRED: { message: "此账号必须提供 TOTP 验证码或恢复码", status: 401 },
  STEP_UP_MFA_INVALID: { message: "TOTP 验证码或恢复码错误", status: 401 },
  FJADMIN_AUDIT_UNAVAILABLE: { message: "审计写入失败，操作未执行", status: 503 },
  OAUTH_BOOTSTRAP_INVALID: { message: "第三方安全验证无效或已使用", status: 401 },
  OAUTH_BOOTSTRAP_EXPIRED: { message: "第三方安全验证已过期，请重试", status: 401 },
  OAUTH_BOOTSTRAP_CONTEXT_MISMATCH: { message: "第三方安全验证与当前会话不匹配", status: 403 },
  OAUTH_BOOTSTRAP_NOT_AVAILABLE: { message: "当前账号不需要首次密码设置", status: 409 },
  OAUTH_BOOTSTRAP_PASSWORD_INVALID: { message: "密码不符合账号安全策略", status: 400 },
  PASSWORD_REUSED: { message: "新密码不能与当前密码相同", status: 409 },
  OAUTH_ROUTE_FAILED: { message: "第三方登录暂时不可用", status: 503 },
  OAUTH_PROVIDERS_FAILED: { message: "获取第三方登录配置失败", status: 503 },
  OAUTH_AUTHORIZE_FAILED: { message: "第三方登录暂时不可用", status: 503 },
  OAUTH_CALLBACK_FAILED: { message: "第三方登录失败", status: 503 },
  OAUTH_EXCHANGE_FAILED: { message: "登录交换失败", status: 503 },
  OAUTH_BIND_FAILED: { message: "绑定验证失败", status: 503 },
  OAUTH_UNBIND_FAILED: { message: "解绑失败", status: 503 },
  OAUTH_IDENTITIES_FAILED: { message: "获取绑定信息失败", status: 503 },
  OAUTH_BOOTSTRAP_FAILED: { message: "首次密码设置暂时不可用", status: 503 },
} as const satisfies Record<string, OAuthErrorDefinition>;

export type OAuthPublicErrorCode = keyof typeof OAUTH_PUBLIC_ERRORS;

export interface OAuthPublicError {
  code: OAuthPublicErrorCode;
  message: string;
  status: number;
  data: Record<string, unknown>;
}

function buildOAuthPublicError(
  code: OAuthPublicErrorCode,
  data: Record<string, unknown>,
): OAuthPublicError {
  const definition = OAUTH_PUBLIC_ERRORS[code];
  return {
    code,
    message: definition.message,
    status: definition.status,
    data,
  };
}

export function oauthPublicError(
  code: OAuthPublicErrorCode,
): OAuthPublicError {
  return buildOAuthPublicError(code, {});
}

function isOAuthPublicErrorCode(value: string): value is OAuthPublicErrorCode {
  return Object.prototype.hasOwnProperty.call(OAUTH_PUBLIC_ERRORS, value);
}

function candidateCode(error: unknown): OAuthPublicErrorCode | "" {
  const value = error as { code?: unknown; message?: unknown };
  const explicit = String(value?.code || "").trim();
  if (isOAuthPublicErrorCode(explicit)) return explicit;
  const message = String(value?.message || "").trim();
  if (message.startsWith("AUDIT_REQUIRED_WRITE_FAILED:")) {
    return "FJADMIN_AUDIT_UNAVAILABLE";
  }
  return isOAuthPublicErrorCode(message) ? message : "";
}

function safeErrorData(error: unknown, code: string): Record<string, unknown> {
  const source = error instanceof AuthError && error.data
    ? error.data
    : {};
  if (code === "MFA_REQUIRED") {
    const challenge = String(source.challenge || "").trim();
    const expiresAt = Number(source.expiresAt);
    return {
      ...(challenge ? { challenge } : {}),
      ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
    };
  }
  if (code === "LOGIN_LOCKED") {
    const retryAfterSeconds = Number(
      (error as { retryAfterSeconds?: unknown })?.retryAfterSeconds
      ?? source.retryAfterSeconds,
    );
    return Number.isFinite(retryAfterSeconds)
      ? { retryAfterSeconds: Math.max(1, Math.trunc(retryAfterSeconds)) }
      : {};
  }
  return {};
}

export function toOAuthPublicError(
  error: unknown,
  fallback: {
    code: OAuthPublicErrorCode;
  },
): OAuthPublicError {
  const code = candidateCode(error);
  if (!code) return oauthPublicError(fallback.code);
  // The allowlisted code owns the complete public contract. Provider and
  // database errors cannot mutate its message, status, or response fields.
  return buildOAuthPublicError(code, safeErrorData(error, code));
}
