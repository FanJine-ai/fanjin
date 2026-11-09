import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { apiGet } from "../api/http";
import { useSessionStore } from "../features/quick-create/session/sessionStore";
import { normalizeProjectId, useProjectStore } from "../stores/projectStore";
import {
  buildProjectModeHref,
  readProjectModeRouteContext,
  type ProjectMode,
} from "./projectModeRoutes";

type ProjectModeRouteSyncProps = {
  mode: ProjectMode;
  children: ReactNode;
};

type PendingProjectHydration = {
  projectId: number;
  source: "route" | "stored";
};

const SESSION_MODE_BY_ROUTE = {
  agent: "agent",
  quick: "quick_create",
  canvas: "canvas",
} as const;

const SAFE_ROUTE_BY_MODE: Record<ProjectMode, string> = {
  agent: "/workbench/project",
  quick: "/workbench/project",
  canvas: "/workbench/canvas",
};

/**
 * Keeps the route, project store and current CreationSession on the same
 * project identity. The wrapped workbench pages stay presentation-focused.
 */
export function ProjectModeRouteSync({ mode, children }: ProjectModeRouteSyncProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const projects = useProjectStore((state) => state.projects);
  const projectLoading = useProjectStore((state) => state.loading);
  const projectError = useProjectStore((state) => state.error);
  const selectProject = useProjectStore((state) => state.selectProject);
  const fetchProjects = useProjectStore((state) => state.fetchProjects);
  const activateMode = useSessionStore((state) => state.activateMode);
  const sessionError = useSessionStore((state) => state.error);
  const routeContext = useMemo(
    () => readProjectModeRouteContext(location),
    [location.pathname, location.search],
  );
  const routeParams = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  );
  const routeSynchronizationIdentity = `${mode}:${location.pathname}${location.search}`;
  const activeRouteIdentityRef = useRef(routeSynchronizationIdentity);
  const routeOccurrenceRef = useRef(0);
  const synchronizationRequestRef = useRef(0);
  if (activeRouteIdentityRef.current !== routeSynchronizationIdentity) {
    activeRouteIdentityRef.current = routeSynchronizationIdentity;
    routeOccurrenceRef.current += 1;
    synchronizationRequestRef.current += 1;
  }
  const routeProjectId = normalizeProjectId(routeContext.projectId);
  const malformedRouteProjectId = routeParams.has("projectId") && routeProjectId === null;
  const targetProjectId = malformedRouteProjectId
    ? null
    : routeProjectId ?? normalizeProjectId(currentProjectId);
  const hydratedProjectRef = useRef<PendingProjectHydration | null>(null);
  const pendingStoredProjectId = targetProjectId === null
    && routeProjectId === null
    && hydratedProjectRef.current?.source === "stored"
    ? hydratedProjectRef.current.projectId
    : null;
  const verificationProjectId = targetProjectId ?? pendingStoredProjectId;
  const verificationProjectAvailable = verificationProjectId !== null
    && projects.some((project) => normalizeProjectId(project.id) === verificationProjectId);
  const targetProjectAvailable = targetProjectId !== null
    && projects.some((project) => normalizeProjectId(project.id) === targetProjectId);
  const routeProjectSelectionReady = routeProjectId === null
    || normalizeProjectId(currentProjectId) === routeProjectId;
  const targetProjectReady = targetProjectAvailable && routeProjectSelectionReady;
  const readOnlyProjectModeProof =
    routeParams.get("__proof") === "readonly";
  const hasRouteSiblingIdentity = Boolean(
    routeContext.sessionId || routeContext.threadId || routeContext.canvasId,
  );
  const boundRouteCanvasId = routeProjectId !== null
    && routeProjectId === targetProjectId
    ? routeContext.canvasId ?? null
    : null;
  const routeIdentityNeedsProof = readOnlyProjectModeProof
    ? boundRouteCanvasId !== null
    : hasRouteSiblingIdentity;
  const routeIdentityProofKey = targetProjectReady
    && routeIdentityNeedsProof
    ? `${mode}:${targetProjectId}:${location.pathname}${location.search}`
    : null;
  const routeIdentityProofToken = routeIdentityProofKey === null
    ? null
    : `${routeOccurrenceRef.current}:${routeIdentityProofKey}`;
  const [verifiedRouteIdentityKey, setVerifiedRouteIdentityKey] = useState<string | null>(null);
  const [localSynchronizationError, setLocalSynchronizationError] = useState<Error | null>(null);
  const routeIdentityReady = routeIdentityProofToken === null
    || verifiedRouteIdentityKey === routeIdentityProofToken;

  useEffect(() => {
    if (malformedRouteProjectId) {
      hydratedProjectRef.current = null;
      navigate(SAFE_ROUTE_BY_MODE[mode], { replace: true });
      return;
    }
    if (verificationProjectId === null) {
      hydratedProjectRef.current = null;
      return;
    }
    if (verificationProjectAvailable) {
      hydratedProjectRef.current = null;
      if (routeProjectId !== null && routeProjectId !== normalizeProjectId(currentProjectId)) {
        // A deep link is authoritative only after the project list proves access.
        selectProject(routeProjectId);
      }
      return;
    }
    const verificationSource = routeProjectId !== null ? "route" : "stored";
    if (
      hydratedProjectRef.current?.projectId !== verificationProjectId
      || hydratedProjectRef.current.source !== verificationSource
    ) {
      hydratedProjectRef.current = {
        projectId: verificationProjectId,
        source: verificationSource,
      };
      void fetchProjects();
      return;
    }
    const latestProjectState = useProjectStore.getState();
    if (!latestProjectState.loading && !latestProjectState.error) {
      navigate(SAFE_ROUTE_BY_MODE[mode], { replace: true });
    }
  }, [
    currentProjectId,
    fetchProjects,
    mode,
    malformedRouteProjectId,
    navigate,
    projectError,
    projectLoading,
    routeProjectId,
    selectProject,
    verificationProjectAvailable,
    verificationProjectId,
  ]);

  function targetIsCurrent(projectId: number) {
    return normalizeProjectId(useProjectStore.getState().currentProjectId) === projectId;
  }

  async function synchronizeTargetProject(projectId: number, isDisposed: () => boolean) {
    const requestId = ++synchronizationRequestRef.current;
    const requestRouteIdentity = routeSynchronizationIdentity;
    const requestRouteOccurrence = routeOccurrenceRef.current;
    const requestIsObsolete = () => isDisposed()
      || synchronizationRequestRef.current !== requestId
      || activeRouteIdentityRef.current !== requestRouteIdentity
      || routeOccurrenceRef.current !== requestRouteOccurrence;
    if (requestIsObsolete()) return;
    setLocalSynchronizationError(null);
    try {
      const session = await activateMode(projectId, SESSION_MODE_BY_ROUTE[mode]);
      if (requestIsObsolete() || !targetIsCurrent(projectId)) return;

      const routeIdentityMatchesProject = routeProjectId !== null
        && routeProjectId === projectId;
      const explicitCanvasId = routeIdentityMatchesProject
        ? routeContext.canvasId ?? null
        : null;
      let canvasId = explicitCanvasId ?? session.canvasId;
      const mustValidateExplicitCanvas = explicitCanvasId !== null;
      const needsCanvasFallback = (mode === "canvas" || mode === "agent") && !canvasId;

      if (mustValidateExplicitCanvas || needsCanvasFallback) {
        const result = await apiGet<{ canvases: Array<{ canvasId: string }> }>(
          `/projects/${projectId}/canvases`,
        );
        if (requestIsObsolete() || !targetIsCurrent(projectId)) return;
        const canvases = Array.isArray(result?.canvases) ? result.canvases : [];
        const canvasIds = new Set(
          canvases
            .map((canvas) => String(canvas?.canvasId || "").trim())
            .filter(Boolean),
        );
        if (explicitCanvasId !== null) {
          canvasId = canvasIds.has(explicitCanvasId)
            ? explicitCanvasId
            : session.canvasId && canvasIds.has(session.canvasId)
              ? session.canvasId
              : canvases[0]?.canvasId ?? null;
        } else {
          canvasId = canvases[0]?.canvasId ?? null;
        }
      }

      if (session.canvasId !== canvasId) {
        await useSessionStore.getState().updateSession({ canvasId });
        if (requestIsObsolete() || !targetIsCurrent(projectId)) return;
      }

      let href = buildProjectModeHref(mode, {
        projectId,
        sessionId: session.id,
        threadId: routeIdentityMatchesProject ? routeContext.threadId : null,
        canvasId,
      }, location.search);
      const currentGenerateMode = mode === "agent" ? routeParams.get("mode") : null;
      if (currentGenerateMode && currentGenerateMode !== "agent") {
        const [pathname, search = ""] = href.split("?");
        const params = new URLSearchParams(search);
        params.set("mode", currentGenerateMode);
        href = `${pathname}?${params.toString()}`;
      }
      if (requestIsObsolete() || !targetIsCurrent(projectId)) return;
      setLocalSynchronizationError(null);
      if (href === `${location.pathname}${location.search}`) {
        if (routeIdentityProofToken !== null) {
          setVerifiedRouteIdentityKey(routeIdentityProofToken);
        }
        return;
      }
      // Keep the entry transition marker across canonical route rewrites.
      // Without this, switching from the full frontstage navigation to a
      // canvas URL that still needs its canvas id would remount the route
      // already collapsed, so the intended spatial transition never runs.
      navigate(href, { replace: true, state: location.state });
    } catch (error) {
      if (!requestIsObsolete()) {
        setLocalSynchronizationError(
          error instanceof Error ? error : new Error("项目创作会话同步失败"),
        );
      }
    }
  }

  async function verifyReadOnlyCanvas(
    projectId: number,
    canvasId: string,
    proofKey: string,
    isDisposed: () => boolean,
  ) {
    const requestId = ++synchronizationRequestRef.current;
    const requestRouteIdentity = routeSynchronizationIdentity;
    const requestRouteOccurrence = routeOccurrenceRef.current;
    const requestIsObsolete = () => isDisposed()
      || synchronizationRequestRef.current !== requestId
      || activeRouteIdentityRef.current !== requestRouteIdentity
      || routeOccurrenceRef.current !== requestRouteOccurrence;
    if (requestIsObsolete()) return;
    setLocalSynchronizationError(null);
    try {
      const result = await apiGet<{ canvases: Array<{ canvasId: string }> }>(
        `/projects/${projectId}/canvases`,
      );
      if (requestIsObsolete() || !targetIsCurrent(projectId)) return;
      const canvasBelongsToProject = Array.isArray(result?.canvases)
        && result.canvases.some((canvas) => String(canvas?.canvasId || "").trim() === canvasId);
      if (!canvasBelongsToProject) {
        throw new Error("画布不属于当前项目");
      }
      setVerifiedRouteIdentityKey(proofKey);
    } catch (error) {
      if (!requestIsObsolete()) {
        setLocalSynchronizationError(
          error instanceof Error ? error : new Error("画布归属验证失败"),
        );
      }
    }
  }

  useEffect(() => {
    if (!targetProjectReady || malformedRouteProjectId) return;
    if (targetProjectId === null) return;
    let disposed = false;
    if (readOnlyProjectModeProof) {
      if (boundRouteCanvasId !== null && routeIdentityProofToken !== null) {
        void verifyReadOnlyCanvas(
          targetProjectId,
          boundRouteCanvasId,
          routeIdentityProofToken,
          () => disposed,
        );
      }
    } else {
      void synchronizeTargetProject(targetProjectId, () => disposed);
    }
    return () => {
      disposed = true;
    };
  }, [
    activateMode,
    boundRouteCanvasId,
    location.pathname,
    location.search,
    location.state,
    mode,
    malformedRouteProjectId,
    navigate,
    routeContext.canvasId,
    routeContext.threadId,
    readOnlyProjectModeProof,
    routeIdentityProofKey,
    routeIdentityProofToken,
    routeParams,
    routeProjectId,
    targetProjectReady,
    targetProjectId,
  ]);

  const synchronizationError = localSynchronizationError
    || sessionError
    || (verificationProjectId !== null && !verificationProjectAvailable ? projectError : null);

  function retrySynchronization() {
    if (malformedRouteProjectId) {
      navigate(SAFE_ROUTE_BY_MODE[mode], { replace: true });
      return;
    }
    if (verificationProjectId !== null && !verificationProjectAvailable) {
      void fetchProjects();
      return;
    }
    if (targetProjectId !== null && targetProjectReady && !readOnlyProjectModeProof) {
      void synchronizeTargetProject(targetProjectId, () => false);
      return;
    }
    if (
      targetProjectId !== null
      && targetProjectReady
      && readOnlyProjectModeProof
      && boundRouteCanvasId !== null
      && routeIdentityProofToken !== null
    ) {
      void verifyReadOnlyCanvas(
        targetProjectId,
        boundRouteCanvasId,
        routeIdentityProofToken,
        () => false,
      );
    }
  }

  const childrenReady = !malformedRouteProjectId
    && (
      verificationProjectId === null
      || (verificationProjectAvailable && routeProjectSelectionReady && routeIdentityReady)
    );
  const synchronizationPending = malformedRouteProjectId
    || (
      verificationProjectId !== null
      && !synchronizationError
      && (
        !verificationProjectAvailable
        || !routeProjectSelectionReady
        || !routeIdentityReady
      )
    );
  const pendingMessage = malformedRouteProjectId
    ? "项目链接无效，正在返回项目入口…"
    : !verificationProjectAvailable || !routeProjectSelectionReady
      ? "正在验证项目访问权限…"
      : "正在验证画布与项目的归属…";

  return (
    <>
      {childrenReady ? children : null}
      {synchronizationPending ? (
        <div
          role="status"
          aria-live="polite"
          data-project-mode-sync-pending
          style={{
            minHeight: "40vh",
            display: "grid",
            placeItems: "center",
            alignContent: "center",
            gap: 12,
            color: "var(--cui-text-secondary)",
          }}
        >
          <span>{pendingMessage}</span>
          <button
            type="button"
            onClick={retrySynchronization}
            style={{
              border: "1px solid var(--cui-border)",
              borderRadius: 8,
              background: "var(--cui-surface)",
              color: "var(--cui-text-primary)",
              cursor: "pointer",
              padding: "6px 10px",
            }}
          >
            重新检查
          </button>
        </div>
      ) : null}
      {verificationProjectId !== null && synchronizationError ? (
        <div
          role="alert"
          aria-live="assertive"
          data-project-mode-sync-error
          className="z-[var(--cui-layer-overlay)] shadow-[var(--cui-shadow-dialog)]"
          style={{
            position: "fixed",
            left: "50%",
            bottom: 24,
            transform: "translateX(-50%)",
            display: "flex",
            maxWidth: "min(680px, calc(100vw - 32px))",
            alignItems: "center",
            gap: 12,
            border: "1px solid var(--cui-danger-border)",
            borderRadius: 12,
            background: "var(--cui-surface)",
            color: "var(--cui-danger-text)",
            padding: "12px 14px",
          }}
        >
          <span>项目创作会话同步失败：{synchronizationError.message}</span>
          <button
            type="button"
            onClick={retrySynchronization}
            style={{
              flex: "0 0 auto",
              border: "1px solid currentColor",
              borderRadius: 8,
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              padding: "6px 10px",
            }}
          >
            重新同步
          </button>
        </div>
      ) : null}
    </>
  );
}
