import { useCallback, useEffect, useRef, useState } from "react";
import { toApiErrorView } from "../../../api/http";
import { listAdminUsers } from "./api";
import type { UsersListInput, UsersListPayload } from "./types";

const emptyPayload: UsersListPayload = { items: [], total: 0, pageNum: 1, pageSize: 20, summary: {} };

export function useAdminUsers(input: UsersListInput) {
  const [data, setData] = useState<UsersListPayload>(emptyPayload);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestSequenceRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const inputKey = JSON.stringify(input);

  const reload = useCallback(async () => {
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const nextData = await listAdminUsers(input, { signal: controller.signal });
      if (controller.signal.aborted || requestSequence !== requestSequenceRef.current) return;
      setData(nextData);
    } catch (cause) {
      if (controller.signal.aborted || requestSequence !== requestSequenceRef.current) return;
      setError(toApiErrorView(cause).message);
    } finally {
      if (controller.signal.aborted || requestSequence !== requestSequenceRef.current) return;
      setLoading(false);
    }
  }, [inputKey]);

  useEffect(() => {
    void reload();
    return () => {
      controllerRef.current?.abort();
    };
  }, [reload]);

  return { data, loading, error, reload };
}
