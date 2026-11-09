import { useCallback, useEffect, useRef, useState } from "react";
import { loadPlatformSettings } from "./api";
import { emptySettingsPayload } from "./types";

export function usePlatformSettings() {
  const [data, setData] = useState(emptySettingsPayload);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const latestRequestRef = useRef(0);

  const reload = useCallback(async () => {
    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;
    setLoading(true);
    setError("");
    try {
      const nextData = await loadPlatformSettings();
      if (latestRequestRef.current === requestId) setData(nextData);
    } catch (caught) {
      if (latestRequestRef.current === requestId) {
        setError(caught instanceof Error ? caught.message : "平台设置读取失败");
      }
    } finally {
      if (latestRequestRef.current === requestId) setLoading(false);
    }
  }, []);

  const applyReload = useCallback(async () => {
    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;
    setLoading(true);
    setError("");
    try {
      const nextData = await loadPlatformSettings();
      if (latestRequestRef.current === requestId) {
        setData(nextData);
        return nextData;
      }
      return null;
    } catch (caught) {
      if (latestRequestRef.current === requestId) {
        setError(caught instanceof Error ? caught.message : "平台设置读取失败");
      }
      throw caught;
    } finally {
      if (latestRequestRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  return { ...data, loading, error, reload, applyReload };
}
