// workspaceStore：工作区状态，从旧 Vue src/stores/workspace.ts 迁移。
// workspace 列表不在这里独立拉，而是由 authStore.fetchMe() → applySession() 同步过来。
// selectWorkspace 会调后端 /workspace/switch，返回新会话，再同步回 authStore。
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ApiErrorView } from "../api/http";
import { toApiErrorView } from "../api/http";
import * as workspaceApi from "../api/workspace";
import type { Workspace } from "../api/types";
import { useAuthStore } from "./authStore";
import { useProjectStore } from "./projectStore";

type WorkspaceState = {
  workspaces: Workspace[];
  currentWorkspaceId: string | number | null;
  loading: boolean;
  error: ApiErrorView | null;

  /** 由 authStore.fetchMe() 调用，不要从页面直接调。 */
  applySession: (workspaces: Workspace[], currentWorkspaceId: string | number | null) => void;
  fetchWorkspaces: () => Promise<void>;
  createWorkspace: (payload: workspaceApi.CreateWorkspacePayload) => Promise<void>;
  selectWorkspace: (id: string | number) => Promise<void>;
  reset: () => void;
};

let workspaceSwitchSequence = 0;

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
  workspaces: [],
  currentWorkspaceId: null,
  loading: false,
  error: null,

  applySession: (workspaces, currentWorkspaceId) => {
    set({ workspaces, currentWorkspaceId });
  },

  fetchWorkspaces: async () => {
    // 委托给 authStore.fetchMe()，它会自动调 applySession
    await useAuthStore.getState().fetchMe();
  },

  createWorkspace: async (payload) => {
    const requestSequence = ++workspaceSwitchSequence;
    set({ loading: true, error: null });
    try {
      const session = await workspaceApi.createWorkspace(payload);
      if (requestSequence !== workspaceSwitchSequence) return;
      useProjectStore.getState().resetWorkspaceProjects();
      const auth = useAuthStore.getState();
      auth.applySession({ ...session, user: session.user ?? auth.user }, session.workspace?.id ?? null);
    } catch (e) {
      if (requestSequence !== workspaceSwitchSequence) return;
      set({ error: toApiErrorView(e) });
      throw e;
    } finally {
      if (requestSequence === workspaceSwitchSequence) set({ loading: false });
    }
  },

  selectWorkspace: async (id) => {
    if (get().loading || String(get().currentWorkspaceId) === String(id)) return;
    const requestSequence = ++workspaceSwitchSequence;
    set({ loading: true, error: null });
    try {
      const session = await workspaceApi.switchWorkspace({ workspaceId: String(id) });
      if (requestSequence !== workspaceSwitchSequence) return;
      // A workspace session is authoritative for project visibility. Clear the
      // previous workspace's selection before publishing the new session so an
      // empty target workspace renders its empty state instead of a stale
      // "project does not exist" route.
      useProjectStore.getState().resetWorkspaceProjects();
      // 新会话是当前工作区的权威状态；同时作废仍在途的旧 /auth/me。
      const auth = useAuthStore.getState();
      auth.applySession({ ...session, user: session.user ?? auth.user }, id);
    } catch (e) {
      if (requestSequence !== workspaceSwitchSequence) return;
      set({ error: toApiErrorView(e) });
      throw e;
    } finally {
      if (requestSequence === workspaceSwitchSequence) set({ loading: false });
    }
  },

  reset: () => {
    workspaceSwitchSequence += 1;
    set({ workspaces: [], currentWorkspaceId: null, loading: false, error: null });
  },
}),
    {
      name: "fanjin-workspace",
      partialize: (state) => ({ currentWorkspaceId: state.currentWorkspaceId }),
    }
  )
);
