import {
  useId,
  useReducer,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import "./ProjectStudioShell.css";

export type ProjectStudioDockState = {
  collapsed: boolean;
};

export type ProjectStudioDockAction =
  | { type: "toggle" }
  | { type: "collapse" }
  | { type: "expand" }
  | { type: "set"; collapsed: boolean };

export function reduceProjectStudioDock(
  state: ProjectStudioDockState,
  action: ProjectStudioDockAction,
): ProjectStudioDockState {
  switch (action.type) {
    case "toggle":
      return { collapsed: !state.collapsed };
    case "collapse":
      return state.collapsed ? state : { collapsed: true };
    case "expand":
      return state.collapsed ? { collapsed: false } : state;
    case "set":
      return action.collapsed === state.collapsed ? state : { collapsed: action.collapsed };
  }
}

export type ProjectStudioShellProps = {
  navigation: ReactNode;
  agentDock?: ReactNode;
  children: ReactNode;
  dockCollapsed?: boolean;
  defaultDockCollapsed?: boolean;
  onDockCollapsedChange?: (collapsed: boolean) => void;
  showDockToggle?: boolean;
  dockAriaLabel?: string;
  agentDockId?: string;
  mainAriaLabel?: string;
  navigationCollapsed?: boolean;
  dark?: boolean;
  className?: string;
};

function shellClassName(dark: boolean, className?: string) {
  return ["projectStudioShell", dark ? "themeDark" : "themeLight", className]
    .filter(Boolean)
    .join(" ");
}

/**
 * Shared working shell for Agent, quick preview and canvas modes. The content
 * slots deliberately do not know anything about the infinite-canvas internals.
 */
export function ProjectStudioShell({
  navigation,
  agentDock,
  children,
  dockCollapsed: controlledDockCollapsed,
  defaultDockCollapsed = false,
  onDockCollapsedChange,
  showDockToggle = true,
  dockAriaLabel = "Agent 对话",
  agentDockId,
  mainAriaLabel = "项目工作区",
  navigationCollapsed = true,
  dark = false,
  className,
}: ProjectStudioShellProps) {
  const [dockState, dispatch] = useReducer(reduceProjectStudioDock, {
    collapsed: defaultDockCollapsed,
  });
  const generatedDockId = useId();
  const dockId = agentDockId || generatedDockId;
  const hasAgentDock = agentDock !== undefined && agentDock !== null;
  const dockCollapsed = hasAgentDock
    ? controlledDockCollapsed ?? dockState.collapsed
    : true;

  function setDockCollapsed(nextCollapsed: boolean) {
    if (controlledDockCollapsed === undefined) {
      dispatch({ type: "set", collapsed: nextCollapsed });
    }
    onDockCollapsedChange?.(nextCollapsed);
  }

  return (
    <div
      className={shellClassName(dark, className)}
      data-dock-collapsed={dockCollapsed ? "true" : "false"}
      data-has-agent-dock={hasAgentDock ? "true" : "false"}
      data-navigation-collapsed={navigationCollapsed ? "true" : "false"}
    >
      <div className="projectStudioNavSlot">{navigation}</div>

      {hasAgentDock ? (
        <section
          className="projectStudioAgentDock"
          id={dockId}
          aria-label={dockAriaLabel}
          aria-hidden={dockCollapsed}
        >
          <div className="projectStudioAgentDockInner">{agentDock}</div>
        </section>
      ) : null}

      {hasAgentDock && showDockToggle ? (
        <button
          className="projectStudioDockToggle"
          type="button"
          aria-label={dockCollapsed ? "展开 Agent 对话" : "收起 Agent 对话"}
          title={dockCollapsed ? "展开 Agent 对话" : "收起 Agent 对话"}
          aria-expanded={!dockCollapsed}
          aria-controls={dockId}
          onClick={() => setDockCollapsed(!dockCollapsed)}
        >
          {dockCollapsed ? (
            <><span className="projectStudioDockLabel">Agent 对话</span><ChevronRight size={17} aria-hidden="true" /></>
          ) : (
            <ChevronLeft size={17} aria-hidden="true" />
          )}
        </button>
      ) : null}

      <div className="projectStudioMain" role="region" aria-label={mainAriaLabel}>
        {children}
      </div>
    </div>
  );
}

export default ProjectStudioShell;
