import { Navigate, useLocation } from "react-router-dom";
import {
  isQuickCreateGenerationModeEnabled,
  normalizeQuickCreateGenerationMode,
} from "../../features/quick-create/capabilities";
import { ProjectModeRouteSync } from "../../routes/ProjectModeRouteSync";
import CanvasEntryPage from "../canvas/CanvasEntryPage";
import GeneratePage from "./GeneratePage";

export function unavailableModeFallback(pathname: string, search: string) {
  const params = new URLSearchParams(search);
  params.set("mode", "agent");
  params.delete("ai_feature_name");
  return `${pathname}?${params.toString()}`;
}

/**
 * Legacy Agent links open the shared studio with its Agent dock expanded.
 * Product navigation exposes only quick and canvas as work modes. Image/video
 * utilities keep their established standalone GeneratePage surface.
 */
export default function GenerateEntryPage() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const requestedMode = params.get("mode") || params.get("ai_feature_name") || "agent";
  const normalizedMode = normalizeQuickCreateGenerationMode(requestedMode);

  if (normalizedMode && !isQuickCreateGenerationModeEnabled(normalizedMode)) {
    return <Navigate to={unavailableModeFallback(location.pathname, location.search)} replace />;
  }

  if (normalizedMode && normalizedMode !== "Agent 模式") {
    return (
      <ProjectModeRouteSync mode="agent">
        <GeneratePage />
      </ProjectModeRouteSync>
    );
  }

  return (
    <ProjectModeRouteSync mode="agent">
      <CanvasEntryPage activeMode="agent" />
    </ProjectModeRouteSync>
  );
}
