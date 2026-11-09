import { type ReactNode, useEffect, useState } from "react";
import { Clock3, FolderOpen, type LucideIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useProjectStore } from "../../stores/projectStore";
import { useV4Theme } from "../../ui/useV4Theme";
import FrontstageNav, { type FrontstageNavKey } from "../frontstage/FrontstageNav";
import "../create/QuickCreateView.css";
import "../assets/AssetListPage.css";
import "./WritingWorkspace.css";

type WritingWorkspaceFrameProps = {
  active: Extract<FrontstageNavKey, "novel" | "script">;
  eyebrow: string;
  title: string;
  description: string;
  actionLabel: string;
  actionTestId: string;
  actionIcon: LucideIcon;
  onAction: () => void;
  children: ReactNode;
};

export default function WritingWorkspaceFrame({
  active,
  eyebrow,
  title,
  description,
  actionLabel,
  actionTestId,
  actionIcon: ActionIcon,
  onAction,
  children,
}: WritingWorkspaceFrameProps) {
  const navigate = useNavigate();
  const theme = useV4Theme();
  const dark = theme.mode === "dark";
  const projects = useProjectStore((state) => state.projects);
  const currentProject = useProjectStore((state) => state.currentProject);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const fetchProjects = useProjectStore((state) => state.fetchProjects);
  const selectProject = useProjectStore((state) => state.selectProject);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => current === message ? "" : current), 2400);
  }

  return (
    <main className={`assetFrontPage writingWorkspacePage ${dark ? "themeDark" : "themeLight"}`}>
      <section className="assetFrontShell">
        <FrontstageNav active={active} dark={dark} onToggleDark={theme.toggle} onNotice={showNotice} />

        <div className="assetFrontMain writingWorkspaceMain">
          <header className="writingWorkspaceHeader">
            <div className="writingWorkspaceTitle">
              <span>{eyebrow}</span>
              <h1>{title}</h1>
              <p>{currentProject?.name || description}</p>
            </div>

            <div className="writingWorkspaceHeaderActions">
              <label className="writingWorkspaceProjectSelect">
                <FolderOpen size={17} aria-hidden="true" />
                <select
                  aria-label="当前项目"
                  value={currentProjectId === null ? "" : String(currentProjectId)}
                  onChange={(event) => {
                    if (event.target.value) selectProject(event.target.value);
                  }}
                >
                  <option value="" disabled>选择项目</option>
                  {projects.map((project) => (
                    <option key={String(project.id)} value={String(project.id)}>{project.name}</option>
                  ))}
                </select>
              </label>
              <button className="writingWorkspaceSecondaryAction" type="button" onClick={() => navigate("/workbench/project")}>
                <Clock3 size={17} aria-hidden="true" />
                项目
              </button>
              <button className="writingWorkspacePrimaryAction" data-testid={actionTestId} type="button" onClick={onAction}>
                <ActionIcon size={17} aria-hidden="true" />
                {actionLabel}
              </button>
            </div>
          </header>

          {children}
        </div>
      </section>

      {notice ? <div className="jimengToast" role="status">{notice}</div> : null}
    </main>
  );
}
