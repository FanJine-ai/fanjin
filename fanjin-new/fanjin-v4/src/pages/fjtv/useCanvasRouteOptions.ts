import { useMemo } from "react";
export function useCanvasRouteOptions(location: { search: string }) {
  const searchParams = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  );
  const forceFreshCanvasEntry =
    searchParams.get("mode") === "create-new" ||
    searchParams.get("empty") === "1";
  const openProjectBrowserOnEntry = searchParams.get("browser") === "projects";
  const readOnlyProofMode = searchParams.get("__proof") === "readonly";

  return {
    searchParams,
    forceFreshCanvasEntry,
    openProjectBrowserOnEntry,
    readOnlyProofMode,
  };
}
