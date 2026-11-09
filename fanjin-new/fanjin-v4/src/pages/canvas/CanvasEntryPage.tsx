import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { ProjectStudioShell } from "../../components/project-studio";
import { useV4Theme } from "../../ui/useV4Theme";
import InfiniteCanvasStable from "../fjtv/InfiniteCanvasStable";
import FrontstageNav from "../frontstage/FrontstageNav";
import GeneratePage from "../generate/GeneratePage";
// import CanvasEditorRefactored from "../fjtv/CanvasEditorRefactored"; // 新画布（暂时禁用）
import "../assets/AssetListPage.css";
import "./CanvasEntryPage.css";

export type CanvasEntryPageProps = {
  activeMode?: "agent" | "canvas";
};

export type StudioNavigationEntryState = {
  fromFrontstage?: boolean;
  studioModeSwitch?: boolean;
  brief?: string;
};

export const DEFAULT_STUDIO_NAVIGATION_COLLAPSED = true;

const PROJECT_STUDIO_AGENT_DOCK_ID = "project-studio-agent-dock";
const PROJECT_STUDIO_COMPACT_QUERY = "(max-width: 1024px)";

export type StudioPanelState = {
  compact: boolean;
  dockCollapsed: boolean;
  assetManagerOpen: boolean;
};

export type StudioPanelAction =
  | { type: "viewport"; compact: boolean }
  | { type: "toggleAgent" }
  | { type: "toggleAssets" }
  | { type: "syncAssets"; open: boolean }
  | { type: "setDockCollapsed"; collapsed: boolean };

export function reduceStudioPanels(
  state: StudioPanelState,
  action: StudioPanelAction,
): StudioPanelState {
  switch (action.type) {
    case "viewport":
      if (action.compact === state.compact) return state;
      return {
        ...state,
        compact: action.compact,
        dockCollapsed: action.compact ? true : state.dockCollapsed,
      };
    case "toggleAgent": {
      const expanding = state.dockCollapsed;
      return {
        ...state,
        dockCollapsed: !state.dockCollapsed,
        assetManagerOpen: expanding && state.compact ? false : state.assetManagerOpen,
      };
    }
    case "toggleAssets": {
      const opening = !state.assetManagerOpen;
      return {
        ...state,
        dockCollapsed: opening && state.compact ? true : state.dockCollapsed,
        assetManagerOpen: opening,
      };
    }
    case "syncAssets":
      return {
        ...state,
        dockCollapsed: action.open && state.compact ? true : state.dockCollapsed,
        assetManagerOpen: action.open,
      };
    case "setDockCollapsed":
      return {
        ...state,
        dockCollapsed: action.collapsed,
        assetManagerOpen: !action.collapsed && state.compact ? false : state.assetManagerOpen,
      };
  }
}

export function shouldCloseAssetManagerForDockExpansion(
  state: StudioPanelState,
  nextDockCollapsed: boolean,
): boolean {
  return state.compact && !nextDockCollapsed && state.assetManagerOpen;
}

export function shouldInitializeAgentDock(
  activeMode: "agent" | "canvas",
  initialized: boolean,
  dockCollapsed: boolean,
): boolean {
  return activeMode === "agent" && !initialized && dockCollapsed;
}

function initialStudioPanelState(activeMode: "agent" | "canvas"): StudioPanelState {
  if (typeof window === "undefined") {
    return {
      compact: false,
      dockCollapsed: activeMode !== "agent",
      assetManagerOpen: true,
    };
  }
  const compact = window.matchMedia(PROJECT_STUDIO_COMPACT_QUERY).matches;
  return {
    compact,
    // Canvas is the primary surface for canvas mode. Agent stays available as
    // a dock, but only the dedicated Agent route opens it automatically.
    dockCollapsed: activeMode !== "agent"
      || window.matchMedia("(max-width: 820px)").matches
      || compact,
    assetManagerOpen: window.matchMedia("(min-width: 821px)").matches,
  };
}

export default function CanvasEntryPage({ activeMode = "canvas" }: CanvasEntryPageProps) {
  const location = useLocation();
  const theme = useV4Theme();
  const dark = theme.mode === "dark";
  const [panels, dispatchPanels] = useReducer(
    reduceStudioPanels,
    activeMode,
    initialStudioPanelState,
  );
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  const agentModeInitializedRef = useRef(false);
  const { dockCollapsed } = panels;
  const [navigationCollapsed, setNavigationCollapsed] = useState(DEFAULT_STUDIO_NAVIGATION_COLLAPSED);
  const [assetManagerCloseRequest, setAssetManagerCloseRequest] = useState(0);
  const entryState = location.state as StudioNavigationEntryState | null;
  const initialBrief = typeof entryState?.brief === "string" ? entryState.brief.trim() : "";

  useEffect(() => {
    const compactQuery = window.matchMedia(PROJECT_STUDIO_COMPACT_QUERY);
    const syncViewport = (event: MediaQueryListEvent | MediaQueryList) => {
      dispatchPanels({ type: "viewport", compact: event.matches });
    };
    syncViewport(compactQuery);
    compactQuery.addEventListener("change", syncViewport);
    return () => compactQuery.removeEventListener("change", syncViewport);
  }, []);

  const setDockCollapsed = useCallback((collapsed: boolean) => {
    if (shouldCloseAssetManagerForDockExpansion(panelsRef.current, collapsed)) {
      setAssetManagerCloseRequest((request) => request + 1);
    }
    dispatchPanels({ type: "setDockCollapsed", collapsed });
  }, []);

  useEffect(() => {
    if (activeMode !== "agent") {
      agentModeInitializedRef.current = false;
      return;
    }
    if (agentModeInitializedRef.current) return;

    const shouldExpand = shouldInitializeAgentDock(
      activeMode,
      agentModeInitializedRef.current,
      dockCollapsed,
    );
    agentModeInitializedRef.current = true;
    if (shouldExpand) setDockCollapsed(false);
  }, [activeMode, dockCollapsed, setDockCollapsed]);

  const handleAssetManagerOpenChange = useCallback((open: boolean) => {
    dispatchPanels({ type: "syncAssets", open });
  }, []);

  return (
    <main className={`assetFrontPage canvasEntryPage ${dark ? "themeDark" : "themeLight"}`}>
      <section className="assetFrontShell">
        <ProjectStudioShell
          className="fanjinCanvasEntry"
          dark={dark}
          navigationCollapsed={navigationCollapsed}
          navigation={(
            <FrontstageNav
              active={activeMode === "agent" ? "generate" : "canvas"}
              dark={dark}
              onCollapsedChange={setNavigationCollapsed}
              onToggleDark={theme.toggle}
            />
          )}
          agentDock={<GeneratePage embedded />}
          agentDockId={PROJECT_STUDIO_AGENT_DOCK_ID}
          dockCollapsed={dockCollapsed}
          onDockCollapsedChange={setDockCollapsed}
          showDockToggle
          dockAriaLabel="项目 Agent 对话"
          mainAriaLabel={dockCollapsed ? "无限画布工作区" : "Agent 与无限画布工作区"}
        >
          <section className="fanjinCanvasEntrySurface">
            <InfiniteCanvasStable
              studioChrome
              studioMode={activeMode}
              studioProjectHeaderInAgent={!dockCollapsed}
              initialBrief={initialBrief}
              assetManagerCloseRequest={assetManagerCloseRequest}
              onAssetManagerOpenChange={handleAssetManagerOpenChange}
            />
          </section>
        </ProjectStudioShell>
      </section>
    </main>
  );
}
