import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BadgeCheck,
  Building2,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Copy,
  Edit3,
  FileCheck2,
  Fingerprint,
  IdCard,
  KeyRound,
  Mail,
  MonitorCheck,
  Phone,
  RefreshCcw,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Timer,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import QRCode from "qrcode";
import { apiGet, apiPost } from "../../api/http";
import {
  apiDeleteWithStepUp,
  apiPostWithStepUp,
} from "../../api/stepUp";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConsolePage,
  DescriptionList,
  Dialog,
  FormField,
  Input,
  MetricStrip,
  ResponsiveSplit,
  Select,
  Section,
  Switch,
  type BadgeTone,
} from "../../ui/console";
import "./SettingsConsole.css";
import { passwordPolicyError } from "../auth/defaultPasswordPolicy";

type SectionId = "basic" | "authentication" | "security";
type VerificationStatus = "not_started" | "pending" | "approved" | "rejected";
type VerificationType = "personal" | "enterprise";
type MfaStage = "closed" | "setup" | "recovery" | "disable";

interface MfaSetupResponse {
  secret: string;
  otpauthUrl?: string | null;
  otpauthUri?: string | null;
  expiresAt: number;
}

interface MfaVerifyResponse {
  enabled: true;
  recoveryCodes: string[];
  configuredAt?: number;
}

interface VerificationInfo {
  type: VerificationType;
  status: VerificationStatus;
  subjectName?: string | null;
  companyName?: string | null;
  unifiedSocialCreditCode?: string | null;
  legalRepresentative?: string | null;
  contactPhone?: string | null;
  idNumberMasked?: string | null;
  submittedAt?: number | null;
  approvedAt?: number | null;
}

interface AccountSecurity {
  phone: string;
  email?: string | null;
  phoneBound: boolean;
  emailBound: boolean;
  mfaEnabled: boolean;
  loginProtectionEnabled: boolean;
  sensitiveOperationProtectionEnabled: boolean;
  loginIpAllowlist: string;
  passwordPolicy: {
    minLength: number;
    requireUppercase: boolean;
    requireLowercase: boolean;
    requireNumber: boolean;
    requireSymbol: boolean;
    rejectHistoryCount: number;
    maxRetriesPerHour: number;
  };
  sessionPolicy: { idleMinutes: number; absoluteHours: number };
}

interface AccountProfile {
  user: {
    id?: number | string;
    name?: string;
    email?: string | null;
    displayName?: string;
    role?: string;
    status?: string;
    createdAt?: number | null;
    lastLoginAt?: number | null;
  } | null;
  verification: { personal: VerificationInfo; enterprise: VerificationInfo };
  security: AccountSecurity;
}

type AccountProfileResponse = Partial<AccountProfile> | { data?: Partial<AccountProfile> | null } | null | undefined;

const defaultSecurity = (): AccountSecurity => ({
  phone: "",
  email: null,
  phoneBound: false,
  emailBound: false,
  mfaEnabled: false,
  loginProtectionEnabled: false,
  sensitiveOperationProtectionEnabled: false,
  loginIpAllowlist: "",
  passwordPolicy: {
    minLength: 10,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSymbol: false,
    rejectHistoryCount: 3,
    maxRetriesPerHour: 5,
  },
  sessionPolicy: { idleMinutes: 2880, absoluteHours: 48 },
});

const emptyVerif = (type: VerificationType): VerificationInfo => ({ type, status: "not_started" });

const defaultProfile = (): AccountProfile => ({
  user: null,
  verification: { personal: emptyVerif("personal"), enterprise: emptyVerif("enterprise") },
  security: defaultSecurity(),
});

function normalizeVerificationInfo(type: VerificationType, info?: Partial<VerificationInfo> | null): VerificationInfo {
  return { ...emptyVerif(type), ...(info || {}), type, status: info?.status || "not_started" };
}

function normalizeSecurity(security?: Partial<AccountSecurity> | null): AccountSecurity {
  const defaults = defaultSecurity();
  return {
    ...defaults,
    ...(security || {}),
    passwordPolicy: { ...defaults.passwordPolicy, ...(security?.passwordPolicy || {}) },
    sessionPolicy: { ...defaults.sessionPolicy, ...(security?.sessionPolicy || {}) },
  };
}

function unwrapProfileResponse(response: AccountProfileResponse): Partial<AccountProfile> {
  if (!response || typeof response !== "object") return {};
  if ("data" in response && response.data && typeof response.data === "object") return response.data;
  return response as Partial<AccountProfile>;
}

const sections: { id: SectionId; label: string; path: string }[] = [
  { id: "basic", label: "基本信息", path: "/settings/profile/basic" },
  { id: "authentication", label: "实名认证", path: "/settings/profile/authentication" },
  { id: "security", label: "安全设置", path: "/settings/profile/security" },
];

const sectionMeta: Record<SectionId, { Icon: LucideIcon; desc: string }> = {
  basic: { Icon: UserRound, desc: "账号、联系方式和登录方式" },
  authentication: { Icon: BadgeCheck, desc: "个人与企业主体认证" },
  security: { Icon: ShieldCheck, desc: "登录保护、验证和会话策略" },
};

const roleMap: Record<string, string> = {
  root: "平台管理员",
  admin: "管理员",
  owner: "所有者",
  developer: "开发者",
  creator: "创作者",
  member: "成员",
};

function verifLabel(status?: VerificationStatus) {
  return ({ not_started: "未认证", pending: "审核中", approved: "已认证", rejected: "未通过" } as Record<string, string>)[status || "not_started"];
}

function statusTone(status?: VerificationStatus | string): BadgeTone {
  if (status === "approved" || status === "active" || status === "enabled") return "success";
  if (status === "pending") return "warning";
  if (status === "rejected" || status === "disabled") return "danger";
  return "neutral";
}

function fmtDate(value?: number | string | null) {
  const timestamp = Number(value || 0);
  if (!timestamp) return "-";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function IconBadge({ icon: Icon, plain = false }: { icon: LucideIcon; plain?: boolean }) {
  return (
    <span className={`settingsConsoleIconBadge${plain ? " settingsConsoleIconBadge--plain" : ""}`} aria-hidden="true">
      <Icon size={18} strokeWidth={1.8} />
    </span>
  );
}

function InlineMeta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="settingsConsoleFieldCluster">
      <span className="settingsConsoleFieldClusterLabel">{label}</span>
      <strong className="settingsConsoleFieldClusterValue">
        {value || "-"}
      </strong>
    </div>
  );
}

function ToggleRow({
  icon,
  title,
  description,
  checked,
  onChange,
  testId,
  disabled = false,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <div className="settingsConsoleRow settingsConsoleToggleRow">
      <div className="settingsConsoleRowMain">
        <IconBadge icon={icon} />
        <div className="settingsConsoleRowCopy">
          <strong className="settingsConsoleRowTitle settingsConsoleRowTitle--large">{title}</strong>
          <p className="settingsConsoleHelperText">{description}</p>
        </div>
      </div>
      <Switch
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        label={checked ? "已启用" : "未启用"}
        onCheckedChange={onChange}
      />
    </div>
  );
}

