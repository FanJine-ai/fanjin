import type { ReactNode } from "react";
import {
  Clapperboard,
  FolderOpen,
  History,
  Settings,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import fanjinLogo from "../../assets/fanjin-logo-fj.svg";
import "./ProjectStudioShell.css";

export type WorkModeNavKey = "quick" | "canvas" | "history" | "assets";

export type WorkModeNavItem = {
  key: WorkModeNavKey;
  label: string;
  path: string;
  icon: LucideIcon;
  group: "mode" | "resource";
};

export const WORK_MODE_NAV_ITEMS: readonly WorkModeNavItem[] = [
  { key: "quick", label: "流程", path: "/workbench/quick-create", icon: Clapperboard, group: "mode" },
  { key: "canvas", label: "画布模式", path: "/workbench/canvas/editor", icon: Workflow, group: "mode" },
  { key: "history", label: "生成历史", path: "/workbench/assets?tab=history", icon: History, group: "resource" },
  { key: "assets", label: "资产", path: "/workbench/assets", icon: FolderOpen, group: "resource" },
] as const;

export type WorkModeNavProps = {
  active: WorkModeNavKey;
  onNavigate: (item: WorkModeNavItem) => void;
  onBrandClick?: () => void;
  onOpenSettings?: () => void;
  profileControl?: ReactNode;
  className?: string;
};

function navClassName(className?: string) {
  return ["projectStudioWorkNav", className].filter(Boolean).join(" ");
}

/**
 * Compact navigation for an active creation session. It mirrors the naming and
 * destination semantics of FrontstageNav while keeping the working area wide.
 */
export function WorkModeNav({
  active,
  onNavigate,
  onBrandClick,
  onOpenSettings,
  profileControl,
  className,
}: WorkModeNavProps) {
  const modeItems = WORK_MODE_NAV_ITEMS.filter((item) => item.group === "mode");
  const resourceItems = WORK_MODE_NAV_ITEMS.filter((item) => item.group === "resource");

  function renderNavItem(item: WorkModeNavItem) {
    const Icon = item.icon;
    const isActive = item.key === active;
    return (
      <button
        className={isActive ? "active" : undefined}
        type="button"
        aria-label={item.label}
        aria-current={isActive ? "page" : undefined}
        title={item.label}
        key={item.key}
        onClick={() => onNavigate(item)}
      >
        <Icon size={19} strokeWidth={1.9} aria-hidden="true" />
      </button>
    );
  }

  return (
    <aside className={navClassName(className)} aria-label="工作模式导航">
      {onBrandClick ? (
        <button
          className="projectStudioBrandButton"
          type="button"
          aria-label="返回繁境工作台"
          title="繁境工作台"
          onClick={onBrandClick}
        >
          <img src={fanjinLogo} alt="" />
        </button>
      ) : (
        <span className="projectStudioBrandButton projectStudioBrandStatic" title="繁境">
          <img src={fanjinLogo} alt="" />
        </span>
      )}

      <nav className="projectStudioModeNav" aria-label="创作模式">
        {modeItems.map(renderNavItem)}
      </nav>

      <span className="projectStudioNavDivider" aria-hidden="true" />

      <nav className="projectStudioResourceNav" aria-label="项目与资产">
        {resourceItems.map(renderNavItem)}
      </nav>

      <div className="projectStudioNavUtilities">
        {profileControl ? <div className="projectStudioProfileControl">{profileControl}</div> : null}
        {onOpenSettings ? (
          <button type="button" aria-label="设置" title="设置" onClick={onOpenSettings}>
            <Settings size={19} strokeWidth={1.9} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </aside>
  );
}

export default WorkModeNav;
