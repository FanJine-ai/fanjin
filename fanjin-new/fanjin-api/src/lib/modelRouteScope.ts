/**
 * Pick the authoritative route scope for one endpoint/model set.
 *
 * This helper intentionally has no database import. Callers that already own
 * a transaction can therefore apply the routing policy without loading the
 * application database singleton (and its dbReady lifecycle).
 */
export function selectPreferredModelRouteScope<
  T extends Record<string, any>,
>(
  routes: T[],
  workspaceId?: string | null,
): T[] {
  const normalizedWorkspaceId = String(workspaceId || "").trim();
  const workspaceRoutes = normalizedWorkspaceId
    ? routes.filter((route) => (
      String(route?.scope || "") === "workspace"
      && String(route?.workspaceId || "") === normalizedWorkspaceId
    ))
    : [];
  if (workspaceRoutes.length > 0) return workspaceRoutes;
  return routes.filter((route) => (
    String(route?.scope || "") === "platform" && route?.workspaceId == null
  ));
}
