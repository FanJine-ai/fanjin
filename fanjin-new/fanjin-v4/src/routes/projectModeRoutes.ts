/** Product-facing project work modes. Agent is a docked tool, not a third mode. */
export const PROJECT_WORK_MODES = ["quick", "canvas"] as const;

/**
 * Route compatibility also keeps `agent` for existing bookmarks and standalone
 * generation utilities that still enter through `/workbench/generate`.
 */
export const PROJECT_MODES = ["agent", "quick", "canvas"] as const;

export type ProjectMode = (typeof PROJECT_MODES)[number];

export type ProjectModeRouteContext = {
  projectId?: string | number | null;
  sessionId?: string | null;
  threadId?: string | null;
  canvasId?: string | null;
};

export type ProjectModeLocation = {
  pathname: string;
  search?: string;
};

const MODE_QUERY_VALUE: Record<ProjectMode, string> = {
  agent: "agent",
  quick: "quick_create",
  canvas: "canvas",
};

const MODE_PATH: Record<ProjectMode, string> = {
  agent: "/workbench/generate",
  quick: "/workbench/quick-create",
  canvas: "/workbench/canvas/editor",
};

function normalizedValue(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function routeCanvasId(pathname: string) {
  const match = pathname.match(/^\/workbench\/canvas\/editor\/([^/]+)\/?$/)
    || pathname.match(/^\/workbench\/generate\/([^/]+)\/?$/)
    || pathname.match(/^\/canvas\/([^/]+)\/?$/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Reads the shared identity of a project work session from either product mode
 * or the legacy Agent route. `thread` remains a legacy deep-link alias.
 */
export function readProjectModeRouteContext(
  location: ProjectModeLocation | string,
): ProjectModeRouteContext {
  const pathname = typeof location === "string" ? "" : location.pathname;
  const search = typeof location === "string" ? location : location.search || "";
  const params = new URLSearchParams(search);
  return {
    projectId: normalizedValue(params.get("projectId")),
    sessionId: normalizedValue(params.get("sessionId")),
    threadId: normalizedValue(params.get("threadId") || params.get("thread")),
    canvasId: normalizedValue(params.get("canvasId")) || routeCanvasId(pathname),
  };
}

function setIdentityParam(
  params: URLSearchParams,
  key: keyof ProjectModeRouteContext,
  value: ProjectModeRouteContext[keyof ProjectModeRouteContext],
) {
  if (value === undefined) return;
  const normalized = normalizedValue(value);
  if (normalized) params.set(key, normalized);
  else params.delete(key);
}

/**
 * Builds one canonical mode URL while retaining the current project/session
 * identity. Passing `undefined` preserves a value already present in `search`;
 * passing `null` explicitly clears it.
 */
export function buildProjectModeHref(
  mode: ProjectMode,
  context: ProjectModeRouteContext = {},
  search = "",
) {
  const params = new URLSearchParams(search);
  const existing = readProjectModeRouteContext(search);
  const merged: ProjectModeRouteContext = {
    projectId: context.projectId === undefined ? existing.projectId : context.projectId,
    sessionId: context.sessionId === undefined ? existing.sessionId : context.sessionId,
    threadId: context.threadId === undefined ? existing.threadId : context.threadId,
    canvasId: context.canvasId === undefined ? existing.canvasId : context.canvasId,
  };

  params.set("mode", MODE_QUERY_VALUE[mode]);
  // Every surface writes the same canonical identity to avoid route rewrites.
  params.delete("thread");
  setIdentityParam(params, "projectId", merged.projectId);
  setIdentityParam(params, "sessionId", merged.sessionId);
  setIdentityParam(params, "threadId", merged.threadId);
  setIdentityParam(params, "canvasId", merged.canvasId);

  const canvasId = normalizedValue(merged.canvasId);
  const pathname = canvasId && (mode === "canvas" || mode === "agent")
    ? `${MODE_PATH[mode]}/${encodeURIComponent(canvasId)}`
    : MODE_PATH[mode];
  const nextSearch = params.toString();
  return `${pathname}${nextSearch ? `?${nextSearch}` : ""}`;
}

export function projectModeFromLocation(pathname: string, search = ""): ProjectMode | null {
  if (pathname === MODE_PATH.agent || /^\/workbench\/generate\/[^/]+\/?$/.test(pathname)) return "agent";
  if (pathname === MODE_PATH.quick) return "quick";
  if (pathname === MODE_PATH.canvas || routeCanvasId(pathname)) return "canvas";

  const mode = new URLSearchParams(search).get("mode");
  if (mode === "agent") return "agent";
  if (mode === "quick" || mode === "quick_create") return "quick";
  if (mode === "canvas") return "canvas";
  return null;
}
