import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  Clapperboard,
  Clock3,
  FileText,
  FolderKanban,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  UsersRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useSessionStore } from "../../features/quick-create/session/sessionStore";
import QuickWorkflowSessionPanel from "../../features/quick-create/QuickWorkflowSessionPanel";
import {
  PortraitAdmissionPanel,
  type PortraitAdmissionAsset,
} from "../../features/portrait-admission/PortraitAdmissionPanel";
import { StudioModeSwitcher } from "../../components/project-studio";
import { buildProjectModeHref, readProjectModeRouteContext } from "../../routes/projectModeRoutes";
import { useProjectStore } from "../../stores/projectStore";
import { useV4Theme } from "../../ui/useV4Theme";
import FrontstageNav from "../frontstage/FrontstageNav";
import ScriptPage from "../script";
import CornerScapePage from "../cornerScape/CornerScapePage";
import AddProject from "./components/AddProject";
import ProjectProfileWorkbench from "./ProjectProfileWorkbench";
import StoryboardWorkbench from "./StoryboardWorkbench";
import ProductionWorkbench from "./ProductionWorkbench";
import ClipWorkbench from "./ClipWorkbench";
import QuickModeOverview from "./QuickModeOverview";
import "../create/QuickCreateView.css";
import "../assets/AssetListPage.css";
import "./QuickCreationWorkbench.css";

export const QUICK_STAGE_IDS = [
  "project",
  "script",
  "characters",
  "storyboard",
  "production",
  "clip",
] as const;

type QuickStageId = (typeof QUICK_STAGE_IDS)[number];

type QuickStage = {
  id: QuickStageId;
  label: string;
  description: string;
  icon: LucideIcon;
};

const stages: QuickStage[] = [
  { id: "project", label: "项目", description: "基础设定", icon: FolderKanban },
  { id: "script", label: "剧本", description: "场次与文本", icon: FileText },
  { id: "characters", label: "角色场景", description: "角色、场景、道具", icon: UsersRound },
  { id: "storyboard", label: "分镜", description: "镜头与画面", icon: Clapperboard },
  { id: "production", label: "视频生成", description: "镜头成片", icon: Workflow },
  { id: "clip", label: "剪辑", description: "成片交付", icon: Scissors },
];

const projectRequiredTargets = new Map([
  ["/workbench/novel", "小说"],
  ["/workbench/script", "剧本"],
  ["/workbench/production", "生产工作台"],
  ["/workbench/corner-scape", "角色场景"],
]);

const projectIdentityQueryKeys = ["projectId", "sessionId", "thread", "threadId", "canvasId"] as const;

export function quickStageFromSearch(search: string): QuickStageId | null {
  const stage = new URLSearchParams(search).get("stage");
  return QUICK_STAGE_IDS.includes(stage as QuickStageId) ? stage as QuickStageId : null;
}

export function quickStageSearch(search: string, stage: QuickStageId | null): string {
  const next = new URLSearchParams(search);
  if (stage) next.set("stage", stage);
  else next.delete("stage");
  const serialized = next.toString();
  return serialized ? `?${serialized}` : "";
}

export function readProjectRequiredRedirect(search: string): { href: string; label: string } | null {
  const raw = new URLSearchParams(search).get("redirect")?.trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  try {
    const parsed = new URL(raw, "https://fanjin.local");
    if (parsed.origin !== "https://fanjin.local") return null;
    const canonicalPathname = parsed.pathname.replace(/\/+$/, "").toLowerCase() || "/";
    const label = projectRequiredTargets.get(canonicalPathname);
    if (!label) return null;
    projectIdentityQueryKeys.forEach((key) => parsed.searchParams.delete(key));
    return { href: `${canonicalPathname}${parsed.search}`, label };
  } catch {
    return null;
  }
}

function withoutProjectRedirect(search: string) {
  const next = new URLSearchParams(search);
  next.delete("projectRequired");
  next.delete("redirect");
  const serialized = next.toString();
  return serialized ? `?${serialized}` : "";
}

function projectTimestamp(project: Record<string, unknown>) {
  return Number(project.updatedAt || project.createTime || project.createdAt || 0);
}