export default function ProfilePage() {
  const location = useLocation();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<AccountProfile>(defaultProfile);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [verifDialogOpen, setVerifDialogOpen] = useState(false);
  const [activeVerifType, setActiveVerifType] = useState<VerificationType>("personal");
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingSecurity, setSavingSecurity] = useState(false);
  const [savingVerification, setSavingVerification] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [mfaStage, setMfaStage] = useState<MfaStage>("closed");
  const [mfaSetup, setMfaSetup] = useState<MfaSetupResponse | null>(null);
  const [mfaQrDataUrl, setMfaQrDataUrl] = useState("");
  const [mfaQrError, setMfaQrError] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaPassword, setMfaPassword] = useState("");
  const [mfaRecoveryCodes, setMfaRecoveryCodes] = useState<string[]>([]);
  const [mfaRecoverySaved, setMfaRecoverySaved] = useState(false);
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaNotice, setMfaNotice] = useState<string | null>(null);
  const profileCancelRef = useRef<HTMLButtonElement>(null);
  const verificationCancelRef = useRef<HTMLButtonElement>(null);
  const profileNameRef = useRef<HTMLInputElement>(null);
  const profileEmailRef = useRef<HTMLInputElement>(null);
  const personalNameRef = useRef<HTMLInputElement>(null);
  const personalIdRef = useRef<HTMLInputElement>(null);
  const personalPhoneRef = useRef<HTMLInputElement>(null);
  const enterpriseCompanyRef = useRef<HTMLInputElement>(null);
  const enterpriseCreditCodeRef = useRef<HTMLInputElement>(null);
  const enterpriseLegalRef = useRef<HTMLInputElement>(null);
  const enterprisePhoneRef = useRef<HTMLInputElement>(null);
  const passwordCurrentRef = useRef<HTMLInputElement>(null);
  const passwordNewRef = useRef<HTMLInputElement>(null);
  const passwordConfirmRef = useRef<HTMLInputElement>(null);
  const profileMutationRef = useRef(false);
  const securitySubmittingRef = useRef(false);
  const verificationSubmittingRef = useRef(false);
  const mfaSubmittingRef = useRef(false);
  const mfaCodeRef = useRef<HTMLInputElement>(null);
  const mfaQrFrameRef = useRef<HTMLDivElement>(null);
  const mfaPasswordRef = useRef<HTMLInputElement>(null);

  const [profileForm, setProfileForm] = useState({ displayName: "", email: "" });
  const [passwordForm, setPasswordForm] = useState({ currentPassword: "", password: "", confirmPassword: "" });
  const [personalForm, setPersonalForm] = useState({ realName: "", idNumber: "", contactPhone: "" });
  const [enterpriseForm, setEnterpriseForm] = useState({
    companyName: "",
    unifiedSocialCreditCode: "",
    legalRepresentative: "",
    contactPhone: "",
    businessLicenseUploaded: false,
  });
  const [securityForm, setSecurityForm] = useState<AccountSecurity>(defaultSecurity());
  const [oauthIdentities, setOauthIdentities] = useState<Array<{
    provider: string;
    label: string;
    displayName?: string | null;
    createdAt?: number;
  }>>([]);
  const [oauthPasswordBound, setOauthPasswordBound] = useState(true);
  const [oauthBootstrapProvider, setOauthBootstrapProvider] = useState("");
  const [oauthBootstrapProof, setOauthBootstrapProof] = useState("");
  const [oauthBootstrapPassword, setOauthBootstrapPassword] = useState({
    password: "",
    confirmPassword: "",
  });
  const [oauthBusy, setOauthBusy] = useState(false);

  const activeSection = useMemo<SectionId>(() => {
    if (location.pathname.includes("/authentication")) return "authentication";
    if (location.pathname.includes("/security")) return "security";
    return "basic";
  }, [location.pathname]);

  const activeSectionMeta = sectionMeta[activeSection];
  const displayName = useMemo(() => profile.user?.displayName || profile.user?.name || "未命名账号", [profile]);
  const accountInitial = useMemo(() => displayName.slice(0, 1).toUpperCase(), [displayName]);
  const roleLabel = useMemo(() => roleMap[String(profile.user?.role || "member")] || String(profile.user?.role || "成员"), [profile]);
  const topVerifStatus = useMemo<VerificationStatus>(() => {
    if (profile.verification.enterprise.status === "approved") return "approved";
    if (profile.verification.personal.status === "approved") return "approved";
    if (profile.verification.enterprise.status === "pending" || profile.verification.personal.status === "pending") return "pending";
    return profile.verification.enterprise.status === "rejected" || profile.verification.personal.status === "rejected" ? "rejected" : "not_started";
  }, [profile]);
  const profileDialogDirty = profileDialogOpen && (
    profileForm.displayName !== displayName
    || profileForm.email !== (profile.user?.email || "")
  );
  const verificationDialogDirty = verifDialogOpen && (activeVerifType === "personal"
    ? personalForm.realName !== (profile.verification.personal.subjectName || "")
      || Boolean(personalForm.idNumber)
      || personalForm.contactPhone !== (profile.verification.personal.contactPhone || profile.security.phone || "")
    : enterpriseForm.companyName !== (profile.verification.enterprise.companyName || "")
      || Boolean(enterpriseForm.unifiedSocialCreditCode)
      || Boolean(enterpriseForm.legalRepresentative)
      || enterpriseForm.contactPhone !== (profile.verification.enterprise.contactPhone || profile.security.phone || "")
      || enterpriseForm.businessLicenseUploaded);

  function applyProfile(response: AccountProfileResponse) {
    const data = unwrapProfileResponse(response);
    const security = normalizeSecurity(data.security);
    setProfile((prev) => ({
      ...prev,
      ...data,
      user: data.user ?? prev.user,
      verification: {
        personal: normalizeVerificationInfo("personal", data.verification?.personal),
        enterprise: normalizeVerificationInfo("enterprise", data.verification?.enterprise),
      },
      security,
    }));
    setSecurityForm(security);
  }

  const fetchOauthIdentities = useCallback(async () => {
    try {
      const data = await apiGet<{
        identities?: Array<{
          provider: string;
          label: string;
          displayName?: string | null;
          createdAt?: number;
        }>;
        passwordBound?: boolean;
      }>(
        "/account/oauth/identities",
      );
      const identities = Array.isArray(data?.identities) ? data.identities : [];
      setOauthIdentities(identities);
      setOauthPasswordBound(data?.passwordBound !== false);
      setOauthBootstrapProvider((current) => (
        identities.some((item) => item.provider === current)
          ? current
          : identities[0]?.provider || ""
      ));
    } catch {
      setOauthIdentities([]);
      setOauthPasswordBound(true);
    }
  }, []);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const response = await apiPost<AccountProfileResponse>("/account/profile", {});
      applyProfile(response);
      await fetchOauthIdentities();
    } catch (error: any) {
      setFeedback({ tone: "error", text: error?.message || "账号资料读取失败" });
    } finally {
      setLoading(false);
    }
  }, [fetchOauthIdentities]);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const proof = String(params.get("oauthBootstrap") || "").trim();
    const provider = String(params.get("provider") || "").trim();
    setOauthBootstrapProof(proof);
    if (provider) setOauthBootstrapProvider(provider);
  }, [location.search]);

  async function handleStartPasswordBootstrap() {
    if (oauthBusy) return;
    if (!oauthBootstrapProvider) {
      setFeedback({ tone: "error", text: "当前账号没有可重新验证的第三方登录方式" });
      return;
    }
    setOauthBusy(true);
    setFeedback(null);
    try {
      const result = await apiPost<{ authorizeUrl?: string }>(
        "/auth/oauth/bootstrap/start",
        { provider: oauthBootstrapProvider },
      );
      const authorizeUrl = String(result?.authorizeUrl || "").trim();
      if (!authorizeUrl) throw new Error("无法发起第三方安全验证");
      window.location.assign(authorizeUrl);
    } catch (error: any) {
      setFeedback({ tone: "error", text: error?.message || "无法发起第三方安全验证" });
      setOauthBusy(false);
    }
  }

  async function handleCompletePasswordBootstrap() {
    if (oauthBusy) return;
    if (!oauthBootstrapProof) {
      setFeedback({ tone: "error", text: "请先重新验证当前第三方账号" });
      return;
    }
    const bootstrapPolicyError = passwordPolicyError(
      oauthBootstrapPassword.password,
      profile.security.passwordPolicy,
    );
    if (bootstrapPolicyError) {
      setFeedback({ tone: "error", text: bootstrapPolicyError });
      return;
    }
    if (
      oauthBootstrapPassword.password
      !== oauthBootstrapPassword.confirmPassword
    ) {
      setFeedback({ tone: "error", text: "两次输入的密码不一致" });
      return;
    }
    setOauthBusy(true);
    setFeedback(null);
    try {
      await apiPost("/auth/oauth/bootstrap/complete", {
        proof: oauthBootstrapProof,
        password: oauthBootstrapPassword.password,
      });
      setOauthBootstrapPassword({
        password: "",
        confirmPassword: "",
      });
      setOauthBootstrapProof("");
      await fetchProfile();
      navigate(location.pathname, { replace: true });
      setFeedback({ tone: "success", text: "登录密码已设置，可用于后续安全验证和账号恢复" });
    } catch (error: any) {
      setFeedback({ tone: "error", text: error?.message || "首次密码设置失败" });
    } finally {
      setOauthBusy(false);
    }
  }

  async function handleUnbindProvider(provider: string) {
    if (oauthBusy) return;
    setOauthBusy(true);
    setFeedback(null);
    try {
      await apiDeleteWithStepUp(
        `/auth/oauth/${provider}`,
        "account.oauth.unbind",
        "解绑第三方登录方式",
      );
      setFeedback({ tone: "success", text: "已解绑" });
      await fetchOauthIdentities();
    } catch (error: any) {
      setFeedback({ tone: "error", text: error?.message || "解绑失败" });
    } finally {
      setOauthBusy(false);
    }
  }

  useEffect(() => {
    if (mfaStage !== "setup" || !mfaSetup) return;

    const focusFrame = window.requestAnimationFrame(() => {
      mfaCodeRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [mfaSetup, mfaStage]);

  useEffect(() => {
    const otpauthUri = mfaSetup?.otpauthUrl || mfaSetup?.otpauthUri || "";
    let cancelled = false;

    setMfaQrDataUrl("");
    setMfaQrError(null);
    if (mfaStage !== "setup" || !otpauthUri) {
      if (mfaStage === "setup" && mfaSetup) {
        setMfaQrError("未收到验证器配置链接，请重新生成二维码");
      }
      return () => {
        cancelled = true;
      };
    }

    const qrFrameStyle = mfaQrFrameRef.current
      ? window.getComputedStyle(mfaQrFrameRef.current)
      : null;
    const qrColor = (token: string, fallback: string) => (
      qrFrameStyle?.getPropertyValue(token).trim() || fallback
    );

    void QRCode.toDataURL(otpauthUri, {
      width: 224,
      margin: 2,
      errorCorrectionLevel: "M",
      color: {
        dark: qrColor("--cui-text", "CanvasText"),
        light: qrColor("--cui-surface", "Canvas"),
      },
    }).then((dataUrl) => {
      if (!cancelled) setMfaQrDataUrl(dataUrl);
    }).catch(() => {
      if (!cancelled) setMfaQrError("二维码生成失败，请重新生成或使用手动配置");
    });

    return () => {
      cancelled = true;
    };
  }, [mfaSetup, mfaStage]);

  function syncSecurityForm() {
    setSecurityForm(normalizeSecurity(profile.security));
  }

  function openProfileDialog() {
    setProfileForm({ displayName, email: profile.user?.email || "" });
    setProfileDialogOpen(true);
  }

  function openVerifDialog(type: VerificationType) {
    setActiveVerifType(type);
    if (type === "personal") {
      setPersonalForm({
        realName: profile.verification.personal.subjectName || "",
        idNumber: "",
        contactPhone: profile.verification.personal.contactPhone || profile.security.phone || "",
      });
    } else {
      setEnterpriseForm({
        companyName: profile.verification.enterprise.companyName || "",
        unifiedSocialCreditCode: "",
        legalRepresentative: "",
        contactPhone: profile.verification.enterprise.contactPhone || profile.security.phone || "",
        businessLicenseUploaded: false,
      });
    }
    setVerifDialogOpen(true);
  }

  function clearMfaSensitiveValues() {
    setMfaSetup(null);
    setMfaQrDataUrl("");
    setMfaQrError(null);
    setMfaCode("");
    setMfaPassword("");
    setMfaRecoveryCodes([]);
    setMfaRecoverySaved(false);
    setMfaError(null);
    setMfaNotice(null);
  }

  function closeMfaDialog() {
    clearMfaSensitiveValues();
    mfaSubmittingRef.current = false;
    setMfaBusy(false);
    setMfaStage("closed");
  }

  async function startMfaSetup() {
    if (mfaSubmittingRef.current || mfaBusy) return;
    mfaSubmittingRef.current = true;
    clearMfaSensitiveValues();
    setMfaStage("setup");
    setMfaBusy(true);
    try {
      const setup = await apiPostWithStepUp<MfaSetupResponse>(
        "/account/security/mfa/setup",
        {},
        "account.security.update",
        "启用 MFA 前需要重新验证当前账号",
      );
      setMfaSetup(setup);
      window.requestAnimationFrame(() => mfaCodeRef.current?.focus({ preventScroll: true }));
    } catch (error: any) {
      setMfaError(error?.message || "MFA 配置创建失败，请重试");
    } finally {
      mfaSubmittingRef.current = false;
      setMfaBusy(false);
    }
  }

  function openMfaDisable() {
    clearMfaSensitiveValues();
    setMfaStage("disable");
    window.requestAnimationFrame(() => mfaPasswordRef.current?.focus({ preventScroll: true }));
  }

  function handleMfaToggle(nextEnabled: boolean) {
    if (nextEnabled) {
      void startMfaSetup();
      return;
    }
    openMfaDisable();
  }

  async function verifyMfaSetup() {
    if (mfaSubmittingRef.current || mfaBusy) return;
    const code = mfaCode.trim();
    setMfaError(null);
    setMfaNotice(null);
    if (!/^\d{6}$/.test(code)) {
      setMfaError("请输入验证器当前显示的 6 位动态验证码");
      mfaCodeRef.current?.focus();
      return;
    }

    mfaSubmittingRef.current = true;
    setMfaBusy(true);
    try {
      const enabled = await apiPost<MfaVerifyResponse>("/account/security/mfa/verify", { code });
      setMfaSetup(null);
      setMfaCode("");
      setMfaPassword("");
      setMfaRecoveryCodes(Array.isArray(enabled.recoveryCodes) ? enabled.recoveryCodes : []);
      setMfaRecoverySaved(false);
      setMfaStage("recovery");
      setMfaNotice("MFA 已启用。恢复码关闭后不会再次显示，请立即安全保存。");
      await fetchProfile();
    } catch (error: any) {
      setMfaError(error?.message || "动态验证码校验失败，请重试");
      window.requestAnimationFrame(() => mfaCodeRef.current?.focus({ preventScroll: true }));
    } finally {
      mfaSubmittingRef.current = false;
      setMfaBusy(false);
    }
  }

  async function disableMfa() {
    if (mfaSubmittingRef.current || mfaBusy) return;
    const password = mfaPassword;
    const code = mfaCode.trim();
    setMfaError(null);
    setMfaNotice(null);
    if (!password) {
      setMfaError("请输入当前登录密码");
      mfaPasswordRef.current?.focus();
      return;
    }
    if (!code) {
      setMfaError("请输入 6 位动态验证码或一枚未使用的恢复码");
      mfaCodeRef.current?.focus();
      return;
    }

    mfaSubmittingRef.current = true;
    setMfaBusy(true);
    try {
      await apiPost("/account/security/mfa/disable", { password, code });
      closeMfaDialog();
      await fetchProfile();
      setFeedback({ tone: "success", text: "MFA 已禁用" });
    } catch (error: any) {
      setMfaError(error?.message || "MFA 禁用失败，请检查密码和验证码");
      window.requestAnimationFrame(() => mfaPasswordRef.current?.focus({ preventScroll: true }));
    } finally {
      mfaSubmittingRef.current = false;
      setMfaBusy(false);
    }
  }

  async function copyMfaRecoveryCodes() {
    if (!mfaRecoveryCodes.length) return;
    setMfaError(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(mfaRecoveryCodes.join("\n"));
      setMfaNotice("恢复码已复制。请保存到可信的密码管理器或离线安全位置。");
    } catch {
      setMfaError("浏览器未允许复制，请手动选择并保存恢复码");
    }
  }

  async function saveProfile() {
    if (profileMutationRef.current) return;
    const displayName = profileForm.displayName.trim();
    const email = profileForm.email.trim();
    if (displayName.length < 2 || displayName.length > 64) {
      setFeedback({ tone: "error", text: "显示名称需为 2–64 个字符" });
      profileNameRef.current?.focus();
      return;
    }
    if (email && !/^\S+@\S+\.\S+$/.test(email)) {
      setFeedback({ tone: "error", text: "请输入有效的安全邮箱" });
      profileEmailRef.current?.focus();
      return;
    }
    profileMutationRef.current = true;
    setSavingProfile(true);
    setFeedback(null);
    try {
      const normalizedEmail = email || null;
      const emailChanged = normalizedEmail !== (profile.user?.email || null);
      const payload = emailChanged
        ? { displayName, email: normalizedEmail }
        : { displayName };
      if (emailChanged) {
        await apiPostWithStepUp("/account/profile", payload, "account.profile.sensitive");
      } else {
        await apiPost("/account/profile", payload);
      }
      setProfileDialogOpen(false);
      await fetchProfile();
      setFeedback({ tone: "success", text: "账号资料已更新" });
    } catch (error: any) {
      setFeedback({ tone: "error", text: error?.message || "账号资料保存失败" });
    } finally {
      profileMutationRef.current = false;
      setSavingProfile(false);
    }
  }

  async function saveSecurity() {
    if (securitySubmittingRef.current) return;
    securitySubmittingRef.current = true;
    setSavingSecurity(true);
    setFeedback(null);
    try {
      const payload = {
        phone: securityForm.phone || null,
        loginProtectionEnabled: securityForm.loginProtectionEnabled,
        sensitiveOperationProtectionEnabled: securityForm.sensitiveOperationProtectionEnabled,
        loginIpAllowlist: securityForm.loginIpAllowlist,
        passwordPolicy: securityForm.passwordPolicy,
        sessionPolicy: securityForm.sessionPolicy,
      };
      await apiPostWithStepUp(
        "/account/security",
        payload,
        "account.security.update",
        "修改账号安全策略前需要重新验证当前账号",
      );
      await fetchProfile();
      setFeedback({ tone: "success", text: "安全设置已保存" });
    } catch (error: any) {
      setFeedback({ tone: "error", text: error?.message || "安全设置保存失败" });
    } finally {
      securitySubmittingRef.current = false;
      setSavingSecurity(false);
    }
  }

  async function savePassword() {
    if (profileMutationRef.current) return;
    setFeedback(null);
    if (!passwordForm.currentPassword) {
      setFeedback({ tone: "error", text: "请输入当前密码" });
      passwordCurrentRef.current?.focus();
      return;
    }
    const newPasswordPolicyError = passwordPolicyError(
      passwordForm.password,
      profile.security.passwordPolicy,
    );
    if (newPasswordPolicyError) {
      setFeedback({ tone: "error", text: newPasswordPolicyError });
      passwordNewRef.current?.focus();
      return;
    }
    if (passwordForm.password !== passwordForm.confirmPassword) {
      setFeedback({ tone: "error", text: "两次输入的新密码不一致" });
      passwordConfirmRef.current?.focus();
      return;
    }
    profileMutationRef.current = true;
    setSavingProfile(true);
    try {
      const payload = { currentPassword: passwordForm.currentPassword, password: passwordForm.password };
      await apiPostWithStepUp("/account/profile", payload, "account.profile.sensitive");
      setPasswordForm({ currentPassword: "", password: "", confirmPassword: "" });
      setFeedback({ tone: "success", text: "密码已更新" });
    } catch (error: any) {
      setFeedback({ tone: "error", text: error?.message || "密码更新失败" });
    } finally {
      profileMutationRef.current = false;
      setSavingProfile(false);
    }
  }

  async function submitVerification() {
    if (verificationSubmittingRef.current) return;
    const invalidControl = activeVerifType === "personal"
      ? personalForm.realName.trim().length < 2
        ? personalNameRef.current
        : personalForm.idNumber.trim().length < 6
          ? personalIdRef.current
          : personalForm.contactPhone.trim().length < 5
            ? personalPhoneRef.current
            : null
      : enterpriseForm.companyName.trim().length < 2
        ? enterpriseCompanyRef.current
        : enterpriseForm.unifiedSocialCreditCode.trim().length < 6
          ? enterpriseCreditCodeRef.current
          : enterpriseForm.legalRepresentative.trim().length < 2
            ? enterpriseLegalRef.current
            : enterpriseForm.contactPhone.trim().length < 5
              ? enterprisePhoneRef.current
              : null;
    if (invalidControl) {
      setFeedback({ tone: "error", text: "请完整填写符合要求的实名认证资料" });
      invalidControl.focus();
      return;
    }
    verificationSubmittingRef.current = true;
    setSavingVerification(true);
    setFeedback(null);
    const payload = activeVerifType === "personal"
      ? {
          type: activeVerifType,
          realName: personalForm.realName.trim(),
          idNumber: personalForm.idNumber.trim(),
          contactPhone: personalForm.contactPhone.trim(),
        }
      : {
          type: activeVerifType,
          companyName: enterpriseForm.companyName.trim(),
          unifiedSocialCreditCode: enterpriseForm.unifiedSocialCreditCode.trim(),
          legalRepresentative: enterpriseForm.legalRepresentative.trim(),
          contactPhone: enterpriseForm.contactPhone.trim(),
          businessLicenseUploaded: enterpriseForm.businessLicenseUploaded,
        };
    try {
      await apiPost("/account/verification", payload);
      await fetchProfile();
      setVerifDialogOpen(false);
      setFeedback({ tone: "success", text: "认证资料已提交" });
    } catch (error: any) {
      setFeedback({ tone: "error", text: error?.message || "认证提交失败" });
    } finally {
      verificationSubmittingRef.current = false;
      setSavingVerification(false);
    }
  }

  const feedbackNode = feedback ? (
    <Alert
      data-testid="settings-feedback"
      tone={feedback.tone === "error" ? "danger" : "success"}
      aria-live={feedback.tone === "error" ? "assertive" : "polite"}
    >
      {feedback.text}
    </Alert>
  ) : null;

  const renderBasic = () => {
    const loginMethods = [
      {
        Icon: KeyRound,
        title: "账号密码登录",
        desc: "用于控制台网页登录与敏感操作验证",
        bound: oauthPasswordBound,
        label: oauthPasswordBound ? "已启用" : "未设置",
      },
      { Icon: Smartphone, title: "绑定手机", desc: "可通过手机验证码快速登录", bound: profile.security.phoneBound },
      { Icon: Mail, title: "绑定邮箱", desc: "可通过邮箱验证码登录", bound: profile.security.emailBound },
      { Icon: Fingerprint, title: "MFA 设备", desc: "保护敏感操作", bound: profile.security.mfaEnabled },
    ];
    return (
      <div className="settingsConsoleStack">
        <ResponsiveSplit
          ratio="aside-first"
          primary={
            <Section
              title="主账号信息"
              description="账号身份、联系方式和最近登录状态"
              icon={UserRound}
              action={<Button icon={<Edit3 aria-hidden="true" size={17} />} onClick={openProfileDialog} data-testid="profile-edit-button">编辑资料</Button>}
            >
              <div className="settingsConsoleStack settingsConsoleStack--compact">
                <div className="settingsConsoleProfileHero">
                  <div className="settingsConsoleAvatar">{accountInitial}</div>
                  <div className="settingsConsoleProfileCopy">
                    <strong className="settingsConsoleProfileTitle">
                      {displayName}
                    </strong>
                    <span className="settingsConsoleProfileMeta">ID {profile.user?.id || "-"}</span>
                    <div className="settingsConsoleBadgeRow settingsConsoleBadgeRow--profile">
                      <Badge tone="info">{roleLabel}</Badge>
                      <Badge tone={statusTone(profile.user?.status)}>{profile.user?.status === "disabled" ? "已停用" : "正常"}</Badge>
                    </div>
                  </div>
                </div>

                <DescriptionList
                  items={[
                    { label: "安全手机", value: <>{profile.security.phone || "未绑定"} <Badge tone={profile.security.phoneBound ? "success" : "warning"}>{profile.security.phoneBound ? "已绑定" : "未绑定"}</Badge></> },
                    { label: "安全邮箱", value: <>{profile.user?.email || "未绑定"} <Badge tone={profile.security.emailBound ? "success" : "warning"}>{profile.security.emailBound ? "已绑定" : "未绑定"}</Badge></> },
                    { label: "注册时间", value: fmtDate(profile.user?.createdAt) },
                    { label: "最近登录", value: fmtDate(profile.user?.lastLoginAt) },
                  ]}
                />

              </div>
            </Section>
          }
          secondary={
            <Section title="登录方式" description="绑定状态会影响找回账号和敏感操作验证" icon={ShieldCheck}>
              <div className="settingsConsoleStack settingsConsoleStack--compact">
                {loginMethods.map((method) => (
                  <div key={method.title} className="settingsConsoleRow">
                    <div className="settingsConsoleRowMain settingsConsoleRowMain--compact">
                      <IconBadge icon={method.Icon} plain />
                      <div className="settingsConsoleRowCopy">
                        <strong className="settingsConsoleRowTitle">{method.title}</strong>
                        <p className="settingsConsoleHelperText">{method.desc}</p>
                      </div>
                    </div>
                    <Badge tone={method.bound ? "success" : "warning"}>{method.bound ? (method.label || "已绑定") : "未绑定"}</Badge>
                  </div>
                ))}
              </div>
            </Section>
          }
        />

        <Section
          title="第三方登录绑定"
          description="管理当前账号已验证的第三方登录方式"
          icon={KeyRound}
        >
          <div className="settingsConsoleStack settingsConsoleStack--compact">
            {oauthIdentities.length === 0 ? (
              <p className="settingsConsoleHelperText">当前账号尚未绑定第三方登录。请先从登录页使用对应方式登录一次。</p>
            ) : (
              oauthIdentities.map((item) => (
                <div key={item.provider} className="settingsConsoleRow">
                  <div className="settingsConsoleRowMain settingsConsoleRowMain--compact">
                    <div className="settingsConsoleRowCopy">
                      <strong className="settingsConsoleRowTitle">{item.label || item.provider}</strong>
                      <p className="settingsConsoleHelperText">
                        {item.displayName || "已绑定"}
                        {item.createdAt ? ` · ${fmtDate(item.createdAt)}` : ""}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    disabled={oauthBusy}
                    onClick={() => void handleUnbindProvider(item.provider)}
                  >
                    解绑
                  </Button>
                </div>
              ))
            )}

            {!oauthPasswordBound && oauthIdentities.length > 0 ? (
              <div className="settingsConsoleStack settingsConsoleStack--compact settingsConsoleStack--separated">
                <strong className="settingsConsoleRowTitle">为当前账号设置登录密码</strong>
                <p className="settingsConsoleHelperText">
                  使用当前已绑定的第三方账号重新授权后，可为本账号设置首个密码。
                  该流程不会合并账号，也不会把未验证邮箱设为恢复邮箱。
                </p>
                {oauthBootstrapProof ? (
                  <>
                    <FormField label="新的登录密码" help={`至少 ${profile.security.passwordPolicy.minLength} 位，并满足当前密码策略。`}>
                      <Input
                        type="password"
                        value={oauthBootstrapPassword.password}
                        onChange={(event) => setOauthBootstrapPassword((current) => ({
                          ...current,
                          password: event.target.value,
                        }))}
                        placeholder={`至少 ${profile.security.passwordPolicy.minLength} 位，按账号密码策略设置`}
                        minLength={profile.security.passwordPolicy.minLength}
                        maxLength={128}
                        autoComplete="new-password"
                      />
                    </FormField>
                    <FormField label="确认登录密码">
                      <Input
                        type="password"
                        value={oauthBootstrapPassword.confirmPassword}
                        onChange={(event) => setOauthBootstrapPassword((current) => ({
                          ...current,
                          confirmPassword: event.target.value,
                        }))}
                        placeholder="再次输入新密码"
                        autoComplete="new-password"
                      />
                    </FormField>
                    <Button
                      disabled={oauthBusy}
                      onClick={() => void handleCompletePasswordBootstrap()}
                    >
                      {oauthBusy ? "设置中…" : "设置登录密码"}
                    </Button>
                  </>
                ) : (
                  <>
                    <FormField label="用于重新验证的第三方方式">
                      <Select
                        value={oauthBootstrapProvider}
                        onChange={(event) => setOauthBootstrapProvider(event.target.value)}
                      >
                        {oauthIdentities.map((item) => (
                          <option key={item.provider} value={item.provider}>
                            {item.label || item.provider}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                    <Button
                      disabled={oauthBusy || !oauthBootstrapProvider}
                      onClick={() => void handleStartPasswordBootstrap()}
                    >
                      {oauthBusy ? "正在跳转…" : "重新验证并设置密码"}
                    </Button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </Section>
      </div>
    );
  };

  const renderAuthentication = () => {
    const heroTitle = topVerifStatus === "approved" ? "已完成实名认证" : topVerifStatus === "pending" ? "认证资料审核中" : "尚未完成实名认证";
    const HeroIcon = topVerifStatus === "approved" ? CheckCircle2 : topVerifStatus === "pending" ? Clock3 : CircleAlert;
    const primaryVerificationType = (["personal", "enterprise"] as VerificationType[])
      .find((type) => ["not_started", "rejected"].includes(profile.verification[type].status));

    return (
      <div className="settingsConsoleStack">
        <Section
          title={heroTitle}
          description="认证通过后可用于发票、合同、团队管理和敏感操作校验。"
          icon={HeroIcon}
          action={<Button icon={<RefreshCcw aria-hidden="true" size={17} />} variant="secondary" disabled={loading} onClick={() => void fetchProfile()}>刷新状态</Button>}
        >
          <MetricStrip metrics={[
            { id: "personal", label: "个人认证", value: verifLabel(profile.verification.personal.status), tone: profile.verification.personal.status === "approved" ? "positive" : profile.verification.personal.status === "pending" ? "warning" : profile.verification.personal.status === "rejected" ? "danger" : "neutral" },
            { id: "enterprise", label: "企业认证", value: verifLabel(profile.verification.enterprise.status), tone: profile.verification.enterprise.status === "approved" ? "positive" : profile.verification.enterprise.status === "pending" ? "warning" : profile.verification.enterprise.status === "rejected" ? "danger" : "neutral" },
            { id: "current", label: "当前状态", value: verifLabel(topVerifStatus), tone: topVerifStatus === "approved" ? "positive" : topVerifStatus === "pending" ? "warning" : topVerifStatus === "rejected" ? "danger" : "neutral" },
          ]} />
        </Section>

        <div className="settingsConsoleCardGrid settingsConsoleCardGrid--wide">
          {(["personal", "enterprise"] as VerificationType[]).map((type) => {
            const verification = profile.verification[type];
            const isPersonal = type === "personal";
            const rows: Array<[string, React.ReactNode]> = isPersonal
              ? [
                  ["认证主体", verification.subjectName || "未提交"],
                  ["证件号码", verification.idNumberMasked || "未提交"],
                  ["联系电话", verification.contactPhone || "未提交"],
                  ["提交时间", fmtDate(verification.submittedAt)],
                ]
              : [
                  ["企业名称", verification.companyName || "未提交"],
                  ["统一社会信用代码", verification.unifiedSocialCreditCode || "未提交"],
                  ["法定代表人", verification.legalRepresentative || "未提交"],
                  ["认证时间", fmtDate(verification.approvedAt || verification.submittedAt)],
                ];

            return (
              <Section
                key={type}
                title={isPersonal ? "个人实名认证" : "企业实名认证"}
                description={isPersonal ? "适合个人开发者和创作者" : "适合团队、企业工作区和结算主体"}
                icon={isPersonal ? IdCard : Building2}
                action={<Badge tone={statusTone(verification.status)}>{verifLabel(verification.status)}</Badge>}
              >
                <div className="settingsConsoleStack settingsConsoleStack--compact">
                  <DescriptionList items={rows.map(([label, value]) => ({ label, value }))} />
                  <div className="settingsConsoleActionRow settingsConsoleActionRow--end">
                    <Button
                      variant={type === primaryVerificationType ? "primary" : "secondary"}
                      icon={<FileCheck2 aria-hidden="true" size={17} />}
                      onClick={() => openVerifDialog(type)}
                    >
                      {verification.status === "not_started" ? `提交${isPersonal ? "个人" : "企业"}认证` : `变更${isPersonal ? "个人" : "企业"}认证`}
                    </Button>
                  </div>
                </div>
              </Section>
            );
          })}
        </div>
      </div>
    );
  };

  const renderSecurity = () => (
    <div className="settingsConsoleStack">
      <Section title="修改密码" description="输入当前密码后设置新的账号密码" icon={KeyRound}>
        <form
          id="profile-password-form"
          className="settingsConsoleStack settingsConsoleStack--compact"
          onSubmit={(event) => {
            event.preventDefault();
            void savePassword();
          }}
        >
          <div className="settingsConsoleTwoColumn">
            <FormField label="当前密码" optionalLabel={null}>
              <Input
                ref={passwordCurrentRef}
                data-testid="profile-password-current-input"
                type="password"
                autoComplete="current-password"
                value={passwordForm.currentPassword}
                onChange={(event) => setPasswordForm((form) => ({ ...form, currentPassword: event.target.value }))}
              />
            </FormField>
            <FormField label="新密码" optionalLabel={null} help={`至少 ${profile.security.passwordPolicy.minLength} 位，并满足下方密码策略。`}>
              <Input
                ref={passwordNewRef}
                data-testid="profile-password-new-input"
                type="password"
                autoComplete="new-password"
                minLength={profile.security.passwordPolicy.minLength}
                maxLength={128}
                value={passwordForm.password}
                onChange={(event) => setPasswordForm((form) => ({ ...form, password: event.target.value }))}
              />
            </FormField>
            <FormField label="确认新密码" optionalLabel={null}>
              <Input
                ref={passwordConfirmRef}
                data-testid="profile-password-confirm-input"
                type="password"
                autoComplete="new-password"
                value={passwordForm.confirmPassword}
                onChange={(event) => setPasswordForm((form) => ({ ...form, confirmPassword: event.target.value }))}
              />
            </FormField>
          </div>
          <div className="settingsConsoleActionRow settingsConsoleActionRow--end">
            <Button type="submit" variant="secondary" data-testid="profile-password-save-button" icon={<Save aria-hidden="true" size={17} />} loading={savingProfile}>
              {savingProfile ? "保存中..." : "保存新密码"}
            </Button>
          </div>
        </form>
      </Section>

      <form
        id="profile-security-form"
        className="settingsConsoleStack"
        onSubmit={(event) => {
          event.preventDefault();
          void saveSecurity();
        }}
      >
      <ResponsiveSplit
        primary={
          <Section title="身份验证" description="维护账号安全手机和邮箱绑定" icon={Smartphone}>
            <div className="settingsConsoleStack settingsConsoleStack--compact">
              <div className="settingsConsoleContactRow">
                <IconBadge icon={Phone} />
                <div className="settingsConsoleRowCopy">
                  <label htmlFor="profile-security-phone" className="settingsConsoleControlLabel">安全手机</label>
                  <p className="settingsConsoleHelperText">{profile.security.phone || "绑定后可用于身份验证"}</p>
                </div>
                <Input
                  id="profile-security-phone"
                  data-testid="profile-security-phone-input"
                  placeholder="+86 手机号"
                  inputMode="tel"
                  autoComplete="tel"
                  value={securityForm.phone}
                  onChange={(event) => setSecurityForm((form) => ({ ...form, phone: event.target.value }))}
                />
              </div>
              <div className="settingsConsoleRowMain">
                <IconBadge icon={Mail} />
                <div className="settingsConsoleRowCopy">
                  <strong className="settingsConsoleRowTitle">安全邮箱</strong>
                  <p className="settingsConsoleHelperText">{profile.user?.email || "绑定后可用于邮箱验证和找回账号"}</p>
                </div>
              </div>
            </div>
          </Section>
        }
        secondary={
          <Section title="多因素认证" description="为登录和敏感操作增加二次校验" icon={Fingerprint}>
            <ToggleRow
              icon={ShieldCheck}
              title="MFA 设备"
              description={mfaBusy ? "正在处理 MFA 安全配置…" : securityForm.mfaEnabled ? "已启用动态验证码二次校验。" : "建议绑定验证器应用。"}
              checked={securityForm.mfaEnabled}
              onChange={handleMfaToggle}
              disabled={mfaBusy}
              testId="profile-mfa-toggle"
            />
          </Section>
        }
      />

      <div className="settingsConsoleCardGrid">
        <Section title="密码策略" description="控制账号密码复杂度和失败重试" icon={KeyRound}>
          <div className="settingsConsoleStack settingsConsoleStack--compact">
            <div className="settingsConsoleBadgeRow">
              {securityForm.passwordPolicy.requireUppercase && <Badge>大写字母</Badge>}
              {securityForm.passwordPolicy.requireLowercase && <Badge>小写字母</Badge>}
              {securityForm.passwordPolicy.requireNumber && <Badge>数字</Badge>}
              {securityForm.passwordPolicy.requireSymbol && <Badge>符号</Badge>}
            </div>
            <div className="settingsConsoleTwoColumn">
              <InlineMeta label="最小长度" value={`${securityForm.passwordPolicy.minLength} 位`} />
              <InlineMeta label="每小时重试" value={`${securityForm.passwordPolicy.maxRetriesPerHour} 次`} />
            </div>
          </div>
        </Section>

        <Section title="登录会话" description="设置控制台空闲和绝对有效期" icon={Timer}>
          <div className="settingsConsoleTwoColumn">
            <InlineMeta label="无操作保持" value={`${securityForm.sessionPolicy.idleMinutes} 分钟`} />
            <InlineMeta label="最大保持" value={`${securityForm.sessionPolicy.absoluteHours} 小时`} />
          </div>
        </Section>
      </div>

      <div className="settingsConsoleCardGrid">
        <Section title="登录保护" description="开启后登录需要二次身份验证。" icon={MonitorCheck}>
          <ToggleRow
            icon={MonitorCheck}
            title="登录保护"
            description="对异常登录和高风险会话增加校验。"
            checked={securityForm.loginProtectionEnabled}
            onChange={(checked) => setSecurityForm((form) => ({ ...form, loginProtectionEnabled: checked }))}
          />
        </Section>
        <Section title="敏感操作保护" description="密钥、计费等敏感操作时二次校验。" icon={ShieldAlert}>
          <ToggleRow
            icon={ShieldAlert}
            title="敏感操作保护"
            description="保护密钥、计费和认证等高风险操作。"
            checked={securityForm.sensitiveOperationProtectionEnabled}
            onChange={(checked) => setSecurityForm((form) => ({ ...form, sensitiveOperationProtectionEnabled: checked }))}
          />
        </Section>
      </div>

      <div className="settingsConsoleActionRow settingsConsoleActionRow--end">
        <Button variant="secondary" icon={<RotateCcw aria-hidden="true" size={17} />} onClick={syncSecurityForm}>恢复当前配置</Button>
        <Button type="submit" data-testid="profile-security-save-button" icon={<Save aria-hidden="true" size={17} />} loading={savingSecurity}>
          {savingSecurity ? "保存中..." : "保存安全设置"}
        </Button>
      </div>
      </form>
    </div>
  );

  const renderProfileDialog = () => (
    <Dialog
      open={profileDialogOpen}
      title="更新账号资料"
      size="md"
      loading={savingProfile}
      dirty={profileDialogDirty}
      initialFocusRef={profileNameRef}
      closeGuardTitle="放弃账号资料修改？"
      closeGuardDescription="尚未保存的显示名称和邮箱修改将丢失。"
      onOpenChange={(open) => {
        if (!open && !savingProfile) setProfileDialogOpen(false);
      }}
      footer={({ requestClose, pending }) => (
        <div className="settingsConsoleActionRow settingsConsoleActionRow--end">
          <Button ref={profileCancelRef} variant="secondary" disabled={pending} onClick={() => requestClose("cancel")}>取消</Button>
          <Button type="submit" form="profile-account-details-form" data-testid="profile-save-button" loading={savingProfile}>
            {savingProfile ? "保存中..." : "保存"}
          </Button>
        </div>
      )}
    >
      <form
        id="profile-account-details-form"
        className="settingsConsoleDialogBody"
        onSubmit={(event) => {
          event.preventDefault();
          void saveProfile();
        }}
      >
        {feedbackNode}
        <FormField label="显示名称" optionalLabel={null}>
          <Input
            ref={profileNameRef}
            data-testid="profile-display-name-input"
            value={profileForm.displayName}
            onChange={(event) => setProfileForm((form) => ({ ...form, displayName: event.target.value }))}
            placeholder="请输入显示名称"
            autoComplete="name"
          />
        </FormField>
        <FormField label="安全邮箱" optionalLabel={null}>
          <Input
            ref={profileEmailRef}
            data-testid="profile-email-input"
            type="email"
            value={profileForm.email}
            onChange={(event) => setProfileForm((form) => ({ ...form, email: event.target.value }))}
            placeholder="name@example.com"
            autoComplete="email"
          />
        </FormField>
      </form>
    </Dialog>
  );

  const renderVerifDialog = () => (
    <Dialog
      open={verifDialogOpen}
      title={activeVerifType === "personal" ? "提交个人实名认证" : "提交企业实名认证"}
      size="lg"
      loading={savingVerification}
      dirty={verificationDialogDirty}
      initialFocusRef={activeVerifType === "personal" ? personalNameRef : enterpriseCompanyRef}
      closeGuardTitle="放弃实名认证修改？"
      closeGuardDescription="尚未提交的认证资料将丢失。"
      onOpenChange={(open) => {
        if (!open && !savingVerification) setVerifDialogOpen(false);
      }}
      footer={({ requestClose, pending }) => (
        <div className="settingsConsoleActionRow settingsConsoleActionRow--end">
          <Button ref={verificationCancelRef} variant="secondary" disabled={pending} onClick={() => requestClose("cancel")}>取消</Button>
          <Button type="submit" form="profile-verification-form" loading={savingVerification}>
            {savingVerification ? "提交中..." : "提交审核"}
          </Button>
        </div>
      )}
    >
      <form
        id="profile-verification-form"
        className="settingsConsoleDialogBody"
        onSubmit={(event) => {
          event.preventDefault();
          void submitVerification();
        }}
      >
        {feedbackNode}
        {activeVerifType === "personal" ? (
          <>
          <FormField label="真实姓名" optionalLabel={null}>
            <Input
              ref={personalNameRef}
              value={personalForm.realName}
              onChange={(event) => setPersonalForm((form) => ({ ...form, realName: event.target.value }))}
              autoComplete="name"
            />
          </FormField>
          <FormField label="证件号码" optionalLabel={null}>
            <Input
              ref={personalIdRef}
              value={personalForm.idNumber}
              onChange={(event) => setPersonalForm((form) => ({ ...form, idNumber: event.target.value }))}
              autoComplete="off"
            />
          </FormField>
          <FormField label="联系电话" optionalLabel={null}>
            <Input
              ref={personalPhoneRef}
              value={personalForm.contactPhone}
              onChange={(event) => setPersonalForm((form) => ({ ...form, contactPhone: event.target.value }))}
              inputMode="tel"
              autoComplete="tel"
            />
          </FormField>
          </>
        ) : (
          <>
          <FormField label="企业名称" optionalLabel={null}>
            <Input
              ref={enterpriseCompanyRef}
              value={enterpriseForm.companyName}
              onChange={(event) => setEnterpriseForm((form) => ({ ...form, companyName: event.target.value }))}
              autoComplete="organization"
            />
          </FormField>
          <FormField label="统一社会信用代码" optionalLabel={null}>
            <Input
              ref={enterpriseCreditCodeRef}
              value={enterpriseForm.unifiedSocialCreditCode}
              onChange={(event) => setEnterpriseForm((form) => ({ ...form, unifiedSocialCreditCode: event.target.value }))}
              autoComplete="off"
            />
          </FormField>
          <FormField label="法定代表人" optionalLabel={null}>
            <Input
              ref={enterpriseLegalRef}
              value={enterpriseForm.legalRepresentative}
              onChange={(event) => setEnterpriseForm((form) => ({ ...form, legalRepresentative: event.target.value }))}
              autoComplete="name"
            />
          </FormField>
          <FormField label="联系电话" optionalLabel={null}>
            <Input
              ref={enterprisePhoneRef}
              value={enterpriseForm.contactPhone}
              onChange={(event) => setEnterpriseForm((form) => ({ ...form, contactPhone: event.target.value }))}
              inputMode="tel"
              autoComplete="tel"
            />
          </FormField>
          </>
        )}
      </form>
    </Dialog>
  );

  const mfaDialogTitle = mfaStage === "setup"
    ? "绑定身份验证器"
    : mfaStage === "recovery"
      ? "保存 MFA 恢复码"
      : "禁用多因素认证";
  const mfaDialogDescription = mfaStage === "setup"
    ? "使用身份验证器扫描二维码，再输入应用中显示的动态验证码。"
    : mfaStage === "recovery"
      ? "每枚恢复码只能使用一次；离开此步骤后不会再次显示。"
      : "此操作会删除现有 MFA 配置和所有未使用的恢复码。";
  const mfaDialogDirty = mfaStage === "setup"
    ? Boolean(mfaSetup || mfaCode)
    : mfaStage === "disable"
      ? Boolean(mfaPassword || mfaCode)
      : false;
  const mfaInitialFocusRef = mfaStage === "disable" ? mfaPasswordRef : mfaCodeRef;

  const renderMfaDialog = () => (
    <Dialog
      open={mfaStage !== "closed"}
      title={mfaDialogTitle}
      description={mfaDialogDescription}
      size="lg"
      data-testid="profile-mfa-dialog"
      loading={mfaBusy}
      dirty={mfaDialogDirty}
      initialFocusRef={mfaInitialFocusRef}
      closeGuardTitle={mfaStage === "setup" ? "放弃 MFA 绑定？" : "放弃禁用 MFA？"}
      closeGuardDescription={mfaStage === "setup"
        ? "关闭后，本次验证器配置和已输入的验证码会立即从页面清除。"
        : "关闭后，已输入的密码和验证码会立即从页面清除。"}
      onBeforeClose={mfaStage === "recovery" ? () => {
        if (!mfaRecoverySaved) {
          setMfaError("请先确认已安全保存全部恢复码，再完成此步骤");
          return false;
        }
        return true;
      } : undefined}
      onOpenChange={(open) => {
        if (!open) closeMfaDialog();
      }}
      footer={({ requestClose, pending }) => (
        <div className="settingsConsoleActionRow settingsConsoleActionRow--end">
          {mfaStage === "recovery" ? (
            <>
              <Button
                variant="secondary"
                icon={<Copy aria-hidden="true" size={16} />}
                disabled={pending || !mfaRecoveryCodes.length}
                onClick={() => void copyMfaRecoveryCodes()}
              >
                复制全部
              </Button>
              <Button
                data-testid="mfa-recovery-finish-button"
                disabled={pending || !mfaRecoverySaved || !mfaRecoveryCodes.length}
                onClick={() => requestClose("programmatic")}
              >
                完成
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => requestClose("cancel")}
              >
                取消
              </Button>
              {mfaStage === "setup" && !mfaSetup ? (
                <Button
                  loading={mfaBusy}
                  disabled={pending && !mfaBusy}
                  onClick={() => void startMfaSetup()}
                >
                  {mfaBusy ? "生成中…" : "重新生成配置"}
                </Button>
              ) : (
                <Button
                  type="submit"
                  form="profile-mfa-form"
                  variant={mfaStage === "disable" ? "danger" : "primary"}
                  data-testid={mfaStage === "disable" ? "mfa-disable-submit-button" : "mfa-verify-submit-button"}
                  loading={mfaBusy}
                  disabled={pending && !mfaBusy}
                >
                  {mfaBusy ? "处理中…" : mfaStage === "disable" ? "确认禁用" : "验证并启用"}
                </Button>
              )}
            </>
          )}
        </div>
      )}
    >
      <div className="settingsConsoleDialogBody">
        {mfaError ? <Alert data-testid="mfa-error" tone="danger" aria-live="assertive">{mfaError}</Alert> : null}
        {mfaNotice ? <Alert data-testid="mfa-notice" tone="success" aria-live="polite">{mfaNotice}</Alert> : null}

        {mfaStage === "setup" ? (
          mfaSetup ? (
            <form
              id="profile-mfa-form"
              className="settingsConsoleMfaForm"
              onSubmit={(event) => {
                event.preventDefault();
                void verifyMfaSetup();
              }}
            >
              <div className="settingsConsoleMfaInstruction">
                <strong className="settingsConsoleRowTitle">1. 扫描二维码</strong>
                <p className="settingsConsoleHelperText settingsConsoleHelperText--flush">打开 iCloud 密码、Google Authenticator 或其他验证器，添加账号并扫描下方二维码。</p>
              </div>
              <div className="settingsConsoleMfaQrPanel">
                <div
                  ref={mfaQrFrameRef}
                  className="settingsConsoleMfaQrFrame themeLight"
                  aria-live="polite"
                >
                  {mfaQrDataUrl ? (
                    <img
                      src={mfaQrDataUrl}
                      alt="身份验证器绑定二维码"
                      data-testid="mfa-setup-qr"
                      className="settingsConsoleMfaQrImage"
                      width={224}
                      height={224}
                    />
                  ) : (
                    <div className="settingsConsoleMfaQrLoading" role="status">
                      {mfaQrError || "正在生成二维码…"}
                    </div>
                  )}
                </div>
                <div className="settingsConsoleMfaQrCopy">
                  <strong className="settingsConsoleRowTitle">扫码后不要关闭此窗口</strong>
                  <p className="settingsConsoleHelperText settingsConsoleHelperText--flush">二维码包含一次性绑定密钥，请勿截图或分享。若二维码曾暴露，请立即重新生成。</p>
                  <InlineMeta label="配置有效期" value={fmtDate(mfaSetup.expiresAt)} />
                  <Button
                    type="button"
                    variant="secondary"
                    size="compact"
                    icon={<RefreshCcw aria-hidden="true" size={15} />}
                    disabled={mfaBusy}
                    onClick={() => void startMfaSetup()}
                  >
                    重新生成二维码
                  </Button>
                </div>
              </div>
              {mfaQrError ? <Alert tone="warning">{mfaQrError}</Alert> : null}
              <details className="settingsConsoleMfaManual">
                <summary>无法扫码？使用手动配置</summary>
                <div className="settingsConsoleMfaManualFields">
                  <FormField label="TOTP 密钥" optionalLabel={null}>
                    <Input
                      data-testid="mfa-setup-secret"
                      className="settingsConsoleMonospace settingsConsoleTracking"
                      value={mfaSetup.secret}
                      readOnly
                      autoComplete="off"
                      spellCheck={false}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  </FormField>
                  <FormField label="验证器链接" optionalLabel={null}>
                    <textarea
                      data-testid="mfa-setup-uri"
                      className="settingsConsoleTextarea settingsConsoleMonospace"
                      value={mfaSetup.otpauthUrl || mfaSetup.otpauthUri || ""}
                      readOnly
                      autoComplete="off"
                      spellCheck={false}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  </FormField>
                </div>
              </details>
              <div className="settingsConsoleDivider" />
              <FormField label="2. 输入 6 位动态验证码" optionalLabel={null}>
                <Input
                  ref={mfaCodeRef}
                  data-testid="mfa-setup-code-input"
                  className="settingsConsoleOtpInput"
                  value={mfaCode}
                  onChange={(event) => {
                    setMfaCode(event.target.value.replace(/\D/g, "").slice(0, 6));
                    setMfaError(null);
                  }}
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  placeholder="000000"
                  invalid={Boolean(mfaError)}
                />
              </FormField>
            </form>
          ) : (
            <div className="settingsConsoleLoadingState" role="status">
              {mfaBusy ? "正在创建一次性 MFA 配置…" : "未能创建 MFA 配置，可重试。"}
            </div>
          )
        ) : null}

        {mfaStage === "recovery" ? (
          <>
            <div
              data-testid="mfa-recovery-codes"
              role="region"
              aria-label="一次性 MFA 恢复码"
              className="settingsConsoleRecoveryGrid"
            >
              {mfaRecoveryCodes.map((code) => (
                <code
                  key={code}
                  data-testid="mfa-recovery-code"
                  className="settingsConsoleRecoveryCode"
                >
                  {code}
                </code>
              ))}
            </div>
            <label className="settingsConsoleCheckRow">
              <Checkbox
                className="settingsConsoleNativeCheck"
                data-testid="mfa-recovery-saved-checkbox"
                size="compact"
                checked={mfaRecoverySaved}
                disabled={!mfaRecoveryCodes.length}
                onCheckedChange={(checked) => {
                  setMfaRecoverySaved(checked);
                  setMfaError(null);
                }}
              />
              我已将全部恢复码安全保存，并了解关闭后无法再次查看
            </label>
          </>
        ) : null}

        {mfaStage === "disable" ? (
          <form
            id="profile-mfa-form"
            className="settingsConsoleMfaForm"
            onSubmit={(event) => {
              event.preventDefault();
              void disableMfa();
            }}
          >
            <FormField label="当前登录密码" optionalLabel={null}>
              <Input
                ref={mfaPasswordRef}
                data-testid="mfa-disable-password-input"
                type="password"
                value={mfaPassword}
                onChange={(event) => {
                  setMfaPassword(event.target.value);
                  setMfaError(null);
                }}
                autoComplete="current-password"
                invalid={Boolean(mfaError)}
              />
            </FormField>
            <FormField label="动态验证码或恢复码" optionalLabel={null}>
              <Input
                ref={mfaCodeRef}
                data-testid="mfa-disable-code-input"
                className="settingsConsoleMonospace"
                value={mfaCode}
                onChange={(event) => {
                  setMfaCode(event.target.value.slice(0, 128));
                  setMfaError(null);
                }}
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="6 位验证码或 XXXXX-XXXXX-…"
                invalid={Boolean(mfaError)}
              />
            </FormField>
            <p className="settingsConsoleHelperText settingsConsoleHelperText--flush">禁用后，其他会话将失效，现有恢复码也会全部作废。</p>
          </form>
        ) : null}
      </div>
    </Dialog>
  );

  const title = sections.find((section) => section.id === activeSection)?.label || "账号设置";
  const pageActions = (
    <Button icon={<RefreshCcw aria-hidden="true" size={17} />} variant="secondary" loading={loading} onClick={() => void fetchProfile()}>
      {loading ? "刷新中..." : "刷新资料"}
    </Button>
  );

  return (
    <div data-testid="settings-profile-page">
      <ConsolePage
        className="settingsProfilePage"
        eyebrow="账号设置"
        title={title}
        description={activeSectionMeta.desc}
        primaryAction={pageActions}
      >
        {!profileDialogOpen && !verifDialogOpen ? feedbackNode : null}
        {loading ? (
          <Section title="加载中" icon={Clock3}>
            <p className="settingsConsoleHelperText">正在读取账号资料…</p>
          </Section>
        ) : (
          <>
            {activeSection === "basic" && renderBasic()}
            {activeSection === "authentication" && renderAuthentication()}
            {activeSection === "security" && renderSecurity()}
          </>
        )}
      </ConsolePage>
      {renderProfileDialog()}
      {renderVerifDialog()}
      {renderMfaDialog()}
    </div>
  );
}
