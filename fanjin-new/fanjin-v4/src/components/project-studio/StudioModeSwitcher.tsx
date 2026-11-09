import { Clapperboard, MessageSquareText, Workflow } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSessionStore } from "../../features/quick-create/session/sessionStore";
import {
  buildProjectModeHref,
  readProjectModeRouteContext,
} from "../../routes/projectModeRoutes";
import { useProjectStore } from "../../stores/projectStore";
import "./StudioModeSwitcher.css";

export type StudioMode = "quick" | "canvas" | "agent";

export type StudioModeSwitcherProps = {
  activeMode?: StudioMode;
  className?: string;
};

const STUDIO_MODES = [
  { id: "quick", label: "流程", icon: Clapperboard },
  { id: "canvas", label: "画布模式", icon: Workflow },
  { id: "agent", label: "Agent 模式", icon: MessageSquareText },
] as const;

/**
 * Quick, Canvas and Agent share one project/session identity and preserve the
 * current project, session, thread and canvas route context.
 */
export function StudioModeSwitcher({ activeMode, className = "" }: StudioModeSwitcherProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const session = useSessionStore((state) => state.session);
  const boundSessionProjectId = useSessionStore((state) => state.boundProjectId);

  function openMode(mode: StudioMode) {
    if (mode === activeMode) return;
    const routeContext = readProjectModeRouteContext(location);
    const projectId = routeContext.projectId ?? currentProjectId;
    const sessionMatchesProject = projectId !== null
      && projectId !== undefined
      && String(boundSessionProjectId) === String(projectId);
    navigate(buildProjectModeHref(mode, {
      projectId,
      sessionId: routeContext.sessionId ?? (sessionMatchesProject ? session?.id : null),
      threadId: routeContext.threadId,
      canvasId: routeContext.canvasId ?? (sessionMatchesProject ? session?.canvasId : null),
    }, location.search), {
      state: { studioModeSwitch: true },
    });
  }

  return (
    <nav className={`studioModeSwitcher ${className}`.trim()} aria-label="创作模式">
      {STUDIO_MODES.map((mode) => {
        const Icon = mode.icon;
        const active = activeMode === mode.id;
        return (
          <button
            key={mode.id}
            type="button"
            className={active ? "active" : ""}
            aria-label={mode.label}
            aria-current={active ? "page" : undefined}
            data-tooltip={mode.label}
            onClick={() => openMode(mode.id)}
          >
            <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
            <span className="studioModeSwitcherLabel">{mode.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

export default StudioModeSwitcher;