function sessionPortraitAssets(
  session: ReturnType<typeof useSessionStore.getState>["session"],
  projectId: string | number | null,
): PortraitAdmissionAsset[] {
  if (!session || projectId === null || String(session.projectId) !== String(projectId)) return [];
  const parameters = session.parameters;
  if (!parameters || typeof parameters !== "object") return [];
  const attachments = parameters.uploadedAttachments;
  if (!Array.isArray(attachments)) return [];

  return attachments.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const attachment = value as Record<string, unknown>;
    const assetVersionId = Number(attachment.assetVersionId);
    const mediaType = attachment.type;
    if (!Number.isSafeInteger(assetVersionId) || assetVersionId <= 0) return [];
    if (mediaType !== "image" && mediaType !== "video") return [];
    return [{
      assetVersionId,
      name: String(attachment.name || `素材 ${assetVersionId}`),
      previewUrl: typeof attachment.previewUrl === "string" ? attachment.previewUrl : undefined,
      mediaType,
    }];
  });
}

export default function ProjectPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const theme = useV4Theme();
  const dark = theme.mode === "dark";
  const projects = useProjectStore((state) => state.projects);
  const currentProject = useProjectStore((state) => state.currentProject);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const loading = useProjectStore((state) => state.loading);
  const error = useProjectStore((state) => state.error);
  const fetchProjects = useProjectStore((state) => state.fetchProjects);
  const selectProject = useProjectStore((state) => state.selectProject);
  const clearProject = useProjectStore((state) => state.clearProject);
  const session = useSessionStore((state) => state.session);
  const boundSessionProjectId = useSessionStore((state) => state.boundProjectId);
  const [activeStage, setActiveStage] = useState<QuickStageId | null>(() => quickStageFromSearch(location.search));
  const [createOpen, setCreateOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [portraitAdmissionBlocking, setPortraitAdmissionBlocking] = useState(false);
  const projectRedirect = readProjectRequiredRedirect(location.search);
  const portraitAssets = useMemo(
    () => sessionPortraitAssets(session, currentProjectId),
    [currentProjectId, session],
  );

  useEffect(() => {
    if (!portraitAssets.length) setPortraitAdmissionBlocking(false);
  }, [portraitAssets.length]);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    const routedStage = quickStageFromSearch(location.search);
    setActiveStage((current) => current === routedStage ? current : routedStage);
  }, [location.search]);

  const visibleProjects = useMemo(() => {
    const query = projectQuery.trim().toLowerCase();
    return [...projects]
      .sort((a, b) => projectTimestamp(b as unknown as Record<string, unknown>) - projectTimestamp(a as unknown as Record<string, unknown>))
      .filter((project) => !query || `${project.name}${project.intro || ""}${project.type || ""}`.toLowerCase().includes(query));
  }, [projectQuery, projects]);

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => current === message ? "" : current), 2400);
  }

  function chooseProject(projectId: string | number) {
    selectProject(projectId);
    setActiveStage(null);
    if (projectRedirect) {
      navigate(projectRedirect.href, { replace: true });
      return;
    }
    navigate(buildProjectModeHref("quick", {
      projectId,
      sessionId: null,
      threadId: null,
      canvasId: null,
    }, withoutProjectRedirect(location.search)));
  }

  function clearSelectedProject() {
    const noProjectHref = buildProjectModeHref("quick", {
      projectId: null,
      sessionId: null,
      threadId: null,
      canvasId: null,
    }, quickStageSearch(location.search, null));
    // Commit the canonical no-project route before clearing the store. If the
    // old deep link remains current for one render, ProjectModeRouteSync can
    // otherwise re-select its project immediately after clearProject().
    navigate(noProjectHref, { replace: true, flushSync: true });
    clearProject();
    setActiveStage(null);
  }

  function openStage(stageId: QuickStageId | null) {
    if (!currentProject && stageId) return;
    if (portraitAdmissionBlocking && (stageId === "production" || stageId === "clip")) {
      showNotice("请先完成人物素材检查，再进入视频生成或剪辑");
      return;
    }
    setActiveStage(stageId);
    navigate(`${location.pathname}${quickStageSearch(location.search, stageId)}`);
  }

  function openExtractedAssets(savedAssetIds: number[]) {
    if (!currentProject) return;
    setActiveStage("characters");
    navigate(`${location.pathname}${quickStageSearch(location.search, "characters")}`, {
      state: {
        projectId: Number(currentProject.id),
        savedAssetIds,
      },
    });
  }

  function renderStage() {
    if (!currentProject || !activeStage) return null;
    if (activeStage === "project") {
      return (
        <div style={{ display: "grid", gap: 16 }}>
          <QuickWorkflowSessionPanel />
          <ProjectProfileWorkbench />
        </div>
      );
    }
    if (activeStage === "script") return <ScriptPage embedded onOpenAssetGeneration={openExtractedAssets} />;
    if (activeStage === "characters") return <CornerScapePage />;
    if (activeStage === "storyboard") {
      return (
        <StoryboardWorkbench
          showPreviousFlowAction
          showNextFlowAction
          onPreviousFlow={() => openStage("characters")}
          onNextFlow={() => openStage("production")}
        />
      );
    }
    if (activeStage === "production") {
      return (
        <ProductionWorkbench
          showPreviousFlowAction
          showClipWorkbenchAction
          onPreviousFlow={() => openStage("storyboard")}
          onOpenClipWorkbench={() => openStage("clip")}
        />
      );
    }
    return <ClipWorkbench />;
  }

  function openCanvasMode() {
    const routeContext = readProjectModeRouteContext(location);
    const projectId = routeContext.projectId ?? currentProjectId;
    const sessionMatchesProject = projectId !== null
      && projectId !== undefined
      && String(boundSessionProjectId) === String(projectId);
    navigate(buildProjectModeHref("canvas", {
      projectId,
      sessionId: routeContext.sessionId ?? (sessionMatchesProject ? session?.id : null),
      threadId: routeContext.threadId,
      canvasId: routeContext.canvasId ?? (sessionMatchesProject ? session?.canvasId : null),
    }, location.search), { state: { studioModeSwitch: true } });
  }

  return (
    <main data-testid="quick-mode-project-page" className={`assetFrontPage quickCreationPage ${dark ? "themeDark" : "themeLight"}`}>
      <section className="assetFrontShell">
        <FrontstageNav
          active="quick"
          dark={dark}
          onToggleDark={theme.toggle}
          onNotice={showNotice}
        />

        <div className="assetFrontMain quickCreationMain">
          <header className="quickCreationHeader">
            <div className="quickCreationTitle">
              <span>项目流程</span>
              <h1>{currentProject?.name || "项目工作台"}</h1>
            </div>

            <StudioModeSwitcher activeMode="quick" className="quickCreationModeSwitcher" />

            <div className="quickCreationHeaderActions">
              <label className="quickCreationProjectSelect">
                <FolderOpen size={17} />
                <select
                  aria-label="当前项目"
                  value={currentProjectId === null ? "" : String(currentProjectId)}
                  onChange={(event) => {
                    if (!event.target.value) {
                      clearSelectedProject();
                      return;
                    }
                    chooseProject(event.target.value);
                  }}
                >
                  <option value="">选择项目</option>
                  {projects.map((project) => (
                    <option key={String(project.id)} value={String(project.id)}>{project.name}</option>
                  ))}
                </select>
              </label>
              <button className="quickCreationSecondaryAction" type="button" aria-label="打开项目广场" onClick={() => navigate("/workbench/project")}>
                <Clock3 size={17} />
                <span className="quickCreationActionLabel">项目</span>
              </button>
              <button className="quickCreationPrimaryAction" type="button" aria-label="新建项目" onClick={() => setCreateOpen(true)}>
                <Plus size={17} />
                <span className="quickCreationActionLabel">新建项目</span>
              </button>
            </div>
          </header>

          <nav className="quickCreationFlow" aria-label="项目流程">
            {stages.map((stage, index) => {
              const Icon = stage.icon;
              const active = activeStage === stage.id;
              return (
                <button
                  key={stage.id}
                  data-testid={`quick-stage-${stage.id}`}
                  className={active ? "active" : ""}
                  type="button"
                  disabled={!currentProject || (portraitAdmissionBlocking && (stage.id === "production" || stage.id === "clip"))}
                  aria-current={active ? "step" : undefined}
                  onClick={() => openStage(stage.id)}
                >
                  <span className="quickCreationStepIndex">{index + 1}</span>
                  <Icon size={19} />
                  <span className="quickCreationStepCopy">
                    <strong>{stage.label}</strong>
                    <small>{stage.description}</small>
                  </span>
                </button>
              );
            })}
          </nav>

          <section className="quickCreationBody">
            {loading ? (
              <div className="quickCreationState">
                <Loader2 className="jimengSpin" size={26} />
                <span>正在载入项目</span>
              </div>
            ) : error ? (
              <div className="quickCreationState error">
                <AlertCircle size={27} />
                <strong>项目加载失败</strong>
                <button type="button" onClick={() => void fetchProjects()}>
                  <RefreshCw size={16} />
                  重试
                </button>
              </div>
            ) : !currentProject ? (
              <div className="quickCreationProjectPicker">
                {projectRedirect ? (
                  <div className="quickCreationProjectRequired" role="status" aria-live="polite">
                    <AlertCircle size={19} aria-hidden="true" />
                    <span>
                      <strong>请先选择项目</strong>
                      选择后将自动继续打开{projectRedirect.label}。
                    </span>
                  </div>
                ) : null}
                <div className="quickCreationPickerHeader">
                  <div>
                    <span>全部项目</span>
                    <h2>选择项目开始创作</h2>
                  </div>
                  <label className="quickCreationSearch">
                    <Search size={17} />
                    <input value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} placeholder="搜索项目" />
                  </label>
                </div>

                {visibleProjects.length ? (
                  <div className="quickCreationProjectGrid">
                    {visibleProjects.map((project) => (
                      <button key={String(project.id)} type="button" onClick={() => chooseProject(project.id)}>
                        <span className="quickCreationProjectInitial">{project.name.trim().slice(0, 1).toUpperCase() || "P"}</span>
                        <span className="quickCreationProjectCopy">
                          <strong>{project.name}</strong>
                          <small>{project.intro || project.type || "暂无简介"}</small>
                        </span>
                        <em>{project.videoRatio || "16:9"}</em>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="quickCreationEmpty">
                    <FolderKanban size={38} />
                    <strong>{projectQuery ? "没有匹配项目" : "还没有项目"}</strong>
                    {!projectQuery ? (
                      <button type="button" onClick={() => setCreateOpen(true)}>
                        <Plus size={17} />
                        新建项目
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            ) : (
              activeStage === null ? (
                <>
                  {portraitAssets.length ? (
                    <div className="quickCreationPortraitAdmission">
                      <PortraitAdmissionPanel
                        projectId={Number(currentProject.id)}
                        model={typeof session?.parameters?.videoModel === "string" ? session.parameters.videoModel : undefined}
                        assets={portraitAssets}
                        onBlockingChange={setPortraitAdmissionBlocking}
                      />
                    </div>
                  ) : null}
                  <QuickModeOverview
                    projectId={Number(currentProject.id)}
                    projectName={currentProject.name}
                    stages={stages}
                    updatedAt={currentProject.updatedAt || currentProject.createTime}
                    onOpenStage={(stageId) => openStage(stageId as QuickStageId)}
                    onOpenCanvas={openCanvasMode}
                  />
                </>
              ) : (
                <div
                  className="quickCreationStageSurface"
                  data-testid="quick-stage-surface"
                  data-quick-stage={activeStage}
                  data-project-correlation-digest={currentProject.correlationDigest || undefined}
                  key={`${currentProject.id}-${activeStage}`}
                >
                  <div className="quickCreationStageHeader">
                    <button className="quickCreationBackToOverview" type="button" onClick={() => openStage(null)}>
                      <ArrowLeft size={15} />
                      返回流程总览
                    </button>
                  </div>
                  {renderStage()}
                </div>
              )
            )}
          </section>
        </div>
      </section>

      <AddProject open={createOpen} onClose={() => setCreateOpen(false)} />
      {notice ? <div className="jimengToast">{notice}</div> : null}
    </main>
  );
}
