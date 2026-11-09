import { useEffect, useState } from "react";
import { fetchQuickCreateVideoModels, type QuickCreateVideoModelOption } from "../../features/quick-create/modelCatalog";

type State = { workspaceId: string; models: QuickCreateVideoModelOption[]; loading: boolean; error: string };

/** Scope-fenced reuse of the creation surfaces' authoritative video directory. */
export function useDeveloperVideoModels(workspaceId: string, enabled: boolean) {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<State>({ workspaceId: "", models: [], loading: false, error: "" });
  useEffect(() => {
    if (!workspaceId || !enabled) return;
    let active = true;
    setState({ workspaceId, models: [], loading: true, error: "" });
    fetchQuickCreateVideoModels().then((models) => {
      if (active) setState({ workspaceId, models, loading: false, error: "" });
    }).catch((error: unknown) => {
      if (active) setState({ workspaceId, models: [], loading: false,
        error: error instanceof Error ? error.message : "视频能力目录读取失败" });
    });
    return () => { active = false; };
  }, [enabled, reloadKey, workspaceId]);
  const current = state.workspaceId === workspaceId;
  return {
    models: current && enabled ? state.models : [],
    loading: enabled && Boolean(workspaceId) && (!current || state.loading),
    error: current && enabled ? state.error : "",
    retry: () => setReloadKey((key) => key + 1),
  };
}
