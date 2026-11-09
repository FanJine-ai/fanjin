import { getBooleanPlatformSetting, getPlatformSettingValue } from "@/lib/platformSettings";

export type RegistrationMode = "self_service" | "invite" | "closed";

function normalizeRegistrationMode(value: unknown, fallback: RegistrationMode): RegistrationMode {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "self_service" || raw === "invite" || raw === "closed") return raw;
  return fallback;
}

export function getRegistrationModeFromEnv(): RegistrationMode {
  const raw = String(process.env.FANJIN_REGISTRATION_MODE || "").trim().toLowerCase();
  if (raw === "self_service" || raw === "invite" || raw === "closed") return raw;
  return process.env.NODE_ENV === "prod" ? "closed" : "self_service";
}

export async function getRegistrationMode(): Promise<RegistrationMode> {
  const fallback = getRegistrationModeFromEnv();
  const configured = await getPlatformSettingValue("platform.auth.registrationMode");
  return normalizeRegistrationMode(configured, fallback);
}

export async function getRegistrationPolicy() {
  const mode = await getRegistrationMode();
  const passwordLoginEnabled = await getBooleanPlatformSetting("platform.auth.passwordLoginEnabled", true);
  const passwordRegisterEnabled = await getBooleanPlatformSetting("platform.auth.passwordRegisterEnabled", true);
  return {
    mode,
    passwordLoginEnabled,
    passwordRegisterEnabled,
    allowSelfService: mode === "self_service" && passwordRegisterEnabled,
    requiresInvitation: mode === "invite",
    message:
      mode === "self_service" && passwordRegisterEnabled
        ? "当前支持自助创建企业账号。"
        : mode === "invite"
          ? "当前仅支持企业邀请注册，请使用管理员发出的邀请入口。"
          : mode === "self_service"
            ? "当前暂未开放账号密码注册，请联系平台管理员开通企业工作区。"
          : "当前暂未开放自助注册，请联系平台管理员开通企业工作区。",
  };
}
