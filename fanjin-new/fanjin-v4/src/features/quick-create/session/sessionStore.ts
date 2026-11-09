import { create } from "zustand";
import { ApiError, type ApiErrorView, toApiErrorView } from "../../../api/http";
import type {
  CreationSessionDto,
  CreationSessionMode,
  CreationSessionPatch,
  CreationSessionUpdatePayload,
} from "./api";
import {
  ensureCurrentCreationSession,
  getCurrentCreationSession,
  updateCreationSession,
} from "./api";

type SessionState = {
  /** 当前项目的 Session，null 表示尚未加载 */
  session: CreationSessionDto | null;
  /** 正在确保当前项目 Session */
  loading: boolean;
  /** 当前项目存在排队或执行中的更新 */
  saving: boolean;
  /** 最近一次操作的错误 */
  error: ApiErrorView | null;
  /** 当前 Session 对应的 projectId，用于隔离项目切换 */
  boundProjectId: number | null;

  /** 拉取或创建项目 Session；失败时 reject */
  ensureSession: (projectId: number, preferredMode?: CreationSessionMode) => Promise<CreationSessionDto>;
  /** 串行、基于最新版本合并并保存 Session；失败时 reject */
  updateSession: (patch: CreationSessionPatch, options?: SessionSaveOptions) => Promise<CreationSessionDto>;
  /** updateSession 的语义化别名，供页面统一防抖保存 */
  saveSession: (patch: CreationSessionPatch, options?: SessionSaveOptions) => Promise<CreationSessionDto>;
  /** 切换创作模式 */
  setMode: (mode: CreationSessionMode) => Promise<CreationSessionDto>;
  /** 确保项目 Session 后原子激活指定模式，供三模式路由入口使用。 */
  activateMode: (projectId: number, mode: CreationSessionMode) => Promise<CreationSessionDto>;
  /** 清空状态（项目切换、登出时调用） */
  clear: () => void;
  /** 用户已处理可见错误时显式清除；不会修改 Session 数据。 */
  clearError: () => void;
};

export type SessionSaveOptions = {
  keepalive?: boolean;
};

type EnsureInFlight = {
  projectId: number;
  requestId: number;
  promise: Promise<CreationSessionDto>;
};

let ensureRequestId = 0;
let ensureInFlight: EnsureInFlight | null = null;
let modeActivationRequestId = 0;
let sessionContextGeneration = 0;
let sessionConflictGeneration = 0;
let updateTail: Promise<void> = Promise.resolve();
const pendingUpdates = new Map<string, number>();

function contextKey(projectId: number, sessionId: string) {
  return `${projectId}:${sessionId}`;
}

