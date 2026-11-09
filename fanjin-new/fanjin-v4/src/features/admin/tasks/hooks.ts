import { useCallback, useEffect, useRef, useState } from "react";
import { listRelayTasks, type RelayTaskListInput } from "./api";
import type { RelayTaskListResponse } from "./types";

const emptyResult: RelayTaskListResponse = { items: [], summary: {}, total: 0, pageNum: 1, pageSize: 20 };

export function useRelayTasks(input: RelayTaskListInput) {
  const [state, setState] = useState({ loading: true, error: "", data: emptyResult });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const inputKey = JSON.stringify(input);
  const requestKey = `${inputKey}:${revision}`;
  const latestRequestKey = useRef(requestKey);
  latestRequestKey.current = requestKey;

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: "" }));
    listRelayTasks(JSON.parse(inputKey) as RelayTaskListInput, controller.signal)
      .then((data) => {
        if (controller.signal.aborted || latestRequestKey.current !== requestKey) return;
        setState({ loading: false, error: "", data: data || emptyResult });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || latestRequestKey.current !== requestKey) return;
        setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "视频任务读取失败" }));
    });
    return () => controller.abort();
  }, [inputKey, requestKey]);

  return { ...state, reload };
}
