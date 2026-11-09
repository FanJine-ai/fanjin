import "../pages/frontstage/FrontstagePage.css";
import {
  BadgeCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CirclePlay,
  Clapperboard,
  Coins,
  CreditCard,
  Film,
  FolderOpen,
  Image,
  LayoutDashboard,
  Moon,
  Plus,
  Search,
  Sparkles,
  Sun,
  Upload,
  Users,
  Workflow,
  X,
} from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import fanjinLogo from "../assets/fanjin-logo-fj.svg";
import { getConsoleAccess } from "../routes/consoleAccess";
import {
  buildProjectModeHref,
  readProjectModeRouteContext,
  type ProjectMode,
} from "../routes/projectModeRoutes";
import { workspaceSwitchDestination } from "../routes/workspaceSwitchNavigation";
import { useSessionStore } from "../features/quick-create/session/sessionStore";
import { useAuthStore } from "../stores/authStore";
import { useProjectStore } from "../stores/projectStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useV4Theme } from "../ui/useV4Theme";

/* ───────── helpers ───────── */

function workspaceInitial(name: string) {
  return name?.trim()?.[0]?.toUpperCase() ?? "W";
}

/* ───────── nav config ───────── */

type NavItem = {
  path: string;
  label: string;
  icon: typeof FolderOpen;
  badge?: string;
  mode?: ProjectMode;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  {
    label: "创作",
    items: [
      { path: "/workbench/create", label: "灵感", icon: Sparkles },
      { path: "/workbench/quick-create", label: "流程", icon: CirclePlay, mode: "quick" },
      { path: "/workbench/project", label: "项目广场", icon: FolderOpen },
      { path: "/workbench/library", label: "素材库", icon: Image },
      { path: "/workbench/task", label: "任务", icon: Clapperboard },
      { path: "/workbench/production", label: "生产工作台", icon: Workflow },
      { path: "/workbench/editor", label: "剪辑台", icon: Film },
    ],
  },
  {
    label: "工作流",
    items: [
      { path: "/workbench/canvas", label: "画布模式", icon: Workflow, mode: "canvas" },
      { path: "/workbench/corner-scape", label: "角景", icon: CirclePlay },
    ],
  },
  {
    label: "资产",
    items: [
      { path: "/workbench/assets", label: "资产库", icon: BadgeCheck },
    ],
  },
];

type GlobalSearchItem = NavItem & {
  group: string;
  description: string;
  keywords: string[];
};

const globalSearchMetadata: Record<string, { description: string; keywords: string[] }> = {
  "/workbench/create": { description: "从灵感开始创建内容", keywords: ["灵感", "创作", "生成", "工作台"] },
  "/workbench/quick-create": { description: "按阶段完成创作", keywords: ["快速创作", "分镜", "成片"] },
  "/workbench/project": { description: "查看和管理全部项目", keywords: ["项目", "历史项目", "工程"] },
  "/workbench/library": { description: "查找图片、视频、音频和文档素材", keywords: ["素材", "媒体", "图片", "视频", "音频", "文档"] },
  "/workbench/task": { description: "查看生成任务和处理状态", keywords: ["任务", "队列", "生成任务", "进度"] },
  "/workbench/production": { description: "进入项目生产流程", keywords: ["生产", "工作流", "制作"] },
  "/workbench/editor": { description: "剪辑和整理视频内容", keywords: ["剪辑", "视频编辑", "时间线"] },
  "/workbench/canvas": { description: "选择项目后进入节点画布", keywords: ["画布", "节点", "项目"] },
  "/workbench/corner-scape": { description: "进入角景创作工具", keywords: ["角景", "场景"] },
  "/workbench/assets": { description: "管理生成资产和云存储文件", keywords: ["资产", "素材", "云存储", "上传"] },
};

const globalSearchItems: GlobalSearchItem[] = navGroups.flatMap((group) =>
  group.items.map((item) => ({
    ...item,
    group: group.label,
    description: globalSearchMetadata[item.path]?.description ?? `前往${item.label}`,
    keywords: globalSearchMetadata[item.path]?.keywords ?? [],
  })),
);

/* ───────── breadcrumb map ───────── */

const breadcrumbMap: Record<string, string> = {
  create: "灵感",
  "quick-create": "流程",
  director: "灵感",
  project: "项目广场",
  library: "素材库",
  task: "任务",
  production: "生产工作台",
  editor: "剪辑台",
  canvas: "画布模式",
  novel: "小说",
  script: "剧本",
  "corner-scape": "角景",
  assets: "资产库",
};

