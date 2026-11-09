import { useCallback, useEffect, useRef, useState } from "react";
import { loadOverviewSnapshot } from "./api";
import type { OverviewSnapshot } from "./types";

const emptySnapshot: OverviewSnapshot = {
  providers: [],
  requests: {},
  tasks: {},
  audits: {},
  users: {},
  errors: {},
  loadedAt: 0,
};

export function useOverviewSnapshot() {
  const [data, setData] = useState<OverviewSnapshot>(emptySnapshot);
  const [loading, setLoading] = useState(true);
  const requestSequenceRef = useRef(0);
  const mountedRef = useRef(true);

  const reload = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current;
    if (!mountedRef.current) return;
    setLoading(true);
    try {
      const snapshot = await loadOverviewSnapshot();
      if (!mountedRef.current || requestSequence !== requestSequenceRef.current) return;
      setData(snapshot);
    } finally {
      if (mountedRef.current && requestSequence === requestSequenceRef.current) setLoading(false);
    }
  }, []);

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

  return { data, loading, reload };
}
