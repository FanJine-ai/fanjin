import { useCallback, useEffect, useRef, useState } from "react";
import type { FinanceQueryState } from "./types";

export function useFinanceQuery<T>(
  loader: () => Promise<T>,
  dependencyKey: string,
  initialData: T,
): FinanceQueryState<T> {
  const initialDataRef = useRef(initialData);
  const loaderRef = useRef(loader);
  const dependencyKeyRef = useRef(dependencyKey);
  const requestSequenceRef = useRef(0);
  const mountedRef = useRef(true);
  loaderRef.current = loader;
  dependencyKeyRef.current = dependencyKey;
  const [state, setState] = useState({ loading: true, error: "", data: initialDataRef.current });

  const reload = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current;
    const requestDependencyKey = dependencyKey;
    if (!mountedRef.current) return;
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const data = await loaderRef.current();
      if (!mountedRef.current
        || requestSequence !== requestSequenceRef.current
        || requestDependencyKey !== dependencyKeyRef.current) return;
      setState({ loading: false, error: "", data });
    } catch (error) {
      if (!mountedRef.current
        || requestSequence !== requestSequenceRef.current
        || requestDependencyKey !== dependencyKeyRef.current) return;
      setState((current) => ({
        loading: false,
        error: error instanceof Error ? error.message : "后台接口读取失败",
        data: current.data,
      }));
    }
  }, [dependencyKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
}
