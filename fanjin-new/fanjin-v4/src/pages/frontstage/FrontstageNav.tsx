import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Battery,
  Bell,
  Boxes,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  CreditCard,
  FileText,
  FolderOpen,
  History,
  Home,
  LayoutDashboard,
  LogOut,
  Menu,
  RefreshCw,
  Settings,
  ShieldCheck,
  UsersRound,
  UserRound,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import fanjinLogo from "../../assets/fanjin-logo-fj.svg";
import { useAuthStore } from "../../stores/authStore";
import { useSessionStore } from "../../features/quick-create/session/sessionStore";
import {
  buildProjectModeHref,
  readProjectModeRouteContext,
  type ProjectMode,
} from "../../routes/projectModeRoutes";
import { workspaceSwitchDestination } from "../../routes/workspaceSwitchNavigation";
import { useProjectStore } from "../../stores/projectStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useV4Theme } from "../../ui/useV4Theme";
import { useTenantRuntime } from "../../lib/tenant-runtime";
import { V4ThemeToggle } from "../../ui/V4ThemeToggle";
import { FrontstageUpdatesDrawer, type FrontstageUpdateMode, useFrontstageUpdates } from "./FrontstageUpdates";
import { useFrontstageBalance } from "./useFrontstageBalance";
import { useFrontstageNavMotion } from "./useFrontstageNavMotion";
import "./FrontstageNav.css";

export type FrontstageNavKey = "inspiration" | "generate" | "quick" | "novel" | "script" | "projects" | "history" | "assets" | "canvas" | "console";

type FrontstageNavProps = {
  active: FrontstageNavKey;
  guest?: boolean;
  onLogin?: (destination?: string) => void;
  dark?: boolean;
  forceCollapsed?: boolean;
  forceExpanded?: boolean;
  studioNavigation?: boolean;
  modeItemsInHeader?: boolean;
  showBrand?: boolean;
  itemActions?: Partial<Record<FrontstageNavKey, () => void>>;
  itemAriaLabels?: Partial<Record<FrontstageNavKey, string>>;
  itemControls?: Partial<Record<FrontstageNavKey, string>>;
  itemExpanded?: Partial<Record<FrontstageNavKey, boolean>>;
  onCollapsedChange?: (collapsed: boolean) => void;
  onNotice?: (message: string) => void;
  onToggleDark?: () => void;
};

type FrontstageTopActionsProps = {
  dark: boolean;
  onToggleDark: () => void;
  onOpenNotifications: () => void;
  onOpenBalance: () => void;
  unreadCount: number;
  balanceOpen: boolean;
  balancePercent: number;
  balanceLabel: string;
};

type FrontstageNavItem = {
  id: FrontstageNavKey;
  path: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
  mode?: ProjectMode;
  hidden?: boolean;
};

const navItems: FrontstageNavItem[] = [
  { id: "inspiration", path: "/workbench/create", label: "灵感", icon: Home },
  { id: "quick", path: "/workbench/quick-create", label: "快速模式", icon: Clapperboard, mode: "quick", hidden: true },
  { id: "canvas", path: "/workbench/canvas", label: "画布模式", icon: Workflow, mode: "canvas" },
  { id: "history", path: "/workbench/assets?tab=history", label: "生成历史", icon: History },
  { id: "assets", path: "/workbench/assets", label: "资产", icon: FolderOpen },
  { id: "console", path: "/workspace/select", label: "后台", icon: LayoutDashboard },
];

const studioNavItems: FrontstageNavItem[] = [
  navItems.find((item) => item.id === "inspiration")!,
  navItems.find((item) => item.id === "history")!,
  navItems.find((item) => item.id === "assets")!,
];

const FRONTSTAGE_TO_CONSOLE_TRANSITION_KEY = "fanjin:frontstage-to-console-transition";
const FRONTSTAGE_NAV_COLLAPSED_KEY = "fanjin:frontstage-nav-collapsed";

