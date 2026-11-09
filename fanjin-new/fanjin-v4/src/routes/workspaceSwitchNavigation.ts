const PROJECT_BOUND_WORKBENCH_PATHS = [
  "/workbench/quick-create",
  "/workbench/novel",
  "/workbench/script",
  "/workbench/production",
  "/workbench/editor",
  "/workbench/corner-scape",
  "/workbench/canvas/editor",
] as const;

const PROJECT_BOUND_QUERY_KEYS = [
  "projectId",
  "sessionId",
  "canvasId",
] as const;

/**
 * A project identity belongs to the workspace in which it was resolved. When
 * the user deliberately changes workspaces, keeping that identity in the URL
 * would make the new workspace try to load an inaccessible old project and
 * surface a misleading "project does not exist" error.
 *
 * Return the workspace-safe landing page only for project-bound workbench
 * routes. Project-independent entries keep their current location.
 */
export function workspaceSwitchDestination(
  pathnameInput: unknown,
  searchInput: unknown,
): string | null {
  const pathname = String(pathnameInput || "").trim();
  const search = String(searchInput || "").trim();
  const projectBoundPath = PROJECT_BOUND_WORKBENCH_PATHS.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ));
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const hasProjectIdentity = PROJECT_BOUND_QUERY_KEYS.some((key) => (
    Boolean(params.get(key)?.trim())
  ));

  return projectBoundPath || (pathname.startsWith("/workbench/") && hasProjectIdentity)
    ? "/workbench/project"
    : null;
}
