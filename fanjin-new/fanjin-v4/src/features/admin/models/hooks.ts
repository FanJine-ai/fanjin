import { useCallback, useEffect, useState } from "react";
import { listModelRoutes } from "./api";
import type { ModelRouteRecord } from "./types";

export function useModelRoutes(workspaceId?: string | null) {
  const [state, setState] = useState<{ loading: boolean; error: string; data: ModelRouteRecord[] }>({ loading: true, error: "", data: [] });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: "" }));
    listModelRoutes(workspaceId, controller.signal)
      .then((data) => setState({ loading: false, error: "", data: Array.isArray(data) ? data : [] }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ loading: false, error: error instanceof Error ? error.message : "模型路由读取失败", data: [] });
      });
    return () => controller.abort();
  }, [revision, workspaceId]);

  return { ...state, reload };
}