type CollapsePreference = {
  hasValue: boolean;
  value: boolean;
};

let frontstageNavCollapsedMemory: CollapsePreference = { hasValue: false, value: false };

export function frontstageNavItemsForAvailability(input: {
  studioNavigation: boolean;
  modeItemsInHeader: boolean;
}): FrontstageNavItem[] {
  const availableItems = input.studioNavigation
    ? studioNavItems
    : input.modeItemsInHeader
      ? navItems.filter((item) => !item.mode)
      : navItems;
  return availableItems.filter((item) => !item.hidden);
}

function isConsolePath(path: string) {
  return path.startsWith("/workspace") || path.startsWith("/developer") || path.startsWith("/admin") || path.startsWith("/settings");
}

function markFrontstageToConsoleTransition() {
  try {
    sessionStorage.setItem(FRONTSTAGE_TO_CONSOLE_TRANSITION_KEY, "1");
  } catch {
    // Router state below is the primary transition signal; storage is only a refresh-safe fallback.
  }
}

function readFrontstageNavCollapsed(): CollapsePreference {
  try {
    const value = sessionStorage.getItem(FRONTSTAGE_NAV_COLLAPSED_KEY);
    if (value === "1") return { hasValue: true, value: true };
    if (value === "0") return { hasValue: true, value: false };
  } catch {
    // A missing storage value keeps the first-run navigation expanded.
  }
  return frontstageNavCollapsedMemory;
}

export function readFrontstageNavCollapsedValue(): boolean {
  return readFrontstageNavCollapsed().value;
}

function writeFrontstageNavCollapsed(value: boolean) {
  frontstageNavCollapsedMemory = { hasValue: true, value };
  try {
    sessionStorage.setItem(FRONTSTAGE_NAV_COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    // The visual state still updates even if storage is unavailable.
  }
}

function planLabel(plan?: string | null) {
  if (plan === "enterprise") return "企业工作区";
  return "工作区";
}

function formatBalanceGu(micros: number, includeUnit = true) {
  const gu = Math.max(0, Number(micros || 0)) / GU_MICROS_PER_GU;
  const formatted = gu.toLocaleString("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: gu >= 100 ? 0 : 2,
  });
  return includeUnit ? `${formatted} GU` : formatted;
}

