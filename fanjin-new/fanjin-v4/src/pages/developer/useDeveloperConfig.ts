import { useCallback, useEffect, useRef, useState } from "react";
import { apiPost } from "../../api/http";
import { useWorkspaceStore } from "../../stores/workspaceStore";

export type DeveloperConfig = {
  apiBaseUrl: string;
  endpoint: string;
};

type DeveloperConfigState = {
  loading: boolean;
  error: string;
  config: DeveloperConfig;
  workspaceId: string;
};

const emptyConfig: DeveloperConfig = { apiBaseUrl: "", endpoint: "" };

function ownString(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor
      && "value" in descriptor
      && typeof descriptor.value === "string"
      ? descriptor.value.trim()
      : "";
  } catch {
    return "";
  }
}

function publicHttpUrl(value: string): string {
  if (!value || value.length > 2_000) return "";
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      return "";
    }
    if (typeof window !== "undefined" && window.location.protocol === "https:"
      && parsed.protocol === "http:" && parsed.host === window.location.host) {
      parsed.protocol = "https:";
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function parseDeveloperConfig(raw: unknown): DeveloperConfig {
  const apiBaseUrl = publicHttpUrl(ownString(raw, "apiBaseUrl"));
  const endpoint = publicHttpUrl(ownString(raw, "endpoint"));
  if (!apiBaseUrl || !endpoint) {
    throw new Error("开发者接口配置返回了不受支持的数据。");
  }
  return { apiBaseUrl, endpoint };
}

function configErrorMessage(error: unknown): string {
  let status: unknown;
  try {
    const descriptor = error
      && (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "status")
      : undefined;
    status = descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    status = undefined;
  }
  if (status === 401) return "登录状态已失效，无法读取开发者接口配置（401）。";
  if (status === 403) return "无权读取当前工作区开发者接口配置（403）。";
  if (status === 503) return "开发者接口配置服务暂不可用（503）。";
  return error instanceof Error && error.message === "开发者接口配置返回了不受支持的数据。"
    ? error.message
    : "开发者接口配置读取失败，请稍后重试。";
}

function workspaceKey(value: string | number | null): string {
  return value == null ? "" : String(value).trim();
}

export function useDeveloperConfig() {
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const requestedWorkspaceId = workspaceKey(currentWorkspaceId);
  const requestGeneration = useRef(0);
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState<DeveloperConfigState>({
    loading: true,
    error: "",
    config: emptyConfig,
    workspaceId: requestedWorkspaceId,
  });
  const retry = useCallback(() => setRetryKey((key) => key + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++requestGeneration.current;
    setState({
      loading: true,
      error: "",
      config: emptyConfig,
      workspaceId: requestedWorkspaceId,
    });
    const payload = requestedWorkspaceId
      ? { workspaceId: requestedWorkspaceId }
      : {};

    void apiPost<unknown>(
      "/developer/config",
      payload,
      undefined,
      { signal: controller.signal },
    )
      .then((raw) => {
        if (
          controller.signal.aborted
          || generation !== requestGeneration.current
        ) {
          return;
        }
        setState({
          loading: false,
          error: "",
          config: parseDeveloperConfig(raw),
          workspaceId: requestedWorkspaceId,
        });
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted
          || generation !== requestGeneration.current
        ) {
          return;
        }
        setState({
          loading: false,
          error: configErrorMessage(error),
          config: emptyConfig,
          workspaceId: requestedWorkspaceId,
        });
      });

    return () => controller.abort();
  }, [requestedWorkspaceId, retryKey]);

  const visibleState = state.workspaceId === requestedWorkspaceId
    ? state
    : {
        loading: true,
        error: "",
        config: emptyConfig,
        workspaceId: requestedWorkspaceId,
      };
  return { ...visibleState, retry };
}
