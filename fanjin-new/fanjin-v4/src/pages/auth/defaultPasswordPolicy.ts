export const DEFAULT_PASSWORD_REQUIREMENTS = [
  { id: "length", label: "至少 10 位", test: (value: string) => value.length >= 10 },
  { id: "uppercase", label: "包含大写字母", test: (value: string) => /[A-Z]/.test(value) },
  { id: "lowercase", label: "包含小写字母", test: (value: string) => /[a-z]/.test(value) },
  { id: "number", label: "包含数字", test: (value: string) => /[0-9]/.test(value) },
] as const;

export type ClientPasswordPolicy = {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
};

export const DEFAULT_CLIENT_PASSWORD_POLICY: ClientPasswordPolicy = {
  minLength: 10,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: false,
};

export function passwordPolicyError(
  password: string,
  policy: ClientPasswordPolicy,
): string | null {
  if (password.length < policy.minLength) return `密码至少 ${policy.minLength} 位字符`;
  if (password.length > 128) return "密码不能超过 128 位字符";
  if (policy.requireUppercase && !/[A-Z]/.test(password)) return "密码必须包含大写字母";
  if (policy.requireLowercase && !/[a-z]/.test(password)) return "密码必须包含小写字母";
  if (policy.requireNumber && !/[0-9]/.test(password)) return "密码必须包含数字";
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) return "密码必须包含特殊字符";
  return null;
}

/** Mirrors `DEFAULT_PASSWORD_POLICY` in the API account-security contract. */
export function defaultPasswordPolicyError(password: string): string | null {
  return passwordPolicyError(password, DEFAULT_CLIENT_PASSWORD_POLICY);
}