function formatBalanceDate(timestamp: number | null) {
  if (!timestamp) return "暂无充值记录";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function FrontstageBalanceGlyph({ percent, large = false }: { percent: number; large?: boolean }) {
  const clampedPercent = Math.max(0, Math.min(100, percent));
  const isLow = clampedPercent < 5;
  return (
    <span
      className={`frontstageBalanceGlyph ${large ? "frontstageBalanceGlyphLarge" : ""} ${isLow ? "frontstageBalanceGlyphLow" : ""}`}
      aria-hidden="true"
    >
      <span
        className="frontstageBalanceGlyphFill"
        style={{ transform: `scaleY(${clampedPercent / 100})` }}
      />
      <Battery size={large ? 28 : 19} strokeWidth={1.8} />
    </span>
  );
}

function FrontstageAccountMenu({
  mode = "account",
  guest = false,
  workspaceName,
  onNavigate,
  onOpenChangelog,
  onLogout,
}: {
  mode?: "account" | "more";
  guest?: boolean;
  workspaceName: string;
  onNavigate: (path: string) => void;
  onOpenChangelog: () => void;
  onLogout: () => void;
}) {
  const tenant = useTenantRuntime();
  return (
    <div className={`frontstageAccountMenu ${mode === "more" ? "frontstageMoreMenu" : ""}`} role="menu" aria-label={mode === "more" ? "更多菜单" : "账号菜单"}>
      {mode === "account" ? (
        <button type="button" role="menuitem" onClick={() => onNavigate("/settings/account")}>
          <UserRound size={17} />
          <span>账号总览</span>
          <ChevronRight size={17} />
        </button>
      ) : null}
      <button type="button" role="menuitem" onClick={() => onNavigate("/workspace/billing?recharge=1")}>
        <CreditCard size={17} />
        <span>充值中心</span>
        <ChevronRight size={17} />
      </button>
      <button type="button" role="menuitem" onClick={() => onNavigate("/models")}>
        <Boxes size={17} />
        <span>模型广场</span>
        <ChevronRight size={17} />
      </button>
      <button type="button" role="menuitem" onClick={() => onNavigate("/docs/legal/terms")}>
        <FileText size={17} />
        <span>用户协议</span>
        <ChevronRight size={17} />
      </button>
      <button type="button" role="menuitem" onClick={() => onNavigate("/docs/legal/privacy")}>
        <ShieldCheck size={17} />
        <span>隐私政策</span>
        <ChevronRight size={17} />
      </button>
      <button type="button" role="menuitem" onClick={onOpenChangelog}>
        <RefreshCw size={17} />
        <span>更新日志</span>
      </button>
      {!guest ? <button type="button" role="menuitem" onClick={onLogout}>
        <LogOut size={17} />
        <span>退出</span>
      </button> : null}
      <div className="frontstageAccountLegal">
        {!guest ? <p>当前工作区：{workspaceName}</p> : null}
        {tenant.icpNumber ? <p>ICP备案：{tenant.icpNumber}</p> : null}
        {tenant.valueAddedTelecomLicense ? (
          <p>增值电信业务经营许可证：{tenant.valueAddedTelecomLicense}</p>
        ) : null}
        {tenant.publicSecurityRegistration ? (
          <p><ShieldCheck size={12} /> 公安网备：{tenant.publicSecurityRegistration}</p>
        ) : null}
        <p>运营主体：{tenant.operatorName}</p>
      </div>
    </div>
  );
}

export function FrontstageTopActions({
  dark,
  onToggleDark,
  onOpenNotifications,
  onOpenBalance,
  unreadCount,
  balanceOpen,
  balancePercent,
  balanceLabel,
}: FrontstageTopActionsProps) {
  return (
    <div className="frontstageTopActions" aria-label="通知、余额与外观">
      <button
        className="frontstageTopIconButton"
        type="button"
        aria-label={unreadCount ? `通知中心，${unreadCount} 条未读` : "通知中心，无未读通知"}
        aria-haspopup="dialog"
        onClick={onOpenNotifications}
      >
        <Bell size={18} />
        {unreadCount ? <span className="frontstageNotificationBadge" aria-hidden="true">{unreadCount > 9 ? "9+" : unreadCount}</span> : null}
      </button>

      <button
        className="frontstageBalanceButton"
        type="button"
        aria-label={balanceLabel}
        aria-haspopup="dialog"
        aria-expanded={balanceOpen}
        aria-controls="frontstage-balance-popover"
        data-tooltip="余额"
        onClick={onOpenBalance}
      >
        <FrontstageBalanceGlyph percent={balancePercent} />
      </button>

      <V4ThemeToggle
        className="frontstageThemeButton"
        mode={dark ? "dark" : "light"}
        onToggle={onToggleDark}
      />
    </div>
  );
}

export default function FrontstageNav({
  active,
  guest = false,
  onLogin,
  dark,
  forceCollapsed = false,
  forceExpanded = false,
  studioNavigation = false,
  modeItemsInHeader = false,
  showBrand = true,
  itemActions,
  itemAriaLabels,
  itemControls,
  itemExpanded,
  onCollapsedChange,
  onToggleDark,
  onNotice,
}: FrontstageNavProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useV4Theme();
  const user = useAuthStore((state) => state.user);
  const currentWorkspace = useAuthStore((state) => state.currentWorkspace);
  const workspaces = useAuthStore((state) => state.workspaces);
  const logout = useAuthStore((state) => state.logout);
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);
  const workspaceLoading = useWorkspaceStore((state) => state.loading);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const currentProject = useProjectStore((state) => state.currentProject);
  const projects = useProjectStore((state) => state.projects);
  const creationSession = useSessionStore((state) => state.session);
  const boundSessionProjectId = useSessionStore((state) => state.boundProjectId);
  const initialCollapsePreferenceRef = useRef<CollapsePreference | null>(null);
  if (!initialCollapsePreferenceRef.current) {
    initialCollapsePreferenceRef.current = readFrontstageNavCollapsed();
  }
  const creationMode = active === "canvas" || active === "generate" || active === "quick";
  const [collapsed, setCollapsed] = useState(creationMode || initialCollapsePreferenceRef.current.value);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [balanceOpen, setBalanceOpen] = useState(false);
  const [updateMode, setUpdateMode] = useState<FrontstageUpdateMode | null>(null);
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.("(max-width: 760px)").matches));
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileDialogRef = useRef<HTMLDialogElement>(null);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);
  const mobileNavigation = mobile && !studioNavigation;
  const navCollapsed = mobileNavigation || forceExpanded ? false : forceCollapsed || collapsed;

  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 760px)");
    if (!query) return;
    const sync = () => { setMobile(query.matches); setMobileOpen(false); };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => { setMobileOpen(false); }, [location.pathname, location.search]);

  useEffect(() => {
    const dialog = mobileDialogRef.current;
    if (!mobileNavigation || !dialog) return;
    if (!mobileOpen) { if (dialog.open) dialog.close(); return; }
    dialog.showModal();
    mobileCloseRef.current?.focus({ preventScroll: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [mobileNavigation, mobileOpen]);

  function trapMobileNavigationFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]',
    )).filter((element) => element.getClientRects().length > 0);
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }

  function closeMobileNavigation() {
    // Close the native top layer before opening login or another drawer.
    if (mobileDialogRef.current?.open) {
      mobileDialogRef.current.close();
      mobileTriggerRef.current?.focus({ preventScroll: true });
    }
    setMobileOpen(false);
  }

  function requestLogin(destination?: string) {
    closeMobileNavigation();
    onLogin?.(destination);
  }
  const visibleNavItems = frontstageNavItemsForAvailability({
    studioNavigation,
    modeItemsInHeader,
  }).filter((item) => !guest || item.id !== "console");
  const identityRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const userName = user?.name || user?.email || "繁境创作者";
  const userInitial = userName.slice(0, 1).toUpperCase();
  const workspaceName = guest ? "登录 / 注册" : currentWorkspace?.name || "Fanjin V4 Test";
  const workspacePlan = planLabel(currentWorkspace?.plan);
  const workspaceItems = workspaces.length ? workspaces : currentWorkspace ? [currentWorkspace] : [];
  const resolvedDark = dark ?? theme.mode === "dark";
  const handleToggleDark = onToggleDark ?? theme.toggle;
  const updates = useFrontstageUpdates(guest ? "guest" : String(user?.id || user?.email || "guest"), !guest, currentWorkspaceId ?? currentWorkspace?.id);
  const balance = useFrontstageBalance(guest ? null : currentWorkspaceId ?? currentWorkspace?.id ?? null, !guest);
  const balanceLabel = balance.loading
    ? "余额正在读取"
    : balance.error
      ? "余额暂不可用"
      : `余额 ${formatBalanceGu(balance.availableMicros)}，剩余 ${balance.percent}%`;

  useLayoutEffect(() => {
    onCollapsedChange?.(navCollapsed);
  }, [navCollapsed, onCollapsedChange]);
  const navRef = useFrontstageNavMotion(navCollapsed);

  function resolveNavPath(item: (typeof navItems)[number]) {
    if (!item.mode) return item.path;
    if (item.mode === "canvas") return "/workbench/canvas";
    const routeContext = readProjectModeRouteContext(location);
    const candidateProjectId = routeContext.projectId ?? currentProjectId;
    const projectId = candidateProjectId !== null
      && candidateProjectId !== undefined
      && (
        String(currentProject?.id) === String(candidateProjectId)
        || projects.some((project) => String(project.id) === String(candidateProjectId))
      )
      ? candidateProjectId
      : null;
    const sessionMatchesProject = projectId !== null
      && projectId !== undefined
      && String(boundSessionProjectId) === String(projectId);
    const routeMatchesProject = projectId !== null
      && routeContext.projectId !== null
      && routeContext.projectId !== undefined
      && String(routeContext.projectId) === String(projectId);
    const boundSessionId = sessionMatchesProject ? creationSession?.id : null;
    const boundCanvasId = sessionMatchesProject ? creationSession?.canvasId : null;
    return buildProjectModeHref(item.mode, {
      projectId,
      sessionId: routeMatchesProject ? routeContext.sessionId ?? boundSessionId : boundSessionId,
      threadId: routeMatchesProject ? routeContext.threadId : null,
      canvasId: routeMatchesProject ? routeContext.canvasId ?? boundCanvasId : boundCanvasId,
    }, location.search);
  }

  useEffect(() => {
    const storedPreference = readFrontstageNavCollapsed();
    // Make room on entry without overwriting other pages' stored preference.
    // A manual expansion remains in effect until the next mode change.
    setCollapsed(creationMode || storedPreference.value);
  }, [active, creationMode]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!identityRef.current?.contains(event.target as Node)) setIdentityOpen(false);
      if (!moreRef.current?.contains(event.target as Node)) {
        setMoreOpen(false);
        setBalanceOpen(false);
      }
    }
    if (identityOpen || moreOpen || balanceOpen) document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [balanceOpen, identityOpen, moreOpen]);

  function handleNavigate(path: string) {
    closeMobileNavigation();
    setIdentityOpen(false);
    setMoreOpen(false);
    setBalanceOpen(false);
    if (guest && path === "/workspace/billing?recharge=1") {
      requestLogin(path);
      return;
    }
    if (isConsolePath(path)) {
      markFrontstageToConsoleTransition();
      navigate(path, { state: { fromFrontstage: true } });
      return;
    }
    navigate(path);
  }

  function openUpdates(mode: FrontstageUpdateMode) {
    closeMobileNavigation();
    setIdentityOpen(false);
    setMoreOpen(false);
    setBalanceOpen(false);
    if (mode === "changelog") updates.markLatestReleaseRead();
    setUpdateMode(mode);
  }

  function handleLogout() {
    closeMobileNavigation();
    logout();
    setIdentityOpen(false);
    setMoreOpen(false);
    setBalanceOpen(false);
    navigate("/workbench/create", { replace: true });
  }

  async function handleSelectWorkspace(id: string | number) {
    if (String(id) === String(currentWorkspace?.id)) {
      setIdentityOpen(false);
      return;
    }
    try {
      await selectWorkspace(id);
      const destination = workspaceSwitchDestination(
        location.pathname,
        location.search,
      );
      if (destination) navigate(destination, { replace: true });
      setIdentityOpen(false);
      onNotice?.("工作区已切换");
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : "工作区切换失败");
    }
  }

  const sidebar = (
      <aside
        ref={navRef}
        className={`frontstageSideNav ${navCollapsed ? "collapsed" : ""}`}
        data-studio-navigation={studioNavigation ? "true" : undefined}
      >
      {mobileNavigation ? (
        <button ref={mobileCloseRef} className="frontstageMobileClose" type="button" aria-label="关闭导航" onClick={closeMobileNavigation} autoFocus>
          <X size={20} />
        </button>
      ) : null}
      {!mobileNavigation && !forceCollapsed && !forceExpanded && !studioNavigation ? (
        <button
          className="frontstageCollapseButton"
          type="button"
          aria-label={navCollapsed ? "展开侧边栏" : "收起侧边栏"}
          onClick={() => {
            setCollapsed((value) => {
              const next = !value;
              writeFrontstageNavCollapsed(next);
              return next;
            });
          }}
        >
          <ChevronLeft size={17} />
        </button>
      ) : null}

      {showBrand ? (
        <div className="frontstageBrandMark" title="FANJIN繁境">
          <span className="frontstageBrandLogo">
            <img src={fanjinLogo} alt="" />
          </span>
          <span className="frontstageBrandText">
            <strong>繁境</strong>
            <small>FANJIN</small>
          </span>
        </div>
      ) : null}

      <nav className="frontstageNavList" aria-label={studioNavigation ? "工作态工具栏" : "用户前台导航"}>
        {visibleNavItems.map((item) => {
          const Icon = item.icon;
          const controlLabel = itemAriaLabels?.[item.id] || item.label;
          const controls = itemControls?.[item.id];
          const expanded = itemExpanded?.[item.id];
          const current = active === item.id;
          return (
            <button
              key={item.id}
              className={current ? "active" : ""}
              type="button"
              aria-label={controlLabel}
              aria-current={current ? "page" : undefined}
              aria-controls={controls}
              aria-expanded={typeof expanded === "boolean" ? expanded : undefined}
              data-tooltip={controlLabel}
              onClick={() => {
                closeMobileNavigation();
                setIdentityOpen(false);
                setMoreOpen(false);
                setBalanceOpen(false);
                if (guest && item.id !== "inspiration") {
                  requestLogin(item.path);
                  return;
                }
                const itemAction = itemActions?.[item.id];
                if (itemAction) {
                  itemAction();
                  return;
                }
                if (item.id === "console") {
                  markFrontstageToConsoleTransition();
                  navigate(item.path, { state: { fromFrontstage: true } });
                  return;
                }
                navigate(resolveNavPath(item), item.mode ? { state: { fromFrontstage: true } } : undefined);
              }}
            >
              <span className="frontstageNavIcon">
                <Icon size={20} />
              </span>
              <span className="frontstageNavLabel">{item.label}</span>
              {item.badge ? <span className="frontstageNavBadge">{item.badge}</span> : null}
            </button>
          );
        })}
      </nav>

      <div className="frontstageIdentitySwitcher" ref={identityRef}>
        <button
          className="frontstageIdentityButton"
          type="button"
          aria-label={guest ? "登录 / 注册" : "个人资料与工作区"}
          aria-expanded={guest ? undefined : identityOpen}
          data-tooltip={workspaceName}
          onClick={(event) => {
            event.stopPropagation();
            setMoreOpen(false);
            setBalanceOpen(false);
            if (guest) requestLogin();
            else {
              if (!identityOpen) balance.refresh();
              setIdentityOpen((value) => !value);
            }
          }}
        >
          <span className="frontstageIdentityAvatar">
            {guest ? <UserRound size={20} /> : user?.avatar ? <img src={user.avatar} alt="" /> : <span>{userInitial}</span>}
          </span>
          <span className="frontstageWorkspaceText">
            <strong>{workspaceName}</strong>
            <small>{guest ? "登录后管理工作区" : workspacePlan}</small>
          </span>
          <ChevronDown className="frontstageWorkspaceChevron" size={14} />
        </button>

        {!guest && identityOpen ? (
          <div className="frontstageIdentityMenu" role="menu" aria-label="个人资料与工作区">
            <button className="frontstageIdentityProfile" type="button" role="menuitem" onClick={() => handleNavigate("/settings/account")}>
              <span className="frontstageIdentityAvatar frontstageIdentityAvatarLarge">
                {user?.avatar ? <img src={user.avatar} alt="" /> : <span>{userInitial}</span>}
              </span>
              <span>
                <strong>{userName}</strong>
                <small>账号总览</small>
              </span>
              <ChevronRight size={17} />
            </button>

            <div className="frontstageIdentityBalance" aria-label="工作区可用余额">
              <div aria-live="polite">
                <span>工作区可用余额</span>
                {balance.loading || balance.error ? (
                  <span className="frontstageIdentityBalanceStatus">{balance.loading ? "读取中…" : "暂时无法读取"}</span>
                ) : (
                  <strong>{formatBalanceGu(balance.availableMicros, false)}<small> GU</small></strong>
                )}
              </div>
              <button type="button" role="menuitem" onClick={() => handleNavigate("/workspace/billing?recharge=1")}>
                充值<ChevronRight size={14} aria-hidden="true" />
              </button>
            </div>

            <div className="frontstageWorkspaceActions" aria-label="工作区快捷操作">
              <button type="button" onClick={() => handleNavigate("/workspace/members")}>
                <UsersRound size={16} />
                <span>成员与权限</span>
              </button>
              <button type="button" onClick={() => handleNavigate("/workspace/billing")}>
                <CreditCard size={16} />
                <span>账单与用量</span>
              </button>
              <button type="button" onClick={() => handleNavigate("/settings/profile/basic")}>
                <Settings size={16} />
                <span>账号设置</span>
              </button>
            </div>

            <div className="frontstageWorkspaceMenuHeader">
              <span>切换工作区</span>
              <button type="button" onClick={() => handleNavigate("/workspace/select")}>管理</button>
            </div>
            <div className="frontstageWorkspaceList">
              {workspaceItems.map((workspace) => {
                const selected = String(workspace.id) === String(currentWorkspace?.id);
                const name = workspace.name || String(workspace.id);
                return (
                  <button
                    key={workspace.id}
                    className={selected ? "selected" : ""}
                    type="button"
                    role="menuitem"
                    disabled={workspaceLoading}
                    onClick={() => {
                      void handleSelectWorkspace(workspace.id);
                    }}
                  >
                    <span>{name.slice(0, 1).toUpperCase()}</span>
                    <strong>{name}</strong>
                    <small>{planLabel(workspace.plan)}</small>
                    {selected ? <Check size={15} /> : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      <div className="frontstagePersistentDock" ref={moreRef} aria-label="通知、外观与更多">
        <FrontstageTopActions
          dark={resolvedDark}
          onToggleDark={handleToggleDark}
          onOpenNotifications={() => guest ? requestLogin() : openUpdates("notifications")}
          onOpenBalance={() => {
            if (guest) { requestLogin(); return; }
            setMoreOpen(false);
            setIdentityOpen(false);
            setBalanceOpen((current) => {
              if (!current) balance.refresh();
              return !current;
            });
          }}
          unreadCount={guest ? 0 : updates.unreadCount}
          balanceOpen={balanceOpen}
          balancePercent={balance.percent}
          balanceLabel={guest ? "登录后查看余额" : balanceLabel}
        />
        <button
          className="frontstageUtilityButton frontstageMoreButton"
          type="button"
          aria-label="更多"
          aria-expanded={moreOpen}
          data-tooltip="更多"
          onClick={(event) => {
            event.stopPropagation();
            setBalanceOpen(false);
            setIdentityOpen(false);
            setMoreOpen((value) => !value);
          }}
        >
          <Menu size={18} />
        </button>

        {balanceOpen ? (
          <div
            id="frontstage-balance-popover"
            className="frontstageBalancePopover"
            role="dialog"
            aria-label="工作区余额"
          >
            <div className="frontstageBalancePopoverHeader">
              <FrontstageBalanceGlyph percent={balance.percent} large />
              <span>
                <strong>工作区余额</strong>
                <small>{balance.loading ? "正在更新" : balance.error ? "暂时无法读取" : `本轮剩余 ${balance.percent}%`}</small>
              </span>
            </div>

            {balance.error ? (
              <div className="frontstageBalanceError" role="status">
                <span>余额暂时无法读取，请重新尝试。</span>
                <button type="button" onClick={balance.refresh}>重新读取</button>
              </div>
            ) : (
              <>
                <div className="frontstageBalanceAmount">
                  <span>当前可用</span>
                  <strong>{balance.loading ? "读取中" : formatBalanceGu(balance.availableMicros)}</strong>
                </div>
                <div
                  className="frontstageBalanceProgress"
                  role="progressbar"
                  aria-label="本轮余额剩余比例"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={balance.percent}
                >
                  <span style={{ transform: `scaleX(${balance.percent / 100})` }} />
                </div>
                <dl className="frontstageBalanceDetails">
                  <div>
                    <dt>本轮起始</dt>
                    <dd>{balance.loading ? "-" : formatBalanceGu(balance.baselineMicros)}</dd>
                  </div>
                  <div>
                    <dt>本轮已用</dt>
                    <dd>{balance.loading ? "-" : formatBalanceGu(balance.spentMicros)}</dd>
                  </div>
                  <div>
                    <dt>冻结中</dt>
                    <dd>{balance.loading ? "-" : formatBalanceGu(balance.reservedMicros)}</dd>
                  </div>
                  <div>
                    <dt>最近充值</dt>
                    <dd>{balance.loading ? "-" : formatBalanceDate(balance.lastRechargeAt)}</dd>
                  </div>
                </dl>
              </>
            )}

            <div className="frontstageBalanceActions">
              <button type="button" onClick={() => handleNavigate("/workspace/billing?recharge=1")}>
                立即充值
              </button>
              <button type="button" onClick={() => handleNavigate("/workspace/billing")}>
                查看明细
              </button>
            </div>
          </div>
        ) : null}

        {moreOpen ? (
          <FrontstageAccountMenu
            mode="more"
            guest={guest}
            workspaceName={workspaceName}
            onNavigate={handleNavigate}
            onOpenChangelog={() => openUpdates("changelog")}
            onLogout={handleLogout}
          />
        ) : null}
      </div>
      </aside>
  );

  return (
    <>
      {mobileNavigation ? (
        <>
          <header className="frontstageMobileHeader">
            <button ref={mobileTriggerRef} className="frontstageMobileMenu" type="button" aria-label="打开导航" aria-haspopup="dialog" aria-expanded={mobileOpen} aria-controls="frontstage-mobile-navigation" onClick={() => setMobileOpen(true)}>
              <Menu size={21} />
            </button>
            <span className="frontstageMobileBrand"><img src={fanjinLogo} alt="" /><strong>繁境</strong></span>
            {guest ? <button className="frontstageMobileLogin" type="button" onClick={() => requestLogin()}>登录</button> : <span className="frontstageMobilePage">{navItems.find((item) => item.id === active)?.label}</span>}
          </header>
          <dialog
            ref={mobileDialogRef}
            id="frontstage-mobile-navigation"
            className="frontstageMobileDialog"
            aria-label="繁境导航"
            onKeyDown={trapMobileNavigationFocus}
            onCancel={(event) => { event.preventDefault(); closeMobileNavigation(); }}
            onClose={() => setMobileOpen(false)}
            onClick={(event) => { if (event.target === event.currentTarget) closeMobileNavigation(); }}
          >
            {sidebar}
          </dialog>
        </>
      ) : sidebar}

      {updateMode ? (
        <FrontstageUpdatesDrawer
          mode={updateMode}
          dark={resolvedDark}
          notifications={updates.notifications}
          releases={updates.releases}
          readIds={updates.readIds}
          onClose={() => setUpdateMode(null)}
          onMarkRead={updates.markRead}
          onMarkAllRead={updates.markAllRead}
          onOpenChangelog={() => openUpdates("changelog")}
        />
      ) : null}
    </>
  );
}
