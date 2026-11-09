// projectStore：项目状态，从旧 Vue src/stores/project.ts 迁移。
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ApiErrorView } from "../api/http";
import { toApiErrorView } from "../api/http";
import * as projectsApi from "../api/projects";
import type { Project } from "../api/types";

type ProjectState = {
  projects: Project[];
  currentProjectId: number | null;
  currentProject: Project | null;
  /** Persisted owner of currentProjectId: [userId, workspaceId]. */
  selectionScope: string | null;
  loading: boolean;
  error: ApiErrorView | null;

  fetchProjects: () => Promise<void>;
  /** Bind persisted selection to an authoritative auth/workspace scope. */
  bindSelectionScope: (scope: string | null) => boolean;
  /** 工作区切换时同步清空旧项目，并使所有在途项目请求失效。 */
  resetWorkspaceProjects: () => void;
  selectProject: (id: string | number) => void;
  /** 刷新项目列表并选中指定项目，用于 Materialize 后安全切换 */
  refreshAndSelectProject: (
    id: string | number,
    options?: RefreshAndSelectProjectOptions,
  ) => Promise<void>;
  removeProject: (id: string | number) => void;
  clearProject: () => void;
};

export type RefreshAndSelectProjectOptions = {
  /** 请求发起时选中的项目；网络返回时若已变化，禁止覆盖用户的新选择。 */
  expectedCurrentProjectId?: string | number | null;
  /** 调用方自己的 request/project epoch 仍然有效时才允许提交 Store。 */
  shouldCommit?: () => boolean;
  /** 所有提交护栏通过后、Store 写入前同步执行。 */
  onBeforeCommit?: () => void;
  /** Store 写入及同步订阅者执行完成后调用，用于认领受控的内部项目切换。 */
  onAfterCommit?: () => void;
};

export class StaleProjectSelectionError extends Error {
  constructor() {
    super("项目已切换，已取消过期的项目选择请求");
    this.name = "StaleProjectSelectionError";
  }
}

let projectListRequestId = 0;
let refreshAndSelectRequestId = 0;
let activeProjectListController: AbortController | null = null;
let activeRefreshAndSelectController: AbortController | null = null;
const removedProjectIds = new Set<number>();

