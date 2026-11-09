import { useCallback, useEffect, useRef, useState } from "react";
import { listAuditLogs } from "./api";
import type { AuditLogListInput, AuditLogListResponse } from "./types";

const emptyResponse: AuditLogListResponse = { items: [], total: 0, pageNum: 1, pageSize: 20 };

export function useAuditLogs(input: AuditLogListInput) {
  const [state, setState] = useState<{ loading: boolean; error: string; data: AuditLogListResponse }>({ loading: true, error: "", data: emptyResponse });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const inputKey = JSON.stringify(input);
  const requestKey = `${inputKey}:${revision}`;
  const latestRequestKey = useRef(requestKey);
  latestRequestKey.current = requestKey;

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: "" }));
    listAuditLogs(JSON.parse(inputKey) as AuditLogListInput, controller.signal)
      .then((data) => {
        if (controller.signal.aborted || latestRequestKey.current !== requestKey) return;
        setState({ loading: false, error: "", data: data || emptyResponse });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || latestRequestKey.current !== requestKey) return;
        setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "审计日志读取失败" }));
    });
    return () => controller.abort();
  }, [inputKey, requestKey]);

  return { ...state, reload };
}
