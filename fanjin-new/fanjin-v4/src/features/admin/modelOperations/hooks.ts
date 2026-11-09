import { useCallback, useEffect, useState } from "react";
import { listModelPool, listModelRouteGroups } from "./api";
import type { ModelPoolItem, ModelRouteGroup } from "./types";

export function useModelOperations() {
  const [pool, setPool] = useState<ModelPoolItem[]>([]);
  const [groups, setGroups] = useState<ModelRouteGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    Promise.all([listModelPool(controller.signal), listModelRouteGroups(controller.signal)])
      .then(([nextPool, nextGroups]) => {
        setPool(nextPool);
        setGroups(nextGroups);
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "模型运营数据读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);

  return { pool, groups, loading, error, reload };
}