/** 后端项目接口统一要求数字 ID；同时兼容 select 和旧持久化数据里的字符串值。 */
export function normalizeProjectId(id: string | number | null | undefined): number | null {
  if (id === null || id === undefined || id === "") return null;
  const normalized = Number(id);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
  projects: [],
  currentProjectId: null,
  currentProject: null,
  selectionScope: null,
  loading: false,
  error: null,

  fetchProjects: async () => {
    activeProjectListController?.abort();
    const controller = new AbortController();
    activeProjectListController = controller;
    const requestId = ++projectListRequestId;
    set({ loading: true, error: null });
    try {
      const projects = (await projectsApi.listProjects(controller.signal))
        .filter((project) => !removedProjectIds.has(Number(project.id)));
      if (requestId !== projectListRequestId) return;
      const currentProjectId = normalizeProjectId(get().currentProjectId);
      const currentProject = currentProjectId !== null
        ? projects.find((p) => String(p.id) === String(currentProjectId)) ?? null
        : null;
      set({
        projects,
        currentProjectId: currentProject ? currentProjectId : null,
        // 如果之前选过项目，刷新列表后重新匹配
        currentProject,
      });
    } catch (e) {
      if (requestId !== projectListRequestId) return;
      set({ error: toApiErrorView(e) });
    } finally {
      if (activeProjectListController === controller) activeProjectListController = null;
      if (requestId === projectListRequestId) set({ loading: false });
    }
  },

  bindSelectionScope: (scope) => {
    const normalizedScope = typeof scope === "string" && scope.trim() ? scope : null;
    if (get().selectionScope === normalizedScope) return false;

    activeProjectListController?.abort();
    activeProjectListController = null;
    activeRefreshAndSelectController?.abort();
    activeRefreshAndSelectController = null;
    projectListRequestId += 1;
    refreshAndSelectRequestId += 1;
    removedProjectIds.clear();
    set({
      projects: [],
      currentProjectId: null,
      currentProject: null,
      selectionScope: normalizedScope,
      loading: false,
      error: null,
    });
    return true;
  },

  resetWorkspaceProjects: () => {
    activeProjectListController?.abort();
    activeProjectListController = null;
    activeRefreshAndSelectController?.abort();
    activeRefreshAndSelectController = null;
    projectListRequestId += 1;
    refreshAndSelectRequestId += 1;
    removedProjectIds.clear();
    set({
      projects: [],
      currentProjectId: null,
      currentProject: null,
      loading: false,
      error: null,
    });
  },

  /** selectProject 立即生效，不需要 await，Codex 直接消费。 */
  selectProject: (id) => {
    activeRefreshAndSelectController?.abort();
    activeRefreshAndSelectController = null;
    refreshAndSelectRequestId += 1;
    const { projects } = get();
    const currentProjectId = normalizeProjectId(id);
    set({
      currentProjectId,
      currentProject: currentProjectId !== null
        ? projects.find((p) => String(p.id) === String(currentProjectId)) ?? null
        : null,
      loading: false,
    });
  },

  /**
   * 刷新项目列表并选中指定项目。
   * 用于 Materialize 后安全切换到新项目。
   * 如果项目不存在或用户无权限，抛出错误。
   */
  refreshAndSelectProject: async (id, options) => {
    const targetId = normalizeProjectId(id);
    if (targetId === null) {
      set({ error: { message: "无效的项目 ID" } });
      throw new Error("无效的项目 ID");
    }

    activeRefreshAndSelectController?.abort();
    const controller = new AbortController();
    activeRefreshAndSelectController = controller;
    const requestId = ++refreshAndSelectRequestId;
    const hasExpectedProject = Object.prototype.hasOwnProperty.call(
      options ?? {},
      "expectedCurrentProjectId",
    );
    const expectedProjectId = normalizeProjectId(options?.expectedCurrentProjectId);
    const canCommit = () => (
      requestId === refreshAndSelectRequestId
      && (!hasExpectedProject || normalizeProjectId(get().currentProjectId) === expectedProjectId)
      && (options?.shouldCommit?.() ?? true)
    );

    set({ loading: true, error: null });
    try {
      const projects = (await projectsApi.listProjects(controller.signal))
        .filter((project) => !removedProjectIds.has(Number(project.id)));
      if (!canCommit()) throw new StaleProjectSelectionError();
      const targetProject = projects.find((p) => Number(p.id) === targetId) ?? null;

      if (!targetProject) {
        set({ projects, loading: false, error: { message: "项目不存在或无权限访问" } });
        throw new Error("项目不存在或无权限访问");
      }

      options?.onBeforeCommit?.();
      if (!canCommit()) throw new StaleProjectSelectionError();
      set({
        projects,
        currentProjectId: targetId,
        currentProject: targetProject,
        loading: false,
      });
      options?.onAfterCommit?.();
    } catch (e) {
      if (e instanceof StaleProjectSelectionError || !canCommit()) {
        if (requestId === refreshAndSelectRequestId) set({ loading: false });
        throw e instanceof StaleProjectSelectionError ? e : new StaleProjectSelectionError();
      }
      if (e instanceof Error && e.message.includes("不存在")) {
        throw e;
      }
      const error = toApiErrorView(e);
      set({ loading: false, error });
      throw e;
    } finally {
      if (activeRefreshAndSelectController === controller) activeRefreshAndSelectController = null;
    }
  },

  removeProject: (id) => {
    const targetId = normalizeProjectId(id);
    if (targetId === null) return;
    removedProjectIds.add(targetId);
    set((state) => {
      const deletingCurrentProject = state.currentProjectId === targetId;
      return {
        projects: state.projects.filter((project) => Number(project.id) !== targetId),
        currentProjectId: deletingCurrentProject ? null : state.currentProjectId,
        currentProject: deletingCurrentProject ? null : state.currentProject,
        loading: false,
      };
    });
  },

  clearProject: () => {
    activeRefreshAndSelectController?.abort();
    activeRefreshAndSelectController = null;
    refreshAndSelectRequestId += 1;
    set({ currentProjectId: null, currentProject: null, loading: false });
  },
}),
    {
      name: "fanjin-project",
      partialize: (state) => ({
        currentProjectId: state.currentProjectId,
        selectionScope: state.selectionScope,
      }),
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<ProjectState>;
        return {
          ...currentState,
          ...persisted,
          currentProjectId: normalizeProjectId(persisted.currentProjectId),
          currentProject: null,
          selectionScope: typeof persisted.selectionScope === "string"
            ? persisted.selectionScope
            : null,
        };
      },
    }
  )
);
