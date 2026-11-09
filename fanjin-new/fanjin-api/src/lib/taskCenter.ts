import { RelayTaskStatus } from "@/lib/relay";
import {
  RELAY_SYNTHETIC_QUARANTINE_MESSAGE,
  publicRelayStatus,
  relayMockIsSuccessful,
  relaySuccessFilterStatuses,
  shouldQuarantineRelayArtifacts,
} from "@/lib/relayMockPolicy";

export interface TaskCenterRow {
  id: number | string;
  source: "legacy" | "relay";
  projectId: number | null;
  projectName: string | null;
  origin: TaskCenterOrigin | null;
  taskClass: string;
  relatedObjects: string;
  model: string | null;
  describe: string;
  state: string;
  startTime: number;
  reason: string | null;
  workspaceId: string | null;
}

export const PUBLIC_TASK_MODEL_LABEL = "平台模型路由";
export const PUBLIC_TASK_AUTO_MODEL_LABEL = "平台自动路由";

/**
 * Provider model identifiers are an internal routing detail. The task center
 * exposes only whether a configured model route was used; admin observability
 * remains the place for exact provider/model inspection.
 */
export function publicTaskModelLabel(value: unknown): string {
  return String(value ?? "").trim()
    ? PUBLIC_TASK_MODEL_LABEL
    : PUBLIC_TASK_AUTO_MODEL_LABEL;
}

export type TaskCenterOriginSurface =
  | "quick-create"
  | "production"
  | "canvas"
  | "agent";

export interface TaskCenterOrigin {
  version: 1;
  surface: TaskCenterOriginSurface;
  projectId: number;
  scriptId?: number;
  trackId?: number;
}

export const relayTaskCategories = [
  "快速创作视频生成",
  "创作台视频生成",
  "Canvas 视频生成",
  "Agent 视频生成",
  "API 视频生成",
  "API 视频增强",
  "API 图片生成",
  "API 中转任务",
];

export function parseObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function relayState(
  status: RelayTaskStatus | string | null | undefined,
  runtime = process.env.NODE_ENV,
): string {
  const publicStatus = publicRelayStatus(String(status || ""), runtime);
  if (publicStatus === "succeeded") return "已完成";
  if (shouldQuarantineRelayArtifacts(status, runtime)) return "生成失败";
  if (status === "enhancing") return "高清处理中";
  if (status === "failed") return "生成失败";
  if (status === "cancelled") return "已取消";
  return "进行中";
}

export function relayStatusFilter(state?: string | null, runtime = process.env.NODE_ENV): string[] | null {
  if (!state) return null;
  if (state === "已完成") return relaySuccessFilterStatuses(runtime);
  if (state === "生成失败") {
    return relayMockIsSuccessful(runtime)
      ? ["failed"]
      : ["failed", "mocked"];
  }
  if (state === "已取消") return ["cancelled"];
  if (state === "高清处理中") return ["enhancing"];
  if (state === "进行中") return ["queued", "running", "enhancing"];
  return [];
}

export function relayTaskClass(row: any): string {
  const requestId = String(row.requestId || "");
  if (requestId.startsWith("quick-create:")) return "快速创作视频生成";
  if (requestId.startsWith("workbench:")) return "创作台视频生成";
  if (requestId.startsWith("canvas-video:")) return "Canvas 视频生成";
  if (requestId.startsWith("agent-video-submit:") || requestId.startsWith("agent-video-retry:")) {
    return "Agent 视频生成";
  }
  if (row.endpointType === "video_generation") return "API 视频生成";
  if (row.endpointType === "video_upscale") return "API 视频增强";
  if (row.endpointType === "image_generation") return "API 图片生成";
  return "API 中转任务";
}

