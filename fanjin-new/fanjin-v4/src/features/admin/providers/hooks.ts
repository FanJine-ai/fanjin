import { useCallback, useEffect, useState } from "react";
import { listProviderChannels } from "./api";
import type { ProviderChannel } from "./types";

export function useProviderChannels() {
  const [channels, setChannels] = useState<ProviderChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setChannels(await listProviderChannels());
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "供应商通道读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { channels, loading, error, reload };
}
