import { useCallback, useEffect, useRef, useState } from "react";
import { toApiErrorView } from "../../../../api/http";
import { fetchRequestLogs, fetchRequestLogStats } from "./api";
import type { RequestLogListInput, RequestLogsState, RequestLogStatsInput } from "./types";

const initialState: RequestLogsState & { settledListKey: string | null } = {
  listLoading: true,
  statsLoading: true,
  listError: "",
  statsError: "",
  list: {},
  stats: {},
  settledListKey: null,
};

export function useRequestLogs(listInput: RequestLogListInput, statsInput: RequestLogStatsInput) {
  const [state, setState] = useState(initialState);
  const [listRevision, setListRevision] = useState(0);
  const [statsRevision, setStatsRevision] = useState(0);
  const listKey = JSON.stringify(listInput);
  const statsKey = JSON.stringify(statsInput);
  const listRequestKey = `${listKey}:${listRevision}`;
  const statsRequestKey = `${statsKey}:${statsRevision}`;
  const latestListRequestKey = useRef(listRequestKey);
  const latestStatsRequestKey = useRef(statsRequestKey);
  latestListRequestKey.current = listRequestKey;
  latestStatsRequestKey.current = statsRequestKey;

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, listLoading: true, listError: "" }));
    void fetchRequestLogs(JSON.parse(listKey) as RequestLogListInput, controller.signal)
      .then((list) => {
        if (controller.signal.aborted || latestListRequestKey.current !== listRequestKey) return;
        setState((current) => ({ ...current, listLoading: false, listError: "", list, settledListKey: listKey }));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || latestListRequestKey.current !== listRequestKey) return;
        setState((current) => ({
          ...current,
          listLoading: false,
          listError: toApiErrorView(error).message || "请求日志读取失败",
          settledListKey: listKey,
        }));
      });
    return () => controller.abort();
  }, [listKey, listRequestKey]);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, statsLoading: true, statsError: "" }));
    void fetchRequestLogStats(JSON.parse(statsKey) as RequestLogStatsInput, controller.signal)
      .then((stats) => {
        if (controller.signal.aborted || latestStatsRequestKey.current !== statsRequestKey) return;
        setState((current) => ({ ...current, statsLoading: false, statsError: "", stats }));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || latestStatsRequestKey.current !== statsRequestKey) return;
        setState((current) => ({ ...current, statsLoading: false, statsError: toApiErrorView(error).message || "请求日志统计读取失败" }));
      });
    return () => controller.abort();
  }, [statsKey, statsRequestKey]);

  const retryList = useCallback(() => setListRevision((revision) => revision + 1), []);
  const retryStats = useCallback(() => setStatsRevision((revision) => revision + 1), []);
  const retryAll = useCallback(() => {
    setListRevision((revision) => revision + 1);
    setStatsRevision((revision) => revision + 1);
  }, []);

  const listLoading = state.listLoading || state.settledListKey !== listKey;
  const responsePageNum = Number(state.list.pageNum);
  const effectivePageNum = !listLoading
    && !state.listError
    && Number.isInteger(responsePageNum)
    && responsePageNum > 0
    ? responsePageNum
    : listInput.pageNum;

  return {
    ...state,
    listLoading,
    effectivePageNum,
    retryList,
    retryStats,
    retryAll,
  };
}