/* ───────── context buttons map ───────── */

type CtxButton = { label: string; icon: typeof Plus; path?: string; action?: string };

function getContextButtons(pathname: string): CtxButton[] {
  if (pathname.startsWith("/workbench/project"))
    return [{ label: "新建项目", icon: Plus, path: "/workbench/create" }];
  if (pathname.startsWith("/workbench/library"))
    return [{ label: "上传素材", icon: Upload, path: "/workbench/assets?tab=cloud&upload=1" }];
  return [];
}

function isImmersiveWorkbenchPath(pathname: string) {
  return pathname === "/workbench/create"
    || pathname === "/workbench/generate"
    || pathname === "/workbench/quick-create"
    || pathname === "/workbench/project"
    || pathname === "/workbench/novel"
    || pathname === "/workbench/script"
    || pathname === "/workbench/assets"
    || pathname === "/workbench/canvas"
    || pathname.startsWith("/workbench/canvas/");
}

/* ───────── component ───────── */

export default function RootLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const baseTheme = useV4Theme();
  const theme = {
    ...baseTheme,
    bg: baseTheme.mode === "dark" ? "#101b20" : "#f7f6f3",
    bgSurface: baseTheme.mode === "dark" ? "#142027" : "#fffefb",
    border: baseTheme.mode === "dark" ? "#33424a" : "#e6e7e4",
    accentSoft: baseTheme.mode === "dark" ? "#1c3847" : "#e5f1f8",
    accent: baseTheme.mode === "dark" ? "#8ed5f6" : "#2c6d8d",
    textTertiary: baseTheme.mode === "dark" ? "#9baeb8" : "#64747d",
  };
  const isImmersiveWorkbench = isImmersiveWorkbenchPath(location.pathname);

  /* stores */
  const user = useAuthStore((s) => s.user);
  const currentWorkspace = useAuthStore((s) => s.currentWorkspace);
  const workspaces = useAuthStore((s) => s.workspaces);
  const selectWorkspace = useWorkspaceStore((s) => s.selectWorkspace);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const creationSession = useSessionStore((state) => state.session);
  const boundSessionProjectId = useSessionStore((state) => state.boundProjectId);

  /* local state */
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 760);
  const [wsPanelOpen, setWsPanelOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchActiveIndex, setGlobalSearchActiveIndex] = useState(0);
  const wsPanelRef = useRef<HTMLDivElement>(null);
  const globalSearchTriggerRef = useRef<HTMLButtonElement>(null);
  const globalSearchDialogRef = useRef<HTMLDivElement>(null);
  const globalSearchInputRef = useRef<HTMLInputElement>(null);

  /* close ws panel on outside click */
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (wsPanelRef.current && !wsPanelRef.current.contains(e.target as Node)) {
        setWsPanelOpen(false);
      }
    }
    if (wsPanelOpen) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [wsPanelOpen]);

  useEffect(() => {
    if (!isImmersiveWorkbench) return;
    setGlobalSearchOpen(false);
    setGlobalSearchQuery("");
  }, [isImmersiveWorkbench]);

  useEffect(() => {
    if (isImmersiveWorkbench) return;
    function handleGlobalSearchShortcut(event: KeyboardEvent) {
      if (event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setGlobalSearchOpen(true);
        window.requestAnimationFrame(() => globalSearchInputRef.current?.focus());
        return;
      }
      if (event.key === "Escape" && globalSearchOpen) {
        event.preventDefault();
        setGlobalSearchOpen(false);
        setGlobalSearchQuery("");
        window.requestAnimationFrame(() => globalSearchTriggerRef.current?.focus());
      }
    }

    window.addEventListener("keydown", handleGlobalSearchShortcut);
    return () => window.removeEventListener("keydown", handleGlobalSearchShortcut);
  }, [globalSearchOpen, isImmersiveWorkbench]);

  useEffect(() => {
    if (!globalSearchOpen) return;
    const frame = window.requestAnimationFrame(() => {
      globalSearchInputRef.current?.focus();
      globalSearchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [globalSearchOpen]);

  useEffect(() => {
    setGlobalSearchActiveIndex(0);
  }, [globalSearchOpen, globalSearchQuery]);

  const sideWidth = collapsed ? 60 : 220;
  const role = (currentWorkspace?.memberRole ?? currentWorkspace?.role ?? "member") as string;
  const consoleAccess = useMemo(
    () => getConsoleAccess(user?.role, role, currentWorkspace?.permissions),
    [currentWorkspace?.permissions, role, user?.role],
  );
  const otherWorkspaces = workspaces.filter((w) => w.id !== currentWorkspace?.id);

  /* ── sidebar style ── */
  const sideBg = theme.bgSurface;

  /* ── active check ── */
  function isActive(path: string) {
    return location.pathname === path || location.pathname.startsWith(path + "/");
  }

  function resolveNavPath(item: NavItem) {
    if (!item.mode) return item.path;
    const routeContext = readProjectModeRouteContext(location);
    const projectId = routeContext.projectId ?? currentProjectId;
    const sessionMatchesProject = projectId !== null
      && projectId !== undefined
      && String(boundSessionProjectId) === String(projectId);
    return buildProjectModeHref(item.mode, {
      projectId,
      sessionId: routeContext.sessionId ?? (sessionMatchesProject ? creationSession?.id : null),
      threadId: routeContext.threadId,
      canvasId: routeContext.canvasId ?? (sessionMatchesProject ? creationSession?.canvasId : null),
    }, location.search);
  }

  async function handleWorkspaceSwitch(id: string | number) {
    try {
      await selectWorkspace(id);
      const destination = workspaceSwitchDestination(
        location.pathname,
        location.search,
      );
      if (destination) navigate(destination, { replace: true });
    } catch {
      // workspaceStore keeps the actionable API error and the existing
      // workspace remains authoritative; do not mutate the route on failure.
    } finally {
      setWsPanelOpen(false);
    }
  }

  const filteredGlobalSearchItems = useMemo(() => {
    const query = globalSearchQuery.trim().toLowerCase();
    if (!query) return globalSearchItems;
    return globalSearchItems.filter((item) =>
      [item.label, item.group, item.description, ...item.keywords]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [globalSearchQuery]);
  const resolvedGlobalSearchActiveIndex = filteredGlobalSearchItems.length
    ? Math.min(globalSearchActiveIndex, filteredGlobalSearchItems.length - 1)
    : 0;

  useEffect(() => {
    if (!globalSearchOpen || !filteredGlobalSearchItems.length) return;
    document
      .getElementById(`fanjin-global-search-option-${resolvedGlobalSearchActiveIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [filteredGlobalSearchItems.length, globalSearchOpen, resolvedGlobalSearchActiveIndex]);

  function closeGlobalSearch(restoreFocus = true) {
    setGlobalSearchOpen(false);
    setGlobalSearchQuery("");
    if (restoreFocus) {
      window.requestAnimationFrame(() => globalSearchTriggerRef.current?.focus());
    }
  }

  function prepareNavigationFocusTransfer() {
    const selector = 'main, [role="main"], [data-page-focus-target], [data-studio-chrome], [role="region"][aria-label]';
    const previousDestinations = new Set(document.querySelectorAll<HTMLElement>(selector));
    const sourceFocus = document.activeElement;
    let observer: MutationObserver | undefined;
    let timeoutId: number | undefined;
    let frameId: number | undefined;
    let settled = false;
    const stopWaiting = () => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
    };
    const focusDestination = () => {
      if (settled) return;
      const activeElement = document.activeElement;
      if (
        activeElement
        && activeElement !== document.body
        && activeElement !== document.documentElement
        && activeElement !== sourceFocus
        && !previousDestinations.has(activeElement as HTMLElement)
      ) {
        stopWaiting();
        return;
      }
      const destination = Array.from(document.querySelectorAll<HTMLElement>(selector))
        .find((candidate) => !previousDestinations.has(candidate));
      if (!destination) return;
      if (!destination.hasAttribute("tabindex")) destination.setAttribute("tabindex", "-1");
      destination.focus({ preventScroll: true });
      stopWaiting();
    };

    observer = new MutationObserver(focusDestination);
    observer.observe(document.body, { childList: true, subtree: true });
    timeoutId = window.setTimeout(stopWaiting, 5_000);
    return () => {
      if (settled) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = undefined;
        focusDestination();
      });
    };
  }

  function selectGlobalSearchItem(item: GlobalSearchItem) {
    const target = resolveNavPath(item);
    const targetPathname = target.split("?", 1)[0];
    const immersiveDestination = isImmersiveWorkbenchPath(targetPathname);
    const scheduleFocusTransfer = immersiveDestination ? prepareNavigationFocusTransfer() : null;
    closeGlobalSearch(!immersiveDestination);
    navigate(target);
    scheduleFocusTransfer?.();
  }

  function handleGlobalSearchInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (!filteredGlobalSearchItems.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setGlobalSearchActiveIndex((index) => (index + 1) % filteredGlobalSearchItems.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setGlobalSearchActiveIndex((index) =>
        (index - 1 + filteredGlobalSearchItems.length) % filteredGlobalSearchItems.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      selectGlobalSearchItem(filteredGlobalSearchItems[resolvedGlobalSearchActiveIndex]);
    }
  }

  function trapGlobalSearchFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab" || !globalSearchDialogRef.current) return;
    const focusable = Array.from(
      globalSearchDialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), input:not([disabled])',
      ),
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /* breadcrumb */
  const segments = location.pathname.split("/").filter(Boolean);
  const areaName = segments[0] === "workbench" ? "创作工作台" : segments[0] === "workspace" ? "控制台" : "";
  const pageName = breadcrumbMap[segments[segments.length - 1]] ?? "";
  const ctxButtons = getContextButtons(location.pathname);

  /* ── plan label ── */
  function planLabel(plan?: string) {
    if (!plan) return "Free";
    if (plan === "free") return "Free";
    if (plan === "team") return "Team";
    if (plan === "enterprise") return "Enterprise";
    return plan;
  }

  if (isImmersiveWorkbench) return <Outlet />;

  return (
    <div
      className="frontPagePalette frontLegacyShell" data-theme={theme.mode}
      style={{
        width: "100vw",
        height: "100vh",
        display: "grid",
        gridTemplateColumns: `${sideWidth}px minmax(0, 1fr)`,
        background: theme.bg,
        color: theme.textPrimary,
        transition: "grid-template-columns 0.2s ease",
      }}
    >
      {/* ═══════════ Sidebar ═══════════ */}
      <aside className="frontLegacySidebar"
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
          overflowX: "hidden",
          background: sideBg,
          borderRight: `1px solid ${theme.border}`,
        }}
      >
        {/* ── Brand ── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: collapsed ? "16px 0" : "16px 14px 16px 14px",
            justifyContent: collapsed ? "center" : "flex-start",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              overflow: "hidden",
              flexShrink: 0,
              background: "transparent",
              display: "grid",
              placeItems: "center",
            }}
          >
            <img src={fanjinLogo} alt="" style={{ width: 20, height: 20 }} />
          </div>
          {!collapsed && (
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 760, lineHeight: 1.2 }}>繁境</div>
              <div style={{ fontSize: 11, color: theme.textTertiary, lineHeight: 1.2, marginTop: 1 }}>
                FANJIN
              </div>
            </div>
          )}
          <button
            type="button"
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
            onClick={() => setCollapsed(!collapsed)}
            style={{
              width: 26,
              height: 26,
              border: 0,
              background: "transparent",
              color: theme.textSecondary,
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
              borderRadius: 6,
              transition: "background 0.15s",
            }}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>

        {/* ── Workspace Switcher ── */}
        {!collapsed && (
          <div ref={wsPanelRef} style={{ position: "relative", padding: "0 10px 8px", flexShrink: 0 }}>
            {/* trigger card */}
            <button
              type="button"
              onClick={() => setWsPanelOpen((v) => !v)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                border: `1px solid ${theme.borderLight}`,
                borderRadius: 10,
                background: theme.bgCard,
                cursor: "pointer",
                color: theme.textPrimary,
                fontSize: 13,
                transition: "background 0.15s",
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  background: theme.accentSoft,
                  color: theme.accentDeep,
                  fontWeight: 700,
                  fontSize: 13,
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                }}
              >
                {workspaceInitial(currentWorkspace?.name ?? "W")}
              </div>
              <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {currentWorkspace?.name ?? "工作区"}
                </div>
                <div style={{ fontSize: 11, color: theme.textTertiary, marginTop: 0 }}>
                  {planLabel(currentWorkspace?.plan)}
                </div>
              </div>
              <ChevronDown
                size={14}
                style={{
                  color: theme.textTertiary,
                  flexShrink: 0,
                  transition: "transform 0.2s",
                  transform: wsPanelOpen ? "rotate(180deg)" : "rotate(0)",
                }}
              />
            </button>

            {/* dropdown panel */}
            {wsPanelOpen && (
              <div
                style={{
                  position: "absolute",
                  left: 10,
                  right: 10,
                  top: "100%",
                  marginTop: 4,
                  zIndex: 100,
                  borderRadius: 12,
                  border: `1px solid ${theme.border}`,
                  background: theme.bgSurface,
                  boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
                  padding: 12,
                  maxHeight: 420,
                  overflowY: "auto",
                }}
              >
                {/* header */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: theme.textSecondary }}>当前工作区</span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      padding: "1px 6px",
                      borderRadius: 4,
                      background: theme.accentSoft,
                      color: theme.accentDeep,
                    }}
                  >
                    {planLabel(currentWorkspace?.plan)}
                  </span>
                </div>

                {/* current detail */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 8,
                    background: theme.accentSoft,
                    marginBottom: 10,
                  }}
                >
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 7,
                      background: theme.accent,
                      color: "#fff",
                      fontWeight: 700,
                      fontSize: 14,
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                    }}
                  >
                    {workspaceInitial(currentWorkspace?.name ?? "W")}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{currentWorkspace?.name ?? "工作区"}</div>
                    <div style={{ fontSize: 11, color: theme.textSecondary }}>
                      {currentWorkspace?.memberCount != null ? `${currentWorkspace.memberCount} 成员` : role}
                    </div>
                  </div>
                </div>

                {/* other workspaces */}
                {otherWorkspaces.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, color: theme.textTertiary, marginBottom: 6 }}>其他工作区</div>
                    {otherWorkspaces.map((ws) => (
                      <button
                        key={ws.id}
                        type="button"
                        onClick={() => void handleWorkspaceSwitch(ws.id)}
                        style={{
                          width: "100%",
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "7px 10px",
                          border: 0,
                          borderRadius: 8,
                          background: "transparent",
                          cursor: "pointer",
                          color: theme.textPrimary,
                          fontSize: 13,
                          transition: "background 0.15s",
                          textAlign: "left",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = theme.bgCardHover)}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <div
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 6,
                            background: theme.borderLight,
                            color: theme.textSecondary,
                            fontWeight: 700,
                            fontSize: 12,
                            display: "grid",
                            placeItems: "center",
                            flexShrink: 0,
                          }}
                        >
                          {workspaceInitial(ws.name)}
                        </div>
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {ws.name}
                        </span>
                        <span style={{ fontSize: 10, color: theme.textTertiary }}>{planLabel(ws.plan)}</span>
                      </button>
                    ))}
                  </>
                )}

                {/* quick actions */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 6,
                    marginTop: 12,
                    paddingTop: 10,
                    borderTop: `1px solid ${theme.divider}`,
                  }}
                >
                  <QuickAction
                    label="进入创作"
                    icon={CirclePlay}
                    onClick={() => {
                      navigate("/workbench/create");
                      setWsPanelOpen(false);
                    }}
                    theme={theme}
                  />
                  <QuickAction
                    label="进入控制台"
                    icon={LayoutDashboard}
                    onClick={() => {
                      navigate("/workspace/select");
                      setWsPanelOpen(false);
                    }}
                    theme={theme}
                  />
                  {consoleAccess.workspaceMembers && (
                    <QuickAction
                      label="团队与成员"
                      icon={Users}
                      onClick={() => {
                        navigate("/workspace/members");
                        setWsPanelOpen(false);
                      }}
                      theme={theme}
                    />
                  )}
                  {consoleAccess.billing && (
                    <QuickAction
                      label="账单与额度"
                      icon={CreditCard}
                      onClick={() => {
                        navigate("/workspace/billing");
                        setWsPanelOpen(false);
                      }}
                      theme={theme}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Mode Switch ── */}
        <div
          style={{
            display: "flex",
            flexDirection: collapsed ? "column" : "row",
            gap: 2,
            padding: "0 10px 8px",
            flexShrink: 0,
          }}
        >
          <ModeTab
            label="前台"
            icon={CirclePlay}
            active={location.pathname.startsWith("/workbench")}
            collapsed={collapsed}
            onClick={() => navigate("/workbench/create")}
            theme={theme}
          />
          <ModeTab
            label="后台"
            icon={LayoutDashboard}
            active={location.pathname.startsWith("/workspace")}
            collapsed={collapsed}
            onClick={() => navigate("/workspace/select")}
            theme={theme}
          />
        </div>

        {/* ── Menu Groups ── */}
        <nav style={{ flex: 1, padding: "0 10px", overflowY: "auto" }}>
          {navGroups.map((group) => (
            <div key={group.label} style={{ marginBottom: 12 }}>
              {!collapsed && (
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: theme.textTertiary,
                    padding: "6px 10px 4px",
                    letterSpacing: 0.5,
                    textTransform: "uppercase",
                  }}
                >
                  {group.label}
                </div>
              )}
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.path);
                return (
                  <Link
                    key={item.path}
                    to={resolveNavPath(item)}
                    title={item.label}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: collapsed ? "9px 0" : "9px 10px",
                      justifyContent: collapsed ? "center" : "flex-start",
                      borderRadius: 8,
                      background: active ? theme.accentSoft : "transparent",
                      color: active ? theme.accentDeep : theme.textSecondary,
                      fontWeight: active ? 600 : 400,
                      fontSize: 13,
                      textDecoration: "none",
                      transition: "background 0.15s, color 0.15s",
                      cursor: "pointer",
                      marginBottom: 1,
                    }}
                    onMouseEnter={(e) => {
                      if (!active) e.currentTarget.style.background = theme.bgCardHover;
                    }}
                    onMouseLeave={(e) => {
                      if (!active) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <span style={{ display: "grid", placeItems: "center", flexShrink: 0 }}>
                      <Icon size={19} />
                    </span>
                    {!collapsed && (
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.label}
                      </span>
                    )}
                    {!collapsed && item.badge && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          padding: "1px 6px",
                          borderRadius: 4,
                          background: theme.warningBg,
                          color: theme.warning,
                        }}
                      >
                        {item.badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* ── Bottom Quota ── */}
        <div
          style={{
            padding: collapsed ? "12px 0" : "12px 14px",
            borderTop: `1px solid ${theme.border}`,
            flexShrink: 0,
          }}
        >
          {collapsed ? (
            <div style={{ textAlign: "center" }}>
              <Coins size={16} style={{ color: theme.textTertiary }} />
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: theme.textSecondary }}>本月用量</span>
                <span
                  style={{
                    fontSize: 10,
                    padding: "1px 5px",
                    borderRadius: 4,
                    background: theme.bgCardHover,
                    color: theme.textTertiary,
                  }}
                >
                  工作区
                </span>
              </div>
              {currentWorkspace?.apiQuota != null && currentWorkspace.apiQuota > 0 ? (
                <div>
                  <QuotaRow
                    label="API 调用"
                    used={currentWorkspace.apiUsed ?? 0}
                    total={currentWorkspace.apiQuota}
                    theme={theme}
                  />
                </div>
              ) : (
                <div style={{ fontSize: 12, color: theme.textTertiary, textAlign: "center", padding: "8px 0" }}>
                  暂无用量数据
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Theme toggle ── */}
        <button
          type="button"
          onClick={theme.toggle}
          title={theme.mode === "dark" ? "切换到浅色" : "切换到深色"}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: collapsed ? "center" : "flex-start",
            gap: 8,
            padding: collapsed ? "10px 0" : "10px 20px",
            border: 0,
            background: "transparent",
            color: theme.textTertiary,
            cursor: "pointer",
            fontSize: 13,
            flexShrink: 0,
            transition: "color 0.15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = theme.textSecondary)}
          onMouseLeave={(e) => (e.currentTarget.style.color = theme.textTertiary)}
        >
          {theme.mode === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          {!collapsed && <span>{theme.mode === "dark" ? "浅色模式" : "深色模式"}</span>}
        </button>
      </aside>

      {/* ═══════════ Main ═══════════ */}
      <main className="frontLegacyMain" style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* ── Header ── */}
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "0 20px",
            height: 52,
            flexShrink: 0,
            borderBottom: `1px solid ${theme.border}`,
            background: theme.bgSurface,
          }}
        >
          {/* breadcrumb */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, minWidth: 0 }}>
            <span style={{ color: theme.textTertiary }}>{areaName || "创作工作台"}</span>
            {pageName && (
              <>
                <ChevronRight size={12} style={{ color: theme.textTertiary }} />
                <span style={{ fontWeight: 600, color: theme.textPrimary }}>{pageName}</span>
              </>
            )}
          </div>

          {/* spacer */}
          <div style={{ flex: 1 }} />

          {/* search */}
          <button
            ref={globalSearchTriggerRef}
            type="button"
            aria-label="打开功能导航"
            aria-haspopup="dialog"
            aria-expanded={globalSearchOpen}
            aria-controls="fanjin-global-search-dialog"
            aria-keyshortcuts="Meta+K Control+K"
            onClick={() => setGlobalSearchOpen(true)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              borderRadius: 8,
              background: theme.bg,
              border: `1px solid ${theme.borderLight}`,
              color: theme.textTertiary,
              fontSize: 13,
              minWidth: 180,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <Search size={14} aria-hidden="true" />
            <span>搜索功能与页面…</span>
            <span
              style={{
                marginLeft: "auto",
                fontSize: 11,
                padding: "1px 5px",
                borderRadius: 4,
                background: theme.bgCardHover,
                color: theme.textTertiary,
                lineHeight: 1.4,
              }}
            >
              ⌘K
            </span>
          </button>

          {/* context buttons */}
          {ctxButtons.map((btn) => {
            const BtnIcon = btn.icon;
            return btn.path ? (
              <Link
                key={btn.label}
                to={btn.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 14px",
                  borderRadius: 8,
                  background: theme.accent,
                  color: theme.accentInk,
                  fontSize: 13,
                  fontWeight: 600,
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                  border: 0,
                  cursor: "pointer",
                }}
              >
                <BtnIcon size={14} />
                {btn.label}
              </Link>
            ) : (
              <button
                key={btn.label}
                type="button"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 14px",
                  borderRadius: 8,
                  background: theme.accent,
                  color: theme.accentInk,
                  fontSize: 13,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  border: 0,
                  cursor: "pointer",
                }}
              >
                <BtnIcon size={14} />
                {btn.label}
              </button>
            );
          })}
        </header>

        {/* ── Content ── */}
        <div style={{ flex: 1, overflow: "auto" }}>
          <Outlet />
        </div>
      </main>

      {globalSearchOpen && (
        <div
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeGlobalSearch();
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            padding: "88px 20px 20px",
            background: theme.mode === "light" ? "rgba(24, 24, 27, 0.32)" : "rgba(0, 0, 0, 0.58)",
          }}
        >
          <div
            id="fanjin-global-search-dialog"
            ref={globalSearchDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="fanjin-global-search-title"
            onKeyDown={trapGlobalSearchFocus}
            style={{
              width: "min(620px, 100%)",
              maxHeight: "min(680px, calc(100vh - 108px))",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              borderRadius: 14,
              border: `1px solid ${theme.border}`,
              background: theme.bgSurface,
              color: theme.textPrimary,
              boxShadow: theme.mode === "light"
                ? "0 24px 64px rgba(24, 24, 27, 0.2)"
                : "0 24px 72px rgba(0, 0, 0, 0.5)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px 10px" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div id="fanjin-global-search-title" style={{ fontSize: 14, fontWeight: 700 }}>
                  功能导航
                </div>
                <div style={{ marginTop: 2, color: theme.textTertiary, fontSize: 12 }}>
                  快速打开项目广场、资产库、任务和创作工具
                </div>
              </div>
              <button
                type="button"
                aria-label="关闭功能导航"
                onClick={() => closeGlobalSearch()}
                style={{
                  width: 30,
                  height: 30,
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                  borderRadius: 8,
                  border: `1px solid ${theme.borderLight}`,
                  background: theme.bg,
                  color: theme.textSecondary,
                  cursor: "pointer",
                }}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                margin: "0 16px 12px",
                padding: "10px 12px",
                borderRadius: 10,
                border: `1px solid ${theme.accentDeep}`,
                background: theme.bg,
                boxShadow: `0 0 0 2px ${theme.accentSoft}`,
              }}
            >
              <Search size={17} aria-hidden="true" style={{ color: theme.textTertiary, flexShrink: 0 }} />
              <input
                ref={globalSearchInputRef}
                role="combobox"
                aria-label="搜索功能入口"
                aria-autocomplete="list"
                aria-controls="fanjin-global-search-results"
                aria-expanded="true"
                aria-activedescendant={
                  filteredGlobalSearchItems.length
                    ? `fanjin-global-search-option-${resolvedGlobalSearchActiveIndex}`
                    : undefined
                }
                autoComplete="off"
                placeholder="输入功能，例如“项目广场”“任务”或“画布”"
                value={globalSearchQuery}
                onChange={(event) => setGlobalSearchQuery(event.target.value)}
                onKeyDown={handleGlobalSearchInputKeyDown}
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: 0,
                  outline: 0,
                  background: "transparent",
                  color: theme.textPrimary,
                  fontFamily: "inherit",
                  fontSize: 14,
                }}
              />
              <span style={{ color: theme.textTertiary, fontSize: 11 }}>Esc</span>
            </div>

            <div aria-live="polite" style={{ padding: "0 18px 8px", color: theme.textTertiary, fontSize: 11 }}>
              {globalSearchQuery.trim()
                ? `${filteredGlobalSearchItems.length} 个匹配结果`
                : "全部功能入口"}
            </div>

            <div
              id="fanjin-global-search-results"
              role="listbox"
              aria-label="功能导航结果"
              style={{ overflowY: "auto", padding: "0 8px 10px" }}
            >
              {filteredGlobalSearchItems.length ? (
                filteredGlobalSearchItems.map((item, index) => {
                  const ItemIcon = item.icon;
                  const active = index === resolvedGlobalSearchActiveIndex;
                  return (
                    <button
                      id={`fanjin-global-search-option-${index}`}
                      key={item.path}
                      type="button"
                      role="option"
                      aria-selected={active}
                      tabIndex={-1}
                      onMouseEnter={() => setGlobalSearchActiveIndex(index)}
                      onClick={() => selectGlobalSearchItem(item)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 11,
                        padding: "10px 12px",
                        borderRadius: 9,
                        border: 0,
                        background: active ? theme.accentSoft : "transparent",
                        color: active ? theme.accentDeep : theme.textPrimary,
                        cursor: "pointer",
                        textAlign: "left",
                        fontFamily: "inherit",
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 32,
                          height: 32,
                          display: "grid",
                          placeItems: "center",
                          flexShrink: 0,
                          borderRadius: 8,
                          background: active ? theme.bgSurface : theme.bg,
                          color: active ? theme.accentDeep : theme.textSecondary,
                        }}
                      >
                        <ItemIcon size={16} />
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 13, fontWeight: 650 }}>{item.label}</span>
                        <span
                          style={{
                            display: "block",
                            marginTop: 2,
                            overflow: "hidden",
                            color: active ? theme.accentDeep : theme.textTertiary,
                            fontSize: 12,
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {item.description}
                        </span>
                      </span>
                      <span style={{ color: active ? theme.accentDeep : theme.textTertiary, fontSize: 11 }}>
                        {item.group}
                      </span>
                    </button>
                  );
                })
              ) : (
                <div role="status" style={{ padding: "34px 18px 40px", textAlign: "center", color: theme.textSecondary }}>
                  <Search size={22} aria-hidden="true" style={{ margin: "0 auto 10px", color: theme.textTertiary }} />
                  <div style={{ fontSize: 13, fontWeight: 600 }}>没有找到匹配功能</div>
                  <div style={{ marginTop: 4, color: theme.textTertiary, fontSize: 12 }}>
                    可以尝试“项目”“素材”“任务”或“画布”
                  </div>
                </div>
              )}
            </div>

            <div
              style={{
                display: "flex",
                gap: 14,
                padding: "9px 16px",
                borderTop: `1px solid ${theme.divider}`,
                color: theme.textTertiary,
                fontSize: 11,
              }}
            >
              <span>↑↓ 选择</span>
              <span>Enter 打开</span>
              <span>Esc 关闭</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────── sub-components ───────── */

function ModeTab({
  label,
  icon: Icon,
  active,
  collapsed,
  onClick,
  theme,
}: {
  label: string;
  icon: typeof CirclePlay;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
  theme: ReturnType<typeof useV4Theme>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: collapsed ? "8px 0" : "8px 10px",
        justifyContent: collapsed ? "center" : "flex-start",
        borderRadius: 8,
        background: active ? theme.accentSoft : "transparent",
        color: active ? theme.accentDeep : theme.textSecondary,
        fontWeight: active ? 600 : 400,
        fontSize: 13,
        border: 0,
        cursor: "pointer",
        transition: "background 0.15s, color 0.15s",
        flex: collapsed ? undefined : 1,
      }}
    >
      <Icon size={18} />
      {!collapsed && <span>{label}</span>}
    </button>
  );
}

function QuickAction({
  label,
  icon: Icon,
  onClick,
  theme,
}: {
  label: string;
  icon: typeof CirclePlay;
  onClick: () => void;
  theme: ReturnType<typeof useV4Theme>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 10px",
        borderRadius: 8,
        border: `1px solid ${theme.borderLight}`,
        background: "transparent",
        color: theme.textSecondary,
        fontSize: 12,
        cursor: "pointer",
        transition: "background 0.15s, color 0.15s",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = theme.bgCardHover;
        e.currentTarget.style.color = theme.textPrimary;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = theme.textSecondary;
      }}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

function QuotaRow({
  label,
  used,
  total,
  theme,
}: {
  label: string;
  used: number;
  total: number;
  theme: ReturnType<typeof useV4Theme>;
}) {
  const pct = Math.min(100, Math.round((used / total) * 100));
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: theme.textSecondary }}>{label}</span>
        <span style={{ color: theme.textTertiary, fontWeight: 500 }}>
          {used.toLocaleString()} / {total.toLocaleString()}
        </span>
      </div>
      <div
        style={{
          width: "100%",
          height: 5,
          borderRadius: 3,
          background: theme.borderLight,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            borderRadius: 3,
            background: pct > 80 ? theme.warning : theme.accent,
            transition: "width 0.3s ease",
          }}
        />
      </div>
    </div>
  );
}
