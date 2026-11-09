import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, FolderClosed, Menu, Moon, Plus, Search, Settings2, ShieldCheck, Sun, X } from "lucide-react";
import { Outlet, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { Button, Dialog, FormField, Input, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Tooltip, TooltipContent, TooltipTrigger, useToast } from "../../ui/console";
import { useV4Theme } from "../../ui/useV4Theme";
import { buildConsoleMenuSections, type ConsoleMenuItem, type ConsoleMenuSection, type ConsoleRoot } from "../../routes/consoleRegistry";
import { getConsoleAccess } from "../../routes/consoleAccess";
import "../../ui/console/index.css";
import fanjinLogo from "../../assets/fanjin-logo-fj.svg";
import "./ConsoleLayout.css";
import { ConsoleCommandPalette } from "./ConsoleCommandPalette";
import { useConsoleScrollRestoration } from "./useConsoleScrollRestoration";

const FRONTSTAGE_TO_CONSOLE_TRANSITION_KEY = "fanjin:frontstage-to-console-transition";
const PERSONAL_SETTINGS_SECTION = "我的账号";
const USER_CONSOLE_ROOTS: readonly ConsoleRoot[] = ["workspace", "developer", "settings"];
const FJADMIN_CONSOLE_ROOTS: readonly ConsoleRoot[] = ["admin"];

type ConsoleLayoutProps = {
  scope?: "user" | "fjadmin";
};

function sectionDisplayLabel(label: string) {
  return label.replace(/^平台管理\s*·\s*/, "");
}

function menuMatchesPath(menu: ConsoleMenuItem, pathname: string) {
  if (menu.matchPrefix) return pathname.startsWith(menu.matchPrefix);
  return pathname === menu.path;
}

function consumeFrontstageTransitionFlag() {
  try {
    const shouldAnimate = sessionStorage.getItem(FRONTSTAGE_TO_CONSOLE_TRANSITION_KEY) === "1";
    if (shouldAnimate) sessionStorage.removeItem(FRONTSTAGE_TO_CONSOLE_TRANSITION_KEY);
    return shouldAnimate;
  } catch {
    return false;
  }
}

/* ---------- component ---------- */
function ConsoleLayoutContent({ scope = "user" }: ConsoleLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const fjAdmin = scope === "fjadmin";
  const authStore = useAuthStore();
  const workspaceStore = useWorkspaceStore();
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== "undefined"
      && window.matchMedia("(min-width: 1024px) and (max-width: 1279px)").matches,
  );
  const [mobileNavMode, setMobileNavMode] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches,
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [wsSwitcherOpen, setWsSwitcherOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [openAdminRailSection, setOpenAdminRailSection] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [wsNameDraft, setWsNameDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const theme = useV4Theme();
  const dark = theme.mode === "dark";
  const { toast } = useToast();
  const mobileNavTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileNavCloseRef = useRef<HTMLButtonElement>(null);
  const mobileNavRef = useRef<HTMLElement>(null);
  const primaryNavListRef = useRef<HTMLElement>(null);
  const workspaceSwitcherTriggerRef = useRef<HTMLButtonElement>(null);
  const commandPaletteTriggerRef = useRef<HTMLButtonElement>(null);
  const createWorkspaceNameRef = useRef<HTMLInputElement>(null);
  const consoleContentRef = useRef<HTMLElement>(null);
  const [enteringFromFrontstage, setEnteringFromFrontstage] = useState(() => {
    if (fjAdmin) return false;
    const routeState = location.state as { fromFrontstage?: boolean } | null;
    return Boolean(routeState?.fromFrontstage) || consumeFrontstageTransitionFlag();
  });

  useEffect(() => {
    const previousTheme = document.body.getAttribute("data-theme");
    const hadConsoleThemeHost = document.body.classList.contains("consoleThemeHost");
    document.body.classList.add("consoleThemeHost");
    document.body.setAttribute("data-theme", dark ? "dark" : "light");
    return () => {
      if (!hadConsoleThemeHost) document.body.classList.remove("consoleThemeHost");
      if (previousTheme === null) document.body.removeAttribute("data-theme");
      else document.body.setAttribute("data-theme", previousTheme);
    };
  }, [dark]);

  const wsName = authStore.currentWorkspace?.name || "Default Workspace";
  // Prefer displayName from session profile; avoid hard-coded "R" which shows for empty/missing name.
  const userLabel = String(
    authStore.user?.displayName
      || authStore.user?.name
      || authStore.user?.email
      || "",
  ).trim();
  const userInitial = (userLabel || "用").slice(0, 1).toUpperCase();
  const wsPanelItems = useMemo(() => (authStore.workspaces || []).slice(0, 8), [authStore.workspaces]);
  const userRole = String(authStore.user?.role || "");
  const workspaceRole = String(authStore.currentWorkspace?.memberRole || authStore.currentWorkspace?.role || "member");
  const workspacePermissions = authStore.currentWorkspace?.permissions;
  const consoleAccess = useMemo(
    () => getConsoleAccess(userRole, workspaceRole, workspacePermissions),
    [userRole, workspacePermissions, workspaceRole],
  );

  /* menus */
  const menuSections = useMemo(
    () => buildConsoleMenuSections(consoleAccess, fjAdmin ? FJADMIN_CONSOLE_ROOTS : USER_CONSOLE_ROOTS),
    [consoleAccess, fjAdmin],
  );
  const personalSettingsSection = useMemo(
    () => menuSections.find((section) => section.label === PERSONAL_SETTINGS_SECTION),
    [menuSections],
  );
  const primaryMenuSections = useMemo(
    () => menuSections.filter((section) => section.label !== PERSONAL_SETTINGS_SECTION),
    [menuSections],
  );
  const activeSectionLabel = useMemo(
    () => menuSections.find((section) => section.items.some((menu) => menuMatchesPath(menu, location.pathname)))?.label,
    [location.pathname, menuSections],
  );
  const activeSectionExpandedState = activeSectionLabel ? expandedSections[activeSectionLabel] : undefined;
  const iconRailMode = collapsed && !mobileNavOpen;
  const groupedAdminRailMode = fjAdmin && iconRailMode;
  const consoleTitle = fjAdmin ? "FJ ADMIN" : "FANJIN V4";

  useConsoleScrollRestoration({
    containerRef: consoleContentRef,
    locationKey: location.key,
    navigationType,
  });

  useLayoutEffect(() => {
    if (!activeSectionLabel) return;
    setExpandedSections((current) => (
      current[activeSectionLabel] === false
        ? { ...current, [activeSectionLabel]: true }
        : current
    ));
  }, [activeSectionLabel, location.pathname]);

  useLayoutEffect(() => {
    const list = primaryNavListRef.current;
    const activeItem = list?.querySelector<HTMLElement>(".consolePrimaryNavItem.active");
    if (!list || !activeItem || activeItem.getClientRects().length === 0) return;

    const listRect = list.getBoundingClientRect();
    const activeSection = activeItem.closest<HTMLElement>(".consolePrimaryNavSection");
    const targetRect = (activeSection ?? activeItem).getBoundingClientRect();
    const edgePadding = 8;
    if (targetRect.top < listRect.top + edgePadding || targetRect.bottom > listRect.bottom - edgePadding) {
      list.scrollTop += targetRect.top - listRect.top - edgePadding;
    }

    const clippedTopItem = Array.from(list.querySelectorAll<HTMLElement>(".consolePrimaryNavItem"))
      .find((item) => {
        const itemRect = item.getBoundingClientRect();
        return itemRect.top < listRect.top && itemRect.bottom > listRect.top;
      });
    if (clippedTopItem) {
      const clippedRect = clippedTopItem.getBoundingClientRect();
      list.scrollTop += clippedRect.bottom - listRect.top + 2;
      const snappedRect = clippedTopItem.getBoundingClientRect();
      if (snappedRect.top < listRect.top && snappedRect.bottom > listRect.top) {
        list.scrollTop -= listRect.top - snappedRect.top + 2;
      }
    }
    list.scrollTop = Math.round(list.scrollTop);
  }, [activeSectionExpandedState, activeSectionLabel, collapsed, location.pathname]);

  useEffect(() => {
    setWsSwitcherOpen(false);
    setMobileNavOpen(false);
    setOpenAdminRailSection(null);
  }, [location.pathname]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const syncMobileNavMode = () => {
      setMobileNavMode(query.matches);
      if (!query.matches) setMobileNavOpen(false);
    };
    syncMobileNavMode();
    query.addEventListener("change", syncMobileNavMode);
    return () => query.removeEventListener("change", syncMobileNavMode);
  }, []);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    mobileNavCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileNavOpen(false);
        window.setTimeout(() => mobileNavTriggerRef.current?.focus(), 0);
        return;
      }
      if (event.key === "Tab") {
        const focusable = Array.from(
          mobileNavRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ) || [],
        ).filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    if (collapsed) {
      setWsSwitcherOpen(false);
      return;
    }
    setOpenAdminRailSection(null);
  }, [collapsed]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || (!event.metaKey && !event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setWsSwitcherOpen(false);
      setMobileNavOpen(false);
      setCommandPaletteOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!enteringFromFrontstage) return;
    const timer = window.setTimeout(() => setEnteringFromFrontstage(false), 720);
    return () => window.clearTimeout(timer);
  }, [enteringFromFrontstage]);

  function isMenuActive(menu: ConsoleMenuItem) {
    return menuMatchesPath(menu, location.pathname);
  }

  function setSectionExpanded(sectionLabel: string, expanded: boolean) {
    setExpandedSections((current) => (
      current[sectionLabel] === expanded
        ? current
        : { ...current, [sectionLabel]: expanded }
    ));
  }

  function focusConsoleContentAfterNavigation(force = false) {
    if (!force && !mobileNavMode) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        consoleContentRef.current?.focus({ preventScroll: true });
      });
    });
  }

  function navigateFromPrimaryNav(path: string, shouldMoveFocus = mobileNavMode) {
    setWsSwitcherOpen(false);
    setMobileNavOpen(false);
    setOpenAdminRailSection(null);
    navigate(path);
    focusConsoleContentAfterNavigation(shouldMoveFocus);
  }

  function restoreWorkspaceSwitcherFocus() {
    window.requestAnimationFrame(() => workspaceSwitcherTriggerRef.current?.focus({ preventScroll: true }));
  }

  async function handleWorkspaceSelect(id: string | number, name: string) {
    if (workspaceStore.loading || String(id) === String(authStore.currentWorkspace?.id)) return;
    setWsSwitcherOpen(false);
    try {
      await workspaceStore.selectWorkspace(id);
      toast({ title: "工作区已切换", message: name, tone: "success" });
    } catch (error) {
      toast({
        title: "工作区切换失败",
        message: error instanceof Error ? error.message : "请稍后重试。",
        tone: "danger",
      });
    } finally {
      restoreWorkspaceSwitcherFocus();
    }
  }

  function renderMenuSection(section: ConsoleMenuSection, controlsId: string) {
    const explicitState = expandedSections[section.label];
    // 用户后台分组默认展开；平台后台优先展示概览、运营和当前分组。
    const defaultExpanded = fjAdmin
      ? section.label === activeSectionLabel || section.label === "概览" || section.label === "运营"
      : true;
    const expanded = iconRailMode || (explicitState !== undefined ? explicitState : defaultExpanded);

    return (
      <div className="consolePrimaryNavSection" key={section.label}>
        <button
          className="consolePrimaryNavSectionToggle"
          type="button"
          aria-expanded={expanded}
          aria-controls={controlsId}
          onClick={() => setSectionExpanded(section.label, !expanded)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" && expanded) {
              event.preventDefault();
              setSectionExpanded(section.label, false);
            } else if (event.key === "ArrowRight" && !expanded) {
              event.preventDefault();
              setSectionExpanded(section.label, true);
            }
          }}
        >
          <span>{sectionDisplayLabel(section.label)}</span>
          <ChevronDown size={11} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <div id={controlsId} className="consolePrimaryNavSectionItems" hidden={!expanded}>
          {section.items.map((menu) => {
            const Icon = menu.icon;
            const active = isMenuActive(menu);
            return (
              <Tooltip key={menu.path} disabled={!iconRailMode}>
                <TooltipTrigger
                  className={`consolePrimaryNavItem ${active ? "active" : ""}`}
                  aria-label={menu.label}
                  aria-current={active ? "page" : undefined}
                  onClick={(event) => navigateFromPrimaryNav(menu.path, mobileNavMode || event.detail === 0)}
                >
                  <span className="consolePrimaryNavIcon"><Icon size={14} strokeWidth={1.5} /></span>
                  <span className="consolePrimaryNavLabel">{menu.label}</span>
                </TooltipTrigger>
                <TooltipContent side="right">{menu.label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </div>
    );
  }

  function renderCollapsedAdminSection(section: ConsoleMenuSection) {
    const SectionIcon = section.icon;
    const active = section.items.some((menu) => isMenuActive(menu));

    return (
      <Popover
        key={section.label}
        open={openAdminRailSection === section.label}
        onOpenChange={(open) => setOpenAdminRailSection(open ? section.label : null)}
      >
        <PopoverTrigger
          className={`consoleAdminNavGroupTrigger ${active ? "active" : ""}`}
          type="button"
          aria-label={section.label}
          aria-current={active ? "page" : undefined}
        >
          <SectionIcon size={16} strokeWidth={1.5} aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent
          className="consoleAdminNavGroupPopover"
          side="right"
          align="start"
          sideOffset={10}
          collisionPadding={12}
        >
          <PopoverTitle className="consoleAdminNavGroupTitle">{section.label}</PopoverTitle>
          <div className="consoleAdminNavGroupItems">
            {section.items.map((menu) => {
              const Icon = menu.icon;
              const menuActive = isMenuActive(menu);
              return (
                <button
                  key={menu.path}
                  className={menuActive ? "active" : ""}
                  type="button"
                  aria-current={menuActive ? "page" : undefined}
                  onClick={(event) => navigateFromPrimaryNav(menu.path, event.detail === 0)}
                >
                  <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
                  <span>{menu.label}</span>
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  function openCreateWorkspaceDialog() {
    setWsSwitcherOpen(false);
    setCreateError("");
    setCreateOpen(true);
  }

  function closeCreateWorkspaceDialog() {
    setCreateOpen(false);
    setWsNameDraft("");
    setCreateError("");
  }

  async function handleCreateWorkspace() {
    const name = wsNameDraft.trim();
    if (!name) return;
    setCreating(true);
    setCreateError("");
    try {
      await workspaceStore.createWorkspace({ name, initialAllocationMicros: 0, switchTo: true });
      setCreateOpen(false);
      setWsNameDraft("");
      navigate("/workspace/manage");
      focusConsoleContentAfterNavigation(true);
    } catch (err: any) {
      setCreateError(err?.message || "工作区创建失败");
    } finally { setCreating(false); }
  }

  return (
    <main
      data-theme={dark ? "dark" : "light"}
      data-console-scope={scope}
      className={`consoleWorkbench ${fjAdmin ? "consoleFjAdmin" : ""} ${dark ? "themeDark" : "themeLight"}`}
    >
      <a
        className="consoleSkipLink"
        href="#console-main-content"
        aria-hidden={mobileNavOpen || undefined}
        inert={mobileNavOpen || undefined}
        onClick={(event) => {
          event.preventDefault();
          consoleContentRef.current?.focus({ preventScroll: true });
        }}
      >
        跳到主内容
      </a>
      <section className={`consoleShell ${collapsed ? "consoleNavCollapsed" : ""} ${mobileNavOpen ? "consoleMobileNavOpen" : ""} ${enteringFromFrontstage ? "consoleShellFromFrontstage" : ""}`}>
        <button
          className="consoleMobileNavScrim"
          type="button"
          aria-label="关闭后台导航"
          tabIndex={mobileNavOpen ? 0 : -1}
          onClick={() => {
            setMobileNavOpen(false);
            window.setTimeout(() => mobileNavTriggerRef.current?.focus(), 0);
          }}
        />
        <aside
          ref={mobileNavRef}
          id="console-primary-navigation"
          className={`consolePrimaryNav ${collapsed && !mobileNavOpen ? "collapsed" : ""}`}
          aria-label="后台主导航"
          role={mobileNavMode && mobileNavOpen ? "dialog" : undefined}
          aria-modal={mobileNavMode && mobileNavOpen ? true : undefined}
          aria-hidden={mobileNavMode && !mobileNavOpen ? true : undefined}
          inert={mobileNavMode && !mobileNavOpen ? true : undefined}
        >
          <button
            ref={mobileNavCloseRef}
            className="consoleMobileNavClose"
            type="button"
            aria-label="关闭后台导航"
            onClick={() => {
              setMobileNavOpen(false);
              window.setTimeout(() => mobileNavTriggerRef.current?.focus(), 0);
            }}
          >
            <X size={18} strokeWidth={1.6} />
          </button>
          <div className="consoleNavHeader">
            {fjAdmin ? (
              <div className="consoleWorkspaceSwitcher">
                <div className="consoleWorkspaceButton" aria-label="FJ Admin 平台管理后台">
                  <span className="consoleWorkspaceAvatar"><ShieldCheck size={14} strokeWidth={1.5} aria-hidden="true" /></span>
                  <span className="consoleWorkspaceCopy"><strong>FJ Admin</strong></span>
                </div>
              </div>
            ) : (
              <div className="consoleWorkspaceSwitcher">
                <Popover open={wsSwitcherOpen} onOpenChange={setWsSwitcherOpen}>
                  <PopoverTrigger
                    ref={workspaceSwitcherTriggerRef}
                    className="consoleWorkspaceButton"
                    aria-label={`切换工作区，当前 ${wsName}`}
                    disabled={workspaceStore.loading}
                  >
                    <span className="consoleWorkspaceAvatar"><FolderClosed size={14} strokeWidth={1.5} aria-hidden="true" /></span>
                    <span className="consoleWorkspaceCopy">
                      <strong>{wsName}</strong>
                    </span>
                    <ChevronDown className="consoleWorkspaceChevron" size={11} strokeWidth={1.5} aria-hidden="true" />
                  </PopoverTrigger>
                  <PopoverContent className="consoleWorkspaceMenu" align="start" sideOffset={6}>
                    <div className="consoleWorkspaceMenuHeader">
                      <span>工作区切换</span>
                      <strong>{authStore.workspaces?.length || 1} 个工作区</strong>
                    </div>
                    {wsPanelItems.map((ws: any) => {
                      const selected = String(ws.id) === String(authStore.currentWorkspace?.id);
                      return (
                        <button
                          key={ws.id}
                          className={selected ? "selected" : ""}
                          type="button"
                          disabled={selected || workspaceStore.loading}
                          onClick={() => void handleWorkspaceSelect(ws.id, String(ws.name || ws.id))}
                        >
                          <span><FolderClosed size={14} strokeWidth={1.5} aria-hidden="true" /></span>
                          <strong>{ws.name || ws.id}</strong>
                          <small>{selected ? "当前" : workspaceStore.loading ? "切换中…" : "切换"}</small>
                        </button>
                      );
                    })}
                    <div className="consoleWorkspaceMenuActions">
                      <button type="button" onClick={openCreateWorkspaceDialog}><Plus size={14} strokeWidth={1.5} />创建工作区</button>
                      <button type="button" onClick={() => navigateFromPrimaryNav("/workspace/manage")}><Settings2 size={14} strokeWidth={1.5} />工作区管理</button>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            )}
            <button
              className="consoleCollapseButton"
              type="button"
              aria-label={collapsed ? "展开后台导航" : "收起后台导航"}
              onClick={() => setCollapsed((value) => !value)}
            >
              {collapsed ? <ChevronRight size={13} strokeWidth={1.5} /> : <ChevronLeft size={13} strokeWidth={1.5} />}
            </button>
          </div>

          <nav ref={primaryNavListRef} className="consolePrimaryNavList" aria-label="后台导航">
            {primaryMenuSections.map((section, index) => (
              groupedAdminRailMode
                ? renderCollapsedAdminSection(section)
                : renderMenuSection(section, `console-primary-nav-section-${index}`)
            ))}
          </nav>

          <div className="consolePrimaryDock">
            {personalSettingsSection ? (
              <nav className="consolePersonalNavDock" aria-label="我的账号">
                {renderMenuSection(personalSettingsSection, "console-personal-nav-section")}
              </nav>
            ) : null}
            <Tooltip disabled={!iconRailMode}>
              <TooltipTrigger
                className="consoleReturnButton"
                aria-label={fjAdmin ? "返回用户后台" : "返回创作台"}
                onClick={() => navigate(fjAdmin ? "/workspace/select" : "/workbench/create")}
              >
                <ArrowLeft size={14} strokeWidth={1.5} />
                <span>{fjAdmin ? "用户后台" : "创作台"}</span>
              </TooltipTrigger>
              <TooltipContent side="right">{fjAdmin ? "返回用户后台" : "返回创作台"}</TooltipContent>
            </Tooltip>
          </div>
        </aside>

        <div
          className="consoleMainPane"
          aria-hidden={mobileNavMode && mobileNavOpen ? true : undefined}
          inert={mobileNavMode && mobileNavOpen ? true : undefined}
        >
          <header className="consoleTopbar">
            <button
              ref={mobileNavTriggerRef}
              className="consoleMobileNavButton"
              type="button"
              aria-label="打开后台导航"
              aria-controls="console-primary-navigation"
              aria-expanded={mobileNavOpen}
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu size={18} strokeWidth={1.6} />
            </button>
            <div className="consoleTopbarBrand">
              <span className="consoleTopbarLogo">
                <img src={fanjinLogo} alt="" />
              </span>
              <strong>{consoleTitle}</strong>
            </div>

            <div className="consoleHeaderActions">
              <span id="console-feedback-slot" />
              <button
                ref={commandPaletteTriggerRef}
                className="consoleCommandTrigger"
                type="button"
                aria-label={fjAdmin ? "搜索 FJ Admin" : "搜索控制台"}
                aria-keyshortcuts="Meta+K Control+K"
                onClick={() => {
                  setWsSwitcherOpen(false);
                  setCommandPaletteOpen(true);
                }}
              >
                <Search size={15} strokeWidth={1.5} aria-hidden="true" />
                <span>{fjAdmin ? "搜索 FJ Admin" : "搜索控制台"}</span>
                <kbd aria-hidden="true">⌘/Ctrl K</kbd>
              </button>
              <button className="consoleThemeButton" type="button" aria-label={dark ? "切换浅色模式" : "切换深色模式"} onClick={theme.toggle}>
                {dark ? <Sun size={14} strokeWidth={1.5} /> : <Moon size={14} strokeWidth={1.5} />}
                <span>{dark ? "浅色" : "深色"}</span>
              </button>
              <button
                className="consoleUserPill"
                type="button"
                aria-label={`打开我的账号，当前用户 ${userLabel || "用户"}`}
                onClick={() => navigate("/settings/account")}
              >
                <span>{userInitial}</span>
                <strong>{userLabel || "用户"}</strong>
              </button>
            </div>
          </header>

          <section className="consoleWorkbenchBody">
            <section id="console-main-content" ref={consoleContentRef} className="consoleContentPane" tabIndex={-1} aria-label={fjAdmin ? "FJ Admin 页面内容" : "后台页面内容"}>
              <Outlet />
            </section>
          </section>
        </div>
      </section>

      <ConsoleCommandPalette
        open={commandPaletteOpen}
        sections={menuSections}
        returnFocusRef={commandPaletteTriggerRef}
        onOpenChange={setCommandPaletteOpen}
        onNavigate={(path) => {
          setCommandPaletteOpen(false);
          navigate(path);
          focusConsoleContentAfterNavigation(true);
        }}
      />

      {!fjAdmin ? <Dialog
        open={createOpen}
        title="创建工作区"
        description="工作区是项目、成员、API 密钥、额度和账单的归属边界。"
        size="sm"
        loading={creating}
        dirty={Boolean(wsNameDraft.trim())}
        initialFocusRef={createWorkspaceNameRef}
        returnFocusRef={workspaceSwitcherTriggerRef}
        closeGuardTitle="放弃创建工作区？"
        closeGuardDescription="关闭后，已输入的工作区名称将不会保留。"
        onOpenChange={(open) => {
          if (!open) closeCreateWorkspaceDialog();
        }}
        footer={({ requestClose, pending }) => (
          <div className="consoleOverlayActionRow">
            <Button variant="secondary" onClick={() => requestClose("cancel")} disabled={pending}>取消</Button>
            <Button
              type="submit"
              form="console-create-workspace-form"
              loading={creating}
              disabled={!wsNameDraft.trim()}
            >
              创建并切换
            </Button>
          </div>
        )}
      >
        <form
          id="console-create-workspace-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreateWorkspace();
          }}
        >
          <FormField
            label="工作区名称"
            required
            optionalLabel={null}
            help="建议使用团队、业务线或项目组名称。"
            error={createError || undefined}
          >
            <Input
              ref={createWorkspaceNameRef}
              type="text"
              value={wsNameDraft}
              onChange={(event) => setWsNameDraft(event.target.value)}
              placeholder="例如：繁境科技工作区"
              autoComplete="organization"
              disabled={creating}
            />
          </FormField>
        </form>
      </Dialog> : null}
    </main>
  );
}

export default function ConsoleLayout({ scope = "user" }: ConsoleLayoutProps) {
  return <ConsoleLayoutContent scope={scope} />;
}
