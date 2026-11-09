import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listProjects } from "../api/projects";

export type AuthorizedProjectOption = {
  id: number;
  name: string;
};

type ProjectSnapshot = {
  workspaceId: string;
  projects: AuthorizedProjectOption[];
  loading: boolean;
  error: string;
};

type ProjectSelection = {
  workspaceId: string;
  projectId: number | null;
};

function normalizeAuthorizedProjects(
  projects: Awaited<ReturnType<typeof listProjects>>,
): AuthorizedProjectOption[] {
  const seen = new Set<number>();
  const result: AuthorizedProjectOption[] = [];
  for (const project of projects) {
    const id = Number(project.id);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      name: String(project.name || "").trim() || `项目 ${id}`,
    });
  }
  return result;
}

/**
 * Loads only active projects returned for the authenticated workspace and
 * requires the operator to choose one explicitly. It never selects the first
 * project, restores a persisted project, or invents a fallback ID.
 */
export function useAuthorizedProjectSelection(workspaceIdInput: string | null | undefined) {
  const workspaceId = String(workspaceIdInput || "");
  const requestSequence = useRef(0);
  const [retryRevision, setRetryRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<ProjectSnapshot>({
    workspaceId: "",
    projects: [],
    loading: false,
    error: "",
  });
  const [selection, setSelection] = useState<ProjectSelection>({
    workspaceId: "",
    projectId: null,
  });

  useEffect(() => {
    const sequence = ++requestSequence.current;
    const controller = new AbortController();
    setSelection({ workspaceId, projectId: null });
    if (!workspaceId) {
      setSnapshot({ workspaceId, projects: [], loading: false, error: "" });
      return () => controller.abort();
    }

    setSnapshot({ workspaceId, projects: [], loading: true, error: "" });
    void listProjects(controller.signal)
      .then((projects) => {
        if (controller.signal.aborted || sequence !== requestSequence.current) return;
        setSnapshot({
          workspaceId,
          projects: normalizeAuthorizedProjects(projects),
          loading: false,
          error: "",
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || sequence !== requestSequence.current) return;
        const aborted = error instanceof Error && error.name === "AbortError";
        if (aborted) return;
        setSnapshot({
          workspaceId,
          projects: [],
          loading: false,
          error: "活动项目权限读取失败，请重试。",
        });
      });

    return () => controller.abort();
  }, [retryRevision, workspaceId]);

  const projects = snapshot.workspaceId === workspaceId ? snapshot.projects : [];
  const loading = snapshot.workspaceId === workspaceId && snapshot.loading;
  const error = snapshot.workspaceId === workspaceId ? snapshot.error : "";
  const selectedProjectId = selection.workspaceId === workspaceId
    && selection.projectId !== null
    && projects.some((project) => project.id === selection.projectId)
    ? selection.projectId
    : null;

  const selectProject = useCallback((value: string | number | null) => {
    const normalized = value === null ? null : Number(value);
    const projectId = normalized !== null
      && Number.isSafeInteger(normalized)
      && normalized > 0
      && projects.some((project) => project.id === normalized)
      ? normalized
      : null;
    setSelection({ workspaceId, projectId });
  }, [projects, workspaceId]);

  return useMemo(() => ({
    projects,
    selectedProjectId,
    selectProject,
    loading,
    error,
    retry: () => setRetryRevision((revision) => revision + 1),
  }), [error, loading, projects, selectProject, selectedProjectId]);
}
