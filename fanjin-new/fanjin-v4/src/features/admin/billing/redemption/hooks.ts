import { useCallback, useEffect, useRef, useState } from "react";
import { listRedemptionCodes } from "./api";
import type { RedemptionList } from "./types";
export function useRedemptionCodes(page: number, status: string, batchId: string) {
  const [state, setState] = useState<RedemptionList>({ total: 0, items: [] }); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const result = await listRedemptionCodes({ page, pageSize: 100, status: status || undefined, batchId: batchId.trim() || undefined, signal: controller.signal });
      if (requestRef.current === controller) setState(result);
    } catch (caught) {
      if (!controller.signal.aborted && requestRef.current === controller) {
        setError(caught instanceof Error ? caught.message : "兑换码读取失败");
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [batchId, page, status]);
  useEffect(() => {
    void reload();
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [reload]);
  return { ...state, loading, error, reload };
}