function enqueueUpdate<T>(operation: () => Promise<T>): Promise<T> {
  const result = updateTail.then(operation, operation);
  updateTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function sessionContextChangedError() {
  return new ApiError("项目或创作 Session 已切换，请在当前项目重试", {
    status: 409,
    code: "creation_session_context_changed",
  });
}

function sessionConflictError(code: string, message: string) {
  return new ApiError(message, { status: 409, code });
}

function buildUpdatePayload(
  session: CreationSessionDto,
  patch: CreationSessionPatch,
): CreationSessionUpdatePayload {
  return {
    expectedVersion: session.version,
    ...patch,
    ...(patch.parameters === undefined
      ? {}
      : { parameters: { ...(session.parameters ?? {}), ...patch.parameters } }),
  };
}

export const useSessionStore = create<SessionState>()((set, get) => {
  const updateSession = (
    patch: CreationSessionPatch,
    options: SessionSaveOptions = {},
  ): Promise<CreationSessionDto> => {
    const initial = get();
    if (!initial.session || !initial.boundProjectId) {
      const error = new ApiError("Session 未加载", {
        status: 409,
        code: "creation_session_not_loaded",
      });
      set({ error: toApiErrorView(error) });
      return Promise.reject(error);
    }

    const projectId = initial.boundProjectId;
    const sessionId = initial.session.id;
    const key = contextKey(projectId, sessionId);
    const queuedContextGeneration = sessionContextGeneration;
    const queuedConflictGeneration = sessionConflictGeneration;
    pendingUpdates.set(key, (pendingUpdates.get(key) ?? 0) + 1);
    set({ saving: true, error: null });

    const execute = async (): Promise<CreationSessionDto> => {
      const current = get();
      if (
        current.boundProjectId !== projectId
        || current.session?.id !== sessionId
      ) {
        throw sessionContextChangedError();
      }
      if (
        sessionContextGeneration !== queuedContextGeneration
        || sessionConflictGeneration !== queuedConflictGeneration
      ) {
        throw sessionConflictError(
          "creation_session_conflict_pending_recovery",
          "其他标签页已更新草稿，已停止旧版本的排队保存。请检查最新内容后再重试。",
        );
      }

      const sendUpdate = (base: CreationSessionDto) => options.keepalive
        ? updateCreationSession(
            projectId,
            sessionId,
            buildUpdatePayload(base, patch),
            options,
          )
        : updateCreationSession(
            projectId,
            sessionId,
            buildUpdatePayload(base, patch),
          );

      let updated: CreationSessionDto;
      try {
        updated = await sendUpdate(current.session);
      } catch (error) {
        const view = toApiErrorView(error);
        if (view.status !== 409 || view.code !== "creation_session_version_conflict") throw error;

        sessionConflictGeneration += 1;
        let refreshed: CreationSessionDto | null;
        try {
          refreshed = await getCurrentCreationSession(projectId);
        } catch {
          throw sessionConflictError(
            "creation_session_conflict_refresh_failed",
            "检测到其他标签页已更新草稿，但暂时无法载入远端最新版本。已停止保存，请稍后重试同步。",
          );
        }
        if (!refreshed || refreshed.id !== sessionId) {
          throw sessionContextChangedError();
        }
        const latest = get();
        if (latest.boundProjectId !== projectId || latest.session?.id !== sessionId) {
          throw sessionContextChangedError();
        }
        set({ session: refreshed });
        throw sessionConflictError(
          "creation_session_conflict_refreshed",
          "检测到其他标签页已更新该草稿。已载入远端最新版本，本页修改尚未覆盖远端；请确认后重试保存。",
        );
      }

      if (sessionContextGeneration !== queuedContextGeneration) {
        throw sessionContextChangedError();
      }

      const latest = get();
      if (latest.boundProjectId === projectId && latest.session?.id === sessionId) {
        set({ session: updated, error: null });
      }
      return updated;
    };

    return enqueueUpdate(execute)
      .catch((error) => {
        const latest = get();
        if (
          sessionContextGeneration === queuedContextGeneration
          && latest.boundProjectId === projectId
          && latest.session?.id === sessionId
        ) {
          set({ error: toApiErrorView(error) });
        }
        throw error;
      })
      .finally(() => {
        const remaining = Math.max(0, (pendingUpdates.get(key) ?? 1) - 1);
        if (remaining) pendingUpdates.set(key, remaining);
        else pendingUpdates.delete(key);

        const latest = get();
        if (
          sessionContextGeneration === queuedContextGeneration
          && latest.boundProjectId === projectId
          && latest.session?.id === sessionId
        ) {
          set({ saving: remaining > 0 });
        }
      });
  };

  return {
    session: null,
    loading: false,
    saving: false,
    error: null,
    boundProjectId: null,

    ensureSession: async (projectId: number, preferredMode: CreationSessionMode = "quick_create") => {
      const current = get();
      if (current.boundProjectId === projectId && current.session) {
        return current.session;
      }
      if (
        current.boundProjectId === projectId
        && ensureInFlight?.projectId === projectId
      ) {
        return ensureInFlight.promise;
      }

      const requestId = ++ensureRequestId;
      sessionContextGeneration += 1;
      set({
        session: null,
        loading: true,
        saving: false,
        error: null,
        boundProjectId: projectId,
      });

      const promise = ensureCurrentCreationSession(projectId, { mode: preferredMode })
        .then((session) => {
          const latest = get();
          if (latest.boundProjectId === projectId && requestId === ensureRequestId) {
            set({ session, loading: false, error: null });
          }
          return session;
        })
        .catch((error) => {
          const latest = get();
          if (latest.boundProjectId === projectId && requestId === ensureRequestId) {
            set({ session: null, loading: false, error: toApiErrorView(error) });
          }
          throw error;
        })
        .finally(() => {
          if (ensureInFlight?.requestId === requestId) ensureInFlight = null;
        });
      ensureInFlight = { projectId, requestId, promise };
      return promise;
    },

    updateSession,
    saveSession: updateSession,

    setMode: async (mode: CreationSessionMode) => updateSession({ mode }),

    activateMode: async (projectId: number, mode: CreationSessionMode) => {
      set({ error: null });
      const activationId = ++modeActivationRequestId;
      const ensured = await get().ensureSession(projectId, mode);
      const current = get();
      if (
        activationId !== modeActivationRequestId
        || current.boundProjectId !== projectId
        || current.session?.id !== ensured.id
      ) {
        throw sessionContextChangedError();
      }
      const key = contextKey(projectId, ensured.id);
      // A previous mode write may still be in flight. Queue the latest mode
      // even when the currently rendered snapshot already has that value, so
      // a late response can never revert a rapid Agent/quick/canvas switch.
      if (current.session.mode === mode && !pendingUpdates.has(key)) {
        set({ error: null });
        return current.session;
      }
      return current.updateSession({ mode });
    },

    clearError: () => set({ error: null }),

    clear: () => {
      ensureRequestId += 1;
      modeActivationRequestId += 1;
      sessionContextGeneration += 1;
      sessionConflictGeneration += 1;
      ensureInFlight = null;
      set({
        session: null,
        loading: false,
        saving: false,
        error: null,
        boundProjectId: null,
      });
    },
  };
});
