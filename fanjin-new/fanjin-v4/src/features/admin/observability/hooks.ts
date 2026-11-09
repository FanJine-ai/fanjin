import { useEffect, useState } from "react";
import type { ObservabilityMetrics, HealthCheckResponse, BackupListResponse } from "./types";
import { fetchObservabilityMetrics, fetchHealthCheck, fetchBackupList } from "./api";

export function useObservabilityMetrics(autoRefresh = false, intervalMs = 5000) {
  const [data, setData] = useState<ObservabilityMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const reload = async () => {
    try {
      setLoading(true);
      setError(null);
      const metrics = await fetchObservabilityMetrics();
      setData(metrics);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => void reload(), intervalMs);
    return () => clearInterval(timer);
  }, [autoRefresh, intervalMs]);

  return { data, loading, error, reload };
}

export function useHealthCheck(autoRefresh = false, intervalMs = 10000) {
  const [data, setData] = useState<HealthCheckResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const reload = async () => {
    try {
      setLoading(true);
      setError(null);
      const health = await fetchHealthCheck();
      setData(health);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => void reload(), intervalMs);
    return () => clearInterval(timer);
  }, [autoRefresh, intervalMs]);

  return { data, loading, error, reload };
}

export function useBackupList() {
  const [data, setData] = useState<BackupListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const reload = async () => {
    try {
      setLoading(true);
      setError(null);
      const backups = await fetchBackupList();
      setData(backups);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  return { data, loading, error, reload };
}
