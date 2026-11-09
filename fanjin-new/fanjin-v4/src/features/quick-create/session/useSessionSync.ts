import { useEffect } from "react";
import { useSessionStore } from "./sessionStore";
import { QUICK_CREATE_CAPABILITIES } from "../capabilities";

/**
 * 同步 QuickCreateView 与 CreationSession 的 Hook。
 * 在项目切换时自动确保 Session，提供稳定、串行的 save 方法。
 *
 * 用法：
 *   const { session, saveSession, saving, sessionError } = useSessionSync(currentProjectId);
 */
export function useSessionSync(projectId: number | null | undefined) {
  const session = useSessionStore((state) => state.session);
  const updateSession = useSessionStore((state) => state.updateSession);
  const saveSession = useSessionStore((state) => state.saveSession);
  const setMode = useSessionStore((state) => state.setMode);
  const activateMode = useSessionStore((state) => state.activateMode);
  const saving = useSessionStore((state) => state.saving);
  const sessionError = useSessionStore((state) => state.error);
  const sessionLoading = useSessionStore((state) => state.loading);
  const ensureSession = useSessionStore((state) => state.ensureSession);
  const clear = useSessionStore((state) => state.clear);
  const clearSessionError = useSessionStore((state) => state.clearError);

  // 项目切换时加载 Session
  useEffect(() => {
    if (!QUICK_CREATE_CAPABILITIES.creationSession) return;
    if (!projectId) {
      clear();
      return;
    }
    void ensureSession(projectId).catch(() => {
      // Store exposes the normalized error. Avoid an unhandled rejection in
      // this fire-and-forget lifecycle effect.
    });
    return () => {
      // Session data is user/workspace scoped. Do not leave it cached after
      // the owning view unmounts (for example during logout/account switch).
      clear();
    };
  }, [projectId, ensureSession, clear]);

  return {
    session,
    updateSession,
    saveSession,
    setMode,
    activateMode,
    saving,
    sessionError,
    sessionLoading,
    clearSessionError,
  };
}
