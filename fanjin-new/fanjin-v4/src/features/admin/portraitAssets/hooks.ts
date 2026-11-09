import { useCallback, useEffect, useState } from "react";
import { listPortraitAssets } from "./api";
import type { PortraitAssetsFilters, PortraitAssetsResponse } from "./types";

export function usePortraitAssets(filters: PortraitAssetsFilters) {
  const [data, setData] = useState<PortraitAssetsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const filtersKey = JSON.stringify(filters);

  const reload = useCallback(() => setRevision((current) => current + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const run = async () => {
      setLoading(true);
      setError("");
      try {
        setData(await listPortraitAssets(filters, controller.signal));
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "人像资产读取失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void run();
    return () => controller.abort();
  // `filtersKey` deliberately snapshots the value object supplied by the URL.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, revision]);

  return { data, loading, error, reload };
}