export function relayProjectId(row: any): number | null {
  const storedProjectId = Number(row.projectId);
  if (Number.isSafeInteger(storedProjectId) && storedProjectId > 0) {
    return storedProjectId;
  }
  const requestId = String(row.requestId || "");
  const match = requestId.match(/^(?:quick-create|workbench):(\d+):/);
  if (match) {
    const requestProjectId = Number(match[1]);
    if (Number.isSafeInteger(requestProjectId) && requestProjectId > 0) {
      return requestProjectId;
    }
  }
  const requestPayload = parseObject(row.requestPayload);
  const payloadProjectId = Number(requestPayload.projectId || 0);
  return Number.isSafeInteger(payloadProjectId) && payloadProjectId > 0 ? payloadProjectId : null;
}

/**
 * Only a server-recognized internal request family gets a workflow origin.
 * Generic API tasks deliberately remain origin-less even when they carry a
 * projectId, so the task center never guesses a paid workflow from task text.
 */
export function relayTaskOrigin(row: any): TaskCenterOrigin | null {
  if (String(row.apiKeyId || "").trim()) return null;
  if (row.endpointType !== "video_generation") return null;

  const projectId = relayProjectId(row);
  if (!projectId) return null;
  const requestId = String(row.requestId || "");
  const workbenchMatch = requestId.match(/^(quick-create|workbench):(\d+):(\d+):(\d+):/);
  if (workbenchMatch) {
    const requestProjectId = Number(workbenchMatch[2]);
    const scriptId = Number(workbenchMatch[3]);
    const trackId = Number(workbenchMatch[4]);
    if (
      requestProjectId !== projectId
      || !Number.isSafeInteger(scriptId)
      || scriptId <= 0
      || !Number.isSafeInteger(trackId)
      || trackId <= 0
    ) return null;
    return {
      version: 1,
      surface: workbenchMatch[1] === "quick-create" ? "quick-create" : "production",
      projectId,
      scriptId,
      trackId,
    };
  }

  // These request ids do not encode project ownership, so a canonical stored
  // projectId is required; requestPayload fallbacks are not sufficient.
  const storedProjectId = Number(row.projectId);
  if (!Number.isSafeInteger(storedProjectId) || storedProjectId !== projectId) return null;
  if (requestId.startsWith("canvas-video:")) {
    return { version: 1, surface: "canvas", projectId };
  }
  if (requestId.startsWith("agent-video-submit:") || requestId.startsWith("agent-video-retry:")) {
    return { version: 1, surface: "agent", projectId };
  }
  return null;
}

export function relayDescription(row: any): string {
  const requestPayload = parseObject(row.requestPayload);
  const textContent = Array.isArray(requestPayload.content)
    ? requestPayload.content.find((item: any) => item?.type === "text" && typeof item.text === "string")?.text
    : "";
  const prompt = String(requestPayload.prompt || textContent || "");
  if (prompt) return prompt.slice(0, 160);
  return row.endpointType === "video_generation" ? "视频生成请求" : "API 中转请求";
}

export function toRelayTaskCenterRow(
  row: any,
  projectNameMap: Map<number, string> = new Map(),
  runtime = process.env.NODE_ENV,
): TaskCenterRow {
  const projectId = relayProjectId(row);
  const syntheticQuarantined = shouldQuarantineRelayArtifacts(
    row.status,
    runtime,
  );
  const relatedObjects = {
    relayTaskId: row.id,
    requestId: row.requestId || null,
    providerTaskId: row.providerTaskId || null,
    endpointType: row.endpointType,
    provider: row.provider || null,
    apiKeyId: row.apiKeyId || null,
    channelId: row.channelId || null,
  };
  return {
    id: String(row.id),
    source: "relay",
    projectId,
    projectName: projectId ? projectNameMap.get(projectId) || null : null,
    origin: relayTaskOrigin(row),
    taskClass: relayTaskClass(row),
    relatedObjects: JSON.stringify(relatedObjects),
    model: row.model || null,
    describe: relayDescription(row),
    state: relayState(row.status, runtime),
    startTime: Number(row.createTime || row.updateTime || Date.now()),
    reason: syntheticQuarantined
      ? RELAY_SYNTHETIC_QUARANTINE_MESSAGE
      : row.errorMessage || null,
    workspaceId: row.workspaceId || null,
  };
}
